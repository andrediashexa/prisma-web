//! Ponte autenticada entre a interface e a API de cada Prisma cadastrado.

use axum::extract::{Path, Query, State};
use axum::Json;
use prisma_api::{Interface, InterfaceUpdate, Route, SystemInfo, TrafficSeries, MTU_MAX, MTU_MIN};
use serde::Deserialize;
use serde_json::{json, Map};
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{ClientMeta, CurrentUser, Role};
use crate::error::{AppError, AppResult};
use crate::AppState;

pub async fn system(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<SystemInfo>> {
    Ok(Json(st.routers.get(id).await?.client.system().await?))
}

pub async fn interfaces(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Vec<Interface>>> {
    Ok(Json(st.routers.get(id).await?.client.interfaces().await?))
}

pub async fn routes(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Vec<Route>>> {
    Ok(Json(st.routers.get(id).await?.client.routes().await?))
}

#[derive(Deserialize)]
pub struct TrafficQuery {
    interface: String,
    #[serde(default = "default_minutes")]
    minutes: u32,
}

fn default_minutes() -> u32 {
    60
}

pub async fn traffic(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
    Query(q): Query<TrafficQuery>,
) -> AppResult<Json<TrafficSeries>> {
    let router = st.routers.get(id).await?;
    Ok(Json(router.client.traffic(&q.interface, q.minutes.clamp(1, 24 * 60)).await?))
}

pub async fn update_interface(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path((id, name)): Path<(Uuid, String)>,
    Json(mut req): Json<InterfaceUpdate>,
) -> AppResult<Json<Interface>> {
    user.require(Role::Operator)?;

    if let Some(mtu) = req.mtu {
        if !(MTU_MIN..=MTU_MAX).contains(&mtu) {
            return Err(AppError::BadRequest(format!(
                "MTU deve estar entre {MTU_MIN} (mínimo do IPv6) e {MTU_MAX}"
            )));
        }
    }
    if let Some(d) = &mut req.description {
        *d = d.trim().to_string();
        if d.chars().count() > 64 {
            return Err(AppError::BadRequest("descrição deve ter no máximo 64 caracteres".into()));
        }
    }

    let router = st.routers.get(id).await?;
    let before = router.client.interface(&name).await?;
    let mut changes = Map::new();
    if let Some(v) = req.admin_up.filter(|v| *v != before.admin_up) {
        changes.insert("admin_up".into(), json!({ "from": before.admin_up, "to": v }));
    }
    if let Some(v) = req.mtu.filter(|v| *v != before.mtu) {
        changes.insert("mtu".into(), json!({ "from": before.mtu, "to": v }));
    }
    if let Some(v) = req.description.as_ref().filter(|v| Some(v.as_str()) != before.description.as_deref()) {
        changes.insert("description".into(), json!({ "from": before.description, "to": v }));
    }
    if changes.is_empty() {
        return Ok(Json(before));
    }

    // Alvo no formato "roteador/interface" para o log ser legível com vários Prismas.
    let target = format!("{}/{}", router.name, name);
    let result = router.client.update_interface(&name, &req).await;
    let mut entry = Entry::by(&user, &meta, "router.interface.update").target(&target).router(id);
    if let Err(e) = &result {
        changes.insert("error".into(), json!(e.to_string()));
        entry = entry.failed();
    }
    audit::record(&st.db, entry.details(changes.into())).await;
    Ok(Json(result?))
}
