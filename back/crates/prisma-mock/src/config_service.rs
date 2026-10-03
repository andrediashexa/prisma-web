//! `ConfigService`: candidates, compare, check, commit (and commit confirmed),
//! rollback and save, in the same model as the VTY.

use chrono::Utc;
use prisma_proto::v1::config_service_server::ConfigService;
use prisma_proto::v1::diagnostic::Severity;
use prisma_proto::v1::*;
use prisma_proto::with_diagnostics;
use rand::distributions::Alphanumeric;
use rand::Rng;
use tonic::{Request, Response, Status};
use prisma_proto::v1::diagnostics::Reason;

use crate::config::{self, diag, Config, BGP_PATH};
use crate::state::{timestamp, Candidate, Pending, SharedRef, State};

pub struct ConfigSvc(pub SharedRef);

type R<T> = Result<Response<T>, Status>;

/// Refusal with the VTY's report attached in `prisma-diagnostics-bin`, and
/// its code (Prisma 0.149.18).
fn refused(code: tonic::Code, message: impl Into<String>, items: Vec<Diagnostic>, reason: Reason) -> Status {
    refused_with(code, message, items, Diagnostics { reason: reason as i32, ..Default::default() })
}

fn refused_with(code: tonic::Code, message: impl Into<String>, items: Vec<Diagnostic>, extra: Diagnostics) -> Status {
    let message = message.into();
    let output = items
        .iter()
        .map(|d| format!("error: {}", d.message))
        .collect::<Vec<_>>()
        .join("\n");
    let output = if output.is_empty() { format!("error: {message}") } else { output };
    with_diagnostics(Status::new(code, message), &Diagnostics { items, output, ..extra })
}

fn not_found(id: &str, expired: bool) -> Status {
    let reason = if expired { Reason::CandidateExpired } else { Reason::CandidateUnknown };
    refused(tonic::Code::NotFound, format!("candidate {id} does not exist"), vec![], reason)
}

/// The candidate, touched; NOT_FOUND with the reason when the idle rule closed it.
fn cand<'a>(st: &'a mut State, id: &str) -> Result<&'a mut Candidate, Status> {
    if st.candidate(id).is_none() {
        return Err(not_found(id, st.expired.contains(id)));
    }
    Ok(st.candidates.get_mut(id).expect("just touched"))
}

fn idle_seconds() -> u32 {
    crate::state::candidate_idle().as_secs() as u32
}

fn expiry() -> Option<prost_types::Timestamp> {
    Some(timestamp(Utc::now() + chrono::Duration::seconds(idle_seconds().into())))
}

/// `commit check` gates: what must be acknowledged explicitly.
struct Gates {
    remap: Vec<String>,
    cutoff: Vec<String>,
    diverge: Vec<String>,
    diagnostics: Vec<Diagnostic>,
}

fn gates(running: &Config, candidate: &Config, subscribers: u64) -> Gates {
    let mut g = Gates { remap: vec![], cutoff: vec![], diverge: vec![], diagnostics: vec![] };

    let wan_was_up = running.iface("wan0").is_some_and(|i| !i.shutdown);
    if let Some(wan) = candidate.iface("wan0").filter(|i| i.shutdown && wan_was_up) {
        g.cutoff.extend(wan.v4.iter().filter_map(|a| config::network(a)));
        g.diagnostics.push(diag(
            Severity::Warning,
            "shutting down wan0 stops advertising the prefix carrying this session",
            &["interface wan0".to_string()],
            "shutdown",
        ));
    }

    let (old_bs, new_bs) = (running.pool_block_size(), candidate.pool_block_size());
    if old_bs != new_bs {
        g.remap.push(format!("pool RFC6598: {subscribers} subscribers would move"));
        g.diagnostics.push(diag(
            Severity::Warning,
            format!("block-size {old_bs} -> {new_bs} remaps every subscriber of pool RFC6598"),
            &config::POOL_PATH.map(String::from),
            &format!("block-size {new_bs}"),
        ));
    }

    let removed: Vec<_> = running
        .bgp_neighbors()
        .into_iter()
        .filter(|n| !candidate.bgp_neighbors().contains(n))
        .collect();
    if !removed.is_empty() {
        g.diverge.push("RFC6598".into());
        for (peer, _) in removed {
            g.diagnostics.push(diag(
                Severity::Warning,
                format!("removing neighbor {peer} makes pool RFC6598 diverge from the HA peer"),
                &BGP_PATH.map(String::from),
                &format!("no neighbor {peer}"),
            ));
        }
    }
    g
}

