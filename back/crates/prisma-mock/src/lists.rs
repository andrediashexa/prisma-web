//! `ip prefix-list` at the top level, and a CGNAT pool's side given by one
//! (Prisma 0.151.12, prismarouting #589, prisma-web #73).
//!
//! A pool reads a list as addresses: an entry with neither `ge` nor `le` covers
//! its whole prefix; with either, an address counts as a /32 and the entry
//! covers its prefix when 32 is in the window, and matches nothing otherwise.
//! What a side resolves to is the permits less the denies.

use std::net::Ipv4Addr;

/// One entry of a list: `ip prefix-list <name> [seq <n>] permit|deny <prefix> [ge <n>] [le <n>] [description <text>]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub seq: u32,
    pub permit: bool,
    pub prefix: String,
    pub ge: u32,
    pub le: u32,
    pub description: String,
}

impl Entry {
    /// Whether a pool can use it: some address is a /32 in its window.
    pub fn matches_addresses(&self) -> bool {
        let len = self.prefix.split_once('/').and_then(|(_, l)| l.parse::<u32>().ok()).unwrap_or(32);
        if self.ge == 0 && self.le == 0 {
            return true;
        }
        let lo = if self.ge == 0 { len } else { self.ge };
        let hi = if self.le == 0 { 32 } else { self.le };
        (lo..=hi).contains(&32)
    }
}

/// The text of a `description` part: the quotes are not part of it.
fn unquote(s: &str) -> String {
    s.trim().trim_matches('"').to_string()
}

/// An entry line after `ip prefix-list`, or why it is refused; `None` for the list's own
/// `description`, `insert` and `resequence` forms.
pub fn parse(words: &[&str]) -> Result<Option<(String, Entry)>, String> {
    let [name, rest @ ..] = words else { return Err("a prefix-list needs a name".into()) };
    if matches!(rest.first(), Some(&("description" | "insert" | "resequence"))) {
        return Ok(None);
    }
    let (seq, rest) = match rest {
        ["seq", n, r @ ..] => (n.parse::<u32>().map_err(|_| format!("% bad sequence number {n}"))?, r),
        r => (0, r),
    };
    let [action @ ("permit" | "deny"), prefix, rest @ ..] = rest else { return Err("% permit or deny, then a prefix".into()) };
    if parse_v4(prefix).is_none() {
        return Err(format!("% {prefix} is not an IPv4 prefix"));
    }
    let mut e = Entry { seq, permit: *action == "permit", prefix: (*prefix).into(), ge: 0, le: 0, description: String::new() };
    let mut i = 0;
    while i < rest.len() {
        match rest[i] {
            "ge" | "le" => {
                let n = rest.get(i + 1).and_then(|n| n.parse::<u32>().ok()).filter(|n| *n <= 32).ok_or("% ge and le take 0 to 32")?;
                if rest[i] == "ge" { e.ge = n } else { e.le = n }
                i += 2;
            }
            "description" => {
                e.description = unquote(&rest[i + 1..].join(" "));
                if e.description.len() > 63 {
                    return Err("% an entry's description is at most 63 bytes".into());
                }
                break;
            }
            w => return Err(format!("% unknown word {w}")),
        }
    }
    Ok(Some(((*name).into(), e)))
}

/// The entries of the IPv4 list `name` in the top-level lines, in order; `None` when no line names it.
pub fn entries(lines: &[String], name: &str) -> Option<Vec<Entry>> {
    let mut found = false;
    let mut out = vec![];
    for l in lines {
        let w: Vec<&str> = l.split_whitespace().collect();
        if w.len() > 2 && w[0] == "ip" && w[1] == "prefix-list" && w[2] == name {
            found = true;
            if let Ok(Some((_, e))) = parse(&w[2..]) {
                out.push(e);
            }
        }
    }
    found.then_some(out)
}

fn parse_v4(p: &str) -> Option<(u32, u32)> {
    let (a, l) = p.split_once('/')?;
    let len: u32 = l.parse().ok().filter(|l| *l <= 32)?;
    let a: Ipv4Addr = a.parse().ok()?;
    let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
    Some((u32::from(a) & mask, len))
}

fn show(net: (u32, u32)) -> String {
    format!("{}/{}", Ipv4Addr::from(net.0), net.1)
}

/// `p` less `d`, as prefixes.
fn subtract(p: (u32, u32), d: (u32, u32)) -> Vec<(u32, u32)> {
    let covers = |outer: (u32, u32), inner: (u32, u32)| {
        outer.1 <= inner.1 && (outer.1 == 0 || (outer.0 ^ inner.0) >> (32 - outer.1) == 0)
    };
    if covers(d, p) {
        return vec![];
    }
    if !covers(p, d) {
        return vec![p];
    }
    let half = p.1 + 1;
    let (lo, hi) = ((p.0, half), (p.0 | (1 << (32 - half)), half));
    [subtract(lo, d), subtract(hi, d)].concat()
}

/// What a side given by a list resolves to: the permits less the denies, and the denied
/// prefixes that took something out of a permit.
pub fn resolve(entries: &[Entry]) -> (Vec<String>, Vec<String>) {
    let usable: Vec<&Entry> = entries.iter().filter(|e| e.matches_addresses()).collect();
    let denies: Vec<(u32, u32)> = usable.iter().filter(|e| !e.permit).filter_map(|e| parse_v4(&e.prefix)).collect();
    let mut nets: Vec<(u32, u32)> = usable.iter().filter(|e| e.permit).filter_map(|e| parse_v4(&e.prefix)).collect();
    let mut took = vec![];
    for d in &denies {
        let before = nets.clone();
        nets = nets.into_iter().flat_map(|n| subtract(n, *d)).collect();
        if nets != before {
            took.push(show(*d));
        }
    }
    (nets.into_iter().map(show).collect(), took)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> Entry {
        let w: Vec<&str> = s.split_whitespace().collect();
        parse(&w).unwrap().unwrap().1
    }

    #[test]
    fn a_list_is_its_permits_less_its_denies() {
        let es = [line("L seq 5 deny 100.64.1.0/24 description \"management\""), line("L seq 10 permit 100.64.0.0/22")];
        assert_eq!(es[0].description, "management");
        let (nets, took) = resolve(&es);
        assert_eq!(nets, ["100.64.0.0/24", "100.64.2.0/23"]);
        assert_eq!(took, ["100.64.1.0/24"]);
    }

    #[test]
    fn a_window_without_32_matches_no_address() {
        assert!(!line("L permit 10.0.0.0/8 le 24").matches_addresses());
        assert!(line("L permit 10.0.0.0/8 ge 32").matches_addresses());
        assert!(line("L permit 10.0.0.0/8").matches_addresses());
        let w: Vec<&str> = "L permit 10.0.0.0/8 description x".split_whitespace().collect();
        assert!(parse(&w).is_ok());
        let long = format!("L permit 10.0.0.0/8 description {}", "x".repeat(64));
        let w: Vec<&str> = long.split_whitespace().collect();
        assert!(parse(&w).is_err(), "at most 63 bytes");
    }
}
