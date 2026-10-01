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
