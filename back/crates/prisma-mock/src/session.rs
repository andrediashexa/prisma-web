//! `SessionService.WhoAmI` (Prisma 0.149.2): the account is the client
//! certificate's Common Name, and its role comes from `MOCK_ACCOUNTS`
//! (`cn=role,cn=role`), standing in for the box's VTY logins.

use prisma_proto::v1::session_service_server::SessionService;
use prisma_proto::v1::{WhoAmIRequest, WhoAmIResponse};
use tonic::{Request, Response, Status};

/// Without `MOCK_ACCOUNTS`: the dev client certificate administers, `noc` only
/// reads and `cgnat-ops` changes CGNAT. A certificate not listed reads only.
const DEFAULT_ACCOUNTS: &str = "prisma-web-dev=administrator,noc=read-only,cgnat-ops=cgnat-operator";
/// The account of a call without TLS (the plain mock); it administers.
const PLAIN_ACCOUNT: &str = "mock";

pub struct SessionSvc;

#[tonic::async_trait]
impl SessionService for SessionSvc {
    async fn who_am_i(&self, req: Request<WhoAmIRequest>) -> Result<Response<WhoAmIResponse>, Status> {
        Ok(Response::new(identity(&account_of(&req))))
    }
}

/// CN of the peer certificate, or the plain account without TLS.
pub fn account_of<T>(req: &Request<T>) -> String {
    req.peer_certs()
        .and_then(|certs| {
            let cert = certs.first()?;
            let (_, x) = x509_parser::parse_x509_certificate(cert.as_ref()).ok()?;
            let cn = x.subject().iter_common_name().next()?.as_str().ok()?.to_string();
            Some(cn)
        })
        .unwrap_or_else(|| PLAIN_ACCOUNT.into())
}

pub fn identity(account: &str) -> WhoAmIResponse {
    let role = role_of(account, &std::env::var("MOCK_ACCOUNTS").unwrap_or_else(|_| DEFAULT_ACCOUNTS.into()));
    WhoAmIResponse {
        account: account.into(),
        can_configure: role == "administrator",
        can_configure_cgnat: role != "read-only",
        role,
        ..Default::default()
    }
}

fn role_of(account: &str, accounts: &str) -> String {
    if account == PLAIN_ACCOUNT {
        return "administrator".into();
    }
    accounts
        .split(',')
        .filter_map(|kv| kv.split_once('='))
        .find(|(cn, _)| cn.trim() == account)
        .map_or("read-only", |(_, role)| role.trim())
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_come_from_the_account_list() {
        assert_eq!(role_of("noc", DEFAULT_ACCOUNTS), "read-only");
        assert_eq!(role_of("prisma-web-dev", DEFAULT_ACCOUNTS), "administrator");
        assert_eq!(role_of("stranger", DEFAULT_ACCOUNTS), "read-only");
        assert_eq!(role_of(PLAIN_ACCOUNT, ""), "administrator");
        let cgnat = identity("cgnat-ops");
        assert!(!cgnat.can_configure && cgnat.can_configure_cgnat);
    }
}
