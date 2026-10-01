use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use prisma_proto::v1::Diagnostics;
use tonic::Code;
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
    #[error("{0}")]
    Prisma(Box<tonic::Status>),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<tonic::Status> for AppError {
    fn from(s: tonic::Status) -> Self {
        Self::Prisma(Box::new(s))
    }
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
            // Recusas do VTY voltam para o usuário com o relato do próprio VTY.
            Self::Prisma(s) => match s.code() {
                Code::InvalidArgument => (StatusCode::UNPROCESSABLE_ENTITY, "router_rejected"),
                Code::FailedPrecondition => (StatusCode::CONFLICT, "router_refused"),
                Code::NotFound => (StatusCode::NOT_FOUND, "router_not_found"),
                Code::PermissionDenied => (StatusCode::FORBIDDEN, "router_forbidden"),
                Code::DeadlineExceeded => (StatusCode::GATEWAY_TIMEOUT, "router_timeout"),
                _ => (StatusCode::BAD_GATEWAY, "router_unavailable"),
            },
            Self::Db(_) | Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        let diagnostics: Option<Diagnostics> = match &self {
            Self::Prisma(s) => prisma_proto::diagnostics(s),
            _ => None,
        };
        let message = match &self {
            Self::Db(e) => {
                tracing::error!(error = %e, "erro de banco");
                "erro interno".to_string()
            }
            Self::Internal(e) => {
                tracing::error!(error = ?e, "erro interno");
                "erro interno".to_string()
            }
            Self::Prisma(s) => {
                if matches!(s.code(), Code::Unavailable | Code::Unknown | Code::Internal) {
                    tracing::warn!(code = ?s.code(), error = %s.message(), "falha ao falar com o Prisma");
                }
                crate::grpc::describe(s)
            }
            other => other.to_string(),
        };
        let body = json!({ "error": { "code": code, "message": message, "diagnostics": diagnostics } });
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use prisma_proto::v1::{diagnostic::Severity, Diagnostic, Diagnostics};

    use super::*;

    #[tokio::test]
    async fn vty_refusal_reaches_the_client_with_its_diagnostics() {
        let diag = Diagnostics {
            items: vec![Diagnostic {
                severity: Severity::Error as i32,
                message: "mtu must be between 1280 and 9216".into(),
                path: vec!["interface lan0".into()],
                line: "mtu 1000".into(),
            }],
            output: "error: mtu must be between 1280 and 9216".into(),
        };
        let status = prisma_proto::with_diagnostics(tonic::Status::invalid_argument("refused"), &diag);
        let resp = AppError::from(status).into_response();
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"]["code"], "router_rejected");
        let item = &v["error"]["diagnostics"]["items"][0];
        assert_eq!(item["severity"], "error");
        assert_eq!(item["line"], "mtu 1000");
        assert_eq!(item["path"][0], "interface lan0");
    }

    #[test]
    fn grpc_codes_map_to_http() {
        let code = |s: tonic::Status| AppError::from(s).status_and_code();
        assert_eq!(code(tonic::Status::failed_precondition("x")).0, StatusCode::CONFLICT);
        assert_eq!(code(tonic::Status::unavailable("x")).0, StatusCode::BAD_GATEWAY);
        assert_eq!(code(tonic::Status::deadline_exceeded("x")).0, StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(code(tonic::Status::permission_denied("x")).0, StatusCode::FORBIDDEN);
    }
}
