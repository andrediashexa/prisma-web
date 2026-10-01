use std::net::SocketAddr;
use std::str::FromStr;
use std::time::Duration;

use anyhow::{bail, Context};

pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    /// Raiz dos perfis TLS (montada somente leitura no container).
    pub tls_dir: std::path::PathBuf,
    /// Se definido e não houver roteadores, cadastra este como o primeiro.
    pub seed_router_url: Option<String>,
    pub session_ttl: Duration,
    /// Marca o cookie de sessão como `Secure`. Deve ser `true` quando houver HTTPS.
    pub cookie_secure: bool,
    /// Confia no `X-Forwarded-For` do proxy (Caddy) para descobrir o IP do cliente.
    pub trust_proxy: bool,
    pub admin_username: String,
    pub admin_password: Option<String>,
    pub login_max_failures: u32,
    pub login_window: Duration,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let cfg = Self {
            bind_addr: parse("BIND_ADDR", "[::]:8000")?,
            database_url: required("DATABASE_URL")?,
            tls_dir: var("PRISMA_TLS_DIR").unwrap_or_else(|| "/run/prisma-tls".into()).into(),
            seed_router_url: var("PRISMA_API_URL"),
            session_ttl: Duration::from_secs(parse::<u64>("SESSION_TTL_HOURS", "12")? * 3600),
            cookie_secure: parse("COOKIE_SECURE", "false")?,
            trust_proxy: parse("TRUST_PROXY", "true")?,
            admin_username: var("ADMIN_USERNAME").unwrap_or_else(|| "admin".into()),
            admin_password: var("ADMIN_PASSWORD"),
            login_max_failures: parse("LOGIN_MAX_FAILURES", "10")?,
            login_window: Duration::from_secs(parse::<u64>("LOGIN_WINDOW_MINUTES", "15")? * 60),
        };
        if cfg.session_ttl.is_zero() {
            bail!("SESSION_TTL_HOURS deve ser maior que zero");
        }
        Ok(cfg)
    }
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn required(name: &str) -> anyhow::Result<String> {
    var(name).with_context(|| format!("variável de ambiente {name} é obrigatória"))
}

fn parse<T: FromStr>(name: &str, default: &str) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    let raw = var(name).unwrap_or_else(|| default.to_string());
    raw.parse::<T>()
        .map_err(|e| anyhow::anyhow!("{name}='{raw}' inválido: {e}"))
}
