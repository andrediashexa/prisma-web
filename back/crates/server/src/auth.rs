use std::net::{IpAddr, SocketAddr};
use std::sync::LazyLock;
use std::time::Duration;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::AppState;

pub const SESSION_COOKIE: &str = "pw_session";
pub const PASSWORD_MIN_LEN: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Operator,
    Admin,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct CurrentUser {
    pub id: Uuid,
    pub username: String,
    pub role: Role,
    pub must_change_password: bool,
    #[serde(skip)]
    pub session_id: Uuid,
}

impl CurrentUser {
    pub fn require(&self, role: Role) -> AppResult<()> {
        if self.role >= role { Ok(()) } else { Err(AppError::Forbidden) }
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar.get(SESSION_COOKIE).ok_or(AppError::Unauthorized)?.value();
        let user = sqlx::query_as::<_, CurrentUser>(
            "UPDATE sessions s SET last_seen_at = now()
               FROM users u
              WHERE s.token_hash = $1 AND s.expires_at > now()
                AND u.id = s.user_id AND NOT u.disabled
             RETURNING u.id, u.username, u.role, u.must_change_password, s.id AS session_id",
        )
        .bind(hash_token(token))
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::Unauthorized)?;
        Ok(user)
    }
}

/// IP e user-agent de quem fez a requisição, para sessões e auditoria.
#[derive(Debug, Clone)]
pub struct ClientMeta {
    pub ip: Option<IpAddr>,
    pub user_agent: Option<String>,
}

impl ClientMeta {
    pub fn ip_string(&self) -> Option<String> {
        self.ip.map(|ip| ip.to_string())
    }
}

impl FromRequestParts<AppState> for ClientMeta {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let forwarded = state
            .cfg
            .trust_proxy
            .then(|| parts.headers.get("x-forwarded-for")?.to_str().ok())
            .flatten()
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse::<IpAddr>().ok());
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| addr.ip());
        // Socket dual-stack entrega IPv4 como ::ffff:a.b.c.d; normaliza para IPv4.
        let ip = forwarded.or(peer).map(|ip| ip.to_canonical());
        let user_agent = parts
            .headers
            .get("user-agent")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.chars().take(256).collect());
        Ok(Self { ip, user_agent })
    }
}

pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub async fn hash_password(password: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| anyhow::anyhow!("hash de senha: {e}"))
    })
    .await
    .map_err(anyhow::Error::from)?
    .map_err(AppError::from)
}

/// Hash fixo usado quando o usuário não existe, para que o tempo de resposta
/// não revele quais usernames são válidos.
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(b"prisma-web-dummy-password", &salt)
        .expect("hash fixo")
        .to_string()
});

pub async fn verify_password(password: String, hash: Option<String>) -> bool {
    tokio::task::spawn_blocking(move || {
        let hash = hash.unwrap_or_else(|| DUMMY_HASH.clone());
        let Ok(parsed) = PasswordHash::new(&hash) else { return false };
        Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
    })
    .await
    .unwrap_or(false)
}

pub fn validate_password(password: &str) -> AppResult<()> {
    if password.chars().count() < PASSWORD_MIN_LEN {
        return Err(AppError::BadRequest(format!(
            "a senha precisa ter pelo menos {PASSWORD_MIN_LEN} caracteres"
        )));
    }
    if password.len() > 1024 {
        return Err(AppError::BadRequest("senha longa demais".into()));
    }
    Ok(())
}

pub fn validate_username(username: &str) -> AppResult<()> {
    let ok = (3..=32).contains(&username.len())
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "usuário deve ter 3 a 32 caracteres: letras, números, '.', '_' ou '-'".into(),
        ))
    }
}

/// Cria a sessão no banco e devolve o cookie a ser enviado ao navegador.
pub async fn create_session(
    db: &PgPool,
    cfg: &Config,
    user_id: Uuid,
    meta: &ClientMeta,
) -> AppResult<(Cookie<'static>, DateTime<Utc>)> {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = URL_SAFE_NO_PAD.encode(raw);
    let expires_at = Utc::now() + cfg.session_ttl;

    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, ip, user_agent, expires_at)
         VALUES ($1, $2, $3::inet, $4, $5)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(meta.ip_string())
    .bind(&meta.user_agent)
    .bind(expires_at)
    .execute(db)
    .await?;

    let cookie = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .secure(cfg.cookie_secure)
        .same_site(SameSite::Strict)
        .max_age(cfg.session_ttl.try_into().map_err(anyhow::Error::from)?)
        .build();
    Ok((cookie, expires_at))
}

pub fn removal_cookie() -> Cookie<'static> {
    let mut c = Cookie::build((SESSION_COOKIE, "")).path("/").build();
    c.make_removal();
    c
}

/// Na primeira subida (tabela de usuários vazia), cria o administrador inicial.
pub async fn bootstrap_admin(db: &PgPool, cfg: &Config) -> anyhow::Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(db).await?;
    if count > 0 {
        return Ok(());
    }

    let (password, generated) = match &cfg.admin_password {
        Some(p) => (p.clone(), false),
        None => {
            let mut raw = [0u8; 12];
            rand::thread_rng().fill_bytes(&mut raw);
            (URL_SAFE_NO_PAD.encode(raw), true)
        }
    };
    validate_username(&cfg.admin_username).map_err(|e| anyhow::anyhow!("ADMIN_USERNAME: {e}"))?;
    validate_password(&password).map_err(|e| anyhow::anyhow!("ADMIN_PASSWORD: {e}"))?;

    let hash = hash_password(password.clone()).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, must_change_password)
         VALUES ($1, $2, 'admin', TRUE)",
    )
    .bind(&cfg.admin_username)
    .bind(hash)
    .execute(db)
    .await?;

    crate::audit::record(
        db,
        crate::audit::Entry::system("user.bootstrap", Some(&cfg.admin_username)),
    )
    .await;

    if generated {
        tracing::warn!(
            username = %cfg.admin_username,
            password = %password,
            "administrador inicial criado com senha aleatória; troque-a no primeiro acesso"
        );
    } else {
        tracing::info!(username = %cfg.admin_username, "administrador inicial criado");
    }
    Ok(())
}

pub async fn purge_expired_sessions(db: PgPool) {
    let mut tick = tokio::time::interval(Duration::from_secs(3600));
    loop {
        tick.tick().await;
        if let Err(e) = sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
            .execute(&db)
            .await
        {
            tracing::warn!(error = %e, "falha ao limpar sessões expiradas");
        }
    }
}
