//! Operational data of each Prisma (`OperationalService`) and telemetry series.

use axum::extract::{Path, Query, State};
use axum::Json;
use prisma_proto::v1::*;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{ClientMeta, CurrentUser, Role};
use crate::error::{AppError, AppResult};
use crate::grpc::{self, req};
use crate::telemetry::{CgnatSample, RateSample, Series};
use crate::AppState;

/// Generates a GET handler that just forwards a parameterless Prisma call.
macro_rules! passthrough {
    ($name:ident, $rpc:ident, $req:expr, $resp:ty) => {
        pub async fn $name(
            State(st): State<AppState>,
            _: CurrentUser,
            Path(id): Path<Uuid>,
        ) -> AppResult<Json<$resp>> {
            let r = st.routers.get(id).await?;
            Ok(Json(r.ops().$rpc(req($req)).await?.into_inner()))
        }
    };
}

passthrough!(version, get_version, GetVersionRequest {}, VersionInfo);
passthrough!(system, get_system, GetSystemRequest {}, SystemInfo);
passthrough!(pools, list_pools, ListPoolsRequest {}, ListPoolsResponse);
passthrough!(sessions, get_sessions_summary, GetSessionsSummaryRequest {}, SessionsSummary);
passthrough!(bgp, list_bgp_neighbors, ListBgpNeighborsRequest {}, ListBgpNeighborsResponse);
passthrough!(ospf, list_ospf_neighbors, ListOspfNeighborsRequest {}, ListOspfNeighborsResponse);
passthrough!(isis, list_isis_adjacencies, ListIsisAdjacenciesRequest {}, ListIsisAdjacenciesResponse);
passthrough!(vrrp, list_vrrp, ListVrrpRequest {}, ListVrrpResponse);
passthrough!(bundles, list_bundles, ListBundlesRequest {}, ListBundlesResponse);
/// Prisma interfaces. 0.148.4 also lists linux_cp's internal `tap*` ones
/// (fixed in 0.148.5, according to the Prisma team); they are hidden here.
pub async fn interfaces(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListInterfacesResponse>> {
    let r = st.routers.get(id).await?;
    let mut resp = r.ops().list_interfaces(req(ListInterfacesRequest { names: vec![], ..Default::default() })).await?.into_inner();
    resp.interfaces.retain(|i| !i.name.starts_with("tap"));
    Ok(Json(resp))
}

passthrough!(policies, list_policies, ListPoliciesRequest {}, ListPoliciesResponse);

#[derive(serde::Serialize)]
pub struct Logging {
    #[serde(flatten)]
    state: LoggingState,
    /// The box's recent `log-*` events, newest first, as the telemetry stream got them.
    events: Vec<crate::telemetry::LogEvent>,
}

/// The CGNAT log export (Prisma 0.149.15, #34): GetLogging and the recent log events.
pub async fn logging(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Logging>> {
    let r = st.routers.get(id).await?;
    let state = r.ops().get_logging(req(GetLoggingRequest {})).await?.into_inner();
    Ok(Json(Logging { state, events: st.routers.telemetry.log_events(id) }))
}

#[derive(Deserialize)]
pub struct CountersQuery {
    /// One policy; absent or empty is every policy.
    #[serde(default)]
    policy: String,
}

/// Per-term hits at every place a policy is applied (Prisma 0.148.12, #21).
pub async fn policy_counters(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
    Query(q): Query<CountersQuery>,
) -> AppResult<Json<GetPolicyCountersResponse>> {
    let r = st.routers.get(id).await?;
    let msg = GetPolicyCountersRequest { policy: q.policy.trim().to_string(), ..Default::default() };
    Ok(Json(r.ops().get_policy_counters(req(msg)).await?.into_inner()))
}

#[derive(Deserialize)]
pub struct TestPolicyBody {
    policy: String,
    prefix: String,
    #[serde(default)]
    attach_point: String,
    #[serde(default)]
    attributes: std::collections::HashMap<String, String>,
    #[serde(default)]
    rib: bool,
    #[serde(default)]
    vrf: String,
    #[serde(default)]
    neighbor: String,
}

/// Simulates a policy on a route (Prisma 0.148.12, #21). Read-only on the box,
/// but it makes the box work, so it is an operator action like the console.
pub async fn test_policy(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(b): Json<TestPolicyBody>,
) -> AppResult<Json<TestPolicyResponse>> {
    user.require(Role::Operator)?;
    if b.policy.trim().is_empty() || b.prefix.trim().is_empty() {
        return Err(AppError::BadRequest("policy and prefix are required".into()));
    }
    let r = st.routers.get(id).await?;
    let msg = TestPolicyRequest {
        policy: b.policy.trim().to_string(),
        prefix: b.prefix.trim().to_string(),
        attach_point: b.attach_point.trim().to_string(),
        attributes: b.attributes,
        rib: b.rib,
        vrf: b.vrf.trim().to_string(),
        neighbor: b.neighbor.trim().to_string(),
        ..Default::default()
    };
    Ok(Json(r.ops().test_policy(req(msg)).await?.into_inner()))
}

#[derive(Deserialize)]
pub struct SubscriberQuery {
    address: String,
}

pub async fn subscriber(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
    Query(q): Query<SubscriberQuery>,
) -> AppResult<Json<Subscriber>> {
    let address = q.address.trim();
    if address.parse::<std::net::IpAddr>().is_err() {
        return Err(AppError::BadRequest(format!("'{address}' is not an IP address")));
    }
    let r = st.routers.get(id).await?;
    let msg = GetSubscriberRequest { address: address.to_string(), ..Default::default() };
    Ok(Json(r.ops().get_subscriber(req(msg)).await?.into_inner()))
}

#[derive(Deserialize)]
pub struct ClearBody {
    target: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    bgp: String,
}

/// The request `Clear` takes for a body; what the UI names wrongly is a 400 here (#48).
fn clear_request(b: &ClearBody) -> Result<ClearRequest, AppError> {
    use clear_request::{BgpMode, Target};
    let target = match b.target.as_str() {
        "interface_counters" => Target::InterfaceCounters,
        "cgnat_subscriber" => Target::CgnatSubscriber,
        "bgp" => Target::Bgp,
        "ospf_process" => Target::OspfProcess,
        "ospf_neighbor" => Target::OspfNeighbor,
        "isis_adjacency" => Target::IsisAdjacency,
        // Prisma 0.151.5 (#70): give up what the boot left out, so `save` writes again.
        "configuration_pending" => Target::ConfigurationPending,
        t => return Err(AppError::BadRequest(format!("'{t}' is not something to clear"))),
    };
    let bgp = match b.bgp.as_str() {
        "" | "hard" => BgpMode::BgpHard,
        "soft" => BgpMode::BgpSoft,
        "soft_in" => BgpMode::BgpSoftIn,
        "soft_out" => BgpMode::BgpSoftOut,
        m => return Err(AppError::BadRequest(format!("'{m}' is not a BGP clear (hard, soft, soft_in, soft_out)"))),
    };
    let name = b.name.trim();
    if target == Target::CgnatSubscriber && name.parse::<std::net::IpAddr>().is_err() {
        return Err(AppError::BadRequest(format!("'{name}' is not a subscriber's address")));
    }
    Ok(ClearRequest { target: target as i32, name: name.to_string(), bgp: bgp as i32, ..Default::default() })
}

/// The VTY's `clear` lines (Prisma 0.149.25, #48): they disrupt (a session,
/// a subscriber, the counters the charts read), so they are an operator's
/// action and are recorded, refused or not.
pub async fn clear(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
    Json(b): Json<ClearBody>,
) -> AppResult<Json<ClearResponse>> {
    user.require(Role::Operator)?;
    let msg = clear_request(&b)?;
    let r = st.routers.get(id).await?;
    let res = r.ops().clear(req(msg)).await;
    let mut entry = Entry::by(&user, &meta, "router.clear").target(&r.name).router(id);
    entry = entry.details(json!({
        "target": b.target,
        "name": b.name.trim(),
        "bgp": b.bgp,
        "command": res.as_ref().map(|r| r.get_ref().command.clone()).unwrap_or_default(),
    }));
    if res.is_err() {
        entry = entry.failed();
    }
    audit::record(&st.db, entry).await;
    Ok(Json(res?.into_inner()))
}

#[derive(Deserialize)]
pub struct ShowBody {
    command: String,
}

/// Console: any operational VTY command (`show ...`, `ping ...`).
/// Prisma itself refuses configuration and shell commands.
pub async fn show(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
    Json(body): Json<ShowBody>,
) -> AppResult<Json<ShowResponse>> {
    user.require(Role::Operator)?;
    let command = body.command.trim();
    if command.is_empty() || command.len() > 256 || command.contains(['\n', '\r']) {
        return Err(AppError::BadRequest("enter a single command of up to 256 characters".into()));
    }
    let r = st.routers.get(id).await?;
    let _console = st.routers.console_started(id);
    let res = r
        .ops()
        .show(grpc::req_with(ShowRequest { command: command.to_string(), ..Default::default() }, grpc::SHOW_TIMEOUT))
        .await;
    // `ping` and the like reach the network; they are recorded like every other command.
    let mut entry = Entry::by(&user, &meta, "router.command").target(&r.name).router(id).details(json!({ "command": command }));
    if res.is_err() {
        entry = entry.failed();
    }
    audit::record(&st.db, entry).await;
    Ok(Json(res?.into_inner()))
}

#[derive(Deserialize)]
pub struct TrafficQuery {
    interface: String,
    #[serde(default = "default_minutes")]
    minutes: u32,
}

#[derive(Deserialize)]
pub struct WindowQuery {
    #[serde(default = "default_minutes")]
    minutes: u32,
}

fn default_minutes() -> u32 {
    60
}

#[derive(serde::Serialize)]
pub struct TrafficSeries {
    interface: String,
    #[serde(flatten)]
    series: Series<RateSample>,
}

pub async fn traffic(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
    Query(q): Query<TrafficQuery>,
) -> AppResult<Json<TrafficSeries>> {
    st.routers.get(id).await?;
    let series = st.routers.telemetry.traffic(id, &q.interface, q.minutes);
    Ok(Json(TrafficSeries { interface: q.interface, series }))
}

pub async fn cgnat(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
    Query(q): Query<WindowQuery>,
) -> AppResult<Json<Series<CgnatSample>>> {
    st.routers.get(id).await?;
    Ok(Json(st.routers.telemetry.cgnat(id, q.minutes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(target: &str, name: &str, bgp: &str) -> ClearBody {
        ClearBody { target: target.into(), name: name.into(), bgp: bgp.into() }
    }

    #[test]
    fn a_clear_names_its_target_and_mode() {
        let r = clear_request(&body("bgp", " 192.0.2.10 ", "soft_in")).unwrap();
        assert_eq!((r.target(), r.name.as_str(), r.bgp()), (clear_request::Target::Bgp, "192.0.2.10", clear_request::BgpMode::BgpSoftIn));
        let r = clear_request(&body("interface_counters", "", "")).unwrap();
        assert_eq!((r.target(), r.name.as_str()), (clear_request::Target::InterfaceCounters, ""));
        assert_eq!(clear_request(&body("bgp", "x", "")).unwrap().bgp(), clear_request::BgpMode::BgpHard);
    }

    #[test]
    fn a_wrong_clear_is_refused_before_the_box() {
        assert!(clear_request(&body("everything", "", "")).is_err());
        assert!(clear_request(&body("bgp", "x", "harder")).is_err());
        assert!(clear_request(&body("cgnat_subscriber", "not-an-ip", "")).is_err());
        assert!(clear_request(&body("cgnat_subscriber", "100.64.0.10", "")).is_ok());
    }
}
