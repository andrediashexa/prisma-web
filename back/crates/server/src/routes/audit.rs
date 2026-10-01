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
    /// Paginação por cursor: devolve eventos com id menor que este.
    before: Option<i64>,
    /// Prefixo da ação, ex.: `auth.` ou `router.interface.update`.
    action: Option<String>,
    username: Option<String>,
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
        "SELECT id, at, user_id, username, action, target, success, host(ip) AS ip, details
           FROM audit_log
          WHERE ($1::bigint IS NULL OR id < $1)
            AND ($2::text IS NULL OR action LIKE $2 || '%')
            AND ($3::text IS NULL OR lower(username) = lower($3))
          ORDER BY id DESC
          LIMIT $4",
    )
    .bind(q.before)
    .bind(q.action.filter(|a| !a.is_empty()).map(|a| a.replace(['%', '_'], "")))
    .bind(q.username.filter(|u| !u.is_empty()))
    .bind(limit)
    .fetch_all(&st.db)
    .await?;

    let next_before = (items.len() as i64 == limit).then(|| items.last().map(|e| e.id)).flatten();
    Ok(Json(AuditPage { items, next_before }))
}
