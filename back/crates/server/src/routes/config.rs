//! Configuration of each Prisma through the VTY model (`ConfigService`):
//! candidate → edit → compare → check → commit [confirmed] → confirm.
//!
//! Prisma sees a single account for the whole web UI, so the ownership of each
//! candidate (which web user opened it) is tracked here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use prisma_proto::v1::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::auth::{ClientMeta, CurrentUser, Role};
use crate::error::{AppError, AppResult};
use crate::grpc::req;
use crate::registry::RouterHandle;
use crate::telemetry::PendingConfirm;
use prisma_proto::v1::diagnostics::Reason;
use crate::AppState;

/// A candidate idle for longer than this is treated as expired. Prisma closes
/// one nobody has touched for 30 minutes; 25 leaves room for a slow last call (#11).
const CANDIDATE_IDLE: Duration = Duration::from_secs(25 * 60);
const EXPIRED: &str = "this change sat idle for over 25 minutes and Prisma closed it; open a new change to apply the lines again";
/// Maximum size of the diff kept in the change log.
const MAX_DIFF_LOG: usize = 20_000;

struct Owner {
    router_id: Uuid,
    user_id: Uuid,
    /// Last call that named the candidate: idleness counts from here, not from opening.
    last_used: Instant,
    /// Revision of the running configuration the candidate was opened from.
    base_revision: String,
    /// When the box closes it, and its idle rule (Prisma 0.149.18); `None`
    /// on an older box, where the 25-minute rule applies (#37).
    expires_at: Option<DateTime<Utc>>,
    idle: Option<Duration>,
}

impl Owner {
    /// By the box's `expires_at` when it gives one (a few seconds early, so a
    /// slow call does not land after it); otherwise 25 idle minutes (#11).
    fn is_expired(&self, now: DateTime<Utc>) -> bool {
        match self.expires_at {
            Some(t) => now + chrono::Duration::seconds(5) >= t,
            None => self.last_used.elapsed() > CANDIDATE_IDLE,
        }
    }
}

#[derive(Default)]
pub struct Candidates(Mutex<HashMap<String, Owner>>);

impl Candidates {
    /// The candidate belongs to this user on this router, and is not idle;
    /// counts as its last use.
    fn check(&self, router_id: Uuid, cid: &str, user: &CurrentUser) -> AppResult<()> {
        let mut map = self.0.lock().unwrap();
        match map.get_mut(cid) {
            Some(o) if o.router_id == router_id && o.user_id == user.id => {
                if o.is_expired(Utc::now()) {
                    map.remove(cid);
                    return Err(AppError::Expired(EXPIRED.into()));
                }
                o.last_used = Instant::now();
                // Every call naming the candidate moves the box's expiry too.
                if let Some(idle) = o.idle {
                    o.expires_at = Some(Utc::now() + chrono::Duration::from_std(idle).unwrap_or_default());
                }
                Ok(())
            }
            Some(o) if o.router_id == router_id => {
                Err(AppError::Conflict("this candidate was opened by another user".into()))
            }
            _ => Err(AppError::NotFound("candidate not found; open a new change".into())),
        }
    }

    /// The box's own expiry after an Edit (Prisma 0.149.18).
    fn set_expiry(&self, cid: &str, expires_at: Option<DateTime<Utc>>) {
        if let (Some(o), Some(t)) = (self.0.lock().unwrap().get_mut(cid), expires_at) {
            o.expires_at = Some(t);
        }
    }

    fn base_revision(&self, cid: &str) -> Option<String> {
        self.0.lock().unwrap().get(cid).map(|o| o.base_revision.clone())
    }

    fn forget(&self, cid: &str) {
        self.0.lock().unwrap().remove(cid);
    }

    /// Removes and returns the expired candidates, so they can be closed on Prisma.
    fn expired(&self) -> Vec<(Uuid, String)> {
        let mut map = self.0.lock().unwrap();
        let old: Vec<(Uuid, String)> = map
            .iter()
            .filter(|(_, o)| o.is_expired(Utc::now()))
            .map(|(cid, o)| (o.router_id, cid.clone()))
            .collect();
        for (_, cid) in &old {
            map.remove(cid);
        }
        old
    }
}

const STALE: &str = "the running configuration changed since this change was opened; reopen it and apply the same lines again on top of the new configuration, then review the new diff";

/// A FAILED_PRECONDITION commit whose candidate was opened from a revision
/// that is no longer the running one, with no commit confirmed pending (that
/// refusal has its own reason): the base moved under the change (#10).
fn is_stale(base: Option<&str>, running: Option<&str>, pending: bool) -> bool {
    match (base, running) {
        (Some(b), Some(r)) => !pending && !b.is_empty() && !r.is_empty() && b != r,
        _ => false,
    }
}

/// The release that stops `logging syslog disable` on a never-enabled syslog
/// from stopping the dataplane (docs/clients.md, 0.149.8).
const SYSLOG_DISABLE_FIXED: (u32, u32, u32) = (0, 149, 8);

fn adds_syslog_disable(diff: &str) -> bool {
    diff.lines().any(|l| l.strip_prefix('+').is_some_and(|l| l.trim() == "logging syslog disable"))
}

/// The change disables syslog, the running configuration has no syslog
/// collector to disable, and the box predates the fix (#31). Before 0.149.8
/// that closes the dataplane's stdin and the next operation stops it.
fn syslog_disable_hazard(release: &str, running: &str, diff: &str) -> bool {
    let enabled = running.lines().any(|l| {
        let l = l.trim();
        l.starts_with("logging syslog ") && l != "logging syslog disable"
    });
    adds_syslog_disable(diff) && !enabled && release_triplet(release).is_some_and(|v| v < SYSLOG_DISABLE_FIXED)
}

