//! The box itself (Prisma 0.149.25, #50): `SystemService`'s reboot, shutdown,
//! dataplane restart and upgrade. Each stops traffic or the box, so they are an
//! administrator's, ask for the router's name and are recorded, refused or not.
//! On the box they are root's today: prisma-web's account is refused there, in
//! the box's words.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use prisma_proto::v1::upgrade_progress::Phase;
use prisma_proto::v1::*;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::{Stream, StreamExt};
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{ClientMeta, CurrentUser, Role};
use crate::error::{AppError, AppResult};
use crate::grpc::{self, req};
use crate::AppState;

/// How long an upgrade may stream before prisma-web stops waiting (the box goes on).
const UPGRADE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// The dataplane restart answers when it has finished.
const RESTART_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ActionBody {
    /// The router's name, typed by the administrator.
    confirm: String,
    /// Past REASON_UNSAVED and REASON_CONFIRM_PENDING (reboot, shutdown).
    force: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct UpgradeBody {
    /// Empty only checks for the newest release, and then needs no confirmation.
    version: String,
    confirm: String,
}

/// Releases whose `RestartDataplane` does not work: on 0.149.25 and 0.149.26 it stops the
/// containers and never starts them again, taking the box off the network until it reboots
/// (prismarouting #564, seen on 192.0.2.198 on 2026-10-04, #51); on 0.149.27 the host
/// refuses to start the new restart unit (#53). Fixed in 0.149.28.
const RESTART_BROKEN: [(u32, u32, u32); 3] = [(0, 149, 25), (0, 149, 26), (0, 149, 27)];

fn restart_broken(release: &str) -> bool {
    super::config::release_triplet(release).is_some_and(|v| RESTART_BROKEN.contains(&v))
}

/// The router's name must be typed as it is (surrounding spaces aside).
fn confirmed(typed: &str, name: &str) -> AppResult<()> {
    if typed.trim() == name {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("type the router's name ({name}) to confirm")))
    }
}

/// `UpgradeProgress` as the page reads it: the phase by name.
fn progress_json(p: &UpgradeProgress) -> Value {
    let mut v = serde_json::to_value(p).unwrap_or(Value::Null);
    v["phase"] = json!(p.phase().as_str_name());
    v
}

/// Reboot, shutdown or dataplane restart.
pub async fn action(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path((id, what)): Path<(Uuid, String)>,
    Json(b): Json<ActionBody>,
) -> AppResult<Json<SystemActionResponse>> {
    user.require(Role::Admin)?;
    if !["reboot", "shutdown", "restart-dataplane"].contains(&what.as_str()) {
        return Err(AppError::NotFound(format!("no system action {what}")));
    }
    let r = st.routers.get(id).await?;
    confirmed(&b.confirm, &r.name)?;
    if what == "restart-dataplane" {
        let release = r.ops().get_version(req(GetVersionRequest {})).await?.into_inner().release;
        if restart_broken(&release) {
            return Err(AppError::Conflict(format!(
                "Prisma {release} cannot restart the dataplane through its API (prismarouting #564): \
                 0.149.25 and 0.149.26 leave the router off the network until it reboots, 0.149.27 refuses it. \
                 Upgrade it to 0.149.28 or later first"
            )));
        }
    }
    let msg = SystemActionRequest { force: b.force, ..Default::default() };
    let mut sys = r.system();
    let res = match what.as_str() {
        "reboot" => sys.reboot(req(msg)).await,
        "shutdown" => sys.shutdown(req(msg)).await,
        _ => sys.restart_dataplane(grpc::req_with(msg, RESTART_TIMEOUT)).await,
    };
    let action = format!("router.system.{what}");
    let lost = res.as_ref().err().is_some_and(lost_mid_call);
    let mut entry = Entry::by(&user, &meta, &action)
        .target(&r.name)
        .router(id)
        .details(json!({ "force": b.force, "connection_lost": lost }));
    if res.is_err() {
        entry = entry.failed();
    }
    if res.is_ok() && what != "restart-dataplane" {
        // The reply comes before the box goes down.
        st.routers.maintenance_begin(id, &what, None);
    } else if lost && what == "restart-dataplane" {
        // The restart answers when it has finished; a box whose management address is on a
        // dataplane interface drops off before it can (192.0.2.198, 2026-10-04, #51).
        st.routers.maintenance_begin(id, "dataplane", None);
    }
    audit::record(&st.db, entry).await;
    Ok(Json(res?.into_inner()))
}

