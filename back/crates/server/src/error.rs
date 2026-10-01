use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use prisma_api::PrismaError;
use serde_json::json;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("não autenticado")]
    Unauthorized,
    #[error("sem permissão para esta ação")]
    Forbidden,
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("muitas tentativas; tente novamente em {0} minuto(s)")]
    TooManyAttempts(u64),
    #[error(transparent)]
    Prisma(#[from] PrismaError),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            Self::BadRequest(_) => (StatusCode::UNPROCESSABLE_ENTITY, "invalid"),
            Self::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Self::TooManyAttempts(_) => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            // Erros de validação do Prisma voltam para o usuário como estão.
            Self::Prisma(PrismaError::Api { status, .. }) if status.is_client_error() => {
                (StatusCode::UNPROCESSABLE_ENTITY, "router_rejected")
            }
            Self::Prisma(_) => (StatusCode::BAD_GATEWAY, "router_unavailable"),
            Self::Db(_) | Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        let message = match &self {
            Self::Db(e) => {
                tracing::error!(error = %e, "erro de banco");
                "erro interno".to_string()
            }
            Self::Internal(e) => {
                tracing::error!(error = ?e, "erro interno");
                "erro interno".to_string()
            }
            Self::Prisma(PrismaError::Api { message, .. }) => message.clone(),
            Self::Prisma(e) => {
                tracing::warn!(error = %e, "falha ao falar com o Prisma");
                "não foi possível falar com o Prisma".to_string()
            }
            other => other.to_string(),
        };
        (status, Json(json!({ "error": { "code": code, "message": message } }))).into_response()
    }
}