/// `0.149.4`, `0.149.0-mock` → (0, 149, 4); anything else is unknown and not refused.
pub(crate) fn release_triplet(release: &str) -> Option<(u32, u32, u32)> {
    let core = release.trim().trim_start_matches('v').split(['-', '+', ' ']).next()?;
    let mut it = core.split('.').map(|n| n.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

/// Prisma answers NOT_FOUND for a candidate it closed (idle, or restarted):
/// the user gets the reason instead of "not found" (#11).
fn gone<'a>(st: &'a AppState, cid: &'a str) -> impl FnOnce(tonic::Status) -> AppError + 'a {
    let candidates = &st.candidates;
    move |s| {
        if s.code() != tonic::Code::NotFound {
            return s.into();
        }
        candidates.forget(cid);
        match reason_of(&s) {
            // Closed by a CloseCandidate, or never this account's: not an expiry (#37).
            Some(Reason::CandidateUnknown) => AppError::NotFound("candidate not found; open a new change".into()),
            // REASON_CANDIDATE_EXPIRED, or a box before 0.149.18 that gives no reason.
            _ => AppError::Expired(EXPIRED.into()),
        }
    }
}

/// The refusal's code (Prisma 0.149.18); `None` from an older box.
fn reason_of(s: &tonic::Status) -> Option<Reason> {
    prisma_proto::diagnostics(s)
        .and_then(|d| Reason::try_from(d.reason).ok())
        .filter(|r| *r != Reason::Unspecified)
}

/// Stale from the reason when the box gives one; `None` to decide the old way (#10).
fn stale_from_reason(reason: Option<Reason>) -> Option<bool> {
    reason.map(|r| r == Reason::StaleBase)
}

fn ts(t: Option<prost_types::Timestamp>) -> Option<DateTime<Utc>> {
    t.and_then(|t| DateTime::from_timestamp(t.seconds, t.nanos.max(0) as u32))
}

fn cref(cid: &str) -> CandidateRef {
    CandidateRef { candidate_id: cid.to_string(), ..Default::default() }
}

pub async fn running(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<ConfigText>> {
    let r = st.routers.get(id).await?;
    Ok(Json(r.config().get_running(crate::grpc::req_with(GetRunningRequest {}, crate::grpc::RUNNING_TIMEOUT)).await?.into_inner()))
}

pub async fn revisions(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListRevisionsResponse>> {
    let r = st.routers.get(id).await?;
    Ok(Json(r.config().list_revisions(req(ListRevisionsRequest {})).await?.into_inner()))
}

#[derive(Serialize)]
pub struct Pending {
    pending: Option<PendingView>,
}

#[derive(Serialize)]
pub struct PendingView {
    #[serde(flatten)]
    inner: PendingConfirm,
    /// Whether the viewer can confirm.
    can_confirm: bool,
}

pub async fn pending(State(st): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Pending>> {
    let r = st.routers.get(id).await?;
    let pending = current_pending(&st, &r).await.map(|p| PendingView {
        can_confirm: can_confirm(&p, &user),
        inner: p,
    });
    Ok(Json(Pending { pending }))
}

/// The `commit confirmed` window: from the box (GetPendingConfirm, Prisma
/// 0.149.18), so it survives a restart of this server; from memory on an
/// older box (#37).
async fn current_pending(st: &AppState, r: &RouterHandle) -> Option<PendingConfirm> {
    match r.config().get_pending_confirm(req(GetPendingConfirmRequest {})).await {
        Ok(resp) => {
            let p = resp.into_inner();
            if !p.pending {
                st.routers.telemetry.set_pending(r.id, None);
                return None;
            }
            let web = web_user(&p.comment);
            let user_id = match web {
                Some(name) => sqlx::query_scalar("SELECT id FROM users WHERE username = $1").bind(name).fetch_optional(&st.db).await.ok().flatten(),
                None => None,
            };
            Some(PendingConfirm {
                deadline: ts(p.deadline),
                by: web.map(str::to_string).unwrap_or(p.account),
                user_id,
                revision: Some(p.revision).filter(|r| !r.is_empty()),
                overdue: p.overdue,
                revert_attempts: p.revert_attempts,
                source: "box",
            })
        }
        Err(_) => st.routers.telemetry.pending(r.id),
    }
}

/// The web user a commit was made by: its comment starts `[prisma-web:<user>]`.
fn web_user(comment: &str) -> Option<&str> {
    comment.strip_prefix("[prisma-web:")?.split_once(']').map(|(u, _)| u).filter(|u| !u.is_empty())
}

fn can_confirm(p: &PendingConfirm, user: &CurrentUser) -> bool {
    user.role >= Role::Admin || (user.role >= Role::Operator && p.user_id.is_none_or(|u| u == user.id))
}

#[derive(Deserialize)]
pub struct OpenBody {
    from_revision: Option<u32>,
}

pub async fn open(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    body: Option<Json<OpenBody>>,
) -> AppResult<Json<OpenCandidateResponse>> {
    user.require(Role::Operator)?;
    close_expired(&st).await;
    let r = st.routers.get(id).await?;
    require_can_change(&st, &r).await?;
    let from_revision = body.and_then(|Json(b)| b.from_revision);
    let resp = r.config().open_candidate(req(OpenCandidateRequest { from_revision, ..Default::default() })).await?.into_inner();
    st.candidates.0.lock().unwrap().insert(
        resp.candidate_id.clone(),
        Owner {
            router_id: id,
            user_id: user.id,
            last_used: Instant::now(),
            base_revision: resp.base_revision.clone(),
            expires_at: ts(resp.expires_at),
            idle: (resp.idle_seconds > 0).then(|| Duration::from_secs(resp.idle_seconds.into())),
        },
    );
    Ok(Json(resp))
}

#[derive(Deserialize)]
pub struct EditBody {
    #[serde(default)]
    path: Vec<String>,
    lines: Vec<String>,
}

pub async fn edit(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
    Json(body): Json<EditBody>,
) -> AppResult<Json<EditResponse>> {
    st.candidates.check(id, &cid, &user)?;
    let lines: Vec<String> = body.lines.into_iter().map(|l| l.trim_end().to_string()).filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return Err(AppError::BadRequest("no lines to apply".into()));
    }
    let r = st.routers.get(id).await?;
    let msg = EditRequest { candidate_id: cid.clone(), path: body.path, lines, ..Default::default() };
    let resp = r.config().edit(req(msg)).await.map_err(gone(&st, &cid))?.into_inner();
    st.candidates.set_expiry(&cid, ts(resp.expires_at));
    Ok(Json(resp))
}

pub async fn show_candidate(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
) -> AppResult<Json<ConfigText>> {
    st.candidates.check(id, &cid, &user)?;
    let r = st.routers.get(id).await?;
    Ok(Json(r.config().show_candidate(req(cref(&cid))).await.map_err(gone(&st, &cid))?.into_inner()))
}

pub async fn compare(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
) -> AppResult<Json<CompareResponse>> {
    st.candidates.check(id, &cid, &user)?;
    let r = st.routers.get(id).await?;
    Ok(Json(r.config().compare(req(cref(&cid))).await.map_err(gone(&st, &cid))?.into_inner()))
}

pub async fn check(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
) -> AppResult<Json<CheckResponse>> {
    st.candidates.check(id, &cid, &user)?;
    let r = st.routers.get(id).await?;
    Ok(Json(r.config().check(req(cref(&cid))).await.map_err(gone(&st, &cid))?.into_inner()))
}

#[derive(Deserialize)]
pub struct RollbackBody {
    revision: u32,
}

pub async fn rollback(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
    Json(body): Json<RollbackBody>,
) -> AppResult<Json<EditResponse>> {
    st.candidates.check(id, &cid, &user)?;
    let r = st.routers.get(id).await?;
    let msg = RollbackRequest { candidate_id: cid.clone(), revision: body.revision, ..Default::default() };
    Ok(Json(r.config().rollback(req(msg)).await.map_err(gone(&st, &cid))?.into_inner()))
}

pub async fn close(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
) -> AppResult<StatusCode> {
    st.candidates.check(id, &cid, &user)?;
    st.candidates.forget(&cid);
    let r = st.routers.get(id).await?;
    match r.config().close_candidate(req(cref(&cid))).await {
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(s) if s.code() == tonic::Code::NotFound => Ok(StatusCode::NO_CONTENT),
        Err(s) => Err(s.into()),
    }
}

#[derive(Deserialize)]
pub struct CommitBody {
    #[serde(default)]
    comment: String,
    #[serde(default)]
    confirmed_minutes: u32,
    #[serde(default)]
    acknowledge_remap: bool,
    #[serde(default)]
    acknowledge_cutoff: bool,
    #[serde(default)]
    acknowledge_diverge: bool,
}

pub async fn commit(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path((id, cid)): Path<(Uuid, String)>,
    Json(body): Json<CommitBody>,
) -> AppResult<Json<CommitResponse>> {
    user.require(Role::Operator)?;
    st.candidates.check(id, &cid, &user)?;
    if body.confirmed_minutes > 60 {
        return Err(AppError::BadRequest("commit confirmed accepts at most 60 minutes".into()));
    }
    let comment = body.comment.trim();
    if comment.chars().count() > 200 || comment.contains(['\n', '\r']) {
        return Err(AppError::BadRequest("the comment must be a single line of up to 200 characters".into()));
    }
    let r = st.routers.get(id).await?;

    // The diff goes to the log: it records what this change changed.
    let diff = r.config().compare(req(cref(&cid))).await.map_err(gone(&st, &cid))?.into_inner().diff;
    if adds_syslog_disable(&diff) {
        let release = r.ops().get_version(req(GetVersionRequest {})).await?.into_inner().release;
        // The box says whether a syslog collector is configured (Prisma 0.149.20); else read the text.
        let typed = r.config().get_config(crate::grpc::req_with(GetConfigRequest { areas: vec!["logging".into()], ..Default::default() }, crate::grpc::RUNNING_TIMEOUT)).await.ok();
        let running = match typed.and_then(|c| c.into_inner().logging) {
            Some(l) if l.collectors.iter().any(|c| c.transport == "syslog" && c.configured) => "logging syslog configured".to_string(),
            Some(_) => String::new(),
            None => r.config().get_running(crate::grpc::req_with(GetRunningRequest {}, crate::grpc::RUNNING_TIMEOUT)).await?.into_inner().text,
        };
        if syslog_disable_hazard(&release, &running, &diff) {
            return Err(AppError::Conflict(format!(
                "refused: on Prisma {release} (before 0.149.8), disabling a syslog that was never enabled stops \
                 the dataplane until the box is rebooted (prismarouting #551). Remove `logging syslog disable` \
                 from this change, or upgrade the box to 0.149.8 or newer"
            )));
        }
    }
    // Every web user shares the same Prisma account; the comment carries
    // the user into the box's own audit trail.
    let box_comment = if comment.is_empty() {
        format!("[prisma-web:{}]", user.username)
    } else {
        format!("[prisma-web:{}] {comment}", user.username)
    };
    let msg = CommitRequest {
        candidate_id: cid.clone(),
        comment: box_comment,
        confirmed_minutes: body.confirmed_minutes,
        acknowledge_remap: body.acknowledge_remap,
        acknowledge_cutoff: body.acknowledge_cutoff,
        acknowledge_diverge: body.acknowledge_diverge,
        ..Default::default()
    };
    st.routers.telemetry.web_action(id);
    let res = r.config().commit(req(msg)).await;

    let mut details = json!({
        "comment": comment,
        "diff": truncate(&diff, MAX_DIFF_LOG),
        "confirmed_minutes": body.confirmed_minutes,
        "acknowledged": {
            "remap": body.acknowledge_remap,
            "cutoff": body.acknowledge_cutoff,
            "diverge": body.acknowledge_diverge,
        },
    });
    let entry = Entry::by(&user, &meta, "config.commit").target(&r.name).router(id);
    match res {
        Ok(resp) => {
            let resp = resp.into_inner();
            details["revision"] = json!(resp.revision);
            st.routers.telemetry.own_commit(id, &resp.revision);
            audit::record(&st.db, entry.details(details)).await;
            st.candidates.forget(&cid);
            // If Prisma does not close the candidate on commit by itself, close it here.
            let _ = r.config().close_candidate(req(cref(&cid))).await;
            if body.confirmed_minutes > 0 {
                let deadline = resp
                    .confirm_deadline
                    .as_ref()
                    .and_then(|t| DateTime::<Utc>::from_timestamp(t.seconds, t.nanos.max(0) as u32));
                st.routers.telemetry.set_pending(
                    id,
                    Some(PendingConfirm {
                        deadline,
                        by: user.username.clone(),
                        user_id: Some(user.id),
                        revision: Some(resp.revision.clone()),
                        overdue: false,
                        revert_attempts: 0,
                        source: "memory",
                    }),
                );
            }
            Ok(Json(resp))
        }
        Err(status) => {
            details["error"] = json!(crate::grpc::describe(&status));
            if let Some(d) = prisma_proto::diagnostics(&status) {
                details["diagnostics"] = json!(d.items);
            }
            // The box's wording is not part of the contract: compare revisions instead.
            let stale = match stale_from_reason(reason_of(&status)) {
                Some(stale) => stale,
                // A box before 0.149.18: compare the candidate's base with the running revision.
                None if status.code() == tonic::Code::FailedPrecondition => {
                    let running = r.config().get_running(crate::grpc::req_with(GetRunningRequest {}, crate::grpc::RUNNING_TIMEOUT)).await.ok().map(|r| r.into_inner().revision);
                    let base = st.candidates.base_revision(&cid);
                    is_stale(base.as_deref(), running.as_deref(), st.routers.telemetry.pending(id).is_some())
                }
                None => false,
            };
            details["stale"] = json!(stale);
            audit::record(&st.db, entry.failed().details(details)).await;
            if stale {
                return Err(AppError::Stale(STALE.into()));
            }
            Err(status.into())
        }
    }
}

pub async fn confirm(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ConfirmResponse>> {
    user.require(Role::Operator)?;
    let r = st.routers.get(id).await?;
    let pending = current_pending(&st, &r).await;
    if let Some(p) = &pending {
        if !can_confirm(p, &user) {
            return Err(AppError::Conflict(format!(
                "the pending commit belongs to {}; only that user or an administrator can confirm it",
                p.by
            )));
        }
    }
    require_can_change(&st, &r).await?;
    st.routers.telemetry.web_action(id);
    let resp = r.config().confirm(req(ConfirmRequest {})).await?.into_inner();
    st.routers.telemetry.set_pending(id, None);
    audit::record(
        &st.db,
        Entry::by(&user, &meta, "config.confirm")
            .target(&r.name)
            .router(id)
            .details(json!({ "revision": pending.and_then(|p| p.revision) })),
    )
    .await;
    Ok(Json(resp))
}

pub async fn save(
    State(st): State<AppState>,
    user: CurrentUser,
    meta: ClientMeta,
    Path(id): Path<Uuid>,
) -> AppResult<Json<SaveResponse>> {
    user.require(Role::Operator)?;
    let r = st.routers.get(id).await?;
    require_can_change(&st, &r).await?;
    st.routers.telemetry.web_action(id);
    let resp = r.config().save(req(SaveRequest {})).await?.into_inner();
    audit::record(
        &st.db,
        Entry::by(&user, &meta, "config.save").target(&r.name).router(id).details(json!({ "output": resp.output })),
    )
    .await;
    Ok(Json(resp))
}

/// Refuses, before calling the box, a change its account could not make: a
/// read-only login. A CGNAT-only login may still change the CGNAT half, and the
/// box itself refuses the rest. Unknown (an older box) is not refused (#28).
async fn require_can_change(st: &AppState, r: &RouterHandle) -> AppResult<()> {
    match read_only(st.routers.access(r).await.as_ref(), &r.name) {
        Some(why) => Err(AppError::ReadOnly(why)),
        None => Ok(()),
    }
}

fn read_only(access: Option<&WhoAmIResponse>, router: &str) -> Option<String> {
    let a = access.filter(|a| !a.can_configure && !a.can_configure_cgnat)?;
    Some(format!("the account {} on {router} is {}: it cannot change the configuration", a.account, a.role))
}

async fn close_expired(st: &AppState) {
    for (router_id, cid) in st.candidates.expired() {
        if let Ok(r) = st.routers.get(router_id).await {
            let _ = r.config().close_candidate(req(cref(&cid))).await;
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (diff truncated)", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Role;

    fn user(id: Uuid) -> CurrentUser {
        CurrentUser { id, username: "u".into(), role: Role::Operator, global_role: Role::Operator, must_change_password: false, session_id: Uuid::nil() }
    }

    #[test]
    fn candidate_belongs_to_whoever_opened_it() {
        let c = Candidates::default();
        let (router, owner, other) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        c.0.lock().unwrap().insert("c1".into(), Owner { router_id: router, user_id: owner, last_used: Instant::now(), base_revision: String::new(), expires_at: None, idle: None });
        assert!(c.check(router, "c1", &user(owner)).is_ok());
        assert!(matches!(c.check(router, "c1", &user(other)), Err(AppError::Conflict(_))));
        // The same id on another router does not count.
        assert!(matches!(c.check(Uuid::new_v4(), "c1", &user(owner)), Err(AppError::NotFound(_))));
        c.forget("c1");
        assert!(matches!(c.check(router, "c1", &user(owner)), Err(AppError::NotFound(_))));
    }

    #[test]
    fn the_reason_is_read_from_the_trailer() {
        let with = |r: Reason| {
            prisma_proto::with_diagnostics(
                tonic::Status::not_found("candidate x does not exist"),
                &Diagnostics { reason: r as i32, ..Default::default() },
            )
        };
        assert_eq!(reason_of(&with(Reason::CandidateUnknown)), Some(Reason::CandidateUnknown));
        assert_eq!(reason_of(&with(Reason::Unspecified)), None);
        assert_eq!(reason_of(&tonic::Status::not_found("no trailer")), None, "a box before 0.149.18");
    }

    #[test]
    fn typed_reasons_win_and_older_boxes_fall_back() {
        assert_eq!(stale_from_reason(Some(Reason::StaleBase)), Some(true));
        assert_eq!(stale_from_reason(Some(Reason::GateRemap)), Some(false), "a gate is not a moved base");
        assert_eq!(stale_from_reason(Some(Reason::ConfirmPending)), Some(false));
        assert_eq!(stale_from_reason(None), None, "no reason (before 0.149.18): decide the old way");
        assert_eq!(web_user("[prisma-web:alice] mtu on lan0"), Some("alice"));
        assert_eq!(web_user("[prisma-web:bob]"), Some("bob"));
        assert_eq!(web_user("made at the prompt"), None);
        assert_eq!(web_user("[prisma-web:] x"), None);
    }

    #[test]
    fn the_boxs_expiry_wins_over_the_25_minute_rule() {
        let o = |expires_at| Owner {
            router_id: Uuid::nil(),
            user_id: Uuid::nil(),
            last_used: Instant::now(),
            base_revision: String::new(),
            expires_at,
            idle: Some(Duration::from_secs(15)),
        };
        let now = Utc::now();
        assert!(o(Some(now - chrono::Duration::seconds(1))).is_expired(now), "past the box's expiry");
        assert!(o(Some(now + chrono::Duration::seconds(3))).is_expired(now), "inside the 5 s margin");
        assert!(!o(Some(now + chrono::Duration::seconds(60))).is_expired(now));
        assert!(!o(None).is_expired(now), "an older box: just used, not expired");
    }

    #[test]
    fn a_moved_base_is_stale_and_nothing_else_is() {
        assert!(is_stale(Some("r3"), Some("r4"), false));
        assert!(!is_stale(Some("r4"), Some("r4"), false), "same base: another precondition (a gate)");
        assert!(!is_stale(Some("r3"), Some("r4"), true), "a pending commit confirmed is its own refusal");
        assert!(!is_stale(Some(""), Some("r4"), false), "unknown base");
        assert!(!is_stale(None, Some("r4"), false));
        assert!(!is_stale(Some("r3"), None, false), "running revision not read");
    }

    #[test]
    fn syslog_disable_is_refused_only_where_it_stops_the_dataplane() {
        let diff = " nat\n  cgnat\n+  logging syslog disable\n  exit\n";
        let never = "nat\n cgnat\n  pool P\n  exit\n exit\n";
        let enabled = "nat\n cgnat\n  logging syslog 192.0.2.10 enterprise 1\n  exit\n exit\n";
        assert!(syslog_disable_hazard("0.149.4", never, diff));
        assert!(syslog_disable_hazard("0.149.0-mock", never, diff), "a suffix does not hide the version");
        assert!(!syslog_disable_hazard("0.149.8", never, diff), "fixed in 0.149.8");
        assert!(!syslog_disable_hazard("0.150.0", never, diff));
        assert!(!syslog_disable_hazard("0.149.4", enabled, diff), "a configured collector can be disabled");
        assert!(!syslog_disable_hazard("0.149.4", never, "+  logging syslog 192.0.2.10 enterprise 1\n"));
        assert!(!syslog_disable_hazard("0.149.4", never, "-  logging syslog disable\n"), "removing the line is not disabling");
        assert!(!syslog_disable_hazard("unknown", never, diff), "an unreadable version is not refused");
        assert_eq!(release_triplet("v0.149.7"), Some((0, 149, 7)));
    }

    #[test]
    fn idle_counts_from_the_last_action_not_from_opening() {
        let c = Candidates::default();
        let (router, owner) = (Uuid::new_v4(), Uuid::new_v4());
        let ago = |m: u64| Instant::now() - Duration::from_secs(m * 60);
        // Opened 40 minutes ago but used 20 minutes ago: alive, and the check counts as a use.
        c.0.lock().unwrap().insert("busy".into(), Owner { router_id: router, user_id: owner, last_used: ago(20), base_revision: String::new(), expires_at: None, idle: None });
        assert!(c.check(router, "busy", &user(owner)).is_ok());
        assert!(c.0.lock().unwrap()["busy"].last_used.elapsed() < Duration::from_secs(5));
        // Idle for 26 minutes: expired with the reason, and forgotten.
        c.0.lock().unwrap().insert("idle".into(), Owner { router_id: router, user_id: owner, last_used: ago(26), base_revision: String::new(), expires_at: None, idle: None });
        assert!(matches!(c.check(router, "idle", &user(owner)), Err(AppError::Expired(_))));
        assert!(matches!(c.check(router, "idle", &user(owner)), Err(AppError::NotFound(_))));
        c.0.lock().unwrap().insert("idle2".into(), Owner { router_id: router, user_id: owner, last_used: ago(26), base_revision: String::new(), expires_at: None, idle: None });
        assert_eq!(c.expired(), vec![(router, "idle2".to_string())]);
    }

    #[test]
    fn confirm_is_for_the_author_or_an_admin() {
        let author = Uuid::new_v4();
        let p = PendingConfirm { deadline: None, by: "a".into(), user_id: Some(author), revision: None, overdue: false, revert_attempts: 0, source: "memory" };
        assert!(can_confirm(&p, &user(author)));
        assert!(!can_confirm(&p, &user(Uuid::new_v4())));
        let mut admin = user(Uuid::new_v4());
        admin.role = Role::Admin;
        assert!(can_confirm(&p, &admin));
        let mut viewer = user(author);
        viewer.role = Role::Viewer;
        assert!(!can_confirm(&p, &viewer));
        // Commit made on the box itself (no web author): any operator.
        let boxp = PendingConfirm { user_id: None, ..p };
        assert!(can_confirm(&boxp, &user(Uuid::new_v4())));
    }

    #[test]
    fn truncate_respects_utf8_boundaries() {
        // "a€" is 1 + 3 bytes: byte 6 falls inside the second '€'.
        let s = "a€".repeat(10);
        let t = truncate(&s, 6);
        assert!(t.starts_with("a€a\n"));
        assert!(t.ends_with("(diff truncated)"));
        assert_eq!(truncate("short", 50), "short");
    }

    #[test]
    fn only_a_read_only_account_is_refused() {
        let who = |role: &str, all: bool, cgnat: bool| WhoAmIResponse {
            account: "noc".into(),
            role: role.into(),
            can_configure: all,
            can_configure_cgnat: cgnat,
            ..Default::default()
        };
        assert!(read_only(Some(&who("read-only", false, false)), "HQ").is_some_and(|m| m.contains("noc") && m.contains("read-only")));
        assert_eq!(read_only(Some(&who("cgnat-operator", false, true)), "HQ"), None);
        assert_eq!(read_only(Some(&who("administrator", true, true)), "HQ"), None);
        assert_eq!(read_only(None, "HQ"), None, "an older box without WhoAmI is not refused");
    }
}

#[derive(Serialize)]
pub struct GrammarView {
    /// "box <release>" when read with GetSchema, "coverage-map" otherwise (#44).
    source: String,
    modes: Arc<Vec<crate::config_model::Mode>>,
}

/// A router's grammar and where it came from, kept ten minutes.
type CachedModes = (Instant, String, Arc<Vec<crate::config_model::Mode>>);
static GRAMMARS: std::sync::LazyLock<Mutex<HashMap<Uuid, CachedModes>>> = std::sync::LazyLock::new(Default::default);
const GRAMMAR_TTL: Duration = Duration::from_secs(600);

/// The box's own grammar (GetSchema, Prisma 0.149.20) when it has one; the
/// vendored coverage map otherwise (#39, #44).
async fn modes_for(r: &RouterHandle) -> (String, Arc<Vec<crate::config_model::Mode>>) {
    if let Some((at, source, modes)) = GRAMMARS.lock().unwrap().get(&r.id) {
        if at.elapsed() < GRAMMAR_TTL {
            return (source.clone(), modes.clone());
        }
    }
    let (source, modes) = match r.config().get_schema(req(GetSchemaRequest::default())).await {
        Ok(s) => {
            let s = s.into_inner();
            (format!("box {}", s.release), Arc::new(crate::config_model::from_schema(&s)))
        }
        Err(_) => ("coverage-map".to_string(), Arc::new(crate::config_model::MODES.clone())),
    };
    GRAMMARS.lock().unwrap().insert(r.id, (Instant::now(), source.clone(), modes.clone()));
    (source, modes)
}

/// The configuration grammar, mode by mode, for the structured editor (#39, #44).
pub async fn grammar(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<GrammarView>> {
    let r = st.routers.get(id).await?;
    let (source, modes) = modes_for(&r).await;
    Ok(Json(GrammarView { source, modes }))
}

#[derive(Deserialize)]
pub struct TreeQuery {
    /// A candidate of the requester's, to see its configuration instead of the running one.
    candidate: Option<String>,
}

#[derive(Serialize)]
pub struct TreeView {
    revision: String,
    instances: Vec<crate::config_model::Instance>,
}

/// The configuration as instances of modes, each line matched to its statement;
/// the box's own lines marked read only with its reason (#39, #44).
pub async fn tree(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<TreeQuery>,
) -> AppResult<Json<TreeView>> {
    let r = st.routers.get(id).await?;
    let cid = q.candidate.filter(|c| !c.is_empty());
    let text = match &cid {
        Some(cid) => {
            st.candidates.check(id, cid, &user)?;
            r.config().show_candidate(req(cref(cid))).await.map_err(gone(&st, cid))?.into_inner()
        }
        None => r.config().get_running(crate::grpc::req_with(GetRunningRequest {}, crate::grpc::RUNNING_TIMEOUT)).await?.into_inner(),
    };
    let (_, modes) = modes_for(&r).await;
    let nodes = crate::config_model::tree(&text.text);
    let mut instances = crate::config_model::instances(&nodes, &modes);
    let owned_req = GetConfigRequest { candidate_id: cid.unwrap_or_default(), areas: vec!["logging".into()], ..Default::default() };
    if let Ok(c) = r.config().get_config(crate::grpc::req_with(owned_req, crate::grpc::RUNNING_TIMEOUT)).await {
        let owned: HashMap<String, String> = c.into_inner().box_owned.into_iter().map(|o| (o.line.trim().to_string(), o.why)).collect();
        for l in instances.iter_mut().flat_map(|i| i.lines.iter_mut()) {
            if let Some(why) = owned.get(l.text.trim()) {
                l.owned = Some(why.clone());
            }
        }
    }
    Ok(Json(TreeView { revision: text.revision, instances }))
}

#[derive(Deserialize)]
pub struct ValidateBody {
    #[serde(default)]
    path: Vec<String>,
    lines: Vec<String>,
}

/// Lines checked by the VTY in a throwaway candidate (ValidateLines, Prisma
/// 0.149.20); nothing is staged (#44). Older boxes answer 501.
pub async fn validate(
    State(st): State<AppState>,
    _: CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<ValidateBody>,
) -> AppResult<Json<ValidateLinesResponse>> {
    let r = st.routers.get(id).await?;
    let msg = ValidateLinesRequest { path: body.path, lines: body.lines, ..Default::default() };
    Ok(Json(r.config().validate_lines(req(msg)).await?.into_inner()))
}

// --- The configuration as fields (Prisma 0.149.20 and 0.149.22, #46) -----------

/// The areas GetConfig answers since 0.149.22; anything else is refused here.
const TYPED_AREAS: [&str; 10] = ["interfaces", "pools", "logging", "static", "bgp", "ospf", "ospf6", "isis", "interface_routing", "bfd"];

#[derive(Deserialize)]
pub struct TypedQuery {
    /// Comma-separated areas; empty is every area (as on the box since 0.149.22).
    #[serde(default)]
    areas: String,
    /// A candidate of the requester's, to read it instead of the running configuration.
    candidate: Option<String>,
}

fn typed_areas(list: &str) -> AppResult<Vec<String>> {
    let areas: Vec<String> = list.split(',').map(str::trim).filter(|a| !a.is_empty()).map(str::to_string).collect();
    match areas.iter().find(|a| !TYPED_AREAS.contains(&a.as_str())) {
        Some(a) => Err(AppError::BadRequest(format!("unknown area {a}; one of {}", TYPED_AREAS.join(", ")))),
        None => Ok(areas),
    }
}

/// A box that does not type the area: before 0.149.20 the rpc is UNIMPLEMENTED,
/// and a 0.149.20/21 box refuses a routing area as an unknown one (REASON_USAGE).
/// Both answer 501, so the front keeps the line form for that area (#46).
fn not_typed(s: tonic::Status) -> AppError {
    let usage = s.code() == tonic::Code::InvalidArgument && reason_of(&s).is_none_or(|r| r == Reason::Usage);
    if usage {
        return AppError::Prisma(Box::new(tonic::Status::unimplemented(format!("the box does not type this area: {}", s.message()))));
    }
    s.into()
}

/// GetConfig: the areas asked, from the running configuration or a candidate of the requester's (#46).
pub async fn typed(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<TypedQuery>,
) -> AppResult<Json<TypedConfig>> {
    let areas = typed_areas(&q.areas)?;
    let cid = q.candidate.filter(|c| !c.is_empty());
    if let Some(cid) = &cid {
        st.candidates.check(id, cid, &user)?;
    }
    let r = st.routers.get(id).await?;
    let msg = GetConfigRequest { candidate_id: cid.clone().unwrap_or_default(), areas, ..Default::default() };
    let resp = r.config().get_config(crate::grpc::req_with(msg, crate::grpc::RUNNING_TIMEOUT)).await;
    let mut c = match (resp, &cid) {
        (Ok(c), _) => c.into_inner(),
        (Err(s), Some(cid)) if s.code() == tonic::Code::NotFound => return Err(gone(&st, cid)(s)),
        (Err(s), _) => return Err(not_typed(s)),
    };
    // A password is never read (0.149.22); nothing here would carry one, but a box
    // that answered `other` with one would not reach the browser either.
    for b in &mut c.bgp {
        scrub(&mut b.other);
        for n in &mut b.neighbors {
            scrub(&mut n.other);
        }
    }
    Ok(Json(c))
}

/// The object of a SetConfig: exactly one of them, and the fields it changes.
#[derive(Deserialize)]
pub struct SetBody {
    interface: Option<InterfaceConfig>,
    pool: Option<PoolConfig>,
    logging: Option<LoggingConfig>,
    static_route: Option<StaticRouteConfig>,
    bgp_neighbor: Option<BgpNeighborEdit>,
    /// BFD (Prisma 0.150.12, #67).
    bfd_peer: Option<BfdPeerConfig>,
    bfd_profile: Option<BfdProfileConfig>,
    #[serde(default)]
    fields: Vec<String>,
}

impl SetBody {
    fn into_request(self, cid: &str) -> AppResult<SetConfigRequest> {
        use set_config_request::Object;
        let objects: Vec<Object> = [
            self.interface.map(Object::Interface),
            self.pool.map(Object::Pool),
            self.logging.map(Object::Logging),
            self.static_route.map(Object::StaticRoute),
            self.bgp_neighbor.map(Object::BgpNeighbor),
            self.bfd_peer.map(Object::BfdPeer),
            self.bfd_profile.map(Object::BfdProfile),
        ]
        .into_iter()
        .flatten()
        .collect();
        let [object] = <[Object; 1]>::try_from(objects).map_err(|_| {
            AppError::BadRequest("send exactly one object: interface, pool, logging, static_route, bgp_neighbor, bfd_peer or bfd_profile".into())
        })?;
        // An empty mask sets EVERY field to the value sent, clearing what a partial
        // object leaves out (docs/prisma-api.md): this server never sends one.
        let fields: Vec<String> = self.fields.into_iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect();
        if fields.is_empty() {
            return Err(AppError::BadRequest("name the fields to change: an empty mask would set every field".into()));
        }
        Ok(SetConfigRequest { candidate_id: cid.to_string(), object: Some(object), fields, ..Default::default() })
    }
}

/// `password <secret>` in a line, masked as the box masks it. The box never echoes one
/// (0.149.22); this keeps an older or misbehaving answer from reaching the browser.
fn mask_password(line: &str) -> String {
    let w: Vec<&str> = line.split_whitespace().collect();
    match w.iter().position(|x| *x == "password") {
        Some(i) if w.get(i + 1).is_some_and(|v| !v.starts_with('<')) => format!("{} password <set, not shown>", w[..i].join(" ")),
        _ => line.to_string(),
    }
}

fn scrub(lines: &mut [String]) {
    for l in lines.iter_mut() {
        *l = mask_password(l);
    }
}

fn scrub_reply(mut resp: SetConfigResponse) -> SetConfigResponse {
    scrub(&mut resp.lines);
    resp.output = resp.output.lines().map(mask_password).collect::<Vec<_>>().join("\n");
    resp
}

/// SetConfig: one object set to the fields named, staged in the candidate as
/// lines, which the reply lists (the preview). Like Edit: the candidate's owner
/// only, and the commit is what the audit log records (#46).
pub async fn typed_set(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
    Json(body): Json<SetBody>,
) -> AppResult<Json<SetConfigResponse>> {
    user.require(Role::Operator)?;
    st.candidates.check(id, &cid, &user)?;
    let msg = body.into_request(&cid)?;
    let r = st.routers.get(id).await?;
    require_can_change(&st, &r).await?;
    let resp = r.config().set_config(req(msg)).await.map_err(gone(&st, &cid))?.into_inner();
    st.candidates.set_expiry(&cid, ts(resp.expires_at));
    Ok(Json(scrub_reply(resp)))
}

#[derive(Deserialize)]
pub struct DeleteBody {
    area: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    transport: String,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    next_hop: String,
    #[serde(default)]
    asn: String,
    #[serde(default)]
    vrf: String,
    /// The BFD session to remove (area `bfd`, Prisma 0.150.12, #67); with no `name` either,
    /// the whole `bfd` block.
    #[serde(default)]
    bfd_peer: Option<BfdPeerConfig>,
}

/// DeleteConfig: an interface, pool, collector, static route or BGP neighbor
/// removed, statement by statement as the box reads them off the candidate (#46).
pub async fn typed_delete(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
    Json(b): Json<DeleteBody>,
) -> AppResult<Json<SetConfigResponse>> {
    user.require(Role::Operator)?;
    st.candidates.check(id, &cid, &user)?;
    if !["interfaces", "pools", "logging", "static", "bgp", "bfd"].contains(&b.area.as_str()) {
        return Err(AppError::BadRequest("area is one of interfaces, pools, logging, static, bgp, bfd".into()));
    }
    let r = st.routers.get(id).await?;
    require_can_change(&st, &r).await?;
    let msg = DeleteConfigRequest {
        candidate_id: cid.clone(),
        area: b.area,
        name: b.name,
        transport: b.transport,
        prefix: b.prefix,
        next_hop: b.next_hop,
        asn: b.asn,
        vrf: b.vrf,
        bfd_peer: b.bfd_peer,
        ..Default::default()
    };
    let resp = r.config().delete_config(req(msg)).await.map_err(gone(&st, &cid))?.into_inner();
    st.candidates.set_expiry(&cid, ts(resp.expires_at));
    Ok(Json(scrub_reply(resp)))
}

#[cfg(test)]
mod typed_tests {
    use super::*;

    #[test]
    fn a_set_names_one_object_and_its_fields() {
        let body = |v: serde_json::Value| serde_json::from_value::<SetBody>(v).unwrap().into_request("c1");
        let ok = body(json!({ "interface": { "name": "lan0", "mtu": 9000 }, "fields": ["mtu"] })).unwrap();
        assert_eq!(ok.fields, ["mtu"]);
        match ok.object {
            Some(set_config_request::Object::Interface(i)) => assert_eq!((i.name.as_str(), i.mtu, i.description.as_str()), ("lan0", 9000, "")),
            _ => panic!("an interface"),
        }
        assert!(matches!(body(json!({ "interface": { "name": "lan0" }, "fields": [] })), Err(AppError::BadRequest(m)) if m.contains("empty mask")));
        assert!(matches!(body(json!({ "interface": { "name": "lan0" }, "fields": [" "] })), Err(AppError::BadRequest(_))), "a blank field is no field");
        assert!(body(json!({ "fields": ["mtu"] })).is_err(), "no object");
        assert!(body(json!({ "interface": {}, "pool": {}, "fields": ["mtu"] })).is_err(), "two objects");
        let n = body(json!({ "bgp_neighbor": { "asn": "65000", "neighbor": { "address": "192.0.2.1", "remote_as": "64500" }, "password": "s3cret",
            "families": [{ "afi": "ipv4", "safi": "unicast", "settings": { "activate": true, "route_map_in": "IN" } }] }, "fields": ["remote_as", "password", "families"] })).unwrap();
        match n.object {
            Some(set_config_request::Object::BgpNeighbor(e)) => {
                assert_eq!(e.password, "s3cret");
                assert_eq!(e.families[0].settings.as_ref().unwrap().route_map_in, "IN");
            }
            _ => panic!("a neighbor"),
        }
        let p = body(json!({ "pool": { "name": "P", "vrf": 0, "algs": { "ftp": true }, "timeouts": {} }, "fields": ["vrf", "algs"] })).unwrap();
        match p.object {
            Some(set_config_request::Object::Pool(p)) => assert_eq!((p.vrf, p.outside_vrf, p.algs["ftp"]), (Some(0), None, true), "VRF 0 is not every VRF"),
            _ => panic!("a pool"),
        }
    }

    #[test]
    fn a_password_never_reaches_the_browser() {
        assert_eq!(mask_password("neighbor 192.0.2.1 password s3cret"), "neighbor 192.0.2.1 password <set, not shown>");
        assert_eq!(mask_password("neighbor 192.0.2.1 password <set, not shown>"), "neighbor 192.0.2.1 password <set, not shown>");
        assert_eq!(mask_password("neighbor 192.0.2.1 remote-as 64500"), "neighbor 192.0.2.1 remote-as 64500");
        let r = scrub_reply(SetConfigResponse {
            lines: vec!["neighbor 192.0.2.1 password hunter2".into()],
            output: "staged: neighbor 192.0.2.1 password hunter2".into(),
            ..Default::default()
        });
        assert!(!format!("{r:?}").contains("hunter2"));
    }

    #[test]
    fn areas_are_checked_and_an_untyped_area_falls_back() {
        assert_eq!(typed_areas("bgp, static").unwrap(), ["bgp", "static"]);
        assert!(typed_areas("").unwrap().is_empty(), "every area");
        assert!(typed_areas("bgp,nope").is_err());
        let usage = prisma_proto::with_diagnostics(tonic::Status::invalid_argument("unknown area bgp"), &Diagnostics { reason: Reason::Usage as i32, ..Default::default() });
        assert!(matches!(not_typed(usage), AppError::Prisma(s) if s.code() == tonic::Code::Unimplemented));
        assert!(matches!(not_typed(tonic::Status::unimplemented("x")), AppError::Prisma(s) if s.code() == tonic::Code::Unimplemented));
        assert!(matches!(not_typed(tonic::Status::unavailable("x")), AppError::Prisma(s) if s.code() == tonic::Code::Unavailable), "a box down is not a box without the call");
    }
}
