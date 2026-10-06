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
    /// `ip prefix-list` and `ipv6 prefix-list` lines, top level, in order (0.151.12, #73).
    pub lists: Vec<String>,
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
                    | "prefix-list-inside"
                    | "prefix-list-outside"
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
        // Routing (#42, #43): the keywords before the value (`bgp router-id`,
        // `neighbor <peer> remote-as`, a static route's prefix and next hop).
        [k @ ("distance" | "maximum-paths" | "table-map" | "table-policy" | "export"), ..] => Some((*k).into()),
        [a @ ("bgp" | "ospf" | "ospf6"), "router-id", ..] => Some(format!("{a} router-id")),
        ["auto-cost", "reference-bandwidth", ..] => Some("auto-cost".into()),
        // One route-map and one prefix-list each way (#46).
        ["neighbor", peer, attr @ ("route-map" | "prefix-list"), _, dir] => Some(format!("neighbor {peer} {attr} {dir}")),
        ["neighbor", peer, attr, ..] if NEIGHBOR_SINGLE.contains(attr) => Some(format!("neighbor {peer} {attr}")),
        ["redistribute", proto, ..] => Some(format!("redistribute {proto}")),
        ["default-information", "originate", ..] => Some("default-information".into()),
        [prefix, "next-hop", nh, ..] if prefix.contains('/') => Some(format!("{prefix} {nh}")),
        _ => None,
    }
}

