//! Cadastro de roteadores Prisma e cache dos clientes HTTP de cada um.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use prisma_api::{PrismaClient, SystemInfo};
use serde::Serialize;
use tokio::task::JoinSet;
use sqlx::PgPool;
use uuid::Uuid;

use crate::crypto::SecretBox;
use crate::error::{AppError, AppResult};

pub struct RouterHandle {
    pub id: Uuid,
    pub name: String,
    pub client: PrismaClient,
}

/// Intervalo do monitor da frota e tempo máximo de resposta de cada Prisma.
const MONITOR_INTERVAL: Duration = Duration::from_secs(5);
const STATUS_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone, Serialize)]
pub struct RouterStatus {
    pub id: Uuid,
    pub name: String,
    pub online: bool,
    pub system: Option<SystemInfo>,
    pub error: Option<String>,
    pub latency_ms: Option<u64>,
    pub checked_at: chrono::DateTime<chrono::Utc>,
}

pub struct Registry {
    db: PgPool,
    pub secrets: SecretBox,
    cache: RwLock<HashMap<Uuid, Arc<RouterHandle>>>,
    status: RwLock<HashMap<Uuid, RouterStatus>>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: Uuid,
    name: String,
    api_url: String,
    token_enc: Option<Vec<u8>>,
}

impl Registry {
    pub fn new(db: PgPool, secrets: SecretBox) -> Self {
        Self { db, secrets, cache: RwLock::new(HashMap::new()), status: RwLock::new(HashMap::new()) }
    }

    pub async fn get(&self, id: Uuid) -> AppResult<Arc<RouterHandle>> {
        if let Some(h) = self.cache.read().unwrap().get(&id) {
            return Ok(h.clone());
        }
        let row = sqlx::query_as::<_, Row>("SELECT id, name, api_url, token_enc FROM routers WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.db)
            .await?
            .ok_or_else(|| AppError::NotFound("roteador não encontrado".into()))?;
        let handle = Arc::new(self.build(row)?);
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

    pub fn invalidate(&self, id: Uuid) {
        self.cache.write().unwrap().remove(&id);
        self.status.write().unwrap().remove(&id);
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
                let res = tokio::time::timeout(STATUS_TIMEOUT, h.client.system()).await;
                let latency = started.elapsed().as_millis() as u64;
                let (system, error) = match res {
                    Ok(Ok(s)) => (Some(s), None),
                    Ok(Err(e)) => (None, Some(e.to_string())),
                    Err(_) => (None, Some("tempo esgotado".to_string())),
                };
                let online = system.is_some();
                RouterStatus {
                    id: h.id,
                    name: h.name.clone(),
                    online,
                    system,
                    error,
                    latency_ms: online.then_some(latency),
                    checked_at: chrono::Utc::now(),
                }
            });
        }
        for st in set.join_all().await {
            self.status.write().unwrap().insert(st.id, st);
        }
    }

    /// Mantém o status da frota atualizado em segundo plano, para a interface
    /// nunca esperar por um roteador lento ou fora do ar.
    pub async fn monitor(self: Arc<Self>) {
        let mut tick = tokio::time::interval(MONITOR_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            match self.all().await {
                Ok(handles) => {
                    let ids: Vec<Uuid> = handles.iter().map(|h| h.id).collect();
                    self.poll(handles).await;
                    // Descarta status de roteadores removidos.
                    self.status.write().unwrap().retain(|id, _| ids.contains(id));
                }
                Err(e) => tracing::warn!(error = %e, "monitor da frota falhou"),
            }
        }
    }

    pub fn client_for(&self, api_url: &str, token: Option<String>) -> AppResult<PrismaClient> {
        Ok(PrismaClient::new(api_url, token).map_err(anyhow::Error::from)?)
    }

    fn build(&self, row: Row) -> AppResult<RouterHandle> {
        let token = row
            .token_enc
            .map(|enc| self.secrets.decrypt(&enc, row.id.as_bytes()))
            .transpose()?;
        Ok(RouterHandle { id: row.id, name: row.name, client: self.client_for(&row.api_url, token)? })
    }
}

/// Valida a URL base da API de um Prisma. Aceita IPv6 entre colchetes.
pub fn validate_api_url(raw: &str) -> AppResult<String> {
    let url = raw.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or_else(|| AppError::BadRequest("a URL deve começar com http:// ou https://".into()))?;
    let authority = rest.split('/').next().unwrap_or_default();
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
                "endereços IPv6 precisam estar entre colchetes: http://[2001:db8::1]:8080".into(),
            ));
        }
        let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
        if !port.is_empty() && !valid_port(port) {
            return Err(AppError::BadRequest("porta inválida".into()));
        }
        host
    };
    if host.is_empty() || authority.contains('@') {
        return Err(AppError::BadRequest("URL sem host válido".into()));
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
            "http://prisma-mock:8080",
            "https://router.example.com/",
            "http://192.0.2.1:8080",
            "http://[2001:db8::1]:8080",
            "http://[fd00::1]",
        ] {
            assert!(v(ok).is_ok(), "{ok}");
        }
        assert_eq!(v("http://x:1/").unwrap(), "http://x:1");
    }

    #[test]
    fn rejects_bad_urls() {
        for bad in [
            "ftp://x",
            "prisma:8080",
            "http://2001:db8::1:8080",
            "http://[2001:db8::zz]:80",
            "http://[2001:db8::1]:99999",
            "http://user@host",
            "http://",
        ] {
            assert!(v(bad).is_err(), "{bad}");
        }
    }
}
