mod audit;
mod auth;
pub mod config;
mod dashboard;
mod ops;
mod route_table;
pub mod routers;
mod users;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::trace::TraceLayer;

use crate::AppState;

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/auth/password", post(auth::change_password))
        .route("/users", get(users::list).post(users::create))
        .route("/users/{id}", patch(users::update).delete(users::delete))
        .route("/users/{id}/access", get(users::access))
        .route("/users/{id}/access/{router_id}", put(users::set_access))
        .route("/audit", get(audit::list))
        .route("/dashboard", get(dashboard::get).put(dashboard::put).delete(dashboard::reset))
        .route("/routers", get(routers::list).post(routers::create))
        .route("/routers/status", get(routers::status))
        .route("/routers/test", post(routers::test))
        .route("/routers/tls-profiles", get(routers::tls_profiles))
        .route("/routers/{id}", get(routers::get).patch(routers::update).delete(routers::delete))
        // Operational data and telemetry
        .route("/routers/{id}/version", get(ops::version))
        .route("/routers/{id}/system", get(ops::system))
        .route("/routers/{id}/interfaces", get(ops::interfaces))
        .route("/routers/{id}/pools", get(ops::pools))
        .route("/routers/{id}/subscriber", get(ops::subscriber))
        .route("/routers/{id}/sessions", get(ops::sessions))
        .route("/routers/{id}/bgp", get(ops::bgp))
        .route("/routers/{id}/ospf", get(ops::ospf))
        .route("/routers/{id}/isis", get(ops::isis))
        .route("/routers/{id}/vrrp", get(ops::vrrp))
        .route("/routers/{id}/bundles", get(ops::bundles))
        .route("/routers/{id}/show", post(ops::show))
        .route("/routers/{id}/clear", post(ops::clear))
        .route("/routers/{id}/policies", get(ops::policies))
        .route("/routers/{id}/logging", get(ops::logging))
        .route("/routers/{id}/policies/counters", get(ops::policy_counters))
        .route("/routers/{id}/policies/test", post(ops::test_policy))
        .route("/routers/{id}/routes", get(route_table::list))
        .route("/routers/{id}/routes/summary", get(route_table::summary))
        .route("/routers/{id}/metrics/traffic", get(ops::traffic))
        .route("/routers/{id}/metrics/cgnat", get(ops::cgnat))
        // Configuration
        .route("/routers/{id}/config/running", get(config::running))
        .route("/routers/{id}/config/grammar", get(config::grammar))
        .route("/routers/{id}/config/tree", get(config::tree))
        .route("/routers/{id}/config/validate", post(config::validate))
        // The configuration as fields (Prisma 0.149.20/0.149.22, #46).
        .route("/routers/{id}/config/typed", get(config::typed))
        .route("/routers/{id}/config/typed/{cid}/set", post(config::typed_set))
        .route("/routers/{id}/config/typed/{cid}/delete", post(config::typed_delete))
        .route("/routers/{id}/config/revisions", get(config::revisions))
        .route("/routers/{id}/config/pending", get(config::pending))
        .route("/routers/{id}/config/confirm", post(config::confirm))
        .route("/routers/{id}/config/save", post(config::save))
        .route("/routers/{id}/config/candidates", post(config::open))
        .route("/routers/{id}/config/candidates/{cid}", get(config::show_candidate).delete(config::close))
        .route("/routers/{id}/config/candidates/{cid}/edit", post(config::edit))
        .route("/routers/{id}/config/candidates/{cid}/compare", get(config::compare))
        .route("/routers/{id}/config/candidates/{cid}/check", post(config::check))
        .route("/routers/{id}/config/candidates/{cid}/rollback", post(config::rollback))
        .route("/routers/{id}/config/candidates/{cid}/commit", post(config::commit));

    Router::new()
        .nest("/api", api)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}
