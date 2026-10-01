//! Perfis TLS: diretórios montados somente leitura com o certificado da CA do
//! Prisma e o par (certificado, chave) do cliente. A chave nunca passa pela API
//! nem pelo banco; o banco guarda só o nome do perfil (issue #4).
//!
//! Layout: `<raiz>/<grupo>/<perfil>/{ca.crt, <nome>.crt, <nome>.key}`. O id do
//! perfil é o caminho relativo, ex.: `host/prisma-api`.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tonic::transport::{Certificate, ClientTlsConfig, Identity};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct ProfileInfo {
    pub id: String,
    /// CN do certificado do cliente: a conta que o Prisma vê.
    pub account: Option<String>,
    pub ca: Option<String>,
    pub not_after: Option<String>,
    /// Problema que impede o uso do perfil, se houver.
    pub error: Option<String>,
}

#[derive(Debug)]
struct Files {
    ca: PathBuf,
    cert: PathBuf,
    key: PathBuf,
}

/// Lista os perfis sob `root` (até dois níveis), com o que dá para ler sem a chave.
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

/// Configuração TLS do cliente para um perfil e o nome que o servidor apresenta.
pub fn client_config(root: &Path, profile: &str, server_name: &str) -> AppResult<ClientTlsConfig> {
    let dir = resolve(root, profile)?;
    let f = files(&dir).map_err(|e| AppError::BadRequest(format!("perfil TLS '{profile}': {e}")))?;
    let read = |p: &Path| {
        std::fs::read(p).map_err(|e| AppError::BadRequest(format!("perfil TLS '{profile}': não li {}: {e}", file_name(p))))
    };
    Ok(ClientTlsConfig::new()
        .ca_certificate(Certificate::from_pem(read(&f.ca)?))
        .identity(Identity::from_pem(read(&f.cert)?, read(&f.key)?))
        .domain_name(server_name))
}

/// Confere que o perfil existe e está completo (usado no cadastro).
pub fn check(root: &Path, profile: &str) -> AppResult<ProfileInfo> {
    let dir = resolve(root, profile)?;
    let f = files(&dir).map_err(|e| AppError::BadRequest(format!("perfil TLS '{profile}': {e}")))?;
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
        Err(AppError::BadRequest("nome do servidor inválido (ex.: prisma-api)".into()))
    }
}

/// O id vem do cliente: só aceita caminho relativo simples, sem `..`.
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
        return Err(AppError::BadRequest(format!("perfil TLS inválido: '{profile}'")));
    }
    let dir = root.join(rel);
    if !dir.is_dir() {
        return Err(AppError::BadRequest(format!("perfil TLS '{profile}' não existe")));
    }
    Ok(dir)
}

/// `ca.crt` mais exatamente um par `<nome>.crt` / `<nome>.key`.
fn files(dir: &Path) -> Result<Files, String> {
    let ca = dir.join("ca.crt");
    if !ca.is_file() {
        return Err("falta ca.crt".into());
    }
    let mut certs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("não li o diretório: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "crt") && p.file_name().is_some_and(|n| n != "ca.crt"))
        .collect();
    certs.sort();
    let cert = match certs.as_slice() {
        [one] => one.clone(),
        [] => return Err("falta o certificado do cliente (<nome>.crt)".into()),
        _ => return Err("há mais de um certificado de cliente; deixe um só par <nome>.crt/<nome>.key".into()),
    };
    let key = cert.with_extension("key");
    if !key.is_file() {
        return Err(format!("falta {}", file_name(&key)));
    }
    Ok(Files { ca, cert, key })
}

fn describe(id: String, f: &Files) -> ProfileInfo {
    let (account, not_after, err) = match cert_info(&f.cert) {
        Ok((cn, na)) => (cn, Some(na), None),
        Err(e) => (None, None, Some(e)),
    };
    let ca = cert_info(&f.ca).ok().and_then(|(cn, _)| cn);
    // A chave não é lida aqui; só se ela é legível pelo processo.
    let key_err = std::fs::File::open(&f.key).err().map(|e| format!("chave ilegível: {e}"));
    ProfileInfo { id, account, ca, not_after, error: err.or(key_err) }
}

fn cert_info(path: &Path) -> Result<(Option<String>, String), String> {
    let pem = std::fs::read(path).map_err(|e| format!("não li {}: {e}", file_name(path)))?;
    let (_, pem) = x509_parser::pem::parse_x509_pem(&pem).map_err(|_| format!("{} não é PEM", file_name(path)))?;
    let cert = pem.parse_x509().map_err(|_| format!("{} não é um certificado X.509", file_name(path)))?;
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
        assert!(files(&dir).unwrap_err().contains("certificado do cliente"));
        std::fs::write(dir.join("web.crt"), "x").unwrap();
        assert!(files(&dir).unwrap_err().contains("web.key"));
        std::fs::write(dir.join("web.key"), "x").unwrap();
        let f = files(&dir).unwrap();
        assert!(f.cert.ends_with("web.crt") && f.key.ends_with("web.key"));
        std::fs::write(dir.join("outro.crt"), "x").unwrap();
        assert!(files(&dir).unwrap_err().contains("mais de um"));
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
