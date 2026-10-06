//! The rest of the VTY's screens, typed (Prisma 0.150.6, #64): OSPF and IS-IS
//! interfaces, the hardware, FRR's logging, the SNMP files, and the probes
//! (`ping`, `traceroute`, `mtr`) as streams.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use prisma_proto::v1::probe_event::Kind;
use prisma_proto::v1::*;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::{Stream, StreamExt};
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{ClientMeta, CurrentUser, Role};
use crate::error::{AppError, AppResult};
use crate::grpc::{self, req};
use crate::AppState;

/// The box stops a probe after 300 s; prisma-web waits a little longer.
const PROBE_TIMEOUT: Duration = Duration::from_secs(320);

fn to_json<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

pub async fn screen(State(st): State<AppState>, _: CurrentUser, Path((id, name)): Path<(Uuid, String)>) -> AppResult<Json<Value>> {
    let r = st.routers.get(id).await?;
    let mut ops = r.ops();
    Ok(Json(match name.as_str() {
        "ospf-interfaces" => to_json(&ops.list_ospf_interfaces(req(ListOspfInterfacesRequest {})).await?.into_inner()),
        "isis-interfaces" => to_json(&ops.list_isis_interfaces(req(ListIsisInterfacesRequest {})).await?.into_inner()),
        "hardware" => to_json(&ops.get_hardware(req(GetHardwareRequest {})).await?.into_inner()),
        "routing-logging" => to_json(&ops.get_routing_logging(req(GetRoutingLoggingRequest {})).await?.into_inner()),
        // Prisma 0.151.5 (#70): what the boot left out.
        "pending-configuration" => to_json(&ops.get_pending_configuration(req(GetPendingConfigurationRequest {})).await?.into_inner()),
        // Prisma 0.150.10 (#66): states by name.
        "bfd-sessions" => {
            let b = ops.list_bfd_sessions(req(ListBfdSessionsRequest::default())).await?.into_inner();
            let mut v = to_json(&b);
            v["sessions"] = Value::Array(b.sessions.iter().map(session_json).collect());
            v
        }
        s => return Err(AppError::NotFound(format!("no screen {s}"))),
    }))
}

/// A BFD session as the page reads it: its state by name (`UP`, `DOWN`, ...).
fn session_json(s: &BfdSession) -> Value {
    let mut v = to_json(s);
    v["state"] = json!(state_name(s.state));
    v
}

fn state_name(state: i32) -> &'static str {
    bfd_session::State::try_from(state).unwrap_or_default().as_str_name().trim_start_matches("STATE_")
}

/// A `BfdEvent` as the page reads it: the kind and the states by name.
fn bfd_event_json(e: &BfdEvent) -> Value {
    let mut v = to_json(e);
    v["kind"] = json!(e.kind().as_str_name().trim_start_matches("KIND_"));
    v["session"] = e.session.as_ref().map(session_json).unwrap_or(Value::Null);
    v["previous_state"] = json!(state_name(e.previous_state));
    v
}

/// The longest a BFD watch runs: a forgotten tab does not hold a stream (as the live log, #49).
const BFD_WATCH_MAX: Duration = Duration::from_secs(30 * 60);

