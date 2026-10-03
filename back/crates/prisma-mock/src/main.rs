//! Simulated Prisma: implements `prisma.v1` (back/proto/prisma/v1/prisma.proto)
//! over gRPC, with configuration in the VTY model and synthetic traffic, so that
//! prisma-web can be developed without a real box.

mod config;
mod config_service;
mod log_export;
mod operational;
mod policy;
mod schema;
mod session;
mod route_service;
mod state;
mod telemetry;
mod typed;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use prisma_proto::v1::config_service_server::ConfigServiceServer;
use prisma_proto::v1::operational_service_server::OperationalServiceServer;
use prisma_proto::v1::session_service_server::SessionServiceServer;
use prisma_proto::v1::route_service_server::RouteServiceServer;
use prisma_proto::v1::telemetry_service_server::TelemetryServiceServer;
use prisma_proto::v1::system_service_server::SystemServiceServer;
use tokio::sync::broadcast;
use tonic_health::pb::health_server::HealthServer;
use tonic_health::server::HealthService;
use tonic::transport::server::Router;
use tonic::transport::{Certificate, Identity, ServerTlsConfig};
use tonic::transport::Server;

use crate::state::{Shared, SharedRef, State};

fn bind_addr() -> anyhow::Result<SocketAddr> {
    Ok(std::env::var("BIND_ADDR").unwrap_or_else(|_| "[::]:50051".into()).parse()?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let hostname = std::env::var("MOCK_HOSTNAME").unwrap_or_else(|_| "prisma-mock".into());
    let scale: f64 = std::env::var("MOCK_TRAFFIC_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);
    let shared = new_shared(&hostname, scale);
    shared.set_health(std::env::var("MOCK_NOT_SERVING").map_or(true, |v| v.is_empty() || v == "0")).await;
    tokio::spawn(ticker(shared.clone()));

    let addr = bind_addr()?;
    let mut builder = Server::builder();
    let tls = tls_from_env()?;
    let mode = if tls.is_some() { "mTLS" } else { "no TLS" };
    if let Some(cfg) = tls {
        builder = builder.tls_config(cfg)?;
    }
    tracing::info!(%addr, %hostname, mode, "prisma-mock (gRPC) listening");
    router_with(builder, shared, hostname)
        .serve_with_shutdown(addr, async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn new_shared(hostname: &str, scale: f64) -> SharedRef {
    let (events, _) = broadcast::channel(64);
    Arc::new(Shared {
        state: Mutex::new(State::new(hostname, scale)),
        events,
        ops: tokio::sync::Mutex::new(()),
        health: tonic_health::server::HealthReporter::new(),
    })
}

/// Like the real Prisma: with `MOCK_TLS_DIR`, serves mTLS only and requires a
/// client certificate signed by `clients-ca.crt` (docs/prisma-api.md).
fn tls_from_env() -> anyhow::Result<Option<ServerTlsConfig>> {
    let Some(dir) = std::env::var_os("MOCK_TLS_DIR").filter(|d| !d.is_empty()) else { return Ok(None) };
    let dir = std::path::PathBuf::from(dir);
    let read = |name: &str| {
        std::fs::read(dir.join(name)).map_err(|e| anyhow::anyhow!("MOCK_TLS_DIR: missing {name}: {e}"))
    };
    Ok(Some(
        ServerTlsConfig::new()
            .identity(Identity::from_pem(read("server.crt")?, read("server.key")?))
            .client_ca_root(Certificate::from_pem(read("clients-ca.crt")?)),
    ))
}

fn router(shared: SharedRef, hostname: String) -> Router {
    router_with(Server::builder(), shared, hostname)
}

fn router_with(mut builder: Server, shared: SharedRef, hostname: String) -> Router {
    builder
        .add_service(ConfigServiceServer::new(config_service::ConfigSvc(shared.clone())))
        .add_service(OperationalServiceServer::new(operational::OperationalSvc { shared: shared.clone(), hostname }))
        .add_service(TelemetryServiceServer::new(telemetry::TelemetrySvc(shared.clone())))
        .add_service(SessionServiceServer::new(session::SessionSvc))
        .add_service(HealthServer::new(HealthService::from_health_reporter(shared.health.clone())))
        .add_service(RouteServiceServer::new(route_service::RouteSvc::default()))
        // 0.149.25 (#48): every call answers unimplemented until its own issue.
        .add_optional_service((!typed::disabled()).then(|| SystemServiceServer::new(SystemSvc)))
}

struct SystemSvc;

#[tonic::async_trait]
impl prisma_proto::v1::system_service_server::SystemService for SystemSvc {}

/// Advances the simulation every second.
async fn ticker(shared: SharedRef) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    for n in 1u64.. {
        tick.tick().await;
        let mut st = shared.state.lock().unwrap();
        st.step(chrono::Utc::now(), 1);
        if n % 60 == 0 {
            st.record_history(chrono::Utc::now());
        }
    }
}

/// Used by the container HEALTHCHECK (the image has no shell): only tests whether
/// the port accepts a connection.
fn healthcheck() -> anyhow::Result<()> {
    let port = bind_addr().map_or(50051, |a| a.port());
    std::net::TcpStream::connect_timeout(&SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)), Duration::from_secs(2))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use prisma_proto::v1::config_service_client::ConfigServiceClient;
    use prisma_proto::v1::operational_service_client::OperationalServiceClient;
    use prisma_proto::v1::route_service_client::RouteServiceClient;
    use prisma_proto::v1::telemetry_service_client::TelemetryServiceClient;
    use prisma_proto::v1::telemetry_update::Update;
    use prisma_proto::v1::*;
    use tokio_stream::wrappers::TcpListenerStream;
    use tokio_stream::StreamExt;
    use tonic::transport::Channel;

    use super::*;

    async fn start(hostname: &str) -> Channel {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let shared = new_shared(hostname, 1.0);
        shared.set_health(true).await;
        tokio::spawn(ticker(shared.clone()));
        let r = router(shared, hostname.to_string());
        tokio::spawn(r.serve_with_incoming(TcpListenerStream::new(listener)));
        Channel::from_shared(format!("http://127.0.0.1:{port}")).unwrap().connect().await.unwrap()
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[tokio::test]
    async fn config_flow_and_refusals() {
        let ch = start("prisma-test").await;
        let mut op = OperationalServiceClient::new(ch.clone());
        let mut cfg = ConfigServiceClient::new(ch.clone());

        let v = op.get_version(GetVersionRequest {}).await.unwrap().into_inner();
        assert_eq!(v.hostname, "prisma-test");

        let c = cfg.open_candidate(OpenCandidateRequest { from_revision: None, ..Default::default() }).await.unwrap().into_inner();
        assert_eq!(c.base_revision, "r1");
        let cid = c.candidate_id;
        let edit = |path: &[&str], lines: &[&str]| EditRequest {
            candidate_id: cid.clone(),
            path: s(path),
            lines: s(lines),
            ..Default::default()
        };
        cfg.edit(edit(&["interface lan0"], &["mtu 9000"])).await.unwrap();

        // Refusal with Diagnostics in the metadata.
        let err = cfg.edit(edit(&["interface lan0"], &["mtu 1000"])).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
        let d = prisma_proto::diagnostics(&err).expect("diagnostics in the metadata");
        assert_eq!(d.items[0].message, "mtu must be between 1280 and 9216");
        assert_eq!(d.items[0].path, s(&["interface lan0"]));

        let cmp = cfg.compare(CandidateRef { candidate_id: cid.clone(), ..Default::default() }).await.unwrap().into_inner();
        assert!(cmp.changed && cmp.diff.contains("+  mtu 9000"), "{}", cmp.diff);

        // Changing the block-size requires acknowledging the remap.
        cfg.edit(edit(&["nat", "cgnat", "pool RFC6598"], &["block-size 512"])).await.unwrap();
        let chk = cfg.check(CandidateRef { candidate_id: cid.clone(), ..Default::default() }).await.unwrap().into_inner();
        assert!(chk.passed && chk.remap.len() == 1, "{chk:?}");
        let commit = |ack| CommitRequest {
            candidate_id: cid.clone(),
            comment: "test".into(),
            acknowledge_remap: ack,
            ..Default::default()
        };
        let err = cfg.commit(commit(false)).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);
        let done = cfg.commit(commit(true)).await.unwrap().into_inner();
        assert_eq!(done.revision, "r2");

        let running = cfg.get_running(GetRunningRequest {}).await.unwrap().into_inner();
        assert!(
            running.text.contains("interface lan0\n description Internal network\n ipv6 ospf6 area 0\n ipv4 address 192.168.10.1/24\n ipv6 address 2001:db8:200:10::1/64\n mtu 9000\n exit\n"),
            "{}",
            running.text
        );
        assert!(running.text.contains("   block-size 512\n"));
        let revs = cfg.list_revisions(ListRevisionsRequest {}).await.unwrap().into_inner().revisions;
        assert_eq!(revs.len(), 2);
        assert_eq!((revs[0].number, revs[0].comment.as_str()), (0, "test"));
        assert_eq!(revs[1].comment, "loaded from file");

        // An old candidate on an outdated base is refused.
        let old = cfg.open_candidate(OpenCandidateRequest { from_revision: Some(1), ..Default::default() }).await.unwrap().into_inner();
        assert!(old.text.contains(" mtu 1500"));
        let c2 = cfg.open_candidate(OpenCandidateRequest { from_revision: None, ..Default::default() }).await.unwrap().into_inner();
        cfg.edit(EditRequest { candidate_id: c2.candidate_id.clone(), path: vec![], lines: s(&["hostname novo"]), ..Default::default() })
            .await
            .unwrap();
        cfg.commit(CommitRequest { candidate_id: c2.candidate_id, confirmed_minutes: 5, ..Default::default() })
            .await
            .unwrap();
        let err = cfg
            .commit(CommitRequest { candidate_id: old.candidate_id, ..Default::default() })
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);
        cfg.confirm(ConfirmRequest {}).await.unwrap();
        assert!(cfg.confirm(ConfirmRequest {}).await.is_err());

        // Show refuses configuration commands.
        let err = op.show(ShowRequest { command: "configure terminal".into(), ..Default::default() }).await.unwrap_err();
        assert!(err.message().starts_with("not an operational command"));
        let r6 = op.show(ShowRequest { command: "show ipv6 route".into(), ..Default::default() }).await.unwrap().into_inner().text;
        assert!(r6.contains("C>* 2001:db8:200:10::/64 is directly connected, lan0"), "{r6}");
    }

    #[tokio::test]
    async fn clear_answers_as_the_box() {
        use prisma_proto::v1::clear_request::{BgpMode, Target};
        let ch = start("prisma-test").await;
        let mut op = OperationalServiceClient::new(ch);
        let peer = op.list_bgp_neighbors(ListBgpNeighborsRequest {}).await.unwrap().into_inner().neighbors.remove(0).peer;
        let clear = |target: Target, name: &str, bgp: BgpMode| ClearRequest { target: target as i32, name: name.into(), bgp: bgp as i32, ..Default::default() };
        let r = op.clear(clear(Target::Bgp, &peer, BgpMode::BgpSoftIn)).await.unwrap().into_inner();
        assert_eq!(r.command, format!("clear ip bgp {peer} soft in"));
        op.clear(clear(Target::Bgp, &peer, BgpMode::BgpHard)).await.unwrap();
        let n = op.list_bgp_neighbors(ListBgpNeighborsRequest {}).await.unwrap().into_inner().neighbors.into_iter().find(|n| n.peer == peer).unwrap();
        assert!(n.uptime_seconds < 5, "a hard clear restarts the session: {}", n.uptime_seconds);
        let e = op.clear(clear(Target::Bgp, "192.0.2.254", BgpMode::BgpHard)).await.unwrap_err();
        assert_eq!(e.code(), tonic::Code::FailedPrecondition);
        let e = op.clear(clear(Target::InterfaceCounters, "two words", BgpMode::BgpHard)).await.unwrap_err();
        assert_eq!(e.code(), tonic::Code::InvalidArgument);
        assert_eq!(op.clear(clear(Target::InterfaceCounters, "", BgpMode::BgpHard)).await.unwrap().into_inner().command, "clear interface counters");
    }

    #[tokio::test]
    async fn watch_logging_streams_as_the_monitor() {
        use prisma_proto::v1::log_event::Kind;
        let ch = start("prisma-test").await;
        let mut t = TelemetryServiceClient::new(ch);
        let req = WatchLoggingRequest { subscriber: "100.64.9.9".into(), event: "alloc".into(), seconds: 3, ..Default::default() };
        let mut s = t.watch_logging(req).await.unwrap().into_inner();
        let mut kinds = vec![];
        while let Some(e) = s.next().await {
            let e = e.unwrap();
            if e.kind() == Kind::Alloc {
                assert_eq!(e.subscriber, "100.64.9.9");
            }
            kinds.push(e.kind());
        }
        assert_eq!(&kinds[..2], &[Kind::Started, Kind::Boot]);
        assert!(kinds.contains(&Kind::Alloc) && !kinds.contains(&Kind::Release), "{kinds:?}");
        let e = t.watch_logging(WatchLoggingRequest { pool: "nope".into(), ..Default::default() }).await.unwrap_err();
        assert_eq!(e.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn telemetry_stream() {
        let ch = start("prisma-branch").await;
        let mut tel = TelemetryServiceClient::new(ch.clone());
        assert!(tel.subscribe(SubscribeRequest { interval_ms: 100, ..Default::default() }).await.is_err());
        let mut stream = tel
            .subscribe(SubscribeRequest {
                interval_ms: 500,
                interface_counters: true,
                interfaces: s(&["wan0"]),
                events: true,
                ..Default::default()
            })
            .await
            .unwrap()
            .into_inner();
        let first = stream.next().await.unwrap().unwrap();
        let Some(Update::Interfaces(batch)) = first.update else { panic!("esperava contadores") };
        assert_eq!(batch.samples.len(), 1);
        assert!(batch.samples[0].counters.unwrap().rx_bytes > 0);

        // A save produces an event on the stream.
        ConfigServiceClient::new(ch.clone()).save(SaveRequest {}).await.unwrap();
        let mut saw_event = false;
        for _ in 0..5 {
            if let Some(Update::Event(e)) = stream.next().await.unwrap().unwrap().update {
                assert_eq!(e.kind, "saved");
                saw_event = true;
                break;
            }
        }
        assert!(saw_event);

        let bgp = OperationalServiceClient::new(ch).list_bgp_neighbors(ListBgpNeighborsRequest {}).await.unwrap();
        let states: Vec<_> = bgp.into_inner().neighbors.into_iter().map(|n| n.state).collect();
        assert_eq!(states, ["Established", "Active"]);
    }

    #[tokio::test]
    async fn history_is_a_day_by_minute_and_honours_since() {
        let ch = start("prisma-test").await;
        let mut tel = TelemetryServiceClient::new(ch);
        let req = |since| GetHistoryRequest { interface_counters: true, cgnat_totals: true, since, ..Default::default() };
        let all: Vec<HistorySample> = tel.get_history(req(None)).await.unwrap().into_inner().collect::<Result<_, _>>().await.unwrap();
        assert_eq!(all.len(), state::HISTORY_LEN);
        let secs: Vec<i64> = all.iter().map(|s| s.at.unwrap().seconds).collect();
        assert!(secs.windows(2).all(|w| w[1] - w[0] == 60), "oldest first, one a minute");
        assert!(all[0].cgnat.is_some() && all[0].interfaces.iter().any(|i| i.name == "wan0"));
        assert_eq!(all[0].memory_used_bytes, 0, "memory was not asked for");
        let since = all[all.len() - 10].at;
        let tail: Vec<HistorySample> = tel.get_history(req(since)).await.unwrap().into_inner().collect::<Result<_, _>>().await.unwrap();
        assert_eq!(tail.len(), 9, "only samples after `since`");
    }

    #[tokio::test]
    async fn route_service_is_served() {
        let mut routes = RouteServiceClient::new(start("prisma-routes").await);
        let p = routes.list_routes(ListRoutesRequest { page_size: 10, ..Default::default() }).await.unwrap().into_inner();
        assert_eq!(p.routes.len(), 10);
        assert!(!p.next_page_token.is_empty());
        let s = routes.get_route_summary(GetRouteSummaryRequest::default()).await.unwrap().into_inner();
        assert!(s.counts.iter().any(|c| c.protocol == "bgp" && c.family == 6));
    }
}
