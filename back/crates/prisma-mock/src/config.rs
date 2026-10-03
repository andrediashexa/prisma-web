//! The mock's configuration model, rendered in the VTY text format.
//!
//! Interfaces are structured (so the simulation knows what is shut down);
//! the rest is kept as generic blocks: a hierarchy path and the lines
//! typed in it, exactly as the operator wrote them.

use std::net::IpAddr;

use prisma_proto::v1::diagnostic::Severity;
use prisma_proto::v1::Diagnostic;

pub const CGNAT_PATH: [&str; 2] = ["nat", "cgnat"];
pub const POOL_PATH: [&str; 3] = ["nat", "cgnat", "pool RFC6598"];
/// The pool the seed configures; the simulated subscribers are on it.
pub const SEED_POOL: &str = "RFC6598";
/// The three CGNAT log collectors `MOCK_LOG_EXPORT=1` configures (#34, #41).
pub const SEED_LOGGING: [&str; 3] = [
    "logging syslog 192.0.2.50 enterprise 32473",
    "logging tcp 192.0.2.51",
    "logging udp 192.0.2.52 src 203.0.113.10",
];
pub const BGP_PATH: [&str; 1] = ["router bgp 65000"];

#[derive(Clone, PartialEq)]
pub struct Iface {
    pub name: String,
    pub description: Option<String>,
    pub mtu: u32,
    pub shutdown: bool,
    pub v4: Vec<String>,
    pub v6: Vec<String>,
    /// The other statements of the port and bundle modes, as typed (#40):
    /// `vrf`, `cgnat`, `member`, `lacp`, OSPF, IS-IS...
    pub extra: Vec<String>,
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

/// A CGNAT log collector as a `logging udp|tcp|syslog` line configures it.
#[derive(Clone, Debug, PartialEq)]
pub struct Collector {
    pub address: String,
    pub port: u32,
    /// `src` of `logging udp`.
    pub source: String,
}

impl Collector {
    pub fn endpoint(&self) -> String {
        if self.address.contains(':') {
            format!("[{}]:{}", self.address, self.port)
        } else {
            format!("{}:{}", self.address, self.port)
        }
    }
}

/// The collectors of each stream; `None` when the stream is not configured,
/// disabled, or the whole export is (`logging disable`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Collectors {
    pub syslog: Option<Collector>,
    pub tcp: Option<Collector>,
    pub udp: Option<Collector>,
}

