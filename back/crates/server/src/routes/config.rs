//! Configuration of each Prisma through the VTY model (`ConfigService`):
//! candidate → edit → compare → check → commit [confirmed] → confirm.
//!
//! Prisma sees a single account for the whole web UI, so the ownership of each
//! candidate (which web user opened it) is tracked here.

use std::collections::HashMap;
use std::sync::Mutex;
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
use crate::telemetry::PendingConfirm;
use crate::AppState;

/// Candidates open for longer than this are discarded.
const CANDIDATE_TTL: Duration = Duration::from_secs(3600);
/// Maximum size of the diff kept in the change log.
const MAX_DIFF_LOG: usize = 20_000;

struct Owner {
    router_id: Uuid,
    user_id: Uuid,
    opened: Instant,
}

#[derive(Default)]
pub struct Candidates(Mutex<HashMap<String, Owner>>);

impl Candidates {
    fn check(&self, router_id: Uuid, cid: &str, user: &CurrentUser) -> AppResult<()> {
        let map = self.0.lock().unwrap();
        match map.get(cid) {
            Some(o) if o.router_id == router_id && o.user_id == user.id => Ok(()),
            Some(o) if o.router_id == router_id => {
                Err(AppError::Conflict("this candidate was opened by another user".into()))
            }
            _ => Err(AppError::NotFound("candidate not found; open a new change".into())),
        }
    }

    fn forget(&self, cid: &str) {
        self.0.lock().unwrap().remove(cid);
    }

    /// Removes and returns the expired candidates, so they can be closed on Prisma.
    fn expired(&self) -> Vec<(Uuid, String)> {
        let mut map = self.0.lock().unwrap();
        let old: Vec<(Uuid, String)> = map
            .iter()
            .filter(|(_, o)| o.opened.elapsed() > CANDIDATE_TTL)
            .map(|(cid, o)| (o.router_id, cid.clone()))
            .collect();
        for (_, cid) in &old {
            map.remove(cid);
        }
        old
    }
}

fn cref(cid: &str) -> CandidateRef {
    CandidateRef { candidate_id: cid.to_string(), ..Default::default() }
}

pub async fn running(State(st): State<AppState>, _: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<ConfigText>> {
    let r = st.routers.get(id).await?;
    Ok(Json(r.config().get_running(req(GetRunningRequest {})).await?.into_inner()))
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
    st.routers.get(id).await?;
    let pending = st.routers.telemetry.pending(id).map(|p| PendingView {
        can_confirm: can_confirm(&p, &user),
        inner: p,
    });
    Ok(Json(Pending { pending }))
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
    let from_revision = body.and_then(|Json(b)| b.from_revision);
    let resp = r.config().open_candidate(req(OpenCandidateRequest { from_revision, ..Default::default() })).await?.into_inner();
    st.candidates.0.lock().unwrap().insert(
        resp.candidate_id.clone(),
        Owner { router_id: id, user_id: user.id, opened: Instant::now() },
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
    let msg = EditRequest { candidate_id: cid, path: body.path, lines, ..Default::default() };
    Ok(Json(r.config().edit(req(msg)).await?.into_inner()))
}

pub async fn show_candidate(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
) -> AppResult<Json<ConfigText>> {
    st.candidates.check(id, &cid, &user)?;
    let r = st.routers.get(id).await?;
    Ok(Json(r.config().show_candidate(req(cref(&cid))).await?.into_inner()))
}

pub async fn compare(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
) -> AppResult<Json<CompareResponse>> {
    st.candidates.check(id, &cid, &user)?;
    let r = st.routers.get(id).await?;
    Ok(Json(r.config().compare(req(cref(&cid))).await?.into_inner()))
}

pub async fn check(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, cid)): Path<(Uuid, String)>,
) -> AppResult<Json<CheckResponse>> {
    st.candidates.check(id, &cid, &user)?;
    let r = st.routers.get(id).await?;
    Ok(Json(r.config().check(req(cref(&cid))).await?.into_inner()))
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
    let msg = RollbackRequest { candidate_id: cid, revision: body.revision, ..Default::default() };
    Ok(Json(r.config().rollback(req(msg)).await?.into_inner()))
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
    let diff = r.config().compare(req(cref(&cid))).await?.into_inner().diff;
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
            audit::record(&st.db, entry.failed().details(details)).await;
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
    let pending = st.routers.telemetry.pending(id);
    if let Some(p) = &pending {
        if !can_confirm(p, &user) {
            return Err(AppError::Conflict(format!(
                "the pending commit belongs to {}; only that user or an administrator can confirm it",
                p.by
            )));
        }
    }
    let r = st.routers.get(id).await?;
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
    st.routers.telemetry.web_action(id);
    let resp = r.config().save(req(SaveRequest {})).await?.into_inner();
    audit::record(
        &st.db,
        Entry::by(&user, &meta, "config.save").target(&r.name).router(id).details(json!({ "output": resp.output })),
    )
    .await;
    Ok(Json(resp))
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
        CurrentUser { id, username: "u".into(), role: Role::Operator, must_change_password: false, session_id: Uuid::nil() }
    }

    #[test]
    fn candidate_belongs_to_whoever_opened_it() {
        let c = Candidates::default();
        let (router, owner, other) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        c.0.lock().unwrap().insert("c1".into(), Owner { router_id: router, user_id: owner, opened: Instant::now() });
        assert!(c.check(router, "c1", &user(owner)).is_ok());
        assert!(matches!(c.check(router, "c1", &user(other)), Err(AppError::Conflict(_))));
        // The same id on another router does not count.
        assert!(matches!(c.check(Uuid::new_v4(), "c1", &user(owner)), Err(AppError::NotFound(_))));
        c.forget("c1");
        assert!(matches!(c.check(router, "c1", &user(owner)), Err(AppError::NotFound(_))));
    }

    #[test]
    fn confirm_is_for_the_author_or_an_admin() {
        let author = Uuid::new_v4();
        let p = PendingConfirm { deadline: None, by: "a".into(), user_id: Some(author), revision: None };
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
}
