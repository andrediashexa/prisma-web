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
    .ok_or_else(|| AppError::Conflict(format!("já existe um usuário '{username}'")))?;

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
            "você não pode desativar nem rebaixar a própria conta".into(),
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
        changes.insert("password".into(), json!("redefinida"));
    }

    if changes.is_empty() {
        return Ok(Json(before));
    }
    ensure_admin_remains(&mut tx).await?;
    // Qualquer mudança de acesso derruba as sessões abertas do usuário afetado.
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
        return Err(AppError::BadRequest("você não pode excluir a própria conta".into()));
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
        .ok_or_else(|| AppError::NotFound("usuário não encontrado".into()))
}

/// Impede que o sistema fique sem nenhum administrador ativo.
async fn ensure_admin_remains(tx: &mut sqlx::PgConnection) -> AppResult<()> {
    let admins: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE role = 'admin' AND NOT disabled")
            .fetch_one(tx)
            .await?;
    if admins == 0 {
        return Err(AppError::BadRequest("é preciso manter pelo menos um administrador ativo".into()));
    }
    Ok(())
}