impl ConfigSvc {
    fn candidate_config(&self, id: &str) -> Result<Config, Status> {
        let mut st = self.0.state.lock().unwrap();
        cand(&mut st, id).map(|c| c.config.clone())
    }
}

#[tonic::async_trait]
impl ConfigService for ConfigSvc {
    async fn open_candidate(&self, req: Request<OpenCandidateRequest>) -> R<OpenCandidateResponse> {
        // Like the box: a read-only login cannot open a candidate.
        let who = crate::session::identity(&crate::session::account_of(&req));
        if !who.can_configure && !who.can_configure_cgnat {
            return Err(refused(tonic::Code::PermissionDenied, format!("account {} is read-only", who.account), vec![], Reason::Permission));
        }
        let req = req.into_inner();
        let mut st = self.0.state.lock().unwrap();
        let config = match req.from_revision {
            Some(n) => st
                .by_rollback_number(n)
                .map(|r| r.config.clone())
                .ok_or_else(|| refused(tonic::Code::InvalidArgument, format!("no revision {n}"), vec![], Reason::Usage))?,
            None => st.running.clone(),
        };
        let id: String = rand::thread_rng().sample_iter(&Alphanumeric).take(12).map(char::from).collect();
        let base = st.revision();
        let text = config.render();
        st.candidates.insert(id.clone(), Candidate { base_revision: base, config, touched: std::time::Instant::now(), created: Utc::now() });
        Ok(Response::new(OpenCandidateResponse {
            candidate_id: id,
            base_revision: format!("r{base}"),
            text,
            expires_at: expiry(),
            idle_seconds: idle_seconds(),
            ..Default::default()
        }))
    }

    async fn edit(&self, req: Request<EditRequest>) -> R<EditResponse> {
        let req = req.into_inner();
        let mut st = self.0.state.lock().unwrap();
        let cand = cand(&mut st, &req.candidate_id)?;
        match cand.config.edit(&req.path, &req.lines) {
            Ok(diagnostics) => {
                let output = diagnostics.iter().map(|d| format!("note: {}", d.message)).collect::<Vec<_>>().join("\n");
                Ok(Response::new(EditResponse {
                    diagnostics,
                    output,
                    last_activity: Some(timestamp(Utc::now())),
                    expires_at: expiry(),
                    ..Default::default()
                }))
            }
            Err(r) => Err(refused(tonic::Code::InvalidArgument, r.message, vec![r.diagnostic], Reason::Grammar)),
        }
    }

    async fn show_candidate(&self, req: Request<CandidateRef>) -> R<ConfigText> {
        let c = self.candidate_config(&req.into_inner().candidate_id)?;
        Ok(Response::new(ConfigText { text: c.render(), revision: String::new(), ..Default::default() }))
    }

    async fn compare(&self, req: Request<CandidateRef>) -> R<CompareResponse> {
        let c = self.candidate_config(&req.into_inner().candidate_id)?;
        let running = self.0.state.lock().unwrap().running.render();
        let diff = config::compare(&running, &c.render());
        Ok(Response::new(CompareResponse { changed: !diff.is_empty(), diff, ..Default::default() }))
    }

    async fn check(&self, req: Request<CandidateRef>) -> R<CheckResponse> {
        let c = self.candidate_config(&req.into_inner().candidate_id)?;
        let st = self.0.state.lock().unwrap();
        let g = gates(&st.running, &c, st.subscribers as u64);
        let mut out: Vec<String> = g.diagnostics.iter().map(|d| format!("warning: {}", d.message)).collect();
        for (word, list) in [("remap", &g.remap), ("cutoff", &g.cutoff), ("diverge", &g.diverge)] {
            for item in list {
                out.push(format!("{word}: {item} (commit needs acknowledge {word})"));
            }
        }
        out.push("configuration check succeeds".into());
        Ok(Response::new(CheckResponse {
            passed: true,
            diagnostics: g.diagnostics,
            remap: g.remap,
            cutoff: g.cutoff,
            diverge: g.diverge,
            output: out.join("\n"),
            ..Default::default()
        }))
    }