/// The line's key when only one line with it can exist in a block, so a new
/// value replaces the old one as the VTY does (`timeout udp 300` after
/// `timeout udp 120`); `None` for lines that accumulate (prefixes, bypasses).
fn single_key(line: &str) -> Option<String> {
    let w: Vec<&str> = line.split_whitespace().collect();
    match w.as_slice() {
        ["logging", "enable" | "disable"] => Some("logging".into()),
        [a @ ("timeout" | "alg" | "logging" | "interface"), b, ..] => Some(format!("{a} {b}")),
        [k, ..]
            if matches!(
                *k,
                "block-size"
                    | "mode"
                    | "policy"
                    | "block-holddown"
                    | "max-blocks"
                    | "initial-allocation"
                    | "block-stride"
                    | "reserve"
                    | "utilisation-alarm"
                    | "max-sessions"
                    | "max-session-rate"
                    | "tcp-mss"
                    | "filter"
                    | "vrf"
                    | "outside-vrf"
                    | "ports"
                    | "identity"
                    | "session-table"
                    | "memory"
            ) =>
        {
            Some((*k).into())
        }
        _ => None,
    }
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
            extra: vec![],
        };
        Self {
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
                    extra: vec![],
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

    /// Configured bundles and their `member` lines.
    pub fn bundles(&self) -> Vec<(&Iface, Vec<String>)> {
        self.interfaces
            .iter()
            .filter(|i| is_bundle(&i.name))
            .map(|i| (i, i.extra.iter().filter_map(|l| l.strip_prefix("member ")).map(str::to_string).collect()))
            .collect()
    }

    pub fn block(&self, path: &[&str]) -> Option<&Block> {
        self.blocks.iter().find(|b| b.path.iter().map(String::as_str).eq(path.iter().copied()))
    }

    /// Names of the CGNAT pools, in the order they appear.
    pub fn pool_names(&self) -> Vec<String> {
        let cgnat = CGNAT_PATH.map(String::from);
        self.children(&cgnat).iter().filter_map(|c| c.strip_prefix("pool ")).map(|n| n.trim().to_string()).collect()
    }

    fn pool_lines(&self, pool: &str) -> &[String] {
        self.block(&["nat", "cgnat", &format!("pool {pool}")]).map_or(&[], |b| &b.lines)
    }

    pub fn pool_block_size(&self, pool: &str) -> u32 {
        self.pool_lines(pool)
            .iter()
            .find_map(|l| l.strip_prefix("block-size "))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(256)
    }

    /// The pool's `prefix-outside` addresses (for the capacity).
    pub fn pool_outside_addresses(&self, pool: &str) -> u64 {
        self.pool_prefixes(pool, "prefix-outside ")
            .iter()
            .filter_map(|p| p.split_once('/').and_then(|(_, l)| l.parse::<u32>().ok()))
            .map(|len| 1u64 << (32 - len.min(32)))
            .sum()
    }

    pub fn pool_prefixes(&self, pool: &str, keyword: &str) -> Vec<String> {
        self.pool_lines(pool).iter().filter_map(|l| l.strip_prefix(keyword)).map(|s| s.trim().to_string()).collect()
    }

    pub fn pool_line(&self, pool: &str, keyword: &str, default: &str) -> String {
        self.pool_lines(pool)
            .iter()
            .find_map(|l| l.strip_prefix(keyword))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| default.to_string())
    }

    /// The log collectors `nat > cgnat` configures (#41): what GetLogging reports.
    pub fn log_collectors(&self) -> Collectors {
        let mut c = Collectors::default();
        let lines = self.block(&CGNAT_PATH).map_or(&[][..], |b| &b.lines[..]);
        if lines.iter().any(|l| l.trim() == "logging disable") {
            return c;
        }
        for l in lines {
            let w: Vec<&str> = l.split_whitespace().collect();
            if w.first() != Some(&"logging") {
                continue;
            }
            let (slot, default_port) = match w.get(1).copied() {
                Some("syslog") => (&mut c.syslog, 601),
                Some("tcp") => (&mut c.tcp, 4739),
                Some("udp") => (&mut c.udp, 4739),
                _ => continue,
            };
            *slot = match w.get(2).copied() {
                None | Some("disable") => None,
                Some(address) => {
                    let after = |k: &str| w.iter().position(|x| *x == k).and_then(|i| w.get(i + 1)).map(|v| v.to_string());
                    Some(Collector {
                        address: address.into(),
                        port: after("port").and_then(|p| p.parse().ok()).unwrap_or(default_port),
                        source: after("src").unwrap_or_default(),
                    })
                }
            };
        }
        c
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

    /// Text as `show running-config` prints it.
    pub fn render(&self) -> String {
        let mut out = vec![format!("hostname {}", self.hostname)];
        // The box's own lines, as FRR writes them on a real box (#44).
        out.extend(crate::schema::BOX_OWNED.iter().map(|(l, _)| l.to_string()));
        out.push("!".to_string());
        for i in &self.interfaces {
            out.push(format!("interface {}", i.name));
            if let Some(d) = &i.description {
                out.push(format!(" description {d}"));
            }
            out.extend(i.extra.iter().map(|l| format!(" {l}")));
            // Order and wording as in a real Prisma's `show running-config` (issue #9).
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
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.first() == Some(&"member") {
            self.check_member(name, &words, path, line)?;
        }
        if self.iface(name).is_none() {
            // `interface bond<n>` creates the bundle, as on the box (#40); a port must exist.
            if !is_bundle(name) {
                return Err(refuse(format!("interface {name} does not exist"), path, line));
            }
            self.interfaces.push(Iface {
                name: name.into(),
                description: None,
                mtu: 1500,
                shutdown: false,
                v4: vec![],
                v6: vec![],
                extra: vec![],
            });
        }
        let i = self.interfaces.iter_mut().find(|i| i.name == name).expect("found or created above");
        match words.as_slice() {
            ["description", ..] => i.description = Some(line["description".len()..].trim().to_string()),
            ["no", "description", ..] => i.description = None,
            ["mtu", n] => match n.parse::<u32>() {
                Ok(m) if (1280..=9216).contains(&m) => i.mtu = m,
                _ => return Err(refuse("mtu must be between 1280 and 9216", path, line)),
            },
            ["no", "mtu", ..] => i.mtu = 1500,
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
            _ => edit_extra(i, path, line)?,
        }
        Ok(None)
    }

    /// A port joins one bundle at most, and only a port does.
    fn check_member(&self, bundle: &str, words: &[&str], path: &[String], line: &str) -> Result<(), Refusal> {
        let [_, port] = words else { return Err(refuse(format!("unknown command: {line}"), path, line)) };
        if !is_bundle(bundle) {
            return Err(refuse(format!("unknown command: {line}"), path, line));
        }
        if self.iface(port).is_none() || is_bundle(port) || *port == "lo" || port.contains('.') {
            return Err(refuse(format!("{port} is not a port that can join a bundle"), path, line));
        }
        if let Some((b, _)) = self.bundles().into_iter().find(|(b, m)| b.name != bundle && m.iter().any(|x| x == port)) {
            return Err(refuse(format!("{port} is already a member of {}", b.name), path, line));
        }
        Ok(())
    }
    fn edit_block(&mut self, path: &[String], line: &str) {
        if let Some(rest) = line.strip_prefix("no ").map(str::trim) {
            // `no pool P` under `nat > cgnat` removes the pool and what is in it.
            let mut child = path.to_vec();
            child.push(rest.to_string());
            self.blocks.retain(|b| !b.path.starts_with(&child));
            if let Some(b) = self.blocks.iter_mut().find(|b| b.path == path) {
                let before = b.lines.len();
                b.lines.retain(|l| l != rest);
                // `no max-blocks`, `no interface wan0`: the line whatever its value.
                if b.lines.len() == before {
                    b.lines.retain(|l| !l.starts_with(&format!("{rest} ")));
                }
            }
            return;
        }
        let idx = match self.blocks.iter().position(|b| b.path == path) {
            Some(i) => i,
            None => {
                self.blocks.push(Block { path: path.to_vec(), lines: Vec::new() });
                self.blocks.len() - 1
            }
        };
        let lines = &mut self.blocks[idx].lines;
        // Single-value statements replace the existing line.
        if let Some(key) = single_key(line) {
            if let Some(existing) = lines.iter_mut().find(|l| single_key(l).as_deref() == Some(key.as_str())) {
                *existing = line.to_string();
                return;
            }
        }
        if !lines.iter().any(|l| l == line) {
            lines.push(line.to_string());
        }
    }
}

pub fn is_bundle(name: &str) -> bool {
    name.strip_prefix("bond").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Statements with one value: a new line replaces the old one (`vrf 10` over `vrf 5`).
const SINGLE: &[&[&str]] = &[
    &["vrf"],
    &["linux-name"],
    &["mac-address"],
    &["vlan"],
    &["urpf"],
    &["cgnat"],
    &["lacp", "mode"],
    &["lacp", "rate"],
    &["load-balance"],
];
/// Statements kept as typed, several of each; the routing ones are not checked further.
const MULTI: &[&[&str]] = &[
    &["member"],
    &["ipv6", "nd", "suppress-ra"],
    &["ip", "ospf"],
    &["ip", "router", "isis"],
    &["isis"],
    &["ipv6", "ospf6"],
    &["ipv6", "router", "isis"],
    &["vrrp"],
];

/// The port and bundle statements beyond description, mtu, shutdown and the addresses (#40).
fn edit_extra(i: &mut Iface, path: &[String], line: &str) -> Result<(), Refusal> {
    let (no, body) = match line.strip_prefix("no ") {
        Some(b) => (true, b.trim()),
        None => (false, line),
    };
    let w: Vec<&str> = body.split_whitespace().collect();
    let unknown = || refuse(format!("unknown command: {line}"), path, line);
    let single = SINGLE.iter().find(|h| w.starts_with(h));
    let Some(head) = single.or_else(|| MULTI.iter().find(|h| w.starts_with(h))) else { return Err(unknown()) };
    if matches!(head[0], "member" | "lacp" | "load-balance") && !is_bundle(&i.name) {
        return Err(unknown());
    }
    let value = &w[head.len()..];
    // `no vrf` alone removes whatever is set; with a value it must be the one set.
    if !(no && value.is_empty()) {
        let int = |v: &str, max: u64| v.parse::<u64>().is_ok_and(|n| (1..=max).contains(&n));
        let ok = match (head, value) {
            (["vrf"], [v]) => int(v, u64::from(u32::MAX)),
            (["vlan"], [v]) => int(v, 4094),
            (["vlan"], [v, "inner", x]) => int(v, 4094) && int(x, 4094),
            (["urpf"], [v]) => matches!(*v, "strict" | "loose" | "off"),
            (["cgnat"], [v]) => matches!(*v, "inside" | "outside"),
            (["lacp", "mode"], [v]) => matches!(*v, "active" | "passive"),
            (["lacp", "rate"], [v]) => matches!(*v, "fast" | "slow"),
            (["load-balance"], [v]) => matches!(*v, "l2" | "l23" | "l34"),
            (["mac-address"], [v]) => {
                v.split(':').count() == 6 && v.split(':').all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_hexdigit()))
            }
            (["linux-name"] | ["member"], [_]) => true,
            (["ipv6", "nd", "suppress-ra"], []) => true,
            // OSPF, IS-IS, VRRP: some value after the keywords.
            (_, v) if single.is_none() => !v.is_empty(),
            _ => false,
        };
        if !ok {
            return Err(refuse(format!("invalid value: {line}"), path, line));
        }
    }
    let starts = |l: &str| l.split_whitespace().take(head.len()).eq(head.iter().copied());
    if no {
        let before = i.extra.len();
        i.extra.retain(|l| !(l == body || (value.is_empty() && single.is_some() && starts(l))));
        if i.extra.len() == before {
            return Err(refuse(format!("{body} is not configured on {}", i.name), path, line));
        }
    } else if let Some(existing) = single.and_then(|_| i.extra.iter_mut().find(|l| starts(l))) {
        *existing = body.to_string();
    } else if !i.extra.iter().any(|l| l == body) {
        i.extra.push(body.to_string());
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
        assert!(text.starts_with("hostname x\nlog syslog informational\nservice integrated-vtysh-config\n!\ninterface wan0\n description Carrier uplink\n ipv4 address"));
        assert!(text.contains("nat\n cgnat\n  pool RFC6598\n   prefix-inside 100.64.0.0/10\n"));
        c.edit(&p(&["interface wan0"]), &p(&["mtu 9000", "no description"])).ok().unwrap();
        c.edit(&p(&POOL_PATH), &p(&["block-size 512"])).ok().unwrap();
        assert_eq!(c.pool_block_size(SEED_POOL), 512);
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

    /// The port and bundle statements the Interfaces form writes (#40).
    #[test]
    fn port_and_bundle_statements() {
        let mut c = Config::seed("x");
        let wan = p(&["interface wan0"]);
        c.edit(&wan, &p(&["vrf 5", "cgnat outside", "ipv6 address 2001:db8:100::3/64", "no ipv6 address 2001:db8:100::2/64"])).ok().unwrap();
        c.edit(&wan, &p(&["no vrf 5", "vrf 10", "urpf strict", "ipv6 nd suppress-ra", "ip ospf area 0"])).ok().unwrap();
        let text = c.render();
        assert!(
            text.contains("interface wan0\n description Carrier uplink\n cgnat outside\n vrf 10\n urpf strict\n ipv6 nd suppress-ra\n ip ospf area 0\n ipv4 address 203.0.113.10/29\n ipv6 address 2001:db8:100::3/64\n"),
            "{text}"
        );
        c.edit(&wan, &p(&["vrf 20"])).ok().unwrap();
        assert_eq!(c.iface("wan0").unwrap().extra.iter().filter(|l| l.starts_with("vrf ")).count(), 1, "one vrf, replaced");
        for bad in ["vrf 0", "vrf ten", "cgnat sideways", "member lan0", "lacp mode active", "mac-address 02:00", "frobnicate"] {
            assert!(c.edit(&wan, &p(&[bad])).is_err(), "{bad} is refused on a port");
        }
        assert!(c.edit(&wan, &p(&["no vrf 99"])).is_err(), "removing a value that is not set");
        c.edit(&wan, &p(&["no vrf"])).ok().unwrap();

        let bond = p(&["interface bond1"]);
        c.edit(&bond, &p(&["description Core", "member lan0", "member wg0", "lacp mode active", "load-balance l34", "ipv4 address 198.51.100.1/24"])).ok().unwrap();
        assert!(c.render().contains("interface bond1\n description Core\n member lan0\n member wg0\n lacp mode active\n load-balance l34\n ipv4 address 198.51.100.1/24\n mtu 1500\n exit\n"));
        assert_eq!(c.bundles()[0].1, ["lan0", "wg0"]);
        let err = c.edit(&p(&["interface bond2"]), &p(&["member lan0"])).err().unwrap();
        assert_eq!(err.message, "lan0 is already a member of bond1");
        for bad in ["member eth9", "member lo", "member lan0.20", "member bond1"] {
            assert!(c.edit(&bond, &p(&[bad])).is_err(), "{bad}");
        }
        c.edit(&bond, &p(&["no member wg0"])).ok().unwrap();
        assert_eq!(c.bundles()[0].1, ["lan0"]);
        assert!(c.edit(&p(&["interface eth9"]), &p(&["mtu 1500"])).is_err(), "a port is not created");
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
    fn pools_are_added_replaced_and_removed() {
        let mut c = Config::seed("x");
        let pool = p(&["nat", "cgnat", "pool BIZ"]);
        c.edit(&pool, &p(&["prefix-inside 10.0.0.0/8", "prefix-outside 198.51.100.0/28", "block-size 512", "max-blocks 4"])).ok().unwrap();
        c.edit(&pool, &p(&["max-blocks 8", "alg ftp off", "alg ftp on", "prefix-outside 198.51.100.16/28"])).ok().unwrap();
        assert_eq!(c.pool_names(), ["RFC6598", "BIZ"]);
        assert_eq!(c.pool_line("BIZ", "max-blocks ", "-"), "8");
        assert_eq!(c.pool_line("BIZ", "alg ftp ", "-"), "on");
        assert_eq!(c.pool_outside_addresses("BIZ"), 32, "two prefixes accumulate");
        c.edit(&pool, &p(&["no max-blocks", "no prefix-outside 198.51.100.0/28"])).ok().unwrap();
        assert_eq!(c.pool_line("BIZ", "max-blocks ", "-"), "-");
        assert_eq!(c.pool_prefixes("BIZ", "prefix-outside "), ["198.51.100.16/28"]);
        c.edit(&p(&CGNAT_PATH), &p(&["interface wan0 outside", "interface wan0 inside", "no pool BIZ"])).ok().unwrap();
        assert_eq!(c.pool_names(), ["RFC6598"]);
        assert!(c.render().contains("  interface wan0 inside\n"), "{}", c.render());
        c.edit(&p(&CGNAT_PATH), &p(&["no interface wan0"])).ok().unwrap();
        assert!(!c.render().contains("interface wan0 inside"));
    }

    #[test]
    fn log_collectors_follow_the_logging_lines() {
        let mut c = Config::seed("x");
        assert_eq!(c.log_collectors(), Collectors::default());
        c.edit(&p(&CGNAT_PATH), &p(&SEED_LOGGING)).ok().unwrap();
        let l = c.log_collectors();
        assert_eq!(l.syslog.unwrap().endpoint(), "192.0.2.50:601");
        assert_eq!(l.tcp.unwrap().endpoint(), "192.0.2.51:4739");
        assert_eq!(l.udp.as_ref().unwrap().source, "203.0.113.10");
        c.edit(&p(&CGNAT_PATH), &p(&["logging udp 2001:db8::9 src 2001:db8::1 port 2055", "logging tcp disable"])).ok().unwrap();
        let l = c.log_collectors();
        assert_eq!(l.udp.unwrap().endpoint(), "[2001:db8::9]:2055", "a new collector replaces the old one");
        assert!(l.tcp.is_none() && l.syslog.is_some());
        c.edit(&p(&CGNAT_PATH), &p(&["logging disable"])).ok().unwrap();
        assert_eq!(c.log_collectors(), Collectors::default(), "logging disable turns the whole export off");
    }

    #[test]
    fn networks() {
        assert_eq!(network("203.0.113.10/29").unwrap(), "203.0.113.8/29");
        assert_eq!(network("2001:db8:200:10::1/64").unwrap(), "2001:db8:200:10::/64");
    }
}
