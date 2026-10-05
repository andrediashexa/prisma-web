//! `SystemService` (Prisma 0.149.25, #50): the VTY's `system` statements.
//! On a real box they are root's; `MOCK_SYSTEM_DENIED=1` refuses them as the
//! box refuses prisma-web's account, and the mock without it lets them run.
//! Nothing really reboots: the mock answers what the box would.

use std::time::Duration;

use chrono::Utc;
use prisma_proto::v1::diagnostics::Reason;
use prisma_proto::v1::system_service_server::SystemService;
use prisma_proto::v1::upgrade_progress::Phase;
use prisma_proto::v1::*;
use prisma_proto::with_diagnostics;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::codegen::BoxStream;
use tonic::{Request, Response, Status};

use crate::state::{timestamp, SharedRef};

pub struct SystemSvc(pub SharedRef);

/// The release the mock offers as the newest.
pub const NEWEST: &str = "0.149.26-mock";

fn refused(code: tonic::Code, reason: Reason, msg: &str) -> Status {
    let d = Diagnostics { reason: reason as i32, output: msg.into(), ..Default::default() };
    with_diagnostics(Status::new(code, msg), &d)
}

/// `MOCK_SYSTEM_DENIED=1`: prisma-web's account has no `operator` (0.149.26, #51).
pub fn denied_env() -> bool {
    std::env::var("MOCK_SYSTEM_DENIED").is_ok_and(|v| v == "1")
}

fn denied() -> Option<Status> {
    denied_env().then(|| {
        refused(
            tonic::Code::PermissionDenied,
            Reason::Permission,
            "% system: this command is root's or a prisma-operator's (the account prisma-web is neither)",
        )
    })
}

fn away_seconds() -> u32 {
    std::env::var("MOCK_API_AWAY_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(5)
}

fn running_upgrade(st: &crate::state::State) -> bool {
    st.upgrade.as_ref().is_some_and(|u| !matches!(u.phase(), Phase::ApiRestart | Phase::Failed | Phase::Checked))
}

impl SystemSvc {
    /// Reboot and Shutdown: refused while unsaved or inside a confirm window, unless `force`.
    fn power(&self, req: &SystemActionRequest, what: &str) -> Result<Response<SystemActionResponse>, Status> {
        if let Some(e) = denied() {
            return Err(e);
        }
        let st = self.0.state.lock().unwrap();
        if !req.force {
            if st.pending.is_some() {
                return Err(refused(tonic::Code::FailedPrecondition, Reason::ConfirmPending, "% a commit confirmed is waiting for its confirmation"));
            }
            if st.revision() != st.saved_revision {
                return Err(refused(tonic::Code::FailedPrecondition, Reason::Unsaved, "% the running configuration is not saved: the next boot loads another"));
            }
        }
        drop(st);
        // A reboot boots with what the configuration says about SFP+ modules (0.151.2, #69).
        let mut st = self.0.state.lock().unwrap();
        st.unsupported_sfp_booted = st.running.unsupported_sfp_allowed();
        drop(st);
        self.0.emit("system", format!("system {what} (simulated)"));
        Ok(Response::new(SystemActionResponse { output: format!("the box will {what} now (simulated)"), ..Default::default() }))
    }
}

#[tonic::async_trait]
impl SystemService for SystemSvc {
    async fn reboot(&self, req: Request<SystemActionRequest>) -> Result<Response<SystemActionResponse>, Status> {
        self.power(req.get_ref(), "reboot")
    }

    async fn shutdown(&self, req: Request<SystemActionRequest>) -> Result<Response<SystemActionResponse>, Status> {
        self.power(req.get_ref(), "shut down")
    }

    async fn restart_dataplane(&self, _: Request<SystemActionRequest>) -> Result<Response<SystemActionResponse>, Status> {
        if let Some(e) = denied() {
            return Err(e);
        }
        {
            let mut st = self.0.state.lock().unwrap();
            if running_upgrade(&st) {
                return Err(refused(tonic::Code::FailedPrecondition, Reason::Busy, "% an upgrade is running"));
            }
            match st.restart_answer.take().as_deref() {
                Some("drops") => return Err(Status::unavailable("Socket closed")),
                Some("apply-failed") => {
                    return Err(refused(
                        tonic::Code::FailedPrecondition,
                        Reason::ApplyFailed,
                        "% the dataplane restarted but its configuration did not load yet",
                    ))
                }
                _ => {}
            }
        }
        Ok(Response::new(SystemActionResponse { output: "dataplane restarted (simulated)".into(), ..Default::default() }))
    }

    /// STARTED, DOWNLOAD, VERIFY, INSTALL per row, INSTALLED, API_RESTART, and the stream ends;
    /// an empty version only checks.
    async fn upgrade(&self, req: Request<UpgradeRequest>) -> Result<Response<BoxStream<UpgradeProgress>>, Status> {
        let version = req.into_inner().version.trim().to_string();
        // The check is every account's since 0.149.26 (#51).
        if let Some(e) = denied().filter(|_| !version.is_empty()) {
            return Err(e);
        }
        let started_at = Some(timestamp(Utc::now()));
        let p = |phase: Phase, message: &str| UpgradeProgress {
            phase: phase as i32,
            message: message.into(),
            version: version.clone(),
            newest: NEWEST.into(),
            started_at,
            ..Default::default()
        };
        let mut phases = vec![];
        {
            let mut st = self.0.state.lock().unwrap();
            if running_upgrade(&st) {
                return Err(refused(tonic::Code::FailedPrecondition, Reason::Busy, "% an upgrade is already running"));
            }
            if version.is_empty() {
                phases.push(p(Phase::Checked, &format!("the newest release is {NEWEST}")));
            } else if version != NEWEST {
                phases.push(p(Phase::Started, &format!("upgrading to {version}")));
                let mut f = p(Phase::Failed, &format!("release {version} not found"));
                f.output = format!("curl: (22) The requested URL returned error: 404 ({version})");
                f.diagnostics = Some(Diagnostics { reason: Reason::Other as i32, output: f.output.clone(), ..Default::default() });
                phases.push(f);
            } else {
                phases.push(p(Phase::Started, &format!("upgrading to {version}")));
                phases.push(p(Phase::Download, "prisma-routing_0.149.26.deb"));
                phases.push(p(Phase::Verify, "sha256 ok"));
                phases.push(p(Phase::Install, "prisma-routing"));
                phases.push(p(Phase::Install, "prisma-routing-plugin"));
                phases.push(p(Phase::Installed, &format!("{version} installed")));
                let mut r = p(Phase::ApiRestart, "the API restarts now");
                r.api_away_seconds = away_seconds();
                phases.push(r);
            }
            st.upgrade = phases.first().cloned();
        }
        let (tx, rx) = mpsc::channel(16);
        let shared = self.0.clone();
        tokio::spawn(async move {
            for ph in phases {
                tokio::time::sleep(Duration::from_millis(300)).await;
                shared.state.lock().unwrap().upgrade = Some(ph.clone());
                if tx.send(Ok(ph)).await.is_err() {
                    // The box goes on without the client: GetUpgradeStatus reads the run back.
                    continue;
                }
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }

    async fn get_upgrade_status(&self, _: Request<GetUpgradeStatusRequest>) -> Result<Response<UpgradeProgress>, Status> {
        if let Some(e) = denied() {
            return Err(e);
        }
        // As the box: NOT_FOUND until a run was started through the API.
        match self.0.state.lock().unwrap().upgrade.clone() {
            Some(p) => Ok(Response::new(p)),
            None => Err(Status::not_found("no upgrade was started through the API on this box")),
        }
    }
}
