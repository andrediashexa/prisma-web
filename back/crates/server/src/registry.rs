//! Cadastro de roteadores Prisma, canais gRPC de cada um e monitor da frota.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use prisma_proto::v1::config_service_client::ConfigServiceClient;
use prisma_proto::v1::operational_service_client::OperationalServiceClient;
use prisma_proto::v1::telemetry_service_client::TelemetryServiceClient;
use prisma_proto::v1::{
    GetSessionsSummaryRequest, GetSystemRequest, GetVersionRequest, SessionsSummary, SystemInfo, VersionInfo,
};
use serde::Serialize;
use sqlx::PgPool;
use tokio::task::JoinSet;
use tonic::transport::{Channel, Endpoint};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::grpc;
use crate::telemetry::Telemetry;
use crate::tls;

/// Intervalo do monitor da frota e tempo máximo de resposta de cada Prisma.
const MONITOR_INTERVAL: Duration = Duration::from_secs(5);
const STATUS_TIMEOUT: Duration = Duration::from_secs(4);

pub struct RouterHandle {
    pub id: Uuid,
    pub name: String,
    pub api_url: String,
    channel: Channel,
}

impl RouterHandle {
    pub fn ops(&self) -> OperationalServiceClient<Channel> {
        OperationalServiceClient::new(self.channel.clone())
    }

    pub fn config(&self) -> ConfigServiceClient<Channel> {
        ConfigServiceClient::new(self.channel.clone())
    }

    pub fn telemetry(&self) -> TelemetryServiceClient<Channel> {
        TelemetryServiceClient::new(self.channel.clone())
    }
}

#[derive(Clone, Serialize)]
pub struct RouterStatus {
    pub id: Uuid,
    pub name: String,
    pub online: bool,
    pub version: Option<VersionInfo>,
    pub system: Option<SystemInfo>,
    pub sessions: Option<SessionsSummary>,
    pub error: Option<String>,
    pub latency_ms: Option<u64>,
    pub checked_at: chrono::DateTime<chrono::Utc>,
}

pub struct Registry {
    db: PgPool,
    /// Raiz dos perfis TLS montados no container (`PRISMA_TLS_DIR`).
    pub tls_root: PathBuf,
    pub telemetry: Telemetry,
    cache: RwLock<HashMap<Uuid, Arc<RouterHandle>>>,
    status: RwLock<HashMap<Uuid, RouterStatus>>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: Uuid,
    name: String,
    api_url: String,
    tls_profile: Option<String>,
    tls_server_name: Option<String>,
}

/// Perfil TLS e nome do servidor de um roteador acessado por `https://`.
pub struct TlsTarget<'a> {
    pub profile: &'a str,
    pub server_name: &'a str,
}

impl Registry {
    pub fn new(db: PgPool, tls_root: PathBuf) -> Self {
        Self {
            telemetry: Telemetry::new(db.clone()),
            tls_root,
            db,
            cache: RwLock::new(HashMap::new()),
            status: RwLock::new(HashMap::new()),
        }
    }

    pub async fn get(&self, id: Uuid) -> AppResult<Arc<RouterHandle>> {
        if let Some(h) = self.cache.read().unwrap().get(&id) {
            return Ok(h.clone());
        }
        let row = sqlx::query_as::<_, Row>(
            "SELECT id, name, api_url, tls_profile, tls_server_name FROM routers WHERE id = $1",
        )
            .bind(id)
            .fetch_optional(&self.db)
            .await?
            .ok_or_else(|| AppError::NotFound("roteador não encontrado".into()))?;
        let tls = row
            .tls_profile
            .as_deref()
            .zip(row.tls_server_name.as_deref())
            .map(|(profile, server_name)| TlsTarget { profile, server_name });
        let handle = Arc::new(RouterHandle {
            channel: self.channel(&row.api_url, tls)?,
            id: row.id,
            name: row.name,
            api_url: row.api_url,
        });
        self.cache.write().unwrap().insert(id, handle.clone());
        Ok(handle)
    }

