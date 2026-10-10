//! The VTY's statement syntax (#39): `neighbor <address> remote-as <1-4294967295>|internal|external`,
//! `[optional]`, `a | b` alternatives, as the coverage map writes it; parsed into
//! tokens, and a configuration line matched against them. Shared by the back end
//! (the structured editor) and the mock (its GetSchema).

use std::collections::BTreeMap;

use serde::Serialize;

/// One element of a statement's syntax.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Tok {
    Word { w: String },
    /// A value: `<A.B.C.D/M>`, `<1-65535>`, `<name>`; `prefix` is a literal
    /// glued before it (`bond<n>`). `rest` takes every word left (a description).
    Param { id: usize, label: String, kind: Kind, prefix: String, rest: bool },
    Opt { items: Vec<Tok> },
    Alt { options: Vec<Vec<Tok>> },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum Kind {
    Text,
    Int { min: u64, max: u64 },
    Ipv4,
    Ipv4Prefix,
    Ipv6,
    Ipv6Prefix,
    /// An IPv4 or IPv6 address.
    Address,
    /// An IPv4 or IPv6 prefix.
    Prefix,
    Interface,
    /// Where a static route goes: an address, an interface, `blackhole`, `Null0` or `reject`,
    /// one word. The box's schema says `address` with `source: next_hops` (#92).
    NextHop,
}

pub fn kind_of(label: &str) -> Kind {
    if let Some((lo, hi)) = label.split_once('-') {
        if let (Ok(min), Ok(max)) = (lo.parse(), hi.parse()) {
            return Kind::Int { min, max };
        }
    }
    match label {
        "A.B.C.D/M" => Kind::Ipv4Prefix,
        "A.B.C.D" => Kind::Ipv4,
        "X:X::X:X/M" => Kind::Ipv6Prefix,
        "X:X::X:X" => Kind::Ipv6,
        "address" | "neighbour" | "neighbor" | "collector" | "source" => Kind::Address,
        "next-hop" | "nexthop" => Kind::NextHop,
        "prefix" | "network" => Kind::Prefix,
        "interface" | "ifname" => Kind::Interface,
        "n" | "seq" | "asn" | "MB" | "GB" | "keepalive" | "hold" | "minutes" | "percent" | "metric" | "cost" | "distance" => {
            Kind::Int { min: 0, max: u32::MAX as u64 }
        }
        _ => Kind::Text,
    }
}

/// `A.B.C.D|X:X::X:X` and the like: alternatives that are all value labels
/// make one value of the widest kind; anything else is a choice of keywords.
fn union_kind(words: &str) -> Option<Kind> {
    let kinds: Vec<Kind> = words.split('|').map(kind_of).collect();
    let all = |f: fn(&Kind) -> bool| kinds.iter().all(f);
    if all(|k| matches!(k, Kind::Ipv4 | Kind::Ipv6 | Kind::Address)) {
        Some(Kind::Address)
    } else if all(|k| matches!(k, Kind::Ipv4Prefix | Kind::Ipv6Prefix | Kind::Prefix)) {
        Some(Kind::Prefix)
    } else {
        None
    }
}

/// Splits on `sep` outside square brackets.
fn split_top<'a>(s: &'a str, sep: &str) -> Vec<&'a str> {
    let (mut out, mut depth, mut start) = (vec![], 0i32, 0usize);
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'[' => depth += 1,
            b']' => depth -= 1,
            _ if depth == 0 && s[i..].starts_with(sep) => {
                out.push(&s[start..i]);
                i += sep.len();
                start = i;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(&s[start..]);
    out
}

struct Parser {
    next_id: usize,
    /// The statement names `ipv6`: the coverage map labels its prefixes
    /// `<A.B.C.D/M>` too, so they are taken as IPv6 (#39).
    ipv6: bool,
    /// The statement belongs to `address-family <afi> <safi>`, which serves both families:
    /// its `<A.B.C.D/M>` takes an IPv6 prefix too (#42).
    any_family: bool,
}

impl Parser {
    fn atom(&mut self, a: &str) -> Tok {
        if let (Some(open), true) = (a.find('<'), a.ends_with('>')) {
            let label = a[open + 1..a.len() - 1].to_string();
            let id = self.next_id;
            self.next_id += 1;
            let kind = match (kind_of(&label), self.ipv6) {
                (Kind::Ipv4Prefix, _) if self.any_family => Kind::Prefix,
                (Kind::Ipv4Prefix, true) => Kind::Ipv6Prefix,
                (Kind::Ipv4, true) => Kind::Ipv6,
                (k, _) => k,
            };
            return Tok::Param { id, kind, label, prefix: a[..open].to_string(), rest: false };
        }
        Tok::Word { w: a.to_string() }
    }

