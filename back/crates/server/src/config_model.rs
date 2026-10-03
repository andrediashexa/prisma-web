//! The configuration as a structure (#39): the VTY's grammar, the running
//! configuration as a tree of statements, and which statement each line is.
//!
//! The grammar comes from `config_grammar.json`, extracted by
//! `scripts/config-grammar.py` from the vendored coverage map, which Prisma
//! generates from the VTY's own grammar (#558). When the box answers
//! `GetSchema` (Prisma 0.149.20) that becomes the source; the model is the same.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct RawGrammar {
    areas: Vec<RawArea>,
}

#[derive(Deserialize)]
struct RawArea {
    title: String,
    path: Vec<String>,
    roles: Vec<String>,
    statements: Vec<RawStatement>,
}

#[derive(Deserialize)]
struct RawStatement {
    syntax: String,
    class: String,
}

/// A configuration mode: the statements reachable at one path.
#[derive(Serialize, Clone)]
pub struct Mode {
    /// The path template joined with " > "; "config" for the top level.
    pub key: String,
    pub title: String,
    /// E.g. `["nat", "cgnat", "pool <name>"]`.
    pub path: Vec<String>,
    pub path_tokens: Vec<Vec<Tok>>,
    /// Box roles that may change it ("administrator", "cgnat-operator").
    pub roles: Vec<String>,
    pub groups: Vec<Group>,
}

#[derive(Serialize, Clone)]
pub struct Group {
    pub title: String,
    pub statements: Vec<Statement>,
}

#[derive(Serialize, Clone)]
pub struct Statement {
    pub syntax: String,
    pub class: String,
    pub tokens: Vec<Tok>,
}

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
}

fn kind_of(label: &str) -> Kind {
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
        "address" | "neighbour" | "neighbor" | "collector" | "source" | "next-hop" | "nexthop" => Kind::Address,
        "prefix" | "network" => Kind::Prefix,
        "interface" | "ifname" => Kind::Interface,
        "n" | "seq" | "asn" | "MB" | "GB" | "keepalive" | "hold" | "minutes" | "percent" | "metric" | "cost" | "distance" => {
            Kind::Int { min: 0, max: u32::MAX as u64 }
        }
        _ => Kind::Text,
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

pub fn parse_syntax(s: &str) -> Vec<Tok> {
    Parser { next_id: 0, ipv6: s.split_whitespace().any(|w| w == "ipv6"), any_family: false }.alts(s)
}

/// A statement of a mode: in an address family, a prefix may be of either family.
fn parse_statement(path: &[String], s: &str) -> Vec<Tok> {
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
        Kind::Int { min, max } => v.parse::<u64>().is_ok_and(|n| n >= *min && n <= *max),
        Kind::Ipv4 => v.parse::<Ipv4Addr>().is_ok(),
        Kind::Ipv6 => v.parse::<Ipv6Addr>().is_ok(),
        Kind::Address => v.parse::<IpAddr>().is_ok(),
        Kind::Ipv4Prefix => prefix(v, Some(false)),
        Kind::Ipv6Prefix => prefix(v, Some(true)),
        Kind::Prefix => prefix(v, None),
    }
}

/// Every mode of the grammar, statements of the same path merged in groups.
pub static MODES: LazyLock<Vec<Mode>> = LazyLock::new(|| {
    let raw: RawGrammar = serde_json::from_str(include_str!("config_grammar.json")).expect("config_grammar.json");
    let mut modes: Vec<Mode> = vec![];
    for a in raw.areas {
        let group = Group {
            title: a.title.clone(),
            statements: a
                .statements
                .into_iter()
                .map(|s| Statement { tokens: parse_statement(&a.path, &s.syntax), syntax: s.syntax, class: s.class })
                .collect(),
        };
        match modes.iter_mut().find(|m| m.path == a.path) {
            Some(m) => m.groups.push(group),
            None => modes.push(Mode {
                key: if a.path.is_empty() { "config".into() } else { a.path.join(" > ") },
                path_tokens: a.path.iter().map(|e| parse_syntax(e)).collect(),
                title: a.title,
                path: a.path,
                roles: a.roles,
                groups: vec![group],
            }),
        }
    }
    modes
});

/// A line of the configuration and the lines under it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Node {
    pub line: String,
    pub children: Vec<Node>,
}

