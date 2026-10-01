//! Custom home page layout, one per user.
//!
//! The front end defines the format; here we only ensure it is a JSON object
//! of reasonable size with a list of widgets.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use serde_json::Value;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::AppState;

const MAX_LAYOUT_BYTES: usize = 32 * 1024;
const MAX_WIDGETS: usize = 40;

#[derive(Serialize)]
pub struct Dashboard {
    /// `null` when the user has not customized it yet: the front end uses the default.
    layout: Option<Value>,
}

pub async fn get(State(st): State<AppState>, user: CurrentUser) -> AppResult<Json<Dashboard>> {
    let layout: Option<Value> = sqlx::query_scalar("SELECT layout FROM dashboards WHERE user_id = $1")
        .bind(user.id)
        .fetch_optional(&st.db)
        .await?;
    Ok(Json(Dashboard { layout }))
}

pub async fn put(State(st): State<AppState>, user: CurrentUser, Json(layout): Json<Value>) -> AppResult<StatusCode> {
    let widgets = layout
        .get("widgets")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::BadRequest("layout needs a 'widgets' list".into()))?;
    if widgets.len() > MAX_WIDGETS {
        return Err(AppError::BadRequest(format!("at most {MAX_WIDGETS} widgets")));
    }
    if widgets.iter().any(|w| !w.get("type").is_some_and(Value::is_string)) {
        return Err(AppError::BadRequest("every widget needs a 'type'".into()));
    }
    if serde_json::to_vec(&layout).map_err(anyhow::Error::from)?.len() > MAX_LAYOUT_BYTES {
        return Err(AppError::BadRequest("layout too large".into()));
    }

    sqlx::query(
        "INSERT INTO dashboards (user_id, layout) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()",
    )
    .bind(user.id)
    .bind(&layout)
    .execute(&st.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reset(State(st): State<AppState>, user: CurrentUser) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM dashboards WHERE user_id = $1").bind(user.id).execute(&st.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
