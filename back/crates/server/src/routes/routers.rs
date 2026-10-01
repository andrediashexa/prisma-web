//! Cadastro dos roteadores Prisma gerenciados por esta instância.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use prisma_proto::v1::operational_service_client::OperationalServiceClient;
use prisma_proto::v1::{GetVersionRequest, VersionInfo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{ClientMeta, CurrentUser, Role};
use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::grpc;
use crate::registry::{validate_api_url, RouterStatus, TlsTarget};
use crate::tls::{self, ProfileInfo};
use crate::AppState;

/// Tempo máximo para um Prisma responder ao teste de conexão.
const STATUS_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Serialize, sqlx::FromRow)]
pub struct RouterView {
    id: Uuid,
    name: String,
    api_url: String,
    description: Option<String>,
    tls_profile: Option<String>,
    tls_server_name: Option<String>,
    /// CN do certificado do perfil: a conta que o Prisma vê. Preenchido fora do SQL.
    #[sqlx(skip)]
    tls_account: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const SELECT_ROUTERS: &str = "
    SELECT id, name, api_url, description, tls_profile, tls_server_name, created_at, updated_at
      FROM routers";

fn with_account(st: &AppState, mut v: RouterView) -> RouterView {
    v.tls_account = v
        .tls_profile
        .as_deref()
        .and_then(|p| tls::check(&st.routers.tls_root, p).ok())
        .and_then(|i| i.account);
    v
}

pub async fn list(State(st): State<AppState>, _: CurrentUser) -> AppResult<Json<Vec<RouterView>>> {
    let rows = sqlx::query_as::<_, RouterView>(&format!("{SELECT_ROUTERS} ORDER BY lower(name)"))
        .fetch_all(&st.db)
        .await?;
    Ok(Json(rows.into_iter().map(|r| with_account(&st, r)).collect()))
}

pub async fn get(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<RouterView>> {
    Ok(Json(with_account(&st, fetch(&st.db, id).await?)))
}

/// Perfis TLS disponíveis no diretório montado (sem nunca expor a chave).
pub async fn tls_profiles(State(st): State<AppState>, user: CurrentUser) -> AppResult<Json<Vec<ProfileInfo>>> {
    user.require(Role::Admin)?;
    Ok(Json(tls::list(&st.routers.tls_root)))
}

/// Endereço e TLS validados juntos: `https://` exige perfil e nome do servidor;
/// `http://` (só os mocks) não aceita perfil.
struct Connection {
    url: String,
    tls: Option<(String, String)>,
}

impl Connection {
    fn parse(st: &AppState, url: &str, profile: Option<&str>, server_name: Option<&str>) -> AppResult<Self> {
        let url = validate_api_url(url)?;
        let profile = profile.map(str::trim).filter(|p| !p.is_empty());
        let server_name = server_name.map(str::trim).filter(|p| !p.is_empty());
        let tls = match (url.starts_with("https://"), profile) {
            (true, Some(p)) => {
                let info = tls::check(&st.routers.tls_root, p)?;
                if let Some(e) = info.error {
                    return Err(AppError::BadRequest(format!("perfil TLS '{p}': {e}")));
                }
                let name = tls::validate_server_name(server_name.unwrap_or("prisma-api"))?;
                Some((p.to_string(), name))
            }
            (true, None) => {
                return Err(AppError::BadRequest(
                    "https:// exige um perfil TLS (certificado do cliente) — o Prisma só aceita mTLS".into(),
                ))
            }
            (false, Some(_)) => {
                return Err(AppError::BadRequest("perfil TLS só vale com https://".into()));
            }
            (false, None) => None,
        };
        Ok(Self { url, tls })
    }

    fn target(&self) -> Option<TlsTarget<'_>> {
        self.tls.as_ref().map(|(p, n)| TlsTarget { profile: p, server_name: n })
    }
}

pub async fn status(State(st): State<AppState>, _: CurrentUser) -> AppResult<Json<Vec<RouterStatus>>> {
    Ok(Json(st.routers.fleet_status().await?))
}

#[derive(Deserialize)]
pub struct TestRequest {
    api_url: String,
    tls_profile: Option<String>,
    tls_server_name: Option<String>,
}

#[derive(Serialize)]
pub struct TestResult {
    #[serde(flatten)]
    version: VersionInfo,
    /// Conta (CN) com que o Prisma nos viu; `None` sem TLS.
    account: Option<String>,
}

/// Testa a conexão com um Prisma antes de salvar o cadastro.
pub async fn test(
    State(st): State<AppState>,
    user: CurrentUser,
    Json(req): Json<TestRequest>,
) -> AppResult<Json<TestResult>> {
    user.require(Role::Admin)?;
    let conn = Connection::parse(&st, &req.api_url, req.tls_profile.as_deref(), req.tls_server_name.as_deref())?;
    let mut client = OperationalServiceClient::new(st.routers.channel(&conn.url, conn.target())?);
    let version = tokio::time::timeout(STATUS_TIMEOUT, client.get_version(grpc::req(GetVersionRequest {})))
        .await
        .map_err(|_| AppError::BadRequest("o Prisma não respondeu a tempo".into()))?
        .map_err(|s| AppError::BadRequest(grpc::describe(&s)))?;
    let account = conn
        .tls
        .as_ref()
        .and_then(|(p, _)| tls::check(&st.routers.tls_root, p).ok())
        .and_then(|i| i.account);
    Ok(Json(TestResult { version: version.into_inner(), account }))
}

#[derive(Deserialize)]
pub struct CreateRouter {
    name: String,
    api_url: String,
    description: Option<String>,
    tls_profile: Option<String>,
    tls_server_name: Option<String>,
}

pub async fn create(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Json(req): Json<CreateRouter>,
) -> AppResult<(StatusCode, Json<RouterView>)> {
    user.require(Role::Admin)?;
    let name = validate_name(&req.name)?;
    let conn = Connection::parse(&st, &req.api_url, req.tls_profile.as_deref(), req.tls_server_name.as_deref())?;
    let description = clean_description(req.description)?;
    let id = Uuid::new_v4();
    insert(&st.db, id, &name, &conn, description.as_deref()).await?;

    audit::record(
        &st.db,
        Entry::by(&user, &meta, "router.create")
            .target(&name)
            .router(id)
            .details(json!({
                "api_url": conn.url,
                "tls_profile": conn.tls.as_ref().map(|t| &t.0),
                "tls_server_name": conn.tls.as_ref().map(|t| &t.1),
            })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(with_account(&st, fetch(&st.db, id).await?))))
}

#[derive(Deserialize)]
pub struct UpdateRouter {
    name: Option<String>,
    /// Endereço e TLS mudam juntos: com `api_url`, os campos de TLS valem como enviados.
    api_url: Option<String>,
    tls_profile: Option<String>,
    tls_server_name: Option<String>,
    description: Option<String>,
}

pub async fn update(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateRouter>,
) -> AppResult<Json<RouterView>> {
    user.require(Role::Admin)?;
    let before = fetch(&st.db, id).await?;
    let mut changes = Map::new();

    let name = req.name.map(|n| validate_name(&n)).transpose()?;
    let conn = req
        .api_url
        .as_deref()
        .map(|u| Connection::parse(&st, u, req.tls_profile.as_deref(), req.tls_server_name.as_deref()))
        .transpose()?;
    let url = conn.as_ref().map(|c| c.url.clone());
    let description = req.description.map(|d| clean_description(Some(d))).transpose()?.map(|d| d.unwrap_or_default());

    if let Some(n) = name.as_ref().filter(|n| **n != before.name) {
        changes.insert("name".into(), json!({ "from": before.name, "to": n }));
    }
    if let Some(u) = url.as_ref().filter(|u| **u != before.api_url) {
        changes.insert("api_url".into(), json!({ "from": before.api_url, "to": u }));
    }
    let new_tls = conn.as_ref().map(|c| c.tls.clone());
    if let Some(t) = &new_tls {
        let (p, n) = (t.as_ref().map(|t| &t.0), t.as_ref().map(|t| &t.1));
        if p != before.tls_profile.as_ref() {
            changes.insert("tls_profile".into(), json!({ "from": before.tls_profile, "to": p }));
        }
        if n != before.tls_server_name.as_ref() {
            changes.insert("tls_server_name".into(), json!({ "from": before.tls_server_name, "to": n }));
        }
    }
    if let Some(d) = description.as_ref().filter(|d| Some(d.as_str()).filter(|d| !d.is_empty()) != before.description.as_deref()) {
        changes.insert("description".into(), json!({ "from": before.description, "to": d }));
    }
    if changes.is_empty() {
        return Ok(Json(before));
    }

    let res = sqlx::query(
        "UPDATE routers SET
             name        = COALESCE($2, name),
             api_url     = COALESCE($3, api_url),
             description = CASE WHEN $4::text IS NULL THEN description ELSE NULLIF($4, '') END,
             tls_profile     = CASE WHEN $5 THEN $6 ELSE tls_profile END,
             tls_server_name = CASE WHEN $5 THEN $7 ELSE tls_server_name END,
             updated_at  = now()
          WHERE id = $1",
    )
    .bind(id)
    .bind(&name)
    .bind(&url)
    .bind(&description)
    .bind(new_tls.is_some())
    .bind(new_tls.as_ref().and_then(|t| t.as_ref().map(|t| t.0.clone())))
    .bind(new_tls.as_ref().and_then(|t| t.as_ref().map(|t| t.1.clone())))
    .execute(&st.db)
    .await;
    map_unique(res, name.as_deref().unwrap_or(&before.name))?;
    st.routers.invalidate(id);

    let target = name.unwrap_or(before.name);
    audit::record(
        &st.db,
        Entry::by(&user, &meta, "router.update").target(&target).router(id).details(Value::Object(changes)),
    )
    .await;
    Ok(Json(with_account(&st, fetch(&st.db, id).await?)))
}

pub async fn delete(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    user.require(Role::Admin)?;
    let before = fetch(&st.db, id).await?;
    sqlx::query("DELETE FROM routers WHERE id = $1").bind(id).execute(&st.db).await?;
    st.routers.invalidate(id);
    audit::record(
        &st.db,
        Entry::by(&user, &meta, "router.delete")
            .target(&before.name)
            .router(id)
            .details(json!({ "api_url": before.api_url })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Na primeira subida, cadastra o roteador de `PRISMA_API_URL` (se definido).
pub async fn seed_from_env(db: &PgPool, cfg: &Config) -> anyhow::Result<()> {
    let Some(raw_url) = &cfg.seed_router_url else { return Ok(()) };
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM routers").fetch_one(db).await?;
    if count > 0 {
        return Ok(());
    }
    let url = validate_api_url(raw_url).map_err(|e| anyhow::anyhow!("PRISMA_API_URL: {e}"))?;
    if url.starts_with("https://") {
        anyhow::bail!("PRISMA_API_URL só aceita http:// (mocks); cadastre um Prisma com mTLS pela interface");
    }
    let id = Uuid::new_v4();
    let name = url
        .split("://")
        .nth(1)
        .and_then(|h| h.trim_start_matches('[').split([']', ':', '/']).next())
        .filter(|h| !h.is_empty())
        .unwrap_or("prisma")
        .to_string();
    let conn = Connection { url: url.clone(), tls: None };
    insert(db, id, &name, &conn, Some("Cadastrado a partir de PRISMA_API_URL"))
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    audit::record(db, Entry::system("router.create", Some(&name)).router(id)).await;
    tracing::info!(%name, %url, "roteador inicial cadastrado");
    Ok(())
}

async fn insert(
    db: &PgPool,
    id: Uuid,
    name: &str,
    conn: &Connection,
    description: Option<&str>,
) -> AppResult<()> {
    let res = sqlx::query(
        "INSERT INTO routers (id, name, api_url, description, tls_profile, tls_server_name)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id)
    .bind(name)
    .bind(&conn.url)
    .bind(description)
    .bind(conn.tls.as_ref().map(|t| &t.0))
    .bind(conn.tls.as_ref().map(|t| &t.1))
    .execute(db)
    .await;
    map_unique(res, name)
}

fn map_unique(res: Result<sqlx::postgres::PgQueryResult, sqlx::Error>, name: &str) -> AppResult<()> {
    match res {
        Ok(_) => Ok(()),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            Err(AppError::Conflict(format!("já existe um roteador chamado '{name}'")))
        }
        Err(e) => Err(e.into()),
    }
}

async fn fetch(db: &PgPool, id: Uuid) -> AppResult<RouterView> {
    sqlx::query_as::<_, RouterView>(&format!("{SELECT_ROUTERS} WHERE id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("roteador não encontrado".into()))
}

fn validate_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 48 {
        return Err(AppError::BadRequest("o nome deve ter de 1 a 48 caracteres".into()));
    }
    Ok(name.to_string())
}

fn clean_description(d: Option<String>) -> AppResult<Option<String>> {
    let d = d.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    if d.as_ref().is_some_and(|d| d.chars().count() > 120) {
        return Err(AppError::BadRequest("a descrição deve ter no máximo 120 caracteres".into()));
    }
    Ok(d)
}
