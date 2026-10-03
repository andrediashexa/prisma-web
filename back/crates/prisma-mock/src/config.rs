//! The mock's configuration model, rendered in the VTY text format.
//!
//! Interfaces are structured (so the simulation knows what is shut down);
//! the rest is kept as generic blocks: a hierarchy path and the lines
//! typed in it, exactly as the operator wrote them.

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
    /// Per-interface OSPF lines (`ip ospf …`, `ipv6 ospf6 …`, #43), as typed.
    pub ospf: Vec<String>,
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

/// Refusal of a line: the VTY message and the matching diagnostic.
pub struct Refusal {
    pub message: String,
    pub diagnostic: Diagnostic,
}

pub fn diag(severity: Severity, message: impl Into<String>, path: &[String], line: &str) -> Diagnostic {
    Diagnostic { severity: severity as i32, message: message.into(), path: path.to_vec(), line: line.into(), ..Default::default() }
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
            ospf: Vec::new(),
        };
        let mut c = Self {
            hostname: hostname.into(),
            interfaces: vec![
                iface("wan0", "Carrier uplink", 1500, &["203.0.113.10/29"], &["2001:db8:100::2/64"]),
                iface("lan0", "Internal network", 1500, &["192.168.10.1/24"], &["2001:db8:200:10::1/64"]),
                iface("lan0.20", "Guest VLAN", 1500, &["192.168.20.1/24"], &["2001:db8:200:20::1/64"]),
                iface("wg0", "Remote access VPN", 1420, &["10.8.0.1/24"], &["fd00:8::1/64"]),
                Iface {
                    name: "lo".into(),
                    description: None,
                    mtu: 65536,
                    shutdown: false,
                    v4: strs(&["127.0.0.1/8"]),
                    v6: strs(&["::1/128"]),
                    ospf: Vec::new(),
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
                // Routing seen by the forms of #42 and #43: an IPv6 family,
                // OSPF on the LAN and a default route per family.
                Block {
                    path: strs(&[BGP_PATH[0], "address-family ipv6 unicast"]),
                    lines: strs(&["neighbor 2001:db8:100::1 activate"]),
                },
                Block {
                    path: strs(&["router ospf"]),
                    lines: strs(&["ospf router-id 192.168.10.1", "network 192.168.10.0/24 area 0", "passive-interface lan0.20"]),
                },
                Block { path: strs(&["router ospf6"]), lines: strs(&["ospf6 router-id 192.168.10.1"]) },
                Block {
                    path: strs(&["router static"]),
                    lines: strs(&["0.0.0.0/0 next-hop 203.0.113.9", "::/0 next-hop 2001:db8:100::1"]),
                },
            ],
        };
        if let Some(lan) = c.interfaces.iter_mut().find(|i| i.name == "lan0") {
            lan.ospf = strs(&["ipv6 ospf6 area 0"]);
        }
        c
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

    /// The pool's `prefix-outside` addresses (for the capacity).
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

    /// The lines `neighbor <peer> …` of the BGP process, without the prefix.
    fn bgp_neighbor_lines(&self, peer: &str) -> Vec<String> {
        let head = format!("neighbor {peer} ");
        self.block(&BGP_PATH)
            .map(|b| b.lines.iter().filter_map(|l| l.strip_prefix(&head)).map(str::to_string).collect())
            .unwrap_or_default()
    }

    /// Whether `neighbor <peer> shutdown` is configured (the session is held down).
    pub fn bgp_neighbor_shutdown(&self, peer: &str) -> bool {
        self.bgp_neighbor_lines(peer).iter().any(|l| l == "shutdown")
    }

    pub fn bgp_neighbor_description(&self, peer: &str) -> Option<String> {
        self.bgp_neighbor_lines(peer).iter().find_map(|l| l.strip_prefix("description ").map(str::to_string))
    }

    /// Text as `show running-config` prints it.
    pub fn render(&self) -> String {
        let mut out = vec![format!("hostname {}", self.hostname), "!".to_string()];
        for i in &self.interfaces {
            out.push(format!("interface {}", i.name));
            if let Some(d) = &i.description {
                out.push(format!(" description {d}"));
            }
            // Order and wording as in a real Prisma's `show running-config` (issue #9).
            out.extend(i.v4.iter().map(|a| format!(" ipv4 address {a}")));
            out.extend(i.v6.iter().map(|a| format!(" ipv6 address {a}")));
            if i.shutdown {
                out.push(" shutdown".into());
            }
            out.push(format!(" mtu {}", i.mtu));
            out.extend(i.ospf.iter().map(|l| format!(" {l}")));
            out.push(" exit".into());
        }
        for top in self.children(&[]) {
            self.render_tree(&[top], 0, &mut out);
            out.push("!".into());
        }
        out.push("end".into());
        out.join("\n") + "\n"
    }

    /// Next segments under `prefix`, in the order they appear.
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
        out.push(format!("{indent}{}", path.last().expect("non-empty path")));
        if let Some(b) = self.blocks.iter().find(|b| b.path == path) {
            out.extend(b.lines.iter().map(|l| format!("{indent} {l}")));
        }
        for child in self.children(path) {
            let mut p = path.to_vec();
            p.push(child);
            self.render_tree(&p, depth + 1, out);
        }
    }

    /// Applies the lines in order; stops at the first refused one, keeping the earlier ones.
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
                self.edit_block(path, line)?;
            }
        }
        Ok(notes)
    }

    fn edit_top(&mut self, line: &str) -> Result<(), Refusal> {
        // `no router ospf`: the block and everything under it.
        if let Some(rest) = line.strip_prefix("no ").map(str::trim) {
            if self.blocks.iter().any(|b| b.path[0] == rest) {
                self.blocks.retain(|b| b.path[0] != rest);
                return Ok(());
            }
        }
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
            ["ip", "ospf", _, ..] | ["ipv6", "ospf6", _, ..] | ["no", "ip", "ospf", _, ..] | ["no", "ipv6", "ospf6", _, ..] => {
                let no = words[0] == "no";
                let stmt = if no { line[2..].trim() } else { line };
                let key = ospf_key(stmt);
                if !no {
                    i.ospf.retain(|l| ospf_key(l) != key);
                    i.ospf.push(stmt.to_string());
                } else if i.ospf.iter().any(|l| ospf_key(l) == key) {
                    i.ospf.retain(|l| ospf_key(l) != key);
                } else {
                    return Err(refuse(format!("{stmt} is not configured on {name}"), path, line));
                }
            }
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

    fn edit_block(&mut self, path: &[String], line: &str) -> Result<(), Refusal> {
        if path.len() == 1 && path[0] == "router static" {
            check_static(path, line)?;
        }
        let found = self.blocks.iter().position(|b| b.path == path);
        if let Some(rest) = line.strip_prefix("no ").map(str::trim) {
            // A mode under this one (`no address-family ipv6 unicast`): the block and its children.
            if self.blocks.iter().any(|b| b.path.len() > path.len() && b.path.starts_with(path) && b.path[path.len()] == rest) {
                self.blocks.retain(|b| !(b.path.len() > path.len() && b.path.starts_with(path) && b.path[path.len()] == rest));
                return Ok(());
            }
            let words: Vec<&str> = rest.split_whitespace().collect();
            // `no neighbor <peer>` (or `no neighbor <peer> remote-as …`, as FRR) removes the
            // neighbor: its lines here and in every address family below.
            if path[0].starts_with("router bgp ") && path.len() == 1 && matches!(words.as_slice(), ["neighbor", _] | ["neighbor", _, "remote-as", ..]) {
                let head = format!("neighbor {} ", words[1]);
                for b in self.blocks.iter_mut().filter(|b| b.path.starts_with(path)) {
                    b.lines.retain(|l| !l.starts_with(&head));
                }
                return Ok(());
            }
            let Some(idx) = found else { return Ok(()) };
            let lines = &mut self.blocks[idx].lines;
            // The exact line, or the setting named without its value (`no bgp router-id`).
            if lines.iter().any(|l| l == rest) {
                lines.retain(|l| l != rest);
            } else {
                let key = replace_key(rest);
                lines.retain(|l| !(l.starts_with(&format!("{rest} ")) || key.as_ref().is_some_and(|k| replace_key(l).as_ref() == Some(k))));
            }
            return Ok(());
        }
        let idx = found.unwrap_or_else(|| {
            self.blocks.push(Block { path: path.to_vec(), lines: Vec::new() });
            self.blocks.len() - 1
        });
        let lines = &mut self.blocks[idx].lines;
        // A setting with one value replaces the existing line.
        if let Some(key) = replace_key(line) {
            if let Some(existing) = lines.iter_mut().find(|l| replace_key(l).as_ref() == Some(&key)) {
                *existing = line.to_string();
                return Ok(());
            }
        }
        if !lines.iter().any(|l| l == line) {
            lines.push(line.to_string());
        }
        Ok(())
    }
}

