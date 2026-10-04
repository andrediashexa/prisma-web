//! The rest of `show cgnat` as typed screens (Prisma 0.150.3, #63): ten reads of
//! `OperationalService`, each the VTY's screen as fields with the screen in `text`.
//! The translation lookup says which subscriber used a public address and port, so
//! it is an operator's and recorded, as the live log is (#49).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::Json;
use prisma_proto::v1::*;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{ClientMeta, CurrentUser, Role};
use crate::error::{AppError, AppResult};
use crate::grpc::req;
use crate::AppState;

fn to_json<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// `LookupTranslation`'s request; what the box would refuse is a 422 here.
fn translation_request(q: &HashMap<String, String>) -> Result<LookupTranslationRequest, AppError> {
    let address = q.get("address").map(|s| s.trim()).unwrap_or_default();
    if address.parse::<std::net::IpAddr>().is_err() {
        return Err(AppError::BadRequest(format!("'{address}' is not a public address")));
    }
    let port = q.get("port").map(|s| s.trim()).unwrap_or_default();
    let port: u32 = match port.parse() {
        Ok(p) if (1..=65535).contains(&p) => p,
        _ => return Err(AppError::BadRequest(format!("'{port}' is not a port (1-65535)"))),
    };
    Ok(LookupTranslationRequest { public_address: address.to_string(), port, ..Default::default() })
}

pub async fn screen(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path((id, screen)): Path<(Uuid, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let r = st.routers.get(id).await?;
    let mut ops = r.ops();
    let v = match screen.as_str() {
        "translation" => {
            user.require(Role::Operator)?;
            let msg = translation_request(&q)?;
            let res = ops.lookup_translation(req(msg.clone())).await;
            let mut entry = Entry::by(&user, &meta, "router.translation")
                .target(&r.name)
                .router(id)
                .details(json!({ "public_address": msg.public_address, "port": msg.port }));
            if res.is_err() {
                entry = entry.failed();
            }
            audit::record(&st.db, entry).await;
            let t = res?.into_inner();
            let mut v = to_json(&t);
            v["source"] = json!(t.source().as_str_name().trim_start_matches("SOURCE_"));
            v
        }
        "top" => {
            let count = q.get("count").and_then(|c| c.parse().ok()).unwrap_or(0);
            to_json(&ops.list_top(req(ListTopRequest { count, ..Default::default() })).await?.into_inner())
        }
        "drops" => to_json(&ops.get_drops(req(GetDropsRequest {})).await?.into_inner()),
        "memory" => to_json(&ops.get_cgnat_memory(req(GetCgnatMemoryRequest {})).await?.into_inner()),
        "blocks" => to_json(&ops.list_blocks(req(ListBlocksRequest {})).await?.into_inner()),
        "identity" => to_json(&ops.get_identity(req(GetIdentityRequest {})).await?.into_inner()),
        "history" => {
            let h = ops.verify_history(req(VerifyHistoryRequest {})).await?.into_inner();
            let mut v = to_json(&h);
            v["verdict"] = json!(h.verdict().as_str_name().trim_start_matches("VERDICT_"));
            v
        }
        "algs" => to_json(&ops.list_algs(req(ListAlgsRequest {})).await?.into_inner()),
        "forwards" => {
            let pool = q.get("pool").map(|p| p.trim().to_string()).unwrap_or_default();
            to_json(&ops.list_forwards(req(ListForwardsRequest { pool, ..Default::default() })).await?.into_inner())
        }
        "ha" => to_json(&ops.get_ha_status(req(GetHaStatusRequest {})).await?.into_inner()),
        s => return Err(AppError::NotFound(format!("no CGNAT screen {s}"))),
    };
    Ok(Json(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_lookup_needs_a_public_address_and_a_port() {
        let r = translation_request(&q(&[("address", " 203.0.113.7 "), ("port", "40000")])).unwrap();
        assert_eq!((r.public_address.as_str(), r.port), ("203.0.113.7", 40000));
        assert!(translation_request(&q(&[("address", "nope"), ("port", "1")])).is_err());
        assert!(translation_request(&q(&[("address", "203.0.113.7"), ("port", "0")])).is_err());
        assert!(translation_request(&q(&[("address", "203.0.113.7")])).is_err());
    }

    #[test]
    fn enums_read_by_name() {
        let t = Translation { source: translation::Source::Dynamic as i32, ..Default::default() };
        assert_eq!(t.source().as_str_name().trim_start_matches("SOURCE_"), "DYNAMIC");
        let h = HistoryVerification { verdict: history_verification::Verdict::Intact as i32, ..Default::default() };
        assert_eq!(h.verdict().as_str_name().trim_start_matches("VERDICT_"), "INTACT");
    }
}
