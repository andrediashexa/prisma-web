use axum::extract::{Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::auth::{CurrentUser, Role};
use crate::error::AppResult;
use crate::AppState;

#[derive(Deserialize)]
pub struct AuditQuery {
    #[serde(default = "default_limit")]
    limit: i64,
    /// Cursor pagination: returns events with an id lower than this one.
    before: Option<i64>,
    /// Action prefix, e.g. `auth.` or `router.interface.update`.
    action: Option<String>,
    username: Option<String>,
    router_id: Option<Uuid>,
}

fn default_limit() -> i64 {
    50
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AuditEntry {
    id: i64,
    at: DateTime<Utc>,
    user_id: Option<Uuid>,
    username: Option<String>,
    action: String,
    target: Option<String>,
    router_id: Option<Uuid>,
    success: bool,
    ip: Option<String>,
    details: Value,
}

#[derive(Serialize)]
pub struct AuditPage {
    items: Vec<AuditEntry>,
    next_before: Option<i64>,
}

pub async fn list(
    State(st): State<AppState>,
    user: CurrentUser,
    Query(q): Query<AuditQuery>,
) -> AppResult<Json<AuditPage>> {
    user.require(Role::Operator)?;
    let limit = q.limit.clamp(1, 200);
    let items = sqlx::query_as::<_, AuditEntry>(
        "SELECT id, at, user_id, username, action, target, router_id, success, host(ip) AS ip, details
           FROM audit_log
          WHERE ($1::bigint IS NULL OR id < $1)
            AND ($2::text IS NULL OR action LIKE $2 || '%')
            AND ($3::text IS NULL OR lower(username) = lower($3))
            AND ($4::uuid IS NULL OR router_id = $4)
            -- Entries of a router hidden from the user are hidden too (#6).
            AND ($6::boolean OR router_id IS NULL OR router_id NOT IN
                 (SELECT router_id FROM router_access WHERE user_id = $7 AND role = 'none'))
          ORDER BY id DESC
          LIMIT $5",
    )
    .bind(q.before)
    .bind(q.action.filter(|a| !a.is_empty()).map(|a| a.replace(['%', '_'], "")))
    .bind(q.username.filter(|u| !u.is_empty()))
    .bind(q.router_id)
    .bind(limit)
    .bind(user.global_role == Role::Admin)
    .bind(user.id)
    .fetch_all(&st.db)
    .await?;

    let next_before = (items.len() as i64 == limit).then(|| items.last().map(|e| e.id)).flatten();
    Ok(Json(AuditPage { items, next_before }))
}
