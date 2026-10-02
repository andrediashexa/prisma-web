use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{self, ClientMeta, CurrentUser, Role};
use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Serialize, sqlx::FromRow)]
pub struct UserView {
    id: Uuid,
    username: String,
    role: Role,
    disabled: bool,
    must_change_password: bool,
    created_at: DateTime<Utc>,
    last_login_at: Option<DateTime<Utc>>,
    active_sessions: i64,
}

const SELECT_USERS: &str = "
    SELECT u.id, u.username, u.role, u.disabled, u.must_change_password, u.created_at, u.last_login_at,
           (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS active_sessions
      FROM users u";

pub async fn list(State(st): State<AppState>, user: CurrentUser) -> AppResult<Json<Vec<UserView>>> {
    user.require(Role::Admin)?;
    let users = sqlx::query_as::<_, UserView>(&format!("{SELECT_USERS} ORDER BY lower(u.username)"))
        .fetch_all(&st.db)
        .await?;
    Ok(Json(users))
}

#[derive(Deserialize)]
pub struct CreateUser {
    username: String,
    password: String,
    role: Role,
}

pub async fn create(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Json(req): Json<CreateUser>,
) -> AppResult<(StatusCode, Json<UserView>)> {
    user.require(Role::Admin)?;
    let username = req.username.trim().to_string();
    auth::validate_username(&username)?;
    auth::validate_password(&req.password)?;
    let hash = auth::hash_password(req.password).await?;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash, role, must_change_password)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT DO NOTHING
         RETURNING id",
    )
    .bind(&username)
    .bind(hash)
    .bind(req.role)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::Conflict(format!("a user '{username}' already exists")))?;

    audit::record(
        &st.db,
        Entry::by(&user, &meta, "user.create")
            .target(&username)
            .details(json!({ "role": req.role })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(fetch(&st, id).await?)))
}

#[derive(Deserialize)]
pub struct UpdateUser {
    role: Option<Role>,
    disabled: Option<bool>,
    password: Option<String>,
}

