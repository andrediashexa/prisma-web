//! Per-router access (#6). A user's global role applies to every router unless
//! a `router_access` row overrides it for one router, up or down; `none`
//! hides that router. A global administrator always has every router.

use std::collections::HashMap;

use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::Role;
use crate::error::AppResult;

/// Effective role on one router; `None` is no access.
pub fn resolve(global: Role, grant: Option<&str>) -> Option<Role> {
    if global == Role::Admin {
        return Some(Role::Admin);
    }
    match grant {
        None => Some(global),
        Some("none") => None,
        Some("viewer") => Some(Role::Viewer),
        Some("operator") => Some(Role::Operator),
        Some("admin") => Some(Role::Admin),
        // The table's CHECK allows nothing else; an unknown value grants nothing.
        Some(_) => None,
    }
}

/// The router a request path names (`…/routers/<uuid>[/…]`), if any.
pub fn router_in_path(path: &str) -> Option<Uuid> {
    let mut it = path.split('/');
    while let Some(seg) = it.next() {
        if seg == "routers" {
            return it.next().and_then(|s| s.parse().ok());
        }
    }
    None
}

pub async fn effective(db: &PgPool, user_id: Uuid, global: Role, router_id: Uuid) -> AppResult<Option<Role>> {
    if global == Role::Admin {
        return Ok(Some(Role::Admin));
    }
    let grant: Option<String> = sqlx::query_scalar("SELECT role FROM router_access WHERE user_id = $1 AND router_id = $2")
        .bind(user_id)
        .bind(router_id)
        .fetch_optional(db)
        .await?;
    Ok(resolve(global, grant.as_deref()))
}

/// The user's overrides, router by router.
pub async fn grants(db: &PgPool, user_id: Uuid) -> AppResult<HashMap<Uuid, String>> {
    let rows: Vec<(Uuid, String)> = sqlx::query_as("SELECT router_id, role FROM router_access WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_role_is_the_default_and_a_grant_overrides_it_both_ways() {
        assert_eq!(resolve(Role::Operator, None), Some(Role::Operator), "no row: as before");
        assert_eq!(resolve(Role::Viewer, Some("operator")), Some(Role::Operator), "raised on one router");
        assert_eq!(resolve(Role::Operator, Some("viewer")), Some(Role::Viewer), "lowered on one router");
        assert_eq!(resolve(Role::Operator, Some("none")), None, "hidden");
        assert_eq!(resolve(Role::Admin, Some("none")), Some(Role::Admin), "a global admin keeps every router");
    }

    #[test]
    fn the_router_comes_from_the_path() {
        let id = Uuid::new_v4();
        assert_eq!(router_in_path(&format!("/routers/{id}/config/candidates")), Some(id));
        assert_eq!(router_in_path(&format!("/api/routers/{id}")), Some(id));
        assert_eq!(router_in_path("/routers/status"), None);
        assert_eq!(router_in_path("/routers/tls-profiles"), None);
        assert_eq!(router_in_path("/users"), None);
    }
}
