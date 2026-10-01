//! Utilidades para chamar o Prisma por gRPC.

use std::time::Duration;

use tonic::{Code, Status};

/// Timeout padrão de uma chamada; o console (`Show`) usa um maior.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(10);
pub const SHOW_TIMEOUT: Duration = Duration::from_secs(30);

pub fn req<T>(msg: T) -> tonic::Request<T> {
    req_with(msg, CALL_TIMEOUT)
}

pub fn req_with<T>(msg: T, timeout: Duration) -> tonic::Request<T> {
    let mut r = tonic::Request::new(msg);
    r.set_timeout(timeout);
    r
}

/// Descrição curta, em português, de uma falha de chamada.
pub fn describe(status: &Status) -> String {
    let what = match status.code() {
        Code::Unavailable => "Prisma inacessível",
        Code::DeadlineExceeded => "o Prisma não respondeu a tempo",
        Code::PermissionDenied => "a conta não tem permissão",
        Code::Unimplemented => "o Prisma não implementa esta chamada",
        _ => "o Prisma recusou",
    };
    if status.message().is_empty() {
        what.to_string()
    } else {
        format!("{what}: {}", status.message())
    }
}