/// What identifies a setting that holds one value, so that a new line replaces the old one:
/// the keywords before the value (`bgp router-id`, `neighbor <peer> remote-as`, a static
/// route's prefix and next hop). `None` for lines that accumulate (`network …`).
fn replace_key(line: &str) -> Option<String> {
    let w: Vec<&str> = line.split_whitespace().collect();
    const NEIGHBOR: &[&str] = &[
        "remote-as", "description", "password", "update-source", "ebgp-multihop", "timers", "maximum-prefix", "peer-group", "route-map",
        "prefix-list", "default-originate",
    ];
    match w.as_slice() {
        [k @ ("block-size" | "mode" | "policy" | "distance" | "maximum-paths" | "table-map" | "table-policy" | "export"), ..] => Some(k.to_string()),
        [a @ ("bgp" | "ospf" | "ospf6"), "router-id", ..] => Some(format!("{a} router-id")),
        ["auto-cost", "reference-bandwidth", ..] => Some("auto-cost".into()),
        ["neighbor", peer, attr, ..] if NEIGHBOR.contains(attr) => Some(format!("neighbor {peer} {attr}")),
        ["redistribute", proto, ..] => Some(format!("redistribute {proto}")),
        ["default-information", "originate", ..] => Some("default-information".into()),
        [prefix, "next-hop", nh, ..] if prefix.contains('/') => Some(format!("{prefix} {nh}")),
        _ => None,
    }
}

