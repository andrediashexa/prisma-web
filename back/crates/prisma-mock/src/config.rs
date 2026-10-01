//! Modelo de configuração do mock, renderizado no formato de texto do VTY.
//!
//! Interfaces são estruturadas (para a simulação saber o que está desligado);
//! o resto é guardado como blocos genéricos: um caminho de hierarquia e as
//! linhas digitadas nele, exatamente como o operador as escreveu.

use std::net::IpAddr;

use prisma_proto::v1::diagnostic::Severity;
use prisma_proto::v1::Diagnostic;

pub const POOL_PATH: [&str; 3] = ["nat", "cgnat", "pool RFC6598"];
pub const BGP_PATH: [&str; 1] = ["router bgp 65000"];

#[derive(Clone, PartialEq)]
pub struct Iface {
    pub name: String,
    pub description: Option<String>,
    pub mtu: u32,
    pub shutdown: bool,
    pub v4: Vec<String>,
    pub v6: Vec<String>,
}

#[derive(Clone, PartialEq)]
pub struct Block {
    pub path: Vec<String>,
    pub lines: Vec<String>,
}

#[derive(Clone, PartialEq)]
pub struct Config {
    pub hostname: String,
    pub interfaces: Vec<Iface>,
    pub blocks: Vec<Block>,
}

/// Recusa de uma linha: mensagem do VTY e o diagnóstico correspondente.
pub struct Refusal {
    pub message: String,
    pub diagnostic: Diagnostic,
}

pub fn diag(severity: Severity, message: impl Into<String>, path: &[String], line: &str) -> Diagnostic {
    Diagnostic { severity: severity as i32, message: message.into(), path: path.to_vec(), line: line.into() }
}

