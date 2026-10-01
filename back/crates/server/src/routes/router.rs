//! Ponte autenticada entre a interface e a API do Prisma.

use axum::extract::{Path, Query, State};
use axum::Json;
use prisma_api::{Interface, InterfaceUpdate, Route, SystemInfo, TrafficSeries, MTU_MAX, MTU_MIN};
use serde::Deserialize;
use serde_json::{json, Map};

use crate::audit::{self, Entry};
use crate::auth::{ClientMeta, CurrentUser, Role};
use crate::error::{AppError, AppResult};
use crate::AppState;

pub async fn system(State(st): State<AppState>, _: CurrentUser) -> AppResult<Json<SystemInfo>> {
    Ok(Json(st.prisma.system().await?))
}

pub async fn interfaces(State(st): State<AppState>, _: CurrentUser) -> AppResult<Json<Vec<Interface>>> {
    Ok(Json(st.prisma.interfaces().await?))
}

pub async fn routes(State(st): State<AppState>, _: CurrentUser) -> AppResult<Json<Vec<Route>>> {
    Ok(Json(st.prisma.routes().await?))
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
    Query(q): Query<TrafficQuery>,
) -> AppResult<Json<TrafficSeries>> {
    Ok(Json(st.prisma.traffic(&q.interface, q.minutes.clamp(1, 24 * 60)).await?))
}

pub async fn update_interface(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(name): Path<String>,
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

    let before = st.prisma.interface(&name).await?;
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

    match st.prisma.update_interface(&name, &req).await {
        Ok(after) => {
            audit::record(
                &st.db,
                Entry::by(&user, &meta, "router.interface.update")
                    .target(&name)
                    .details(changes.into()),
            )
            .await;
            Ok(Json(after))
        }
        Err(e) => {
            let mut details = changes;
            details.insert("error".into(), json!(e.to_string()));
            audit::record(
                &st.db,
                Entry::by(&user, &meta, "router.interface.update")
                    .target(&name)
                    .failed()
                    .details(details.into()),
            )
            .await;
            Err(e.into())
        }
    }
}