    fn seq(&mut self, s: &str) -> Vec<Tok> {
        let mut out = vec![];
        for part in split_top(s.trim(), " ").into_iter().filter(|p| !p.is_empty()) {
            // `<A.B.C.D|X:X::X:X>...`: one or more values of that kind, to the end (Prisma 0.152.5, #94).
            if let Some(base) = part.strip_suffix("...").filter(|b| b.starts_with('<') && b.ends_with('>')) {
                let mut one = self.seq(base);
                if let [Tok::Param { rest, .. }] = one.as_mut_slice() {
                    *rest = true;
                }
                out.extend(one);
                continue;
            }
            // `rt|soo:<asn>:<value>...`: values of a shape the map spells out, to the end. The box
            // states it as one word argument, many (seen on 0.152.9, #89): any words here.
            if let Some(base) = part.strip_suffix("...").filter(|b| b.contains('<') && !b.starts_with('<')) {
                let id = self.next_id;
                self.next_id += 1;
                out.push(Tok::Param { id, label: base.to_string(), kind: Kind::Text, prefix: String::new(), rest: true });
                continue;
            }
            if let Some(inner) = part.strip_prefix('[').and_then(|p| p.strip_suffix(']')) {
                // `[options]` stands for free-form options, not the word "options".
                if !inner.contains(' ') && !inner.contains('<') && !inner.contains('|') && inner == "options" {
                    let id = self.next_id;
                    self.next_id += 1;
                    out.push(Tok::Opt {
                        items: vec![Tok::Param { id, label: "options".into(), kind: Kind::Text, prefix: String::new(), rest: true }],
                    });
                } else {
                    out.push(Tok::Opt { items: self.alts(inner) });
                }
            } else if let Some(words) = part.strip_prefix('<').and_then(|p| p.strip_suffix('>')).filter(|p| p.contains('|')) {
                match union_kind(words) {
                    // `<A.B.C.D|X:X::X:X>`: one value of either family (Prisma 0.149.20, #44).
                    Some(kind) => {
                        let id = self.next_id;
                        self.next_id += 1;
                        out.push(Tok::Param { id, label: words.to_string(), kind, prefix: String::new(), rest: false });
                    }
                    // `<on|off>`: a choice of keywords written as a value (#41).
                    None => out.push(Tok::Alt { options: words.split('|').map(|w| vec![Tok::Word { w: w.to_string() }]).collect() }),
                }
            } else if part.contains('|') {
                out.push(Tok::Alt { options: part.split('|').map(|o| vec![self.atom(o)]).collect() });
            } else {
                out.push(self.atom(part));
            }
        }
        // A text value at the very end takes the rest of the line (`description <text>`).
        if let Some(Tok::Param { kind: Kind::Text, rest, .. }) = out.last_mut() {
            *rest = true;
        }
        out
    }

    /// A syntax with ` | ` alternatives at the top level: the alternatives
    /// replace the tail after the leading keywords. An alternative that is a
    /// keyword followed by more (`dhcp-leases <path>`) is a sibling of the last
    /// keyword (`identity file <path> | dhcp-leases <path>`); a bare word
    /// (`| disable`) follows the keywords, unless siblings were found.
    fn alts(&mut self, s: &str) -> Vec<Tok> {
        let parts = split_top(s, " | ");
        if parts.len() == 1 {
            return self.seq(s);
        }
        let base = self.seq(parts[0]);
        let others: Vec<Vec<Tok>> = parts[1..].iter().map(|p| self.seq(p)).collect();
        let k = base.iter().take_while(|t| matches!(t, Tok::Word { .. })).count();
        let sibling = |o: &Vec<Tok>| matches!(o.first(), Some(Tok::Word { .. })) && o.len() > 1;
        let p = if k > 0 && others.iter().any(sibling) { k - 1 } else { k };
        let mut options = vec![base[p..].to_vec()];
        options.extend(others);
        let mut out = base[..p].to_vec();
        out.push(Tok::Alt { options });
        out
    }
}

