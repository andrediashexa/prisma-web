//! TLS profiles: directories mounted read-only holding Prisma's CA certificate
//! and the client's (certificate, key) pair. The key never goes through the API
//! or the database; the database stores only the profile name (issue #4).
//!
//! Layout: `<root>/<group>/<profile>/{ca.crt, <name>.crt, <name>.key}`. The
//! profile id is the relative path, e.g. `host/prisma-api`.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tonic::transport::{Certificate, ClientTlsConfig, Identity};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct ProfileInfo {
    pub id: String,
    /// CN of the client certificate: the account Prisma sees.
    pub account: Option<String>,
    pub ca: Option<String>,
    pub not_after: Option<String>,
    /// Problem that prevents using the profile, if any.
    pub error: Option<String>,
}

#[derive(Debug)]
struct Files {
    ca: PathBuf,
    cert: PathBuf,
    key: PathBuf,
}

/// Lists the profiles under `root` (up to two levels), with what can be read without the key.
pub fn list(root: &Path) -> Vec<ProfileInfo> {
    let mut out = Vec::new();
    for dir in subdirs(root).into_iter().flat_map(|d| {
        let mut v = vec![d.clone()];
        v.extend(subdirs(&d));
        v
    }) {
        if !dir.join("ca.crt").exists() {
            continue;
        }
        let id = dir.strip_prefix(root).unwrap_or(&dir).to_string_lossy().into_owned();
        out.push(match files(&dir) {
            Ok(f) => describe(id, &f),
            Err(e) => ProfileInfo { id, account: None, ca: None, not_after: None, error: Some(e) },
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Client TLS configuration for a profile and the name the server presents.
pub fn client_config(root: &Path, profile: &str, server_name: &str) -> AppResult<ClientTlsConfig> {
    let dir = resolve(root, profile)?;
    let f = files(&dir).map_err(|e| AppError::BadRequest(format!("TLS profile '{profile}': {e}")))?;
    let read = |p: &Path| {
        std::fs::read(p).map_err(|e| AppError::BadRequest(format!("TLS profile '{profile}': cannot read {}: {e}", file_name(p))))
    };
    Ok(ClientTlsConfig::new()
        .ca_certificate(Certificate::from_pem(read(&f.ca)?))
        .identity(Identity::from_pem(read(&f.cert)?, read(&f.key)?))
        .domain_name(server_name))
}

/// Checks that the profile exists and is complete (used on registration).
pub fn check(root: &Path, profile: &str) -> AppResult<ProfileInfo> {
    let dir = resolve(root, profile)?;
    let f = files(&dir).map_err(|e| AppError::BadRequest(format!("TLS profile '{profile}': {e}")))?;
    Ok(describe(profile.to_string(), &f))
}

pub fn validate_server_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    let ok = !n.is_empty()
        && n.len() <= 253
        && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    if ok {
        Ok(n.to_string())
    } else {
        Err(AppError::BadRequest("invalid server name (e.g. prisma-api)".into()))
    }
}

/// The id comes from the client: accepts only a simple relative path, no `..`.
fn resolve(root: &Path, profile: &str) -> AppResult<PathBuf> {
    let rel = Path::new(profile);
    let simple = !profile.is_empty()
        && rel.components().all(|c| match c {
            Component::Normal(s) => s
                .to_str()
                .is_some_and(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))),
            _ => false,
        });
    if !simple || rel.components().count() > 2 {
        return Err(AppError::BadRequest(format!("invalid TLS profile: '{profile}'")));
    }
    let dir = root.join(rel);
    if !dir.is_dir() {
        return Err(AppError::BadRequest(format!("TLS profile '{profile}' does not exist")));
    }
    Ok(dir)
}

/// `ca.crt` plus exactly one `<name>.crt` / `<name>.key` pair.
fn files(dir: &Path) -> Result<Files, String> {
    let ca = dir.join("ca.crt");
    if !ca.is_file() {
        return Err("missing ca.crt".into());
    }
    let mut certs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read the directory: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "crt") && p.file_name().is_some_and(|n| n != "ca.crt"))
        .collect();
    certs.sort();
    let cert = match certs.as_slice() {
        [one] => one.clone(),
        [] => return Err("missing the client certificate (<name>.crt)".into()),
        _ => return Err("more than one client certificate; keep a single <name>.crt/<name>.key pair".into()),
    };
    let key = cert.with_extension("key");
    if !key.is_file() {
        return Err(format!("missing {}", file_name(&key)));
    }
    Ok(Files { ca, cert, key })
}

fn describe(id: String, f: &Files) -> ProfileInfo {
    let (account, not_after, err) = match cert_info(&f.cert) {
        Ok((cn, na)) => (cn, Some(na), None),
        Err(e) => (None, None, Some(e)),
    };
    let ca = cert_info(&f.ca).ok().and_then(|(cn, _)| cn);
    // The key is not read here; only whether the process can read it.
    let key_err = std::fs::File::open(&f.key).err().map(|e| format!("unreadable key: {e}"));
    ProfileInfo { id, account, ca, not_after, error: err.or(key_err) }
}

fn cert_info(path: &Path) -> Result<(Option<String>, String), String> {
    let pem = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", file_name(path)))?;
    let (_, pem) = x509_parser::pem::parse_x509_pem(&pem).map_err(|_| format!("{} is not PEM", file_name(path)))?;
    let cert = pem.parse_x509().map_err(|_| format!("{} is not an X.509 certificate", file_name(path)))?;
    let cn = cert.subject().iter_common_name().next().and_then(|c| c.as_str().ok()).map(str::to_string);
    let not_after = cert.validity().not_after.to_datetime();
    Ok((cn, not_after.to_string()))
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|it| it.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_ids_cannot_escape_the_root() {
        let root = std::env::temp_dir();
        for bad in ["../etc", "/etc", "a/../../b", "a/b/c", "", "a b", "host/..", "./x"] {
            assert!(resolve(&root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn profile_needs_ca_and_exactly_one_client_pair() {
        let dir = std::env::temp_dir().join(format!("pw-tls-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(files(&dir).unwrap_err().contains("ca.crt"));
        std::fs::write(dir.join("ca.crt"), "x").unwrap();
        assert!(files(&dir).unwrap_err().contains("client certificate"));
        std::fs::write(dir.join("web.crt"), "x").unwrap();
        assert!(files(&dir).unwrap_err().contains("web.key"));
        std::fs::write(dir.join("web.key"), "x").unwrap();
        let f = files(&dir).unwrap();
        assert!(f.cert.ends_with("web.crt") && f.key.ends_with("web.key"));
        std::fs::write(dir.join("other.crt"), "x").unwrap();
        assert!(files(&dir).unwrap_err().contains("more than one"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn server_name_validation() {
        assert_eq!(validate_server_name(" prisma-api ").unwrap(), "prisma-api");
        assert!(validate_server_name("192.0.2.166").is_ok());
        assert!(validate_server_name("").is_err());
        assert!(validate_server_name("a b").is_err());
    }
}