fn refuse(message: impl Into<String>, path: &[String], line: &str) -> Refusal {
    let message = message.into();
    Refusal { diagnostic: diag(Severity::Error, message.clone(), path, line), message }
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

impl Config {
    pub fn seed(hostname: &str) -> Self {
        let iface = |name: &str, desc: &str, mtu, v4: &[&str], v6: &[&str]| Iface {
            name: name.into(),
            description: Some(desc.into()),
            mtu,
            shutdown: false,
            v4: strs(v4),
            v6: strs(v6),
        };
        Self {
            hostname: hostname.into(),
            interfaces: vec![
                iface("wan0", "Uplink operadora", 1500, &["203.0.113.10/29"], &["2001:db8:100::2/64"]),
                iface("lan0", "Rede interna", 1500, &["192.168.10.1/24"], &["2001:db8:200:10::1/64"]),
                iface("lan0.20", "VLAN convidados", 1500, &["192.168.20.1/24"], &["2001:db8:200:20::1/64"]),
                iface("wg0", "VPN de acesso remoto", 1420, &["10.8.0.1/24"], &["fd00:8::1/64"]),
                Iface {
                    name: "lo".into(),
                    description: None,
                    mtu: 65536,
                    shutdown: false,
                    v4: strs(&["127.0.0.1/8"]),
                    v6: strs(&["::1/128"]),
                },
            ],
            blocks: vec![
                Block {
                    path: strs(&POOL_PATH),
                    lines: strs(&[
                        "prefix-inside 100.64.0.0/10",
                        "prefix-outside 203.0.113.64/27",
                        "block-size 256",
                        "mode dynamic",
                    ]),
                },
                Block {
                    path: strs(&BGP_PATH),
                    lines: strs(&[
                        "neighbor 203.0.113.9 remote-as 64500",
                        "neighbor 2001:db8:100::1 remote-as 64500",
                    ]),
                },
            ],
        }
    }

    pub fn iface(&self, name: &str) -> Option<&Iface> {
        self.interfaces.iter().find(|i| i.name == name)
    }

    pub fn block(&self, path: &[&str]) -> Option<&Block> {
        self.blocks.iter().find(|b| b.path.iter().map(String::as_str).eq(path.iter().copied()))
    }

    pub fn pool_block_size(&self) -> u32 {
        self.block(&POOL_PATH)
            .and_then(|b| b.lines.iter().find_map(|l| l.strip_prefix("block-size ")))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(256)
    }

    /// Endereços de `prefix-outside` do pool (para a capacidade).
    pub fn pool_outside_addresses(&self) -> u64 {
        self.pool_prefixes("prefix-outside ")
            .iter()
            .filter_map(|p| p.split_once('/').and_then(|(_, l)| l.parse::<u32>().ok()))
            .map(|len| 1u64 << (32 - len.min(32)))
            .sum()
    }

    pub fn pool_prefixes(&self, keyword: &str) -> Vec<String> {
        self.block(&POOL_PATH)
            .map(|b| b.lines.iter().filter_map(|l| l.strip_prefix(keyword)).map(|s| s.trim().to_string()).collect())
            .unwrap_or_default()
    }

    pub fn pool_line(&self, keyword: &str, default: &str) -> String {
        self.block(&POOL_PATH)
            .and_then(|b| b.lines.iter().find_map(|l| l.strip_prefix(keyword)))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| default.to_string())
    }

    pub fn bgp_neighbors(&self) -> Vec<(String, u32)> {
        self.block(&BGP_PATH)
            .map(|b| {
                b.lines
                    .iter()
                    .filter_map(|l| {
                        let mut w = l.split_whitespace();
                        match (w.next(), w.next(), w.next(), w.next()) {
                            (Some("neighbor"), Some(peer), Some("remote-as"), Some(asn)) => {
                                Some((peer.to_string(), asn.parse().unwrap_or(0)))
                            }
                            _ => None,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Texto como `show running-config` o imprime.
    pub fn render(&self) -> String {
        let mut out = vec![format!("hostname {}", self.hostname), "!".to_string()];
        for i in &self.interfaces {
            out.push(format!("interface {}", i.name));
            if let Some(d) = &i.description {
                out.push(format!(" description {d}"));
            }
            // Ordem e palavras como no `show running-config` de um Prisma real (issue #9).
            out.extend(i.v4.iter().map(|a| format!(" ipv4 address {a}")));
            out.extend(i.v6.iter().map(|a| format!(" ipv6 address {a}")));
            if i.shutdown {
                out.push(" shutdown".into());
            }
            out.push(format!(" mtu {}", i.mtu));
            out.push(" exit".into());
        }
        for top in self.children(&[]) {
            self.render_tree(&[top], 0, &mut out);
            out.push("!".into());
        }
        out.push("end".into());
        out.join("\n") + "\n"
    }

    /// Próximos segmentos sob `prefix`, na ordem em que aparecem.
    fn children(&self, prefix: &[String]) -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        for b in &self.blocks {
            if b.path.len() > prefix.len() && b.path.starts_with(prefix) && !seen.contains(&b.path[prefix.len()]) {
                seen.push(b.path[prefix.len()].clone());
            }
        }
        seen
    }

    fn render_tree(&self, path: &[String], depth: usize, out: &mut Vec<String>) {
        let indent = " ".repeat(depth);
        out.push(format!("{indent}{}", path.last().expect("caminho não vazio")));
        if let Some(b) = self.blocks.iter().find(|b| b.path == path) {
            out.extend(b.lines.iter().map(|l| format!("{indent} {l}")));
        }
        for child in self.children(path) {
            let mut p = path.to_vec();
            p.push(child);
            self.render_tree(&p, depth + 1, out);
        }
    }

    /// Aplica as linhas na ordem; para na primeira recusada, mantendo as anteriores.
    pub fn edit(&mut self, path: &[String], lines: &[String]) -> Result<Vec<Diagnostic>, Refusal> {
        let mut notes = Vec::new();
        for raw in lines {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            if path.is_empty() {
                self.edit_top(line)?;
            } else if let Some(name) = path[0].strip_prefix("interface ").filter(|_| path.len() == 1) {
                if let Some(note) = self.edit_iface(name.trim(), path, line)? {
                    notes.push(note);
                }
            } else {
                self.edit_block(path, line);
            }
        }
        Ok(notes)
    }

    fn edit_top(&mut self, line: &str) -> Result<(), Refusal> {
        match line.strip_prefix("hostname ").map(str::trim) {
            Some(h) if !h.is_empty() && !h.contains(char::is_whitespace) => {
                self.hostname = h.to_string();
                Ok(())
            }
            Some(_) => Err(refuse("invalid hostname", &[], line)),
            None => Err(refuse(format!("unknown command: {line}"), &[], line)),
        }
    }

    fn edit_iface(&mut self, name: &str, path: &[String], line: &str) -> Result<Option<Diagnostic>, Refusal> {
        let Some(i) = self.interfaces.iter_mut().find(|i| i.name == name) else {
            return Err(refuse(format!("interface {name} does not exist"), path, line));
        };
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.as_slice() {
            ["description", ..] => i.description = Some(line["description".len()..].trim().to_string()),
            ["no", "description", ..] => i.description = None,
            ["mtu", n] => match n.parse::<u32>() {
                Ok(m) if (1280..=9216).contains(&m) => i.mtu = m,
                _ => return Err(refuse("mtu must be between 1280 and 9216", path, line)),
            },
            ["shutdown"] => {
                i.shutdown = true;
                if !i.v4.is_empty() || !i.v6.is_empty() {
                    return Ok(Some(diag(Severity::Note, format!("traffic on {} will stop", i.name), path, line)));
                }
            }
            ["no", "shutdown"] => i.shutdown = false,
            [no @ .., fam @ ("ipv4" | "ipv6"), "address", cidr] if no.is_empty() || *no == ["no"] => {
                let v6 = *fam == "ipv6";
                if !valid_cidr(cidr, v6) {
                    let family = if v6 { "IPv6" } else { "IPv4" };
                    return Err(refuse(format!("invalid {family} prefix: {cidr}"), path, line));
                }
                let list = if v6 { &mut i.v6 } else { &mut i.v4 };
                if no.is_empty() {
                    if !list.iter().any(|a| a == cidr) {
                        list.push(cidr.to_string());
                    }
                } else if let Some(pos) = list.iter().position(|a| a == cidr) {
                    list.remove(pos);
                } else {
                    return Err(refuse(format!("address {cidr} is not configured on {name}"), path, line));
                }
            }
            _ => return Err(refuse(format!("unknown command: {line}"), path, line)),
        }
        Ok(None)
    }

    fn edit_block(&mut self, path: &[String], line: &str) {
        let idx = match self.blocks.iter().position(|b| b.path == path) {
            Some(i) => i,
            None => {
                self.blocks.push(Block { path: path.to_vec(), lines: Vec::new() });
                self.blocks.len() - 1
            }
        };
        let lines = &mut self.blocks[idx].lines;
        if let Some(rest) = line.strip_prefix("no ") {
            lines.retain(|l| l != rest.trim());
            return;
        }
        // Palavras-chave de valor único substituem a linha existente.
        let key = line.split_whitespace().next().unwrap_or_default();
        if matches!(key, "block-size" | "mode" | "policy") {
            if let Some(existing) = lines.iter_mut().find(|l| l.split_whitespace().next() == Some(key)) {
                *existing = line.to_string();
                return;
            }
        }
        if !lines.iter().any(|l| l == line) {
            lines.push(line.to_string());
        }
    }
}

pub fn valid_cidr(cidr: &str, v6: bool) -> bool {
    let Some((addr, len)) = cidr.split_once('/') else { return false };
    let Ok(len) = len.parse::<u8>() else { return false };
    match addr.parse::<IpAddr>() {
        Ok(IpAddr::V4(_)) => !v6 && len <= 32,
        Ok(IpAddr::V6(_)) => v6 && len <= 128,
        Err(_) => false,
    }
}

/// Rede de um endereço CIDR: `203.0.113.10/29` → `203.0.113.8/29`.
pub fn network(cidr: &str) -> Option<String> {
    let (addr, len) = cidr.split_once('/')?;
    let len: u32 = len.parse().ok()?;
    match addr.parse::<IpAddr>().ok()? {
        IpAddr::V4(a) => {
            let mask = if len == 0 { 0 } else { u32::MAX << (32 - len.min(32)) };
            Some(format!("{}/{len}", std::net::Ipv4Addr::from(u32::from(a) & mask)))
        }
        IpAddr::V6(a) => {
            let mask = if len == 0 { 0 } else { u128::MAX << (128 - len.min(128)) };
            Some(format!("{}/{len}", std::net::Ipv6Addr::from(u128::from(a) & mask)))
        }
    }
}

/// Diferença linha a linha (LCS), no estilo de `show configuration compare`:
/// `+ `/`- ` para o que muda e até duas linhas de contexto ao redor.
pub fn compare(old: &str, new: &str) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    // ops: (marcador, linha)
    let mut ops: Vec<(char, &str)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            ops.push((' ', a[i]));
            i += 1;
            j += 1;
        } else if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            ops.push(('+', b[j]));
            j += 1;
        } else {
            ops.push(('-', a[i]));
            i += 1;
        }
    }
    const CONTEXT: usize = 2;
    let changed: Vec<usize> = ops.iter().enumerate().filter(|(_, (c, _))| *c != ' ').map(|(k, _)| k).collect();
    if changed.is_empty() {
        return String::new();
    }
    let keep = |k: usize| changed.iter().any(|&c| c.abs_diff(k) <= CONTEXT);
    let mut out = Vec::new();
    let mut last: Option<usize> = None;
    for (k, (c, line)) in ops.iter().enumerate() {
        if !keep(k) {
            continue;
        }
        if last.is_some_and(|l| k > l + 1) {
            out.push("...".to_string());
        }
        out.push(format!("{c} {line}"));
        last = Some(k);
    }
    out.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &[&str]) -> Vec<String> {
        strs(s)
    }

    #[test]
    fn render_and_edit() {
        let mut c = Config::seed("x");
        let text = c.render();
        assert!(text.starts_with("hostname x\n!\ninterface wan0\n description Uplink operadora\n ipv4 address"));
        assert!(text.contains("nat\n cgnat\n  pool RFC6598\n   prefix-inside 100.64.0.0/10\n"));
        c.edit(&p(&["interface wan0"]), &p(&["mtu 9000", "no description"])).ok().unwrap();
        c.edit(&p(&POOL_PATH), &p(&["block-size 512"])).ok().unwrap();
        assert_eq!(c.pool_block_size(), 512);
        let err = c.edit(&p(&["interface wan0"]), &p(&["mtu 1400", "mtu 1000"])).err().unwrap();
        assert_eq!(err.message, "mtu must be between 1280 and 9216");
        assert_eq!(c.iface("wan0").unwrap().mtu, 1400, "linhas antes da recusa ficam");
        assert!(c.edit(&p(&["interface eth9"]), &p(&["mtu 1500"])).is_err());
        assert!(c.edit(&p(&["interface wan0"]), &p(&["ipv6 address 10.0.0.1/24"])).is_err());
    }

    /// Gramática observada no `show running-config` de um Prisma 0.148.3 real
    /// (issue #9): `ipv4 address`, `shutdown` antes de `mtu`, bloco fechado com `exit`.
    #[test]
    fn interface_grammar_matches_real_box() {
        let mut c = Config::seed("x");
        c.edit(&p(&["interface wan0"]), &p(&["shutdown"])).ok().unwrap();
        let text = c.render();
        assert!(
            text.contains("interface wan0\n description Uplink operadora\n ipv4 address 203.0.113.10/29\n ipv6 address 2001:db8:100::2/64\n shutdown\n mtu 1500\n exit\n"),
            "{text}"
        );
        assert!(!text.contains(" ip address "));
        let err = c.edit(&p(&["interface wan0"]), &p(&["ip address 192.0.2.1/24"])).err().unwrap();
        assert!(err.message.starts_with("unknown command"), "{}", err.message);
        c.edit(&p(&["interface wan0"]), &p(&["ipv4 address 192.0.2.1/24", "no ipv4 address 192.0.2.1/24"])).ok().unwrap();
    }

    #[test]
    fn compare_marks_changes() {
        let a = Config::seed("x");
        let mut b = a.clone();
        b.edit(&p(&["interface lan0"]), &p(&["mtu 9000"])).ok().unwrap();
        let d = compare(&a.render(), &b.render());
        assert!(d.contains("-  mtu 1500"), "{d}");
        assert!(d.contains("+  mtu 9000"), "{d}");
        assert!(compare(&a.render(), &a.render()).is_empty());
    }

    #[test]
    fn networks() {
        assert_eq!(network("203.0.113.10/29").unwrap(), "203.0.113.8/29");
        assert_eq!(network("2001:db8:200:10::1/64").unwrap(), "2001:db8:200:10::/64");
    }
}
