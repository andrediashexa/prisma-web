//! The CGNAT log, live (Prisma 0.149.25, #49): `TelemetryService.WatchLogging`,
//! the VTY's `monitor cgnat logging`, relayed as Server-Sent Events.
//!
//! The stream says which subscriber had which public address and ports, so it
//! is an operator's and every watch is recorded with its filters. A watch ends
//! by itself after `MAX_SECONDS` (the box's `seconds`), and dropping the
//! response (the browser closing the page) cancels the gRPC stream.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use prisma_proto::v1::*;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::{Stream, StreamExt};
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{ClientMeta, CurrentUser, Role};
use crate::error::{AppError, AppResult};
use crate::AppState;

/// The longest a watch runs: a forgotten tab does not hold a stream (#49).
pub const MAX_SECONDS: u32 = 30 * 60;

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct WatchQuery {
    subscriber: String,
    public_address: String,
    port: u32,
    /// `alloc`, `release` or `exhausted`; empty is every event.
    event: String,
    pool: String,
    /// 0 (or more than `MAX_SECONDS`) is `MAX_SECONDS`.
    seconds: u32,
    raw: bool,
    no_deliveries: bool,
}

fn watch_request(q: &WatchQuery) -> Result<WatchLoggingRequest, AppError> {
    let addr = |what: &str, v: &str| -> Result<String, AppError> {
        let v = v.trim();
        if !v.is_empty() && v.parse::<std::net::IpAddr>().is_err() {
            return Err(AppError::BadRequest(format!("'{v}' is not {what}")));
        }
        Ok(v.to_string())
    };
    if q.port > 65535 {
        return Err(AppError::BadRequest(format!("{} is not a port", q.port)));
    }
    if q.port != 0 && q.public_address.trim().is_empty() {
        return Err(AppError::BadRequest("a port goes with a public address".into()));
    }
    let event = q.event.trim().to_ascii_lowercase();
    if !["", "alloc", "release", "exhausted"].contains(&event.as_str()) {
        return Err(AppError::BadRequest(format!("'{event}' is not an event (alloc, release, exhausted)")));
    }
    Ok(WatchLoggingRequest {
        subscriber: addr("a subscriber's address", &q.subscriber)?,
        public_address: addr("a public address", &q.public_address)?,
        port: q.port,
        event,
        pool: q.pool.trim().to_string(),
        seconds: if q.seconds == 0 || q.seconds > MAX_SECONDS { MAX_SECONDS } else { q.seconds },
        raw: q.raw,
        no_deliveries: q.no_deliveries,
        ..Default::default()
    })
}

/// A `LogEvent` as the page reads it: the kind by name (`ALLOC`, `LOST`, ...).
fn event_json(e: &LogEvent) -> Value {
    let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
    v["kind"] = json!(e.kind().as_str_name());
    v
}

pub async fn watch(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
    Query(q): Query<WatchQuery>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    user.require(Role::Operator)?;
    let msg = watch_request(&q)?;
    let r = st.routers.get(id).await?;
    let filters = json!({
        "subscriber": msg.subscriber, "public_address": msg.public_address, "port": msg.port,
        "event": msg.event, "pool": msg.pool, "seconds": msg.seconds, "raw": msg.raw,
    });
    let res = r.telemetry().watch_logging(crate::grpc::req_with(msg.clone(), Duration::from_secs(msg.seconds as u64 + 30))).await;
    let mut entry = Entry::by(&user, &meta, "router.log_watch").target(&r.name).router(id).details(filters);
    if res.is_err() {
        entry = entry.failed();
    }
    audit::record(&st.db, entry).await;
    // A refusal before the first event (a filter, the permission) is the call's answer, in the box's words.
    let stream = res?.into_inner();
    let events = stream.map(|m| {
        Ok(match m {
            Ok(e) => Event::default().event("log").json_data(event_json(&e)).unwrap_or_default(),
            // A stream that breaks says why, then ends.
            Err(s) => Event::default().event("error").data(crate::grpc::describe(&s)),
        })
    });
    let end = tokio_stream::once(Ok(Event::default().event("end").data("")));
    Ok(Sse::new(events.chain(end)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_watch_is_bounded_and_its_filters_checked() {
        let r = watch_request(&WatchQuery { subscriber: " 100.64.0.10 ".into(), event: "ALLOC".into(), ..Default::default() }).unwrap();
        assert_eq!((r.subscriber.as_str(), r.event.as_str(), r.seconds), ("100.64.0.10", "alloc", MAX_SECONDS));
        assert_eq!(watch_request(&WatchQuery { seconds: 5, ..Default::default() }).unwrap().seconds, 5);
        assert_eq!(watch_request(&WatchQuery { seconds: 99_999, ..Default::default() }).unwrap().seconds, MAX_SECONDS);
        assert!(watch_request(&WatchQuery { subscriber: "nope".into(), ..Default::default() }).is_err());
        assert!(watch_request(&WatchQuery { port: 40000, ..Default::default() }).is_err(), "a port needs its address");
        assert!(watch_request(&WatchQuery { event: "everything".into(), ..Default::default() }).is_err());
    }

    #[test]
    fn an_event_reads_its_kind_by_name() {
        let e = LogEvent { kind: log_event::Kind::Lost as i32, lost: 12, ..Default::default() };
        let v = event_json(&e);
        assert_eq!((v["kind"].as_str(), v["lost"].as_u64()), (Some("LOST"), Some(12)));
    }
}