/// A neighbor's settings that hold one value (`neighbor <peer> remote-as <n>`).
const NEIGHBOR_SINGLE: &[&str] = &[
    "remote-as", "description", "password", "update-source", "ebgp-multihop", "timers", "maximum-prefix", "peer-group", "route-map",
    "prefix-list", "default-originate",
];

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
        let mut c = Self {
            lists: vec![],
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
                        // `mode dynamic` became `mode bpa` in 0.151.0 (#68).
                        "mode bpa",
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
            lan.extra = strs(&["ipv6 ospf6 area 0"]);
        }
        c
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

    /// The mode at `path`, created empty when it is not there (#67).
    pub fn ensure_block(&mut self, path: &[String]) {
        if !self.blocks.iter().any(|b| b.path == path) {
            self.blocks.push(Block { path: path.to_vec(), lines: Vec::new() });
        }
    }

    pub fn block(&self, path: &[&str]) -> Option<&Block> {
        self.blocks.iter().find(|b| b.path.iter().map(String::as_str).eq(path.iter().copied()))
    }

    /// `unsupported-sfp allow` under `system > hardware` (0.151.2, #69).
    pub fn unsupported_sfp_allowed(&self) -> bool {
        self.block(&["system", "hardware"]).is_some_and(|b| b.lines.iter().any(|l| l == "unsupported-sfp allow"))
    }

    /// Names of the NAT64 pools (`nat > nat64`, 0.151.0, #68), in the order they appear.
    pub fn nat64_pool_names(&self) -> Vec<String> {
        self.children(&["nat".to_string(), "nat64".to_string()]).iter().filter_map(|c| c.strip_prefix("pool ")).map(|n| n.trim().to_string()).collect()
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

    /// `ip prefix-list` lines (0.151.12, #73): an entry replaces the one with its sequence;
    /// `no ip prefix-list <name>` removes the list, with an entry only that entry.
    fn edit_list(&mut self, line: &str) -> Result<bool, Refusal> {
        let (no, body) = match line.strip_prefix("no ") {
            Some(b) => (true, b.trim()),
            None => (false, line.trim()),
        };
        let w: Vec<&str> = body.split_whitespace().collect();
        let (fam, rest) = match w.as_slice() {
            [f @ ("ip" | "ipv6"), "prefix-list", rest @ ..] => (*f, rest),
            _ => return Ok(false),
        };
        let Some(name) = rest.first() else { return Err(refuse("% a prefix-list needs a name", &[], line)) };
        let head = format!("{fam} prefix-list {name} ");
        if no {
            if rest.len() == 1 {
                self.lists.retain(|l| !l.starts_with(&head));
            } else {
                self.lists.retain(|l| l != body);
            }
            return Ok(true);
        }
        // The IPv6 list keeps FRR's rules: kept as written.
        let entry = if fam == "ip" { crate::lists::parse(rest).map_err(|m| refuse(m, &[], line))? } else { None };
        match entry {
            Some((_, e)) if e.seq > 0 => {
                let key = format!("{head}seq {} ", e.seq);
                match self.lists.iter_mut().find(|l| l.starts_with(&key)) {
                    Some(l) => *l = body.to_string(),
                    None => self.lists.push(body.to_string()),
                }
            }
            _ if !self.lists.iter().any(|l| l == body) => self.lists.push(body.to_string()),
            _ => {}
        }
        Ok(true)
    }

    /// A side of a CGNAT pool: its list's name when a list gives it (0.151.12, #73).
    pub fn pool_list(&self, pool: &str, side: &str) -> String {
        self.pool_line(pool, &format!("prefix-list-{side} "), "")
    }

    /// What a side of a CGNAT pool maps: its typed prefixes, or what its list resolves to
    /// (permits less denies), with the denies that took something out (0.151.12, #73).
    pub fn pool_side(&self, pool: &str, side: &str) -> (Vec<String>, Vec<String>) {
        let list = self.pool_list(pool, side);
        if list.is_empty() {
            return (self.pool_prefixes(pool, &format!("prefix-{side} ")), vec![]);
        }
        crate::lists::resolve(&crate::lists::entries(&self.lists, &list).unwrap_or_default())
    }

    /// What a commit refuses about the pools' lists (0.151.12, #73): a side given both ways,
    /// a list that does not exist or has no entry, an entry that matches no address, an inside
    /// list that translates nothing, an outside one that leaves no public address.
    pub fn list_refusals(&self) -> Vec<(Vec<String>, String, String)> {
        let mut out = vec![];
        for pool in self.pool_names() {
            let path = vec!["nat".to_string(), "cgnat".to_string(), format!("pool {pool}")];
            for side in ["inside", "outside"] {
                let list = self.pool_list(&pool, side);
                if list.is_empty() {
                    continue;
                }
                let line = format!("prefix-list-{side} {list}");
                let mut say = |m: String| out.push((path.clone(), line.clone(), m));
                if !self.pool_prefixes(&pool, &format!("prefix-{side} ")).is_empty() {
                    say(format!("pool '{pool}': prefix-{side} and prefix-list-{side} both given"));
                    continue;
                }
                let Some(entries) = crate::lists::entries(&self.lists, &list) else {
                    say(format!("pool '{pool}': prefix-list '{list}' does not exist"));
                    continue;
                };
                if entries.is_empty() {
                    say(format!("pool '{pool}': prefix-list '{list}' has no entry"));
                    continue;
                }
                if let Some(e) = entries.iter().find(|e| !e.matches_addresses()) {
                    say(format!("pool '{pool}': prefix-list '{list}' seq {} can match no address", e.seq));
                    continue;
                }
                if self.pool_side(&pool, side).0.is_empty() {
                    say(if side == "inside" {
                        format!("pool '{pool}': prefix-list '{list}' translates nothing")
                    } else {
                        format!("pool '{pool}': prefix-list '{list}' leaves no public address")
                    });
                }
            }
        }
        out
    }

    /// The pool's outside addresses (for the capacity): typed, or what its list resolves to.
    pub fn pool_outside_addresses(&self, pool: &str) -> u64 {
        self.pool_side(pool, "outside")
            .0
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

    /// The lines `neighbor <peer> …` of the BGP process, without the prefix.
    fn bgp_neighbor_lines(&self, peer: &str) -> Vec<String> {
        let head = format!("neighbor {peer} ");
        self.block(&BGP_PATH)
            .map(|b| b.lines.iter().filter_map(|l| l.strip_prefix(&head)).map(str::to_string).collect())
            .unwrap_or_default()
    }

    /// The neighbours of the `router bgp` at `path` that name `group` as their peer-group.
    pub fn peer_group_members(&self, path: &[String], group: &str) -> Vec<String> {
        let tail = format!(" peer-group {group}");
        self.blocks
            .iter()
            .find(|b| b.path == path)
            .map(|b| {
                b.lines
                    .iter()
                    .filter_map(|l| l.strip_suffix(&tail).and_then(|h| h.strip_prefix("neighbor ")).filter(|p| !p.contains(' ')).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether `neighbor <peer> shutdown` is configured (the session is held down).
    pub fn bgp_neighbor_shutdown(&self, peer: &str) -> bool {
        self.bgp_neighbor_lines(peer).iter().any(|l| l == "shutdown")
    }

    /// Whether `neighbor <peer> bfd [profile <name>]` is configured (#66).
    pub fn bgp_neighbor_bfd(&self, peer: &str) -> bool {
        self.bgp_neighbor_lines(peer).iter().any(|l| l == "bfd" || l.starts_with("bfd "))
    }

    pub fn bgp_neighbor_description(&self, peer: &str) -> Option<String> {
        self.bgp_neighbor_lines(peer).iter().find_map(|l| l.strip_prefix("description ").map(str::to_string))
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
        if !self.lists.is_empty() {
            out.extend(self.lists.iter().cloned());
            out.push("!".into());
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
            // A BGP password is masked as the box masks it (#46).
            out.extend(b.lines.iter().map(|l| format!("{indent} {}", crate::typed::mask(l))));
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
        if self.edit_list(line)? {
            return Ok(());
        }
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
            // One line per OSPF setting (`ip ospf cost 20` replaces `ip ospf cost 10`, #43).
            ["ip", "ospf", _, ..] | ["ipv6", "ospf6", _, ..] | ["no", "ip", "ospf", _, ..] | ["no", "ipv6", "ospf6", _, ..] => {
                let no = words[0] == "no";
                let stmt = if no { line[2..].trim() } else { line };
                let key = ospf_key(stmt);
                if !no {
                    i.extra.retain(|l| ospf_key(l) != key);
                    i.extra.push(stmt.to_string());
                } else if i.extra.iter().any(|l| ospf_key(l) == key) {
                    i.extra.retain(|l| ospf_key(l) != key);
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
    fn edit_block(&mut self, path: &[String], line: &str) -> Result<(), Refusal> {
        if path.len() == 1 && path[0] == "router static" {
            check_static(path, line)?;
        }
        check_pool_line(path, line)?;
        if let Some(rest) = line.strip_prefix("no ").map(str::trim) {
            // A mode under this one (`no pool P` under `nat > cgnat`, `no address-family ipv6
            // unicast` under `router bgp`): the block and everything in it.
            let mut child = path.to_vec();
            child.push(rest.to_string());
            self.blocks.retain(|b| !b.path.starts_with(&child));
            let words: Vec<&str> = rest.split_whitespace().collect();
            // `no neighbor <peer>` (or `no neighbor <peer> remote-as …`, as FRR) removes the
            // neighbor: its lines here and in every address family below.
            if path[0].starts_with("router bgp ") && path.len() == 1 && matches!(words.as_slice(), ["neighbor", _] | ["neighbor", _, "remote-as", ..]) {
                // As Prisma 0.149.23: a peer-group a member still names is refused, nothing staged.
                let members = self.peer_group_members(path, words[1]);
                if !members.is_empty() {
                    return Err(refuse(
                        format!("peer-group {} is still used by {}: take them out of it first", words[1], members.join(", ")),
                        path,
                        line,
                    ));
                }
                let head = format!("neighbor {} ", words[1]);
                for b in self.blocks.iter_mut().filter(|b| b.path.starts_with(path)) {
                    b.lines.retain(|l| !l.starts_with(&head));
                }
                return Ok(());
            }
            if let Some(b) = self.blocks.iter_mut().find(|b| b.path == path) {
                let before = b.lines.len();
                b.lines.retain(|l| l != rest);
                // `no max-blocks`, `no interface wan0`, `no bgp router-id`: the line whatever its value.
                if b.lines.len() == before {
                    let key = single_key(rest);
                    b.lines.retain(|l| !(l.starts_with(&format!("{rest} ")) || key.is_some() && single_key(l) == key));
                }
            }
            return Ok(());
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
                return Ok(());
            }
        }
        if !lines.iter().any(|l| l == line) {
            lines.push(line.to_string());
        }
        Ok(())
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
    // PREF64 (0.150.2, #61): one line per NAT64 prefix the advertisements carry.
    &["ipv6", "nd", "nat64"],
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
            (["ipv6", "nd", "nat64"], [p]) => p.split_once('/').is_some_and(|(a, l)| {
                a.parse::<std::net::Ipv6Addr>().is_ok() && l.parse::<u8>().is_ok_and(|l| l <= 128)
            }),
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

        // A peer-group a member still names is refused (Prisma 0.149.23), nothing staged.
        c.edit(&bgp, &p(&["neighbor UPSTREAM peer-group", "neighbor 192.0.2.9 peer-group UPSTREAM"])).ok().unwrap();
        let err = c.edit(&bgp, &p(&["no neighbor UPSTREAM"])).err().unwrap();
        assert!(err.message.contains("192.0.2.9"), "{}", err.message);
        c.edit(&bgp, &p(&["no neighbor 192.0.2.9", "no neighbor UPSTREAM"])).ok().unwrap();
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
        assert!(c.render().contains(" description Carrier uplink\n ip ospf area 0\n ip ospf cost 20\n ipv6 ospf6 passive\n"), "{}", c.render());
        c.edit(&p(&["interface wan0"]), &p(&["no ip ospf cost 20", "no ipv6 ospf6 passive"])).ok().unwrap();
        assert_eq!(c.iface("wan0").unwrap().extra, ["ip ospf area 0"]);
        assert!(c.edit(&p(&["interface wan0"]), &p(&["no ip ospf bfd"])).is_err());

        c.edit(&[], &p(&["no router ospf6"])).ok().unwrap();
        assert!(!c.render().contains("router ospf6"));
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
    fn a_pool_side_given_by_a_list() {
        // Prisma 0.151.12 (#73): the list's permits less its denies; refusals at commit.
        let mut c = Config::seed("t");
        c.edit(&[], &p(&["ip prefix-list SUBS seq 5 deny 100.64.1.0/24 description \"management\"", "ip prefix-list SUBS seq 10 permit 100.64.0.0/22"])).ok().unwrap();
        c.edit(&[], &p(&["ip prefix-list PUBLIC seq 10 permit 198.51.100.0/28"])).ok().unwrap();
        let pool = p(&["nat", "cgnat", "pool LISTS"]);
        c.edit(&pool, &p(&["prefix-list-inside SUBS", "prefix-list-outside PUBLIC", "block-size 512"])).ok().unwrap();
        assert_eq!(c.pool_side("LISTS", "inside"), (p(&["100.64.0.0/24", "100.64.2.0/23"]), p(&["100.64.1.0/24"])));
        assert_eq!(c.pool_outside_addresses("LISTS"), 16);
        assert!(c.list_refusals().is_empty(), "{:?}", c.list_refusals());
        assert!(c.render().contains("ip prefix-list SUBS seq 5 deny 100.64.1.0/24 description \"management\"\n"));
        // The same sequence replaces the entry; a list a pool names must exist; both ways refused.
        c.edit(&[], &p(&["ip prefix-list PUBLIC seq 10 permit 198.51.100.16/28"])).ok().unwrap();
        assert_eq!(c.pool_side("LISTS", "outside").0, ["198.51.100.16/28"]);
        c.edit(&pool, &p(&["prefix-inside 10.0.0.0/8"])).ok().unwrap();
        assert!(c.list_refusals()[0].2.contains("prefix-inside and prefix-list-inside both given"));
        c.edit(&pool, &p(&["no prefix-inside 10.0.0.0/8", "prefix-list-outside NOPE"])).ok().unwrap();
        assert_eq!(c.list_refusals()[0].2, "pool 'LISTS': prefix-list 'NOPE' does not exist");
        c.edit(&pool, &p(&["no prefix-list-outside"])).ok().unwrap();
        assert_eq!(c.pool_list("LISTS", "outside"), "");
        // A NAT64 pool takes no list.
        assert!(c.edit(&p(&["nat", "nat64", "pool V6"]), &p(&["prefix-list-inside SUBS"])).is_err());
    }

    #[test]
    fn networks() {
        assert_eq!(network("203.0.113.10/29").unwrap(), "203.0.113.8/29");
        assert_eq!(network("2001:db8:200:10::1/64").unwrap(), "2001:db8:200:10::/64");
    }
}

/// A pool's lines as 0.151.0 checks them (#68): NAT64's under `nat > nat64` only, `mode bpa`
/// for what was `mode dynamic`, and no bypass on a NAT64 pool.
fn check_pool_line(path: &[String], line: &str) -> Result<(), Refusal> {
    let level = match path {
        [n, l, p] if n == "nat" && p.starts_with("pool ") => l.as_str(),
        _ => return Ok(()),
    };
    let w: Vec<&str> = line.split_whitespace().collect();
    let refused = match (level, w.as_slice()) {
        (_, ["mode", "dynamic"]) => Some("% mode dynamic is mode bpa since 0.151.0"),
        ("cgnat", ["prefix-inside", p]) if p.contains(':') => Some("% an IPv6 inside prefix is a NAT64 pool's: it goes under nat > nat64"),
        ("cgnat", ["subscriber-length" | "nat64-prefix", ..]) => Some("% a NAT64 pool's statement: it goes under nat > nat64"),
        ("nat64", ["bypass", ..]) => Some("% a NAT64 pool takes no bypass"),
        ("nat64", ["prefix-list-inside" | "prefix-list-outside", ..]) => Some("% a NAT64 pool takes no prefix-list"),
        _ => None,
    };
    match refused {
        Some(m) => Err(refuse(m.to_string(), path, line)),
        None => Ok(()),
    }
}