/// Tokens back to the syntax as the coverage map writes it.
pub fn describe(tokens: &[Tok]) -> String {
    tokens
        .iter()
        .map(|t| match t {
            Tok::Word { w } => w.clone(),
            // A shape spelled out (`rt|soo:<asn>:<value>...`, #89) is written back as it came.
            Tok::Param { label, prefix, .. } if label.contains('<') => format!("{prefix}{label}..."),
            Tok::Param { label, prefix, .. } => format!("{prefix}<{label}>"),
            Tok::Opt { items } => format!("[{}]", describe(items)),
            Tok::Alt { options } => options.iter().map(|o| describe(o)).collect::<Vec<_>>().join("|"),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_syntax(s: &str) -> Vec<Tok> {
    Parser { next_id: 0, ipv6: s.split_whitespace().any(|w| w == "ipv6"), any_family: false }.alts(s)
}

/// A statement of a mode: in an address family, a prefix may be of either family.
pub fn parse_statement(path: &[String], s: &str) -> Vec<Tok> {
    let any_family = path.last().is_some_and(|e| e.starts_with("address-family <afi>"));
    Parser { next_id: 0, ipv6: s.split_whitespace().any(|w| w == "ipv6"), any_family }.alts(s)
}

/// The values a line gives a statement's parameters, by id; `None` when the
/// line is not that statement.
pub fn match_line(toks: &[Tok], words: &[&str]) -> Option<BTreeMap<usize, String>> {
    fn go(toks: &[Tok], words: &[&str], vals: &mut BTreeMap<usize, String>) -> bool {
        let Some((first, rest)) = toks.split_first() else { return words.is_empty() };
        match first {
            Tok::Word { w } => words.first() == Some(&w.as_str()) && go(rest, &words[1..], vals),
            Tok::Param { id, kind, prefix, rest: takes_rest, .. } => {
                let Some(word) = words.first() else { return false };
                let Some(v) = word.strip_prefix(prefix.as_str()) else { return false };
                if !valid(kind, v) {
                    return false;
                }
                if *takes_rest && rest.is_empty() {
                    // A list of values (addresses, #93) checks each; text is any words.
                    if !matches!(kind, Kind::Text) && !words[1..].iter().all(|w| valid(kind, w)) {
                        return false;
                    }
                    vals.insert(*id, words.join(" ").strip_prefix(prefix.as_str()).unwrap_or_default().to_string());
                    return true;
                }
                vals.insert(*id, v.to_string());
                go(rest, &words[1..], vals) || {
                    vals.remove(id);
                    false
                }
            }
            Tok::Opt { items } => {
                let mut with: Vec<Tok> = items.clone();
                with.extend_from_slice(rest);
                let mut tried = vals.clone();
                if go(&with, words, &mut tried) {
                    *vals = tried;
                    return true;
                }
                go(rest, words, vals)
            }
            Tok::Alt { options } => options.iter().any(|o| {
                let mut with = o.clone();
                with.extend_from_slice(rest);
                let mut tried = vals.clone();
                go(&with, words, &mut tried) && {
                    *vals = tried;
                    true
                }
            }),
        }
    }
    let mut vals = BTreeMap::new();
    go(toks, words, &mut vals).then_some(vals)
}

/// `[2001:db8::1]` → `2001:db8::1`; anything else as it is.
fn unbracket(v: &str) -> &str {
    v.strip_prefix('[').and_then(|x| x.strip_suffix(']')).filter(|x| x.contains(':')).unwrap_or(v)
}

/// Whether a word can be the value of a parameter; loose on purpose: the box
/// has the last word, this only tells statements apart.
pub fn valid(kind: &Kind, v: &str) -> bool {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    let prefix = |v: &str, v6: Option<bool>| {
        v.split_once('/').is_some_and(|(a, l)| {
            l.parse::<u8>().is_ok()
                && match v6 {
                    Some(true) => a.parse::<Ipv6Addr>().is_ok(),
                    Some(false) => a.parse::<Ipv4Addr>().is_ok(),
                    None => a.parse::<IpAddr>().is_ok(),
                }
        })
    };
    match kind {
        Kind::Text | Kind::Interface => !v.is_empty(),
        Kind::NextHop => !v.is_empty() && !v.contains(char::is_whitespace),
        Kind::Int { min, max } => v.parse::<u64>().is_ok_and(|n| n >= *min && n <= *max),
        Kind::Ipv4 => v.parse::<Ipv4Addr>().is_ok(),
        Kind::Ipv6 => unbracket(v).parse::<Ipv6Addr>().is_ok(),
        // An IPv6 address may come bracketed, as sshd prints it (`[::]`, Prisma 0.152.5, #94).
        Kind::Address => unbracket(v).parse::<IpAddr>().is_ok(),
        Kind::Ipv4Prefix => prefix(v, Some(false)),
        Kind::Ipv6Prefix => prefix(v, Some(true)),
        Kind::Prefix => prefix(v, None),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_of_addresses_bracketed_or_not() {
        // Prisma 0.152.5 (#94): `<A.B.C.D|X:X::X:X>...`, and IPv6 as sshd prints it.
        let t = parse_syntax("ssh listen-address <A.B.C.D|X:X::X:X>...");
        let w = |s: &'static str| s.split_whitespace().collect::<Vec<_>>();
        assert!(match_line(&t, &w("ssh listen-address 192.0.2.166 [2001:db8:6::166]")).is_some());
        assert!(match_line(&t, &w("ssh listen-address 0.0.0.0 [::]")).is_some());
        assert!(match_line(&t, &w("ssh listen-address 192.0.2.166")).is_some());
        assert!(match_line(&t, &w("ssh listen-address 192.0.2.166 nope")).is_none());
        assert!(match_line(&t, &w("ssh listen-address [10.0.0.1]")).is_none(), "brackets are IPv6's");
    }

    #[test]
    fn a_spelled_out_shape_with_dots_is_one_list_to_the_end() {
        let t = parse_syntax("extended-community <name> members rt|soo:<asn>:<value>...");
        assert_eq!(describe(&t), "extended-community <name> members rt|soo:<asn>:<value>...");
        let v = match_line(&t, &["extended-community", "RT", "members", "rt:65000:100", "soo:65000:7"]).expect("matches");
        assert_eq!(v.values().last().map(String::as_str), Some("rt:65000:100 soo:65000:7"));
    }
}