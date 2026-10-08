//! Helpers for calling Prisma over gRPC.

use std::time::Duration;

use tonic::{Code, Status};

/// Default timeout of a call; the console (`Show`) uses a longer one.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(10);
pub const SHOW_TIMEOUT: Duration = Duration::from_secs(30);
/// Reads of the running configuration (GetRunning, GetConfig): before Prisma
/// 0.149.21 an account with no configuration role waited about 90 s for them
/// (prismarouting #561), so `clients.md` asks for at least 120 s.
pub const RUNNING_TIMEOUT: Duration = Duration::from_secs(120);
/// A `ListRoutes` page waits up to 60 s for the box's snapshot to reach it
/// (docs/prisma-api.md, "The routing table"), then answers what it has.
pub const ROUTES_TIMEOUT: Duration = Duration::from_secs(65);

/// What applies or stages configuration (Commit, Check, Edit, SetConfig, DeleteConfig, Confirm,
/// Rollback): since Prisma 0.152.7 a commit that moves interfaces between VRFs waits for FRR's
/// zebra up to 10 s a move (#84), and a commit the box applied must not read as failed.
pub const COMMIT_TIMEOUT: Duration = Duration::from_secs(120);

pub fn req<T>(msg: T) -> tonic::Request<T> {
    req_with(msg, CALL_TIMEOUT)
}

pub fn req_with<T>(msg: T, timeout: Duration) -> tonic::Request<T> {
    let mut r = tonic::Request::new(msg);
    r.set_timeout(timeout);
    r
}

/// Short description of a failed call.
pub fn describe(status: &Status) -> String {
    let what = match status.code() {
        Code::Unavailable => "Prisma unreachable",
        Code::DeadlineExceeded => "Prisma did not answer in time",
        Code::PermissionDenied => "the account has no permission",
        Code::Unimplemented => "Prisma does not implement this call",
        _ => "Prisma refused",
    };
    if status.message().is_empty() {
        what.to_string()
    } else {
        format!("{what}: {}", status.message())
    }
}
