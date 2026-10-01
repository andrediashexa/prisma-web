mod audit;
mod auth;
mod dashboard;
mod router;
pub mod routers;
mod users;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, patch, post};
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
        .route("/audit", get(audit::list))
        .route("/dashboard", get(dashboard::get).put(dashboard::put).delete(dashboard::reset))
        .route("/routers", get(routers::list).post(routers::create))
        .route("/routers/status", get(routers::status))
        .route("/routers/test", post(routers::test))
        .route("/routers/{id}", get(routers::get).patch(routers::update).delete(routers::delete))
        .route("/routers/{id}/system", get(router::system))
        .route("/routers/{id}/interfaces", get(router::interfaces))
        .route("/routers/{id}/interfaces/{name}", patch(router::update_interface))
        .route("/routers/{id}/routes", get(router::routes))
        .route("/routers/{id}/metrics/traffic", get(router::traffic));

    Router::new()
        .nest("/api", api)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}
