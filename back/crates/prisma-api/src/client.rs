use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::{paths, ApiError, Interface, InterfaceUpdate, Route, SystemInfo, TrafficSeries};

#[derive(Debug, thiserror::Error)]
pub enum PrismaError {
    #[error("Prisma inacessível: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("Prisma respondeu {status}: {message}")]
    Api { status: StatusCode, message: String },
}

#[derive(Clone)]
pub struct PrismaClient {
    http: reqwest::Client,
    base_url: String,
    token: Option<String>,
}

impl PrismaClient {
    pub fn new(base_url: impl Into<String>, token: Option<String>) -> Result<Self, PrismaError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(3))
            .build()?;
        Ok(Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token,
        })
    }

    pub async fn system(&self) -> Result<SystemInfo, PrismaError> {
        self.call(Method::GET, paths::SYSTEM, None::<&()>).await
    }

    pub async fn interfaces(&self) -> Result<Vec<Interface>, PrismaError> {
        self.call(Method::GET, paths::INTERFACES, None::<&()>).await
    }

    pub async fn interface(&self, name: &str) -> Result<Interface, PrismaError> {
        let path = format!("{}/{}", paths::INTERFACES, urlencode(name));
        self.call(Method::GET, &path, None::<&()>).await
    }

    pub async fn update_interface(
        &self,
        name: &str,
        update: &InterfaceUpdate,
    ) -> Result<Interface, PrismaError> {
        let path = format!("{}/{}", paths::INTERFACES, urlencode(name));
        self.call(Method::PATCH, &path, Some(update)).await
    }

    pub async fn routes(&self) -> Result<Vec<Route>, PrismaError> {
        self.call(Method::GET, paths::ROUTES, None::<&()>).await
    }

    pub async fn traffic(&self, interface: &str, minutes: u32) -> Result<TrafficSeries, PrismaError> {
        let path = format!(
            "{}?interface={}&minutes={minutes}",
            paths::METRICS_TRAFFIC,
            urlencode(interface)
        );
        self.call(Method::GET, &path, None::<&()>).await
    }

    async fn call<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<T, PrismaError> {
        let mut req = self.http.request(method, format!("{}{}", self.base_url, path));
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        let resp = req.send().await?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp.json().await?);
        }
        let message = match resp.json::<ApiError>().await {
            Ok(e) => e.error,
            Err(_) => status.canonical_reason().unwrap_or("erro").to_string(),
        };
        Err(PrismaError::Api { status, message })
    }
}

/// Codifica um segmento de caminho/query. Nomes de interface são ASCII simples,
/// mas não confiamos nisso.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