/// The configuration text as a tree, by indentation; `!`, `exit`, `end` and
/// `exit-address-family` close a level and are not statements.
pub fn tree(text: &str) -> Vec<Node> {
    let mut root: Vec<Node> = vec![];
    // Stack of (indent, path of child indices).
    let mut stack: Vec<(usize, Vec<usize>)> = vec![];
    for raw in text.lines() {
        let line = raw.trim_end();
        let content = line.trim_start();
        if content.is_empty() || content.starts_with('!') || matches!(content, "exit" | "end" | "exit-address-family" | "exit-vrf") {
            continue;
        }
        let indent = line.len() - content.len();
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let node = Node { line: content.to_string(), children: vec![] };
        let path = match stack.last() {
            None => {
                root.push(node);
                vec![root.len() - 1]
            }
            Some((_, p)) => {
                let mut cur = &mut root[p[0]];
                for &i in &p[1..] {
                    cur = &mut cur.children[i];
                }
                cur.children.push(node);
                let mut p = p.clone();
                p.push(cur.children.len() - 1);
                p
            }
        };
        stack.push((indent, path));
    }
    root
}

/// One configured instance of a mode (an interface, a pool, the BGP process).
#[derive(Serialize)]
pub struct Instance {
    pub mode: String,
    /// The concrete path, as `EditRequest.path` takes it.
    pub path: Vec<String>,
    pub lines: Vec<Line>,
}

#[derive(Serialize)]
pub struct Line {
    pub text: String,
    /// `[group, statement]` in the mode; `None` when no statement matched.
    pub statement: Option<(usize, usize)>,
    pub values: BTreeMap<usize, String>,
}

fn words(s: &str) -> Vec<&str> {
    s.split_whitespace().collect()
}

/// How specific a path element is: the literal characters it pins.
fn specificity(toks: &[Tok]) -> usize {
    toks.iter()
        .map(|t| match t {
            Tok::Word { w } => w.len() + 10,
            Tok::Param { prefix, .. } => prefix.len(),
            _ => 0,
        })
        .sum()
}

/// The mode a line enters at `depth` under `parent`, if any.
fn mode_entered<'a>(parent: &[String], line: &str) -> Option<&'a Mode> {
    let w = words(line);
    MODES
        .iter()
        .filter(|m| m.path.len() == parent.len() + 1 && m.path[..parent.len()].iter().zip(parent).all(|(t, c)| element_matches(t, c)))
        .filter(|m| match_line(&m.path_tokens[parent.len()], &w).is_some())
        .max_by_key(|m| specificity(&m.path_tokens[parent.len()]))
}

fn element_matches(template: &str, concrete: &str) -> bool {
    match_line(&parse_syntax(template), &words(concrete)).is_some()
}

/// Every configured instance of every mode, the root first.
pub fn instances(roots: &[Node]) -> Vec<Instance> {
    let mut out = vec![];
    let root = MODES.iter().find(|m| m.path.is_empty()).expect("the top-level mode");
    walk(root, vec![], roots, &mut out);
    out
}

fn walk(mode: &Mode, path: Vec<String>, nodes: &[Node], out: &mut Vec<Instance>) {
    let mut lines = vec![];
    let mut nested = vec![];
    for n in nodes {
        match mode_entered(&path, &n.line) {
            Some(child) => nested.push((child, n)),
            None => lines.push(classify(mode, &n.line)),
        }
    }
    out.push(Instance { mode: mode.key.clone(), path: path.clone(), lines });
    for (child, n) in nested {
        let mut p = path.clone();
        p.push(n.line.clone());
        walk(child, p, &n.children, out);
    }
}

