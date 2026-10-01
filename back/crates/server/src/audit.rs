//! Records changes and security events in the `audit_log` table.

use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::{ClientMeta, CurrentUser};

pub struct Entry<'a> {
    pub user_id: Option<Uuid>,
    pub username: Option<&'a str>,
    pub action: &'a str,
    pub target: Option<&'a str>,
    pub router_id: Option<Uuid>,
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
            router_id: None,
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
            router_id: None,
            success: true,
            ip: meta.ip_string(),
            details: Value::Object(Default::default()),
        }
    }

    pub fn system(action: &'a str, target: Option<&'a str>) -> Self {
        Self {
            user_id: None,
            username: Some("system"),
            action,
            target,
            router_id: None,
            success: true,
            ip: None,
            details: Value::Object(Default::default()),
        }
    }

    pub fn target(mut self, target: &'a str) -> Self {
        self.target = Some(target);
        self
    }

    pub fn router(mut self, id: Uuid) -> Self {
        self.router_id = Some(id);
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

/// Writes the event. Failures are only logged: auditing never breaks the action,
/// but a database refusal is recorded in the log.
pub async fn record(db: &PgPool, e: Entry<'_>) {
    let res = sqlx::query(
        "INSERT INTO audit_log (user_id, username, action, target, router_id, success, ip, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8)",
    )
    .bind(e.user_id)
    .bind(e.username)
    .bind(e.action)
    .bind(e.target)
    .bind(e.router_id)
    .bind(e.success)
    .bind(&e.ip)
    .bind(&e.details)
    .execute(db)
    .await;
    if let Err(err) = res {
        tracing::error!(error = %err, action = e.action, "failed to write audit entry");
    }
}