/// The keywords that name an interface's OSPF setting (`ip ospf cost`, `ip ospf message-digest-key 1`).
fn ospf_key(line: &str) -> String {
    let w: Vec<&str> = line.split_whitespace().collect();
    let n = if w.get(2) == Some(&"message-digest-key") { 4 } else { 3 };
    w[..n.min(w.len())].join(" ")
}

/// `<prefix> next-hop <next-hop> [distance <1-255>] [tag <n>] [description <text>]`: the
/// prefix must be valid and the next hop, an address of the same family or an interface name.
fn check_static(path: &[String], line: &str) -> Result<(), Refusal> {
    let stmt = line.strip_prefix("no ").unwrap_or(line);
    let w: Vec<&str> = stmt.split_whitespace().collect();
    let [prefix, "next-hop", nh, rest @ ..] = w.as_slice() else {
        return Err(refuse(format!("unknown command: {line}"), path, line));
    };
    let v6 = prefix.contains(':');
    if !valid_cidr(prefix, v6) {
        return Err(refuse(format!("invalid prefix: {prefix}"), path, line));
    }
    match nh.parse::<IpAddr>() {
        Ok(a) if a.is_ipv6() != v6 => return Err(refuse(format!("next hop {nh} is not of the prefix's family"), path, line)),
        _ => {}
    }
    if let Some(d) = rest.iter().position(|w| *w == "distance").and_then(|i| rest.get(i + 1)) {
        if !d.parse::<u8>().is_ok_and(|d| d >= 1) {
            return Err(refuse("distance must be between 1 and 255", path, line));
        }
    }
    Ok(())
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

/// Network of a CIDR address: `203.0.113.10/29` → `203.0.113.8/29`.
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

/// Line-by-line diff (LCS), in the style of `show configuration compare`:
/// `+ `/`- ` for what changes and up to two lines of context around it.
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
    // ops: (marker, line)
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
        assert!(text.starts_with("hostname x\n!\ninterface wan0\n description Carrier uplink\n ipv4 address"));
        assert!(text.contains("nat\n cgnat\n  pool RFC6598\n   prefix-inside 100.64.0.0/10\n"));
        c.edit(&p(&["interface wan0"]), &p(&["mtu 9000", "no description"])).ok().unwrap();
        c.edit(&p(&POOL_PATH), &p(&["block-size 512"])).ok().unwrap();
        assert_eq!(c.pool_block_size(), 512);
        let err = c.edit(&p(&["interface wan0"]), &p(&["mtu 1400", "mtu 1000"])).err().unwrap();
        assert_eq!(err.message, "mtu must be between 1280 and 9216");
        assert_eq!(c.iface("wan0").unwrap().mtu, 1400, "lines before the refusal are kept");
        assert!(c.edit(&p(&["interface eth9"]), &p(&["mtu 1500"])).is_err());
        assert!(c.edit(&p(&["interface wan0"]), &p(&["ipv6 address 10.0.0.1/24"])).is_err());
    }

    /// Grammar observed in a real Prisma 0.148.3's `show running-config`
    /// (issue #9): `ipv4 address`, `shutdown` before `mtu`, block closed with `exit`.
    #[test]
    fn interface_grammar_matches_real_box() {
        let mut c = Config::seed("x");
        c.edit(&p(&["interface wan0"]), &p(&["shutdown"])).ok().unwrap();
        let text = c.render();
        assert!(
            text.contains("interface wan0\n description Carrier uplink\n ipv4 address 203.0.113.10/29\n ipv6 address 2001:db8:100::2/64\n shutdown\n mtu 1500\n exit\n"),
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

    /// The routing statements of #42 and #43: neighbors render under `router bgp`, a
    /// single-valued setting replaces its line and `no` removes it.
    #[test]
    fn routing_blocks() {
        let mut c = Config::seed("x");
        let bgp = p(&BGP_PATH);
        let v6 = p(&[BGP_PATH[0], "address-family ipv6 unicast"]);
        c.edit(&bgp, &p(&["neighbor 192.0.2.1 remote-as 64510", "neighbor 192.0.2.1 description Peer A", "bgp router-id 10.0.0.1"])).ok().unwrap();
        c.edit(&v6, &p(&["neighbor 192.0.2.1 activate", "network 2001:db8:1::/48"])).ok().unwrap();
        let text = c.render();
        assert!(text.contains("router bgp 65000\n neighbor 203.0.113.9 remote-as 64500\n"), "{text}");
        assert!(text.contains(" neighbor 192.0.2.1 description Peer A\n bgp router-id 10.0.0.1\n address-family ipv6 unicast\n"), "{text}");
        assert!(text.contains("  neighbor 192.0.2.1 activate\n  network 2001:db8:1::/48\n"), "{text}");

        c.edit(&bgp, &p(&["neighbor 192.0.2.1 remote-as 64511", "bgp router-id 10.0.0.2", "neighbor 192.0.2.1 shutdown"])).ok().unwrap();
        assert_eq!(c.bgp_neighbors().iter().filter(|(n, _)| n == "192.0.2.1").collect::<Vec<_>>(), [&("192.0.2.1".to_string(), 64511)]);
        assert!(c.render().contains(" bgp router-id 10.0.0.2\n") && !c.render().contains("10.0.0.1"));
        assert!(c.bgp_neighbor_shutdown("192.0.2.1"));
        c.edit(&bgp, &p(&["no neighbor 192.0.2.1 shutdown", "no neighbor 192.0.2.1 description"])).ok().unwrap();
        assert!(!c.bgp_neighbor_shutdown("192.0.2.1") && c.bgp_neighbor_description("192.0.2.1").is_none());

        c.edit(&bgp, &p(&["no neighbor 192.0.2.1"])).ok().unwrap();
        let text = c.render();
        assert!(!text.contains("192.0.2.1"), "the neighbor goes from every address family: {text}");
        c.edit(&bgp, &p(&["no address-family ipv6 unicast"])).ok().unwrap();
        assert!(!c.render().contains("address-family ipv6"));

        let st = p(&["router static"]);
        c.edit(&st, &p(&["192.0.2.0/24 next-hop 203.0.113.9 distance 10", "2001:db8:5::/48 next-hop wan0"])).ok().unwrap();
        c.edit(&st, &p(&["192.0.2.0/24 next-hop 203.0.113.9 distance 20"])).ok().unwrap();
        let text = c.render();
        assert!(text.contains("router static\n 0.0.0.0/0 next-hop 203.0.113.9\n ::/0 next-hop 2001:db8:100::1\n 192.0.2.0/24 next-hop 203.0.113.9 distance 20\n 2001:db8:5::/48 next-hop wan0\n"), "{text}");
        assert!(c.edit(&st, &p(&["192.0.2.0/24 next-hop 2001:db8::1"])).is_err(), "families must match");
        assert!(c.edit(&st, &p(&["192.0.2.0/33 next-hop 203.0.113.9"])).is_err());
        c.edit(&st, &p(&["no 192.0.2.0/24 next-hop 203.0.113.9 distance 20"])).ok().unwrap();
        assert!(!c.render().contains("192.0.2.0/24"));

        c.edit(&p(&["interface wan0"]), &p(&["ip ospf area 0", "ip ospf cost 10", "ip ospf cost 20", "ipv6 ospf6 passive"])).ok().unwrap();
        assert!(c.render().contains(" mtu 1500\n ip ospf area 0\n ip ospf cost 20\n ipv6 ospf6 passive\n exit\n"), "{}", c.render());
        c.edit(&p(&["interface wan0"]), &p(&["no ip ospf cost 20", "no ipv6 ospf6 passive"])).ok().unwrap();
        assert_eq!(c.iface("wan0").unwrap().ospf, ["ip ospf area 0"]);
        assert!(c.edit(&p(&["interface wan0"]), &p(&["no ip ospf bfd"])).is_err());

        c.edit(&[], &p(&["no router ospf6"])).ok().unwrap();
        assert!(!c.render().contains("router ospf6"));
    }

    #[test]
    fn networks() {
        assert_eq!(network("203.0.113.10/29").unwrap(), "203.0.113.8/29");
        assert_eq!(network("2001:db8:200:10::1/64").unwrap(), "2001:db8:200:10::/64");
    }
}