    async fn commit(&self, req: Request<CommitRequest>) -> R<CommitResponse> {
        let req = req.into_inner();
        let shared = self.0.clone();
        let mut st = shared.state.lock().unwrap();
        cand(&mut st, &req.candidate_id)?;
        let cand = &st.candidates[&req.candidate_id];
        if let Some(p) = &st.pending {
            return Err(refused(
                tonic::Code::FailedPrecondition,
                format!("a commit confirmed is pending (rollback at {})", p.deadline.to_rfc3339()),
                vec![],
                Reason::ConfirmPending,
            ));
        }
        if cand.base_revision != st.revision() {
            return Err(refused_with(
                tonic::Code::FailedPrecondition,
                "running configuration changed since the candidate was opened",
                vec![],
                Diagnostics { reason: Reason::StaleBase as i32, running_revision: format!("r{}", st.revision()), ..Default::default() },
            ));
        }
        let g = gates(&st.running, &cand.config, st.subscribers as u64);
        let mut missing = Vec::new();
        let mut first_gate: Option<(Reason, Vec<String>)> = None;
        for (word, list, ack) in [
            ("remap", &g.remap, req.acknowledge_remap),
            ("cutoff", &g.cutoff, req.acknowledge_cutoff),
            ("diverge", &g.diverge, req.acknowledge_diverge),
        ] {
            if !list.is_empty() && !ack {
                let message = match word {
                    "remap" => "commit would remap subscribers; acknowledge remap".to_string(),
                    "cutoff" => "commit would stop advertising the prefix carrying this session; acknowledge cutoff".to_string(),
                    _ => "commit would make pools diverge from the HA peer; acknowledge diverge".to_string(),
                };
                missing.push(diag(Severity::Error, message, &[], ""));
                let reason = match word {
                    "remap" => Reason::GateRemap,
                    "cutoff" => Reason::GateCutoff,
                    _ => Reason::GateDiverge,
                };
                first_gate.get_or_insert((reason, list.clone()));
            }
        }
        if let Some((reason, gate_items)) = first_gate {
            let first = missing[0].message.clone();
            return Err(refused_with(
                tonic::Code::FailedPrecondition,
                first,
                missing,
                Diagnostics { reason: reason as i32, gate_items, ..Default::default() },
            ));
        }

        let cand = st.candidates.remove(&req.candidate_id).expect("candidate checked above");
        let previous = std::mem::replace(&mut st.running, cand.config);
        let comment = if req.comment.is_empty() { "commit".to_string() } else { req.comment.clone() };
        let number = st.push_revision(comment.clone());
        shared.emit_commit(format!("r{number}"), comment);

        let mut confirm_deadline = None;
        let mut output = format!("commit complete (revision r{number})");
        if req.confirmed_minutes > 0 {
            let token = st.next_token;
            st.next_token += 1;
            let deadline = Utc::now() + chrono::Duration::minutes(i64::from(req.confirmed_minutes));
            st.pending = Some(Pending {
                token,
                deadline,
                previous,
                revision: format!("r{number}"),
                account: "mock".into(),
                comment: req.comment.clone(),
                committed_at: Utc::now(),
                minutes: req.confirmed_minutes,
            });
            confirm_deadline = Some(timestamp(deadline));
            output = format!(
                "commit confirmed will be automatically rolled back in {} minutes unless confirmed (revision r{number})",
                req.confirmed_minutes
            );
            shared.emit("confirm-pending", format!("rollback at {}", deadline.to_rfc3339()));
            let timer = shared.clone();
            let wait = std::time::Duration::from_secs(u64::from(req.confirmed_minutes) * 60);
            tokio::spawn(async move {
                tokio::time::sleep(wait).await;
                let mut st = timer.state.lock().unwrap();
                if st.pending.as_ref().is_some_and(|p| p.token == token) {
                    let p = st.pending.take().expect("checked above");
                    st.running = p.previous;
                    st.push_revision("rolled back: commit confirmed expired".into());
                    timer.emit("rolled-back", "commit confirmed expired");
                }
            });
        }

        Ok(Response::new(CommitResponse { revision: format!("r{number}"), confirm_deadline, diagnostics: vec![], output, ..Default::default() }))
    }

