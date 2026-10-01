use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{self, ClientMeta, CurrentUser, Role, SESSION_COOKIE};
use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

#[derive(sqlx::FromRow)]
struct LoginRow {
    id: Uuid,
    username: String,
    password_hash: String,
    role: Role,
    disabled: bool,
    must_change_password: bool,
}

pub async fn login(
    State(st): State<AppState>,
    meta: ClientMeta,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> AppResult<(CookieJar, Json<CurrentUser>)> {
    if let Some(ip) = meta.ip {
        if let Some(minutes) = st.limiter.blocked(ip) {
            audit::record(
                &st.db,
                Entry::anonymous(&meta, Some(&req.username), "auth.login_blocked").failed(),
            )
            .await;
            return Err(AppError::TooManyAttempts(minutes));
        }
    }

    let row = sqlx::query_as::<_, LoginRow>(
        "SELECT id, username, password_hash, role, disabled, must_change_password
           FROM users WHERE lower(username) = lower($1)",
    )
    .bind(req.username.trim())
    .fetch_optional(&st.db)
    .await?;

    // Verify the password even with no user, so as not to leak which usernames exist.
    let valid = auth::verify_password(req.password, row.as_ref().map(|r| r.password_hash.clone())).await;

    let user = match row {
        Some(r) if valid && !r.disabled => r,
        other => {
            if let Some(ip) = meta.ip {
                st.limiter.record_failure(ip);
            }
            let reason = match other {
                None => "unknown user",
                Some(r) if r.disabled && valid => "user disabled",
                Some(_) => "wrong password",
            };
            audit::record(
                &st.db,
                Entry::anonymous(&meta, Some(&req.username), "auth.login")
                    .failed()
                    .details(json!({ "reason": reason })),
            )
            .await;
            return Err(AppError::BadRequest("invalid username or password".into()));
        }
    };

    if let Some(ip) = meta.ip {
        st.limiter.reset(ip);
    }
    let (cookie, expires_at) = auth::create_session(&st.db, &st.cfg, user.id, &meta).await?;
    sqlx::query("UPDATE users SET last_login_at = now() WHERE id = $1")
        .bind(user.id)
        .execute(&st.db)
        .await?;

    let current = CurrentUser {
        id: user.id,
        username: user.username,
        role: user.role,
        must_change_password: user.must_change_password,
        session_id: Uuid::nil(),
    };
    audit::record(
        &st.db,
        Entry::by(&current, &meta, "auth.login")
            .details(json!({ "expires_at": expires_at, "user_agent": meta.user_agent })),
    )
    .await;

    Ok((jar.add(cookie), Json(current)))
}

pub async fn logout(
    State(st): State<AppState>,
    meta: ClientMeta,
    jar: CookieJar,
) -> AppResult<(CookieJar, StatusCode)> {
    if let Some(token) = jar.get(SESSION_COOKIE).map(|c| c.value().to_string()) {
        let user: Option<(Uuid, String)> = sqlx::query_as(
            "DELETE FROM sessions s USING users u
              WHERE s.token_hash = $1 AND u.id = s.user_id
             RETURNING u.id, u.username",
        )
        .bind(auth::hash_token(&token))
        .fetch_optional(&st.db)
        .await?;
        if let Some((id, username)) = user {
            let mut e = Entry::anonymous(&meta, Some(&username), "auth.logout");
            e.user_id = Some(id);
            audit::record(&st.db, e).await;
        }
    }
    Ok((jar.add(auth::removal_cookie()), StatusCode::NO_CONTENT))
}

pub async fn me(user: CurrentUser) -> Json<CurrentUser> {
    Json(user)
}

#[derive(Deserialize)]
pub struct ChangePassword {
    current_password: String,
    new_password: String,
}

pub async fn change_password(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Json(req): Json<ChangePassword>,
) -> AppResult<StatusCode> {
    auth::validate_password(&req.new_password)?;
    if req.new_password == req.current_password {
        return Err(AppError::BadRequest("the new password must differ from the current one".into()));
    }

    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&st.db)
        .await?;
    if !auth::verify_password(req.current_password, Some(hash)).await {
        audit::record(&st.db, Entry::by(&user, &meta, "auth.password_change").failed()).await;
        return Err(AppError::BadRequest("wrong current password".into()));
    }

    let new_hash = auth::hash_password(req.new_password).await?;
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = now()
          WHERE id = $2",
    )
    .bind(new_hash)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    // Drop the user's other sessions; keep the current one.
    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2")
        .bind(user.id)
        .bind(user.session_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    audit::record(&st.db, Entry::by(&user, &meta, "auth.password_change")).await;
    Ok(StatusCode::NO_CONTENT)
}