/// `WatchBfd` as Server-Sent Events (`bfd` per event, `error`, `end`); leaving the page cancels it.
pub async fn watch_bfd(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let r = st.routers.get(id).await?;
    // The box answers the call with its first event: with no session that can be never. The page
    // gets its stream at once (`open`), and the call runs behind it (192.0.2.166, #66).
    let (tx, rx) = tokio::sync::mpsc::channel::<Event>(32);
    let mut ops = r.ops();
    tokio::spawn(async move {
        let send = |e: Event| tx.send(e);
        if send(Event::default().event("open").data("watching")).await.is_err() {
            return;
        }
        let call = ops.watch_bfd(grpc::req_with(WatchBfdRequest { interval_seconds: 0 }, BFD_WATCH_MAX));
        let mut stream = tokio::select! {
            res = call => match res {
                Ok(s) => s.into_inner(),
                Err(s) => {
                    let _ = send(Event::default().event("error").data(grpc::describe(&s))).await;
                    return;
                }
            },
            // The page left before the box answered.
            _ = tx.closed() => return,
        };
        loop {
            let m = tokio::select! {
                m = stream.next() => m,
                _ = tx.closed() => return,
            };
            let e = match m {
                Some(Ok(e)) => Event::default().event("bfd").json_data(bfd_event_json(&e)).unwrap_or_default(),
                // The deadline passing is the watch's end, not an error.
                Some(Err(s)) if s.code() == tonic::Code::DeadlineExceeded => break,
                Some(Err(s)) => Event::default().event("error").data(grpc::describe(&s)),
                None => break,
            };
            if send(e).await.is_err() {
                return;
            }
        }
        let _ = send(Event::default().event("end").data("done")).await;
    });
    let events = tokio_stream::wrappers::ReceiverStream::new(rx).map(Ok);
    Ok(Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct EventsQuery {
    last: u32,
    since: String,
    severity: String,
    source: String,
}

/// `show log` (Prisma 0.151.14, #75): the box's record of what happened on it, oldest first, with
/// its filters; a filter the box does not take is refused in its words, a box before it is 501.
pub async fn events(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>, Query(q): Query<EventsQuery>) -> AppResult<Json<Value>> {
    if q.last > 10_000 {
        return Err(AppError::BadRequest("last is at most 10000".into()));
    }
    let r = st.routers.get(id).await?;
    let msg = ListEventsRequest { last: q.last, since: q.since.trim().into(), severity: q.severity.trim().into(), source: q.source.trim().into() };
    Ok(Json(to_json(&r.ops().list_events(req(msg)).await?.into_inner())))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct TransceiversQuery {
    /// Comma-separated interfaces or Linux cards; empty is every one.
    names: String,
}

/// `show interface transceiver` (Prisma 0.151.15, #76): each port's module and its levels, the
/// status and each level by name; a box before it is 501.
pub async fn transceivers(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>, Query(q): Query<TransceiversQuery>) -> AppResult<Json<Value>> {
    let names: Vec<String> = q.names.split(',').map(str::trim).filter(|n| !n.is_empty()).map(String::from).collect();
    let r = st.routers.get(id).await?;
    let t = r.ops().list_transceivers(req(ListTransceiversRequest { names })).await?.into_inner();
    Ok(Json(transceivers_json(&t)))
}

fn level_name(l: &TransceiverLevel) -> &'static str {
    transceiver_level::Level::try_from(l.level).unwrap_or_default().as_str_name().trim_start_matches("LEVEL_")
}

fn transceivers_json(t: &Transceivers) -> Value {
    let mut v = to_json(t);
    let named = |v: &mut Value, l: &Option<TransceiverLevel>| {
        if let Some(l) = l {
            v["level"] = json!(level_name(l));
        }
    };
    for (i, x) in t.transceivers.iter().enumerate() {
        let tv = &mut v["transceivers"][i];
        tv["status"] = json!(transceiver::Status::try_from(x.status).unwrap_or_default().as_str_name().trim_start_matches("STATUS_"));
        named(&mut tv["temperature_c"], &x.temperature_c);
        named(&mut tv["voltage_v"], &x.voltage_v);
        for (j, lane) in x.lanes.iter().enumerate() {
            let lv = &mut tv["lanes"][j];
            named(&mut lv["bias_ma"], &lane.bias_ma);
            named(&mut lv["tx_power_mw"], &lane.tx_power_mw);
            named(&mut lv["rx_power_mw"], &lane.rx_power_mw);
        }
    }
    v
}

#[derive(Deserialize)]
pub struct SnmpQuery {
    kind: String,
}

fn snmp_kind(kind: &str) -> Result<get_snmp_file_request::Kind, AppError> {
    use get_snmp_file_request::Kind as K;
    match kind {
        "mib" => Ok(K::Mib),
        "zabbix" => Ok(K::ZabbixTemplate),
        k => Err(AppError::BadRequest(format!("'{k}' is not an SNMP file (mib, zabbix)"))),
    }
}

/// The MIB or the Zabbix template, as a download under the box's filename.
pub async fn snmp_file(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>, Query(q): Query<SnmpQuery>) -> AppResult<Response> {
    let kind = snmp_kind(&q.kind)?;
    let r = st.routers.get(id).await?;
    let f = r.ops().get_snmp_file(req(GetSnmpFileRequest { kind: kind as i32 })).await?.into_inner();
    let name = f.filename.replace(['"', '\r', '\n', '/', '\\'], "_");
    let media = if f.media_type.is_empty() { "application/octet-stream".to_string() } else { f.media_type };
    Ok(([(header::CONTENT_TYPE, media), (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\""))], f.content).into_response())
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ProbeBody {
    host: String,
    count: u32,
    source: String,
}

fn probe_request(b: &ProbeBody) -> Result<ProbeRequest, AppError> {
    let host = b.host.trim();
    if host.is_empty() || host.len() > 253 || host.contains(char::is_whitespace) {
        return Err(AppError::BadRequest("a host: one address or name".into()));
    }
    if b.count > 100 {
        return Err(AppError::BadRequest("count is 1 to 100 (0 is the box's 5)".into()));
    }
    let source = b.source.trim();
    if source.contains(char::is_whitespace) {
        return Err(AppError::BadRequest("a source: one address or interface".into()));
    }
    Ok(ProbeRequest { host: host.to_string(), count: b.count, source: source.to_string() })
}

/// A `ProbeEvent` as the page reads it: the line, and the one part it carries.
fn event_json(e: &ProbeEvent) -> Value {
    let mut v = json!({ "line": e.line });
    match &e.kind {
        Some(Kind::Reply(x)) => v["reply"] = to_json(x),
        Some(Kind::Hop(x)) => v["hop"] = to_json(x),
        Some(Kind::MtrHop(x)) => v["mtr_hop"] = to_json(x),
        Some(Kind::End(x)) => v["end"] = to_json(x),
        None => {}
    }
    v
}

/// `ping`, `traceroute` or `mtr` as Server-Sent Events (`probe` per line, `error`, `end`).
/// Leaving the page cancels the call, which stops the probe on the box.
pub async fn probe(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path((id, tool)): Path<(Uuid, String)>,
    Json(b): Json<ProbeBody>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    user.require(Role::Operator)?;
    if !["ping", "traceroute", "mtr"].contains(&tool.as_str()) {
        return Err(AppError::NotFound(format!("no probe {tool}")));
    }
    let msg = probe_request(&b)?;
    let r = st.routers.get(id).await?;
    let mut ops = r.ops();
    let call = grpc::req_with(msg.clone(), PROBE_TIMEOUT);
    let res = match tool.as_str() {
        "ping" => ops.ping(call).await,
        "traceroute" => ops.traceroute(call).await,
        _ => ops.mtr(call).await,
    };
    // Recorded as the console's commands are: they reach the network.
    let mut entry = Entry::by(&user, &meta, "router.command")
        .target(&r.name)
        .router(id)
        .details(json!({ "command": format!("{tool} {}", msg.host), "count": msg.count, "source": msg.source }));
    if res.is_err() {
        entry = entry.failed();
    }
    audit::record(&st.db, entry).await;
    let stream = res?.into_inner();
    let events = stream.map(|m| {
        Ok(match m {
            Ok(e) => Event::default().event("probe").json_data(event_json(&e)).unwrap_or_default(),
            Err(s) => Event::default().event("error").data(grpc::describe(&s)),
        })
    });
    let end = tokio_stream::once(Ok(Event::default().event("end").data("done")));
    Ok(Sse::new(events.chain(end)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transceiver_reads_by_name() {
        let rx = TransceiverLevel { known: true, value: 0.0, no_light: true, level: transceiver_level::Level::LowAlarm as i32, ..Default::default() };
        let t = Transceivers {
            transceivers: vec![Transceiver {
                name: "wan0".into(),
                status: transceiver::Status::Ddm as i32,
                temperature_c: Some(TransceiverLevel { known: true, value: 41.5, level: transceiver_level::Level::Normal as i32, ..Default::default() }),
                lanes: vec![TransceiverLane { lane: 1, rx_power_mw: Some(rx), ..Default::default() }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let v = transceivers_json(&t);
        assert_eq!(v["transceivers"][0]["status"], "DDM");
        assert_eq!(v["transceivers"][0]["temperature_c"]["level"], "NORMAL");
        assert_eq!(v["transceivers"][0]["lanes"][0]["rx_power_mw"]["level"], "LOW_ALARM");
        assert_eq!(v["transceivers"][0]["lanes"][0]["rx_power_mw"]["no_light"], true);
        assert!(v["transceivers"][0]["voltage_v"].is_null(), "a level the box did not send stays absent");
    }

    #[test]
    fn bfd_reads_by_name() {
        let s = BfdSession { peer: "192.0.2.1".into(), state: bfd_session::State::Down as i32, ..Default::default() };
        assert_eq!(session_json(&s)["state"], "DOWN");
        let e = BfdEvent { kind: bfd_event::Kind::Changed as i32, session: Some(s), previous_state: bfd_session::State::Up as i32, ..Default::default() };
        let v = bfd_event_json(&e);
        assert_eq!((v["kind"].as_str(), v["previous_state"].as_str(), v["session"]["state"].as_str()), (Some("CHANGED"), Some("UP"), Some("DOWN")));
    }

    #[test]
    fn a_probe_takes_one_host_and_the_boxs_count() {
        let r = probe_request(&ProbeBody { host: " 192.0.2.1 ".into(), count: 3, source: String::new() }).unwrap();
        assert_eq!((r.host.as_str(), r.count), ("192.0.2.1", 3));
        assert!(probe_request(&ProbeBody { host: "a b".into(), ..Default::default() }).is_err());
        assert!(probe_request(&ProbeBody { host: "x".into(), count: 101, ..Default::default() }).is_err());
        assert!(probe_request(&ProbeBody::default()).is_err());
    }

    #[test]
    fn an_event_carries_its_line_and_its_part() {
        let e = ProbeEvent { line: "64 bytes".into(), kind: Some(Kind::Reply(PingReply { sequence: 1, rtt_ms: 0.4, ..Default::default() })) };
        let v = event_json(&e);
        assert_eq!((v["line"].as_str(), v["reply"]["sequence"].as_u64()), (Some("64 bytes"), Some(1)));
        assert!(snmp_kind("mib").is_ok() && snmp_kind("zabbix").is_ok() && snmp_kind("x").is_err());
    }
}
