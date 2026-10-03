mod audit;
mod access;
mod auth;
mod config;
mod config_model;
mod error;
mod grpc;
mod limiter;
mod registry;
mod routes;
mod telemetry;
mod tls;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::config::Config;
use crate::limiter::LoginLimiter;
use crate::registry::Registry;
use crate::routes::config::Candidates;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub routers: Arc<Registry>,
    pub candidates: Arc<Candidates>,
    pub cfg: Arc<Config>,
    pub limiter: Arc<LoginLimiter>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck();
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info,sqlx=warn".into()),
        )
        .init();

    let cfg = Arc::new(Config::from_env()?);

    let db = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&cfg.database_url)
        .await
        .context("connecting to PostgreSQL")?;
    sqlx::migrate!("./migrations").run(&db).await.context("applying migrations")?;

    auth::bootstrap_admin(&db, &cfg).await?;
    routes::routers::seed_from_env(&db, &cfg).await?;
    let routers = Arc::new(Registry::new(db.clone(), cfg.tls_dir.clone(), cfg.allow_plaintext));
    tokio::spawn(auth::purge_expired_sessions(db.clone()));
    tokio::spawn(routers.clone().monitor());

    let state = AppState {
        db,
        routers,
        candidates: Arc::new(Candidates::default()),
        limiter: Arc::new(LoginLimiter::new(cfg.login_max_failures, cfg.login_window)),
        cfg: cfg.clone(),
    };

    let app = routes::router(state);
    let listener = tokio::net::TcpListener::bind(cfg.bind_addr)
        .await
        .with_context(|| format!("binding {}", cfg.bind_addr))?;
    tracing::info!(addr = %cfg.bind_addr, "prisma-web-server listening");

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

/// Used by the container HEALTHCHECK (the image has no shell or curl).
fn healthcheck() -> anyhow::Result<()> {
    use std::io::{Read, Write};
    let port = std::env::var("BIND_ADDR")
        .ok()
        .and_then(|a| a.parse::<SocketAddr>().ok())
        .map_or(8000, |a| a.port());
    let mut s = std::net::TcpStream::connect_timeout(
        &SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
        Duration::from_secs(2),
    )?;
    s.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(s, "GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
    let mut buf = [0u8; 12];
    s.read_exact(&mut buf)?;
    anyhow::ensure!(&buf[9..12] == b"200", "unexpected status");
    Ok(())
}
