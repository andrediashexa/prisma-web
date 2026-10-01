//! Registro de mudanças e eventos de segurança na tabela `audit_log`.

use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{ClientMeta, CurrentUser};

pub struct Entry<'a> {
    pub user_id: Option<Uuid>,
    pub username: Option<&'a str>,
    pub action: &'a str,
    pub target: Option<&'a str>,
    pub success: bool,
    pub ip: Option<String>,
    pub details: Value,
}

impl<'a> Entry<'a> {
    pub fn by(user: &'a CurrentUser, meta: &ClientMeta, action: &'a str) -> Self {
        Self {
            user_id: Some(user.id),
            username: Some(&user.username),
            action,
            target: None,
            success: true,
            ip: meta.ip_string(),
            details: Value::Object(Default::default()),
        }
    }

    pub fn anonymous(meta: &ClientMeta, username: Option<&'a str>, action: &'a str) -> Self {
        Self {
            user_id: None,
            username,
            action,
            target: None,
            success: true,
            ip: meta.ip_string(),
            details: Value::Object(Default::default()),
        }
    }

    pub fn system(action: &'a str, target: Option<&'a str>) -> Self {
        Self {
            user_id: None,
            username: Some("sistema"),
            action,
            target,
            success: true,
            ip: None,
            details: Value::Object(Default::default()),
        }
    }

    pub fn target(mut self, target: &'a str) -> Self {
        self.target = Some(target);
        self
    }

    pub fn failed(mut self) -> Self {
        self.success = false;
        self
    }

    pub fn details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

/// Grava o evento. Falhas são apenas logadas: auditoria nunca derruba a ação,
/// mas fica registrado em log se o banco recusar.
pub async fn record(db: &PgPool, e: Entry<'_>) {
    let res = sqlx::query(
        "INSERT INTO audit_log (user_id, username, action, target, success, ip, details)
         VALUES ($1, $2, $3, $4, $5, $6::inet, $7)",
    )
    .bind(e.user_id)
    .bind(e.username)
    .bind(e.action)
    .bind(e.target)
    .bind(e.success)
    .bind(&e.ip)
    .bind(&e.details)
    .execute(db)
    .await;
    if let Err(err) = res {
        tracing::error!(error = %err, action = e.action, "falha ao gravar auditoria");
    }
}