    async fn confirm(&self, _: Request<ConfirmRequest>) -> R<ConfirmResponse> {
        let mut st = self.0.state.lock().unwrap();
        if st.pending.take().is_none() {
            return Err(refused(tonic::Code::FailedPrecondition, "no commit confirmed is pending", vec![], Reason::Other));
        }
        self.0.emit("confirmed", format!("revision r{}", st.revision()));
        Ok(Response::new(ConfirmResponse { diagnostics: vec![], output: "commit confirmed".into(), ..Default::default() }))
    }

    async fn rollback(&self, req: Request<RollbackRequest>) -> R<EditResponse> {
        let req = req.into_inner();
        let mut st = self.0.state.lock().unwrap();
        let snapshot = st
            .by_rollback_number(req.revision)
            .map(|r| r.config.clone())
            .ok_or_else(|| refused(tonic::Code::InvalidArgument, format!("no revision {}", req.revision), vec![], Reason::Usage))?;
        let cand = cand(&mut st, &req.candidate_id)?;
        cand.config = snapshot;
        Ok(Response::new(EditResponse { diagnostics: vec![], output: "load complete".into(), ..Default::default() }))
    }

    async fn save(&self, _: Request<SaveRequest>) -> R<SaveResponse> {
        self.0.emit("saved", "/etc/prisma/prisma.conf");
        Ok(Response::new(SaveResponse { output: "configuration saved to /etc/prisma/prisma.conf".into(), ..Default::default() }))
    }

    async fn close_candidate(&self, req: Request<CandidateRef>) -> R<CloseResponse> {
        let id = req.into_inner().candidate_id;
        let mut st = self.0.state.lock().unwrap();
        st.candidates.remove(&id).ok_or_else(|| not_found(&id, st.expired.contains(&id)))?;
        Ok(Response::new(CloseResponse {}))
    }

    async fn get_pending_confirm(&self, _: Request<GetPendingConfirmRequest>) -> R<PendingConfirm> {
        let st = self.0.state.lock().unwrap();
        Ok(Response::new(match &st.pending {
            None => PendingConfirm::default(),
            Some(p) => PendingConfirm {
                pending: true,
                revision: p.revision.clone(),
                deadline: Some(timestamp(p.deadline)),
                account: p.account.clone(),
                comment: p.comment.clone(),
                committed_at: Some(timestamp(p.committed_at)),
                minutes: p.minutes,
                revert_attempts: 0,
                overdue: Utc::now() > p.deadline,
                ..Default::default()
            },
        }))
    }

    async fn list_candidates(&self, _: Request<ListCandidatesRequest>) -> R<ListCandidatesResponse> {
        let st = self.0.state.lock().unwrap();
        let idle = crate::state::candidate_idle();
        let mut candidates: Vec<_> = st
            .candidates
            .iter()
            .map(|(id, c)| {
                let last = Utc::now() - chrono::Duration::from_std(c.touched.elapsed()).unwrap_or_default();
                CandidateInfo {
                    candidate_id: id.clone(),
                    base_revision: format!("r{}", c.base_revision),
                    created_at: Some(timestamp(c.created)),
                    last_activity: Some(timestamp(last)),
                    expires_at: Some(timestamp(last + chrono::Duration::from_std(idle).unwrap_or_default())),
                    staged_lines: crate::config::compare(&st.running.render(), &c.config.render())
                        .lines()
                        .filter(|l| l.starts_with('+') || l.starts_with('-'))
                        .count() as u32,
                    ..Default::default()
                }
            })
            .collect();
        candidates.sort_by_key(|c| c.created_at.map(|t| (t.seconds, t.nanos)));
        Ok(Response::new(ListCandidatesResponse { candidates, idle_seconds: idle_seconds(), ..Default::default() }))
    }

    async fn get_running(&self, _: Request<GetRunningRequest>) -> R<ConfigText> {
        let st = self.0.state.lock().unwrap();
        Ok(Response::new(ConfigText { text: st.running.render(), revision: format!("r{}", st.revision()), ..Default::default() }))
    }

    async fn list_revisions(&self, _: Request<ListRevisionsRequest>) -> R<ListRevisionsResponse> {
        let st = self.0.state.lock().unwrap();
        let revisions = st
            .revisions
            .iter()
            .rev()
            .enumerate()
            .map(|(n, r)| Revision {
                number: n as u32,
                committed_at: Some(timestamp(r.committed_at)),
                comment: r.comment.clone(),
                ..Default::default()
            })
            .collect();
        Ok(Response::new(ListRevisionsResponse { revisions, ..Default::default() }))
    }
}