fn classify(mode: &Mode, line: &str) -> Line {
    let w = words(line);
    for (gi, g) in mode.groups.iter().enumerate() {
        for (si, s) in g.statements.iter().enumerate() {
            if let Some(values) = match_line(&s.tokens, &w) {
                return Line { text: line.to_string(), statement: Some((gi, si)), values };
            }
        }
    }
    Line { text: line.to_string(), statement: None, values: BTreeMap::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Vec<&str> {
        s.split_whitespace().collect()
    }

    #[test]
    fn syntax_with_ranges_optionals_and_choices() {
        let t = parse_syntax("neighbor <address> remote-as <1-4294967295>|internal|external");
        assert!(matches!(&t[1], Tok::Param { kind: Kind::Address, .. }));
        assert!(matches!(&t[3], Tok::Alt { options } if options.len() == 3));
        let v = match_line(&t, &w("neighbor 203.0.113.9 remote-as 64500")).unwrap();
        assert_eq!(v.values().cloned().collect::<Vec<_>>(), ["203.0.113.9", "64500"]);
        assert!(match_line(&t, &w("neighbor 2001:db8::1 remote-as internal")).is_some());
        assert!(match_line(&t, &w("neighbor nope remote-as 1")).is_none(), "not an address");

        let t = parse_syntax("aggregate-address <A.B.C.D/M> [summary-only] [policy <policy>]");
        assert!(match_line(&t, &w("aggregate-address 192.0.2.0/24")).is_some());
        assert!(match_line(&t, &w("aggregate-address 192.0.2.0/24 summary-only policy OUT")).is_some());
        assert!(match_line(&t, &w("aggregate-address 192.0.2.0/24 policy")).is_none());
    }

    #[test]
    fn top_level_alternatives_replace_the_tail() {
        let t = parse_syntax("identity file <path> | dhcp-leases <path> | radius secret <s> [port <n>] | none");
        assert!(matches!(&t[0], Tok::Word { w } if w == "identity"));
        for ok in ["identity file /x", "identity dhcp-leases /y", "identity radius secret s port 1812", "identity none"] {
            assert!(match_line(&t, &w(ok)).is_some(), "{ok}");
        }
        let t = parse_syntax("logging udp <collector> src <source> [port <n>] | disable");
        assert!(match_line(&t, &w("logging udp 192.0.2.52 src 203.0.113.10 port 4739")).is_some());
        assert!(match_line(&t, &w("logging udp disable")).is_some());
    }

    #[test]
    fn ipv6_statements_take_ipv6_values() {
        let t = parse_syntax("ipv6 address <A.B.C.D/M>");
        assert!(match_line(&t, &w("ipv6 address 2001:db8:100::2/64")).is_some());
        assert!(match_line(&t, &w("ipv6 address 192.0.2.1/24")).is_none());
        assert!(match_line(&parse_syntax("ipv4 address <A.B.C.D/M>"), &w("ipv4 address 192.0.2.1/24")).is_some());
    }

    #[test]
    fn a_final_text_takes_the_rest_and_glued_prefixes_match() {
        let t = parse_syntax("description <text>");
        assert_eq!(match_line(&t, &w("description Carrier uplink")).unwrap()[&0], "Carrier uplink");
        let t = parse_syntax("interface bond<n>");
        assert_eq!(match_line(&t, &w("interface bond1")).unwrap()[&0], "1");
        assert!(match_line(&t, &w("interface wan0")).is_none());
    }

    #[test]
    fn the_running_text_becomes_a_tree_and_its_instances() {
        let text = "hostname h\n!\ninterface wan0\n description Carrier uplink\n mtu 1500\n exit\nnat\n cgnat\n  pool P\n   block-size 256\n  exit\n exit\n!\nrouter bgp 65000\n neighbor 203.0.113.9 remote-as 64500\n!\nend\n";
        let t = tree(text);
        assert_eq!(t.iter().map(|n| n.line.as_str()).collect::<Vec<_>>(), ["hostname h", "interface wan0", "nat", "router bgp 65000"]);
        assert_eq!(t[2].children[0].children[0].line, "pool P");
        let inst = instances(&t);
        let find = |k: &str| inst.iter().find(|i| i.mode == k).unwrap_or_else(|| panic!("{k}"));
        assert_eq!(find("interface <name>").path, ["interface wan0"]);
        assert!(find("interface <name>").lines.iter().all(|l| l.statement.is_some()), "description and mtu are statements");
        assert_eq!(find("nat > cgnat > pool <name>").path, ["nat", "cgnat", "pool P"]);
        let bgp = find("router bgp <asn>");
        assert!(bgp.lines[0].statement.is_some(), "a neighbor line is a bgp neighbor statement");
        assert!(find("config").lines.iter().any(|l| l.text == "hostname h"));
    }

    #[test]
    fn an_address_family_takes_prefixes_of_both_families() {
        let af = MODES.iter().find(|m| m.key == "router bgp <asn> > address-family <afi> <safi>").unwrap();
        let network = af.groups.iter().flat_map(|g| &g.statements).find(|s| s.syntax.starts_with("network ")).unwrap();
        assert!(match_line(&network.tokens, &w("network 2001:db8:1::/48")).is_some());
        assert!(match_line(&network.tokens, &w("network 192.0.2.0/24 policy P")).is_some());
        let bgp = MODES.iter().find(|m| m.key == "router bgp <asn>").unwrap();
        let top = bgp.groups.iter().flat_map(|g| &g.statements).find(|s| s.syntax.starts_with("network ")).unwrap();
        assert!(match_line(&top.tokens, &w("network 2001:db8:1::/48")).is_none(), "router bgp itself is IPv4");
    }

    #[test]
    fn every_statement_of_the_grammar_parses() {
        let n: usize = MODES.iter().flat_map(|m| &m.groups).map(|g| g.statements.len()).sum();
        assert!(n > 500, "{n} statements");
        assert!(MODES.iter().any(|m| m.key == "interface bond<n>"));
    }
}