    /// Todos os roteadores cadastrados, em ordem de nome.
    pub async fn all(&self) -> AppResult<Vec<Arc<RouterHandle>>> {
        let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM routers ORDER BY lower(name)")
            .fetch_all(&self.db)
            .await?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            out.push(self.get(id).await?);
        }
        Ok(out)
    }

    /// Chamado ao editar ou remover um roteador: descarta canal, status e coletor.
    pub fn invalidate(&self, id: Uuid) {
        self.cache.write().unwrap().remove(&id);
        self.status.write().unwrap().remove(&id);
        self.telemetry.stop(id);
    }

    /// Status de todos os roteadores. Usa o cache do monitor; quem ainda não
    /// tem status (recém-cadastrado) é consultado agora.
    pub async fn fleet_status(&self) -> AppResult<Vec<RouterStatus>> {
        let handles = self.all().await?;
        let missing: Vec<_> = {
            let cache = self.status.read().unwrap();
            handles.iter().filter(|h| !cache.contains_key(&h.id)).cloned().collect()
        };
        self.poll(missing).await;
        let cache = self.status.read().unwrap();
        Ok(handles.iter().filter_map(|h| cache.get(&h.id).cloned()).collect())
    }

    /// Consulta os roteadores em paralelo e atualiza o cache de status.
    async fn poll(&self, handles: Vec<Arc<RouterHandle>>) {
        let mut set = JoinSet::new();
        for h in handles {
            set.spawn(async move {
                let started = Instant::now();
                let res = tokio::time::timeout(STATUS_TIMEOUT, async {
                    let (mut a, mut b, mut c) = (h.ops(), h.ops(), h.ops());
                    tokio::try_join!(
                        a.get_version(GetVersionRequest {}),
                        b.get_system(GetSystemRequest {}),
                        c.get_sessions_summary(GetSessionsSummaryRequest {}),
                    )
                })
                .await;
                let latency = started.elapsed().as_millis() as u64;
                let mut st = RouterStatus {
                    id: h.id,
                    name: h.name.clone(),
                    online: false,
                    version: None,
                    system: None,
                    sessions: None,
                    error: None,
                    latency_ms: None,
                    checked_at: chrono::Utc::now(),
                };
                match res {
                    Ok(Ok((v, s, ss))) => {
                        st.online = true;
                        st.latency_ms = Some(latency);
                        st.version = Some(v.into_inner());
                        st.system = Some(s.into_inner());
                        st.sessions = Some(ss.into_inner());
                    }
                    Ok(Err(status)) => st.error = Some(grpc::describe(&status)),
                    Err(_) => st.error = Some("tempo esgotado".into()),
                }
                st
            });
        }
        for st in set.join_all().await {
            self.status.write().unwrap().insert(st.id, st);
        }
    }

    /// Mantém o status da frota e os coletores de telemetria em dia, para a
    /// interface nunca esperar por um roteador lento ou fora do ar.
    pub async fn monitor(self: Arc<Self>) {
        let mut tick = tokio::time::interval(MONITOR_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            match self.all().await {
                Ok(handles) => {
                    let ids: Vec<Uuid> = handles.iter().map(|h| h.id).collect();
                    for h in &handles {
                        self.telemetry.ensure(h.clone());
                    }
                    self.telemetry.retain(&ids);
                    self.poll(handles).await;
                    self.status.write().unwrap().retain(|id, _| ids.contains(id));
                }
                Err(e) => tracing::warn!(error = %e, "monitor da frota falhou"),
            }
        }
    }
}

impl Registry {
    /// Canal gRPC preguiçoso: conecta na primeira chamada e reconecta sozinho.
    /// Com `tls`, faz mTLS com o perfil e confere o nome do servidor.
    pub fn channel(&self, url: &str, tls: Option<TlsTarget>) -> AppResult<Channel> {
        let mut endpoint = Endpoint::from_shared(url.to_string())
            .map_err(|e| AppError::BadRequest(format!("endereço inválido: {e}")))?
            .connect_timeout(Duration::from_secs(3))
            .http2_keep_alive_interval(Duration::from_secs(30))
            .keep_alive_while_idle(true);
        if let Some(t) = tls {
            let cfg = tls::client_config(&self.tls_root, t.profile, t.server_name)?;
            endpoint = endpoint
                .tls_config(cfg)
                .map_err(|e| AppError::BadRequest(format!("configuração TLS inválida: {e}")))?;
        }
        Ok(endpoint.connect_lazy())
    }
}

/// Valida o endereço gRPC de um Prisma. Aceita IPv6 entre colchetes.
pub fn validate_api_url(raw: &str) -> AppResult<String> {
    let url = raw.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| AppError::BadRequest("o endereço deve começar com https:// (mTLS) ou http:// (só mocks)".into()))?;
    if rest.contains('/') {
        return Err(AppError::BadRequest("informe só host e porta, sem caminho: http://host:50051".into()));
    }
    let authority = rest;
    let host = if let Some(v6) = authority.strip_prefix('[') {
        let (addr, after) = v6
            .split_once(']')
            .ok_or_else(|| AppError::BadRequest("endereço IPv6 sem ']' de fechamento".into()))?;
        addr.parse::<std::net::Ipv6Addr>()
            .map_err(|_| AppError::BadRequest(format!("IPv6 inválido: {addr}")))?;
        if !(after.is_empty() || after.strip_prefix(':').is_some_and(valid_port)) {
            return Err(AppError::BadRequest("porta inválida".into()));
        }
        addr
    } else {
        if authority.matches(':').count() > 1 {
            return Err(AppError::BadRequest(
                "endereços IPv6 precisam estar entre colchetes: http://[2001:db8::1]:50051".into(),
            ));
        }
        let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
        if !port.is_empty() && !valid_port(port) {
            return Err(AppError::BadRequest("porta inválida".into()));
        }
        host
    };
    if host.is_empty() || authority.contains('@') {
        return Err(AppError::BadRequest("endereço sem host válido".into()));
    }
    Ok(url.to_string())
}

fn valid_port(p: &str) -> bool {
    p.parse::<u16>().is_ok_and(|n| n > 0)
}

#[cfg(test)]
mod tests {
    use super::validate_api_url as v;

    #[test]
    fn accepts_v4_v6_and_names() {
        for ok in [
            "http://prisma-mock:50051",
            "http://192.0.2.1:50051",
            "http://[2001:db8::1]:50051",
            "http://[fd00::1]",
            "https://192.0.2.166:50051",
            "https://[2001:db8::1]:50051",
        ] {
            assert!(v(ok).is_ok(), "{ok}");
        }
        assert_eq!(v("http://x:1/").unwrap(), "http://x:1");
    }

    #[test]
    fn rejects_bad_urls() {
        for bad in [
            "ftp://x",
            "prisma:50051",
            "http://x:1/v1",
            "http://2001:db8::1:50051",
            "http://[2001:db8::zz]:80",
            "http://[2001:db8::1]:99999",
            "http://user@host",
            "http://",
        ] {
            assert!(v(bad).is_err(), "{bad}");
        }
    }
}