pub async fn update(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateUser>,
) -> AppResult<Json<UserView>> {
    user.require(Role::Admin)?;
    let before = fetch(&st, id).await?;

    if id == user.id && (req.disabled == Some(true) || req.role.is_some_and(|r| r != Role::Admin)) {
        return Err(AppError::BadRequest(
            "you cannot disable or demote your own account".into(),
        ));
    }

    let mut tx = st.db.begin().await?;
    let mut changes = Map::new();

    if let Some(role) = req.role.filter(|r| *r != before.role) {
        sqlx::query("UPDATE users SET role = $1, updated_at = now() WHERE id = $2")
            .bind(role)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        changes.insert("role".into(), json!({ "from": before.role, "to": role }));
    }
    if let Some(disabled) = req.disabled.filter(|d| *d != before.disabled) {
        sqlx::query("UPDATE users SET disabled = $1, updated_at = now() WHERE id = $2")
            .bind(disabled)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        changes.insert("disabled".into(), json!({ "from": before.disabled, "to": disabled }));
    }
    if let Some(password) = req.password {
        auth::validate_password(&password)?;
        let hash = auth::hash_password(password).await?;
        sqlx::query(
            "UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = now()
              WHERE id = $2",
        )
        .bind(hash)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        changes.insert("password".into(), json!("reset"));
    }

    if changes.is_empty() {
        return Ok(Json(before));
    }
    ensure_admin_remains(&mut tx).await?;
    // Any access change drops the open sessions of the affected user.
    if changes.contains_key("disabled") || changes.contains_key("password") || changes.contains_key("role") {
        sqlx::query("DELETE FROM sessions WHERE user_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    audit::record(
        &st.db,
        Entry::by(&user, &meta, "user.update")
            .target(&before.username)
            .details(Value::Object(changes)),
    )
    .await;
    Ok(Json(fetch(&st, id).await?))
}

pub async fn delete(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    user.require(Role::Admin)?;
    if id == user.id {
        return Err(AppError::BadRequest("you cannot delete your own account".into()));
    }
    let target = fetch(&st, id).await?;

    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM users WHERE id = $1").bind(id).execute(&mut *tx).await?;
    ensure_admin_remains(&mut tx).await?;
    tx.commit().await?;

    audit::record(
        &st.db,
        Entry::by(&user, &meta, "user.delete")
            .target(&target.username)
            .details(json!({ "role": target.role })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn fetch(st: &AppState, id: Uuid) -> AppResult<UserView> {
    sqlx::query_as::<_, UserView>(&format!("{SELECT_USERS} WHERE u.id = $1"))
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("user not found".into()))
}

/// Prevents the system from being left without any active administrator.
async fn ensure_admin_remains(tx: &mut sqlx::PgConnection) -> AppResult<()> {
    let admins: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE role = 'admin' AND NOT disabled")
            .fetch_one(tx)
            .await?;
    if admins == 0 {
        return Err(AppError::BadRequest("at least one active administrator must remain".into()));
    }
    Ok(())
}

#[derive(Serialize, sqlx::FromRow)]
pub struct RouterAccess {
    router_id: Uuid,
    router_name: String,
    /// The override on this router, or `None` when the global role applies.
    role: Option<String>,
}

/// Every router and the user's override on it (#6).
pub async fn access(State(st): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Vec<RouterAccess>>> {
    user.require_global(Role::Admin)?;
    let rows = sqlx::query_as::<_, RouterAccess>(
        "SELECT r.id AS router_id, r.name AS router_name, a.role
           FROM routers r LEFT JOIN router_access a ON a.router_id = r.id AND a.user_id = $1
          ORDER BY lower(r.name)",
    )
    .bind(id)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct SetAccess {
    /// `none`, `viewer`, `operator` or `admin`; `null` goes back to the global role.
    role: Option<String>,
}

/// Grants, changes or revokes a user's access to one router, in the change log.
pub async fn set_access(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path((id, router_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<SetAccess>,
) -> AppResult<StatusCode> {
    user.require_global(Role::Admin)?;
    let (username, target_role): (String, Role) = sqlx::query_as("SELECT username, role FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("user not found".into()))?;
    if target_role == Role::Admin {
        return Err(AppError::BadRequest("an administrator always has every router; change the global role first".into()));
    }
    let router: String = sqlx::query_scalar("SELECT name FROM routers WHERE id = $1")
        .bind(router_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("router not found".into()))?;
    let before: Option<String> = sqlx::query_scalar("SELECT role FROM router_access WHERE user_id = $1 AND router_id = $2")
        .bind(id)
        .bind(router_id)
        .fetch_optional(&st.db)
        .await?;
    match req.role.as_deref() {
        None => {
            sqlx::query("DELETE FROM router_access WHERE user_id = $1 AND router_id = $2")
                .bind(id)
                .bind(router_id)
                .execute(&st.db)
                .await?;
        }
        Some(r @ ("none" | "viewer" | "operator" | "admin")) => {
            sqlx::query(
                "INSERT INTO router_access (user_id, router_id, role, granted_by) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, router_id) DO UPDATE SET role = $3, granted_by = $4, granted_at = now()",
            )
            .bind(id)
            .bind(router_id)
            .bind(r)
            .bind(&user.username)
            .execute(&st.db)
            .await?;
        }
        Some(other) => return Err(AppError::BadRequest(format!("unknown router role: {other}"))),
    }
    if before != req.role {
        let action = if req.role.is_none() { "user.access.revoke" } else { "user.access.grant" };
        audit::record(
            &st.db,
            Entry::by(&user, &meta, action).target(&username).router(router_id).details(json!({
                "router": router,
                "before": before.as_deref().unwrap_or("global role"),
                "after": req.role.as_deref().unwrap_or("global role"),
            })),
        )
        .await;
    }
    Ok(StatusCode::NO_CONTENT)
}
