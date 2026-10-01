//! Dados operacionais de cada Prisma (`OperationalService`) e séries de telemetria.

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

/// Gera um handler GET que só repassa uma chamada sem parâmetros do Prisma.
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
/// Interfaces do Prisma. O 0.148.4 também lista as `tap*` internas do linux_cp
/// (corrigido no 0.148.5, segundo o time do Prisma); elas são escondidas aqui.
pub async fn interfaces(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListInterfacesResponse>> {
    let r = st.routers.get(id).await?;
    let mut resp = r.ops().list_interfaces(req(ListInterfacesRequest { names: vec![] })).await?.into_inner();
    resp.interfaces.retain(|i| !i.name.starts_with("tap"));
    Ok(Json(resp))
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
        return Err(AppError::BadRequest(format!("'{address}' não é um endereço IP")));
    }
    let r = st.routers.get(id).await?;
    let msg = GetSubscriberRequest { address: address.to_string() };
    Ok(Json(r.ops().get_subscriber(req(msg)).await?.into_inner()))
}

#[derive(Deserialize)]
pub struct ShowBody {
    command: String,
}

/// Console: qualquer comando operacional do VTY (`show ...`, `ping ...`).
/// O próprio Prisma recusa comandos de configuração e de shell.
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
        return Err(AppError::BadRequest("informe um único comando de até 256 caracteres".into()));
    }
    let r = st.routers.get(id).await?;
    let res = r
        .ops()
        .show(grpc::req_with(ShowRequest { command: command.to_string() }, grpc::SHOW_TIMEOUT))
        .await;
    // `ping` e afins atingem a rede; ficam registrados como os demais comandos.
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