/// The connection went away while the call ran ("Socket closed", a reset): not a refusal.
fn lost_mid_call(s: &tonic::Status) -> bool {
    matches!(s.code(), tonic::Code::Unavailable | tonic::Code::Unknown | tonic::Code::Cancelled)
}

/// The last upgrade run, read back from the box (it outlives a lost stream).
pub async fn upgrade_status(State(st): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    user.require(Role::Admin)?;
    let r = st.routers.get(id).await?;
    match r.system().get_upgrade_status(req(GetUpgradeStatusRequest {})).await {
        Ok(p) => Ok(Json(progress_json(&p.into_inner()))),
        // A box with no run through the API answers NOT_FOUND: no run, not an error (#50).
        Err(s) if s.code() == tonic::Code::NotFound => {
            Ok(Json(progress_json(&UpgradeProgress { message: s.message().to_string(), ..Default::default() })))
        }
        Err(s) => Err(s.into()),
    }
}

/// `Upgrade` as Server-Sent Events: `progress` per phase, `error` if the stream
/// breaks, `end`. The box is in maintenance from STARTED until `api_away_seconds`
/// after API_RESTART.
pub async fn upgrade(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
    Json(b): Json<UpgradeBody>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    user.require(Role::Admin)?;
    let r = st.routers.get(id).await?;
    let version = b.version.trim().to_string();
    if !version.is_empty() {
        confirmed(&b.confirm, &r.name)?;
    }
    let res = r.system().upgrade(grpc::req_with(UpgradeRequest { version: version.clone(), ..Default::default() }, UPGRADE_TIMEOUT)).await;
    let action = if version.is_empty() { "router.system.upgrade-check" } else { "router.system.upgrade" };
    let mut entry = Entry::by(&user, &meta, action).target(&r.name).router(id).details(json!({ "version": version }));
    if res.is_err() {
        entry = entry.failed();
    }
    audit::record(&st.db, entry).await;
    let stream = res?.into_inner();
    let registry = st.routers.clone();
    let events = stream.map(move |m| {
        Ok(match m {
            Ok(p) => {
                match p.phase() {
                    Phase::Started => registry.maintenance_begin(id, "upgrade", None),
                    Phase::ApiRestart => registry
                        .maintenance_until(id, chrono::Utc::now() + chrono::Duration::seconds(p.api_away_seconds.into())),
                    Phase::Failed => registry.maintenance_end(id),
                    _ => {}
                }
                Event::default().event("progress").json_data(progress_json(&p)).unwrap_or_default()
            }
            Err(s) => Event::default().event("error").data(grpc::describe(&s)),
        })
    });
    let end = tokio_stream::once(Ok(Event::default().event("end").data("done")));
    Ok(Sse::new(events.chain(end)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_must_be_typed_as_it_is() {
        assert!(confirmed(" vm-prisma-teste ", "vm-prisma-teste").is_ok());
        assert!(confirmed("vm-prisma", "vm-prisma-teste").is_err());
        assert!(confirmed("", "x").is_err());
    }

    #[test]
    fn the_releases_with_the_broken_restart_are_refused() {
        assert!(restart_broken("0.149.25") && restart_broken("0.149.26-mock") && restart_broken("0.149.27"));
        assert!(!restart_broken("0.149.28") && !restart_broken("0.149.0-mock") && !restart_broken("garbage"));
    }

    #[test]
    fn a_dropped_connection_is_not_a_refusal() {
        assert!(lost_mid_call(&tonic::Status::unavailable("Socket closed")));
        assert!(!lost_mid_call(&tonic::Status::permission_denied("root's")));
        assert!(!lost_mid_call(&tonic::Status::failed_precondition("busy")));
    }

    #[test]
    fn a_phase_reads_by_name() {
        let p = UpgradeProgress { phase: Phase::ApiRestart as i32, api_away_seconds: 60, ..Default::default() };
        let v = progress_json(&p);
        assert_eq!((v["phase"].as_str(), v["api_away_seconds"].as_u64()), (Some("API_RESTART"), Some(60)));
    }
}
