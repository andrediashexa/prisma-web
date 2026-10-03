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

pub use prisma_proto::vty::{match_line, parse_statement, parse_syntax, Kind, Tok};

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

/// The modes of a box's GetSchema (Prisma 0.149.20), in the same model as the
/// coverage map's: each statement's words, then its forms as alternatives,
/// each argument typed by the box (#44).
pub fn from_schema(schema: &prisma_proto::v1::ConfigSchema) -> Vec<Mode> {
    // From Prisma 0.149.24 each argument says where it stands among the words (#47).
    let positional = release_at_least(&schema.release, (0, 149, 24));
    schema
        .modes
        .iter()
        .map(|m| Mode {
            key: if m.path.is_empty() { "config".into() } else { m.path.join(" > ") },
            title: m.mode.clone(),
            path_tokens: m.path.iter().map(|e| parse_syntax(e)).collect(),
            path: m.path.clone(),
            roles: m.roles.split(',').map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect(),
            groups: vec![Group {
                title: m.mode.clone(),
                statements: m.statements.iter().map(|s| if positional { statement_positional(s) } else { statement_from_schema(s) }).collect(),
            }],
        })
        .collect()
}

fn release_at_least(release: &str, min: (u32, u32, u32)) -> bool {
    let core = release.trim().trim_start_matches('v').split([' ', '-', '+', '(']).next().unwrap_or_default();
    let mut it = core.split('.').map(|n| n.parse::<u32>().ok());
    matches!((it.next().flatten(), it.next().flatten(), it.next().flatten()), (Some(a), Some(b), Some(c)) if (a, b, c) >= min)
}

/// A 0.149.24 schema statement: literal `words`, each argument at its
/// `position` among them (`neighbor <address> remote-as <asn>` is words
/// [neighbor, remote-as] with the address at 1 and the AS at 2) (#47).
fn statement_positional(s: &prisma_proto::v1::SchemaStatement) -> Statement {
    let mut next_id = 0usize;
    let mut forms: Vec<Vec<Tok>> = vec![];
    let shapes: Vec<&[prisma_proto::v1::SchemaArgument]> =
        if s.forms.is_empty() { vec![&[]] } else { s.forms.iter().map(|f| f.arguments.as_slice()).collect() };
    for args in shapes {
        let mut toks = vec![];
        for i in 0..=s.words.len() {
            let here: Vec<prisma_proto::v1::SchemaArgument> = args.iter().filter(|a| a.position as usize == i).cloned().collect();
            toks.extend(form_tokens(&here, &mut next_id));
            if let Some(w) = s.words.get(i) {
                toks.push(Tok::Word { w: w.clone() });
            }
        }
        forms.push(toks);
    }
    // The words every form starts with stay in front; the forms differ after them.
    let common = (0..forms.iter().map(Vec::len).min().unwrap_or(0))
        .take_while(|&i| matches!(&forms[0][i], Tok::Word { .. }) && forms.iter().all(|f| f[i] == forms[0][i]))
        .count();
    let mut tokens: Vec<Tok> = forms[0][..common].to_vec();
    match forms.len() {
        1 => tokens.extend(forms.pop().unwrap().split_off(common)),
        _ => tokens.push(Tok::Alt { options: forms.into_iter().map(|mut f| f.split_off(common)).collect() }),
    }
    let syntax = prisma_proto::vty::describe(&tokens);
    Statement { syntax, class: if s.typed { "typed".into() } else { "text".into() }, tokens }
}

fn statement_from_schema(s: &prisma_proto::v1::SchemaStatement) -> Statement {
    // The box's `words` can carry placeholders ("<prefix>", "neighbor <address>"):
    // read them with the syntax parser, so they become values (#45).
    let mut tokens = parse_syntax(&s.words.join(" "));
    let mut next_id = count_params(&tokens);
    let mut forms: Vec<Vec<Tok>> = s.forms.iter().map(|f| form_tokens(&f.arguments, &mut next_id)).collect();
    forms.retain(|f| !f.is_empty() || s.forms.len() > 1);
    match forms.len() {
        0 => {}
        1 => tokens.extend(forms.pop().unwrap()),
        _ => tokens.push(Tok::Alt { options: forms }),
    }
    let syntax = prisma_proto::vty::describe(&tokens);
    Statement { syntax, class: if s.typed { "typed".into() } else { "text".into() }, tokens }
}

fn count_params(toks: &[Tok]) -> usize {
    toks.iter()
        .map(|t| match t {
            Tok::Param { .. } => 1,
            Tok::Opt { items } => count_params(items),
            Tok::Alt { options } => options.iter().map(|o| count_params(o)).sum(),
            Tok::Word { .. } => 0,
        })
        .sum()
}

/// A form's arguments as tokens. An optional keyword takes the optional
/// values after it with it (`[port <n>]`), as the prompt groups them.
fn form_tokens(args: &[prisma_proto::v1::SchemaArgument], next_id: &mut usize) -> Vec<Tok> {
    let mut out: Vec<Tok> = vec![];
    let mut group: Option<Vec<Tok>> = None;
    let n = args.len();
    for (i, a) in args.iter().enumerate() {
        let tok = arg_token(a, next_id, i + 1 == n);
        match (a.optional, a.kind.as_str(), &mut group) {
            (true, "keyword", g) => {
                if let Some(items) = g.take() {
                    out.push(Tok::Opt { items });
                }
                *g = Some(vec![tok]);
            }
            (true, _, Some(items)) => items.push(tok),
            (true, _, None) => out.push(Tok::Opt { items: vec![tok] }),
            (false, _, g) => {
                if let Some(items) = g.take() {
                    out.push(Tok::Opt { items });
                }
                out.push(tok);
            }
        }
    }
    if let Some(items) = group {
        out.push(Tok::Opt { items });
    }
    out
}

fn arg_token(a: &prisma_proto::v1::SchemaArgument, next_id: &mut usize, last: bool) -> Tok {
    let label = a.name.trim_start_matches('<').trim_end_matches('>').to_string();
    let kind = match a.kind.as_str() {
        "keyword" => return Tok::Word { w: a.name.clone() },
        "choice" => {
            return Tok::Alt {
                options: a
                    .choices
                    .iter()
                    .map(|c| {
                        // A choice that is a value (`<1-4294967295>`, even split as `1-4294967295>`)
                        // is a typed value, not a keyword (#45).
                        let label = c.trim_start_matches('<').trim_end_matches('>');
                        let value = c.starts_with('<') || c.ends_with('>') || matches!(prisma_proto::vty::kind_of(label), Kind::Int { .. });
                        if value {
                            let id = *next_id;
                            *next_id += 1;
                            vec![Tok::Param { id, label: label.to_string(), kind: prisma_proto::vty::kind_of(label), prefix: String::new(), rest: false }]
                        } else {
                            vec![Tok::Word { w: c.clone() }]
                        }
                    })
                    .collect(),
            }
        }
        "integer" if a.min == 0 && a.max == 0 => Kind::Int { min: 0, max: u32::MAX as u64 },
        "integer" => Kind::Int { min: a.min.max(0) as u64, max: a.max.max(0) as u64 },
        "ipv4_prefix" => Kind::Ipv4Prefix,
        "ipv4_address" => Kind::Ipv4,
        "ipv6_prefix" => Kind::Ipv6Prefix,
        "ipv6_address" => Kind::Ipv6,
        "address" => Kind::Address,
        "prefix" => Kind::Prefix,
        _ => Kind::Text,
    };
    let id = *next_id;
    *next_id += 1;
    // `text` takes the rest of the line; so does `many` (several values to the end, 0.149.24).
    Tok::Param { id, label, kind: if a.many { Kind::Text } else { kind }, prefix: String::new(), rest: (a.kind == "text" || a.many) && last }
}

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
    /// The box's own line (FRR's logging, its VRF), read only on purpose: why (#44).
    pub owned: Option<String>,
    /// `[group, statement]` in the mode; `None` when no statement matched.
    pub statement: Option<(usize, usize)>,
    pub values: BTreeMap<usize, String>,
}

fn words(s: &str) -> Vec<&str> {
    s.split_whitespace().collect()
}

/// The keywords that start a part of a statement (`enterprise <n>`, `[port <n>]`)
/// after its first value, in the grammar's order.
fn part_keywords(toks: &[Tok]) -> Vec<String> {
    let mut out = vec![];
    collect_parts(toks, &mut false, &mut out);
    out
}

fn collect_parts(toks: &[Tok], seen_value: &mut bool, out: &mut Vec<String>) {
    for (i, t) in toks.iter().enumerate() {
        match t {
            // A choice between forms (`<collector> enterprise <n> … | disable`): their parts too.
            Tok::Alt { options } if options.iter().any(|o| o.len() > 1) => {
                for o in options {
                    let mut seen = *seen_value;
                    collect_parts(o, &mut seen, out);
                }
                *seen_value = true;
            }
            Tok::Param { .. } | Tok::Alt { .. } => *seen_value = true,
            Tok::Word { w } if *seen_value && matches!(toks.get(i + 1), Some(Tok::Param { .. })) => {
                if !out.contains(w) {
                    out.push(w.clone())
                }
            }
            Tok::Opt { items } => {
                if let Some(Tok::Word { w }) = items.first() {
                    if !out.contains(w) {
                        out.push(w.clone());
                    }
                }
            }
            _ => {}
        }
    }
}

/// The line with its keyword parts put in the grammar's order; `None` when it
/// has none to move.
fn reordered(toks: &[Tok], words: &[&str]) -> Option<Vec<String>> {
    let keys = part_keywords(toks);
    let first = words.iter().position(|w| keys.iter().any(|k| k == w))?;
    let mut parts: Vec<Vec<String>> = vec![];
    for w in &words[first..] {
        if keys.iter().any(|k| k == w) || parts.is_empty() {
            parts.push(vec![w.to_string()]);
        } else {
            parts.last_mut().unwrap().push(w.to_string());
        }
    }
    let rank = |p: &Vec<String>| keys.iter().position(|k| *k == p[0]).unwrap_or(usize::MAX);
    let mut sorted = parts.clone();
    sorted.sort_by_key(rank);
    if sorted == parts {
        return None;
    }
    let mut out: Vec<String> = words[..first].iter().map(|w| w.to_string()).collect();
    out.extend(sorted.into_iter().flatten());
    Some(out)
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
fn mode_entered<'a>(modes: &'a [Mode], parent: &[String], line: &str) -> Option<&'a Mode> {
    let w = words(line);
    modes
        .iter()
        .filter(|m| m.path.len() == parent.len() + 1 && m.path[..parent.len()].iter().zip(parent).all(|(t, c)| element_matches(t, c)))
        .filter(|m| match_line(&m.path_tokens[parent.len()], &w).is_some())
        .max_by_key(|m| specificity(&m.path_tokens[parent.len()]))
}

fn element_matches(template: &str, concrete: &str) -> bool {
    match_line(&parse_syntax(template), &words(concrete)).is_some()
}

/// Every configured instance of every mode, the root first.
pub fn instances(roots: &[Node], modes: &[Mode]) -> Vec<Instance> {
    let mut out = vec![];
    let Some(root) = modes.iter().find(|m| m.path.is_empty()) else { return out };
    walk(modes, root, vec![], roots, &mut out);
    out
}

fn walk(modes: &[Mode], mode: &Mode, path: Vec<String>, nodes: &[Node], out: &mut Vec<Instance>) {
    let mut lines = vec![];
    let mut nested = vec![];
    for n in nodes {
        match mode_entered(modes, &path, &n.line) {
            Some(child) => nested.push((child, n)),
            None => lines.push(classify(mode, &n.line)),
        }
    }
    out.push(Instance { mode: mode.key.clone(), path: path.clone(), lines });
    for (child, n) in nested {
        let mut p = path.clone();
        p.push(n.line.clone());
        walk(modes, child, p, &n.children, out);
    }
}

fn classify(mode: &Mode, line: &str) -> Line {
    let w = words(line);
    for (gi, g) in mode.groups.iter().enumerate() {
        for (si, s) in g.statements.iter().enumerate() {
            if let Some(values) = match_line(&s.tokens, &w) {
                return Line { text: line.to_string(), owned: None, statement: Some((gi, si)), values };
            }
        }
    }
    // The running configuration may write a statement's keyword parts in another
    // order than its grammar (`port 1601 enterprise 67033`): try them in the grammar's (#45).
    for (gi, g) in mode.groups.iter().enumerate() {
        for (si, s) in g.statements.iter().enumerate() {
            if let Some(values) = reordered(&s.tokens, &w).and_then(|r| match_line(&s.tokens, &r.iter().map(String::as_str).collect::<Vec<_>>())) {
                return Line { text: line.to_string(), owned: None, statement: Some((gi, si)), values };
            }
        }
    }
    Line { text: line.to_string(), owned: None, statement: None, values: BTreeMap::new() }
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
        let t = parse_syntax("ssh listen-address <A.B.C.D|X:X::X:X>");
        assert!(match_line(&t, &w("ssh listen-address 0.0.0.0")).is_some() && match_line(&t, &w("ssh listen-address ::")).is_some());
        assert!(match_line(&t, &w("ssh listen-address A.B.C.D")).is_none(), "a value, not the label");
        let t = parse_syntax("alg ftp <on|off>");
        assert!(match_line(&t, &w("alg ftp off")).is_some() && match_line(&t, &w("alg ftp maybe")).is_none());
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
        let inst = instances(&t, &MODES);
        let find = |k: &str| inst.iter().find(|i| i.mode == k).unwrap_or_else(|| panic!("{k}"));
        assert_eq!(find("interface <name>").path, ["interface wan0"]);
        assert!(find("interface <name>").lines.iter().all(|l| l.statement.is_some()), "description and mtu are statements");
        assert_eq!(find("nat > cgnat > pool <name>").path, ["nat", "cgnat", "pool P"]);
        let bgp = find("router bgp <asn>");
        assert!(bgp.lines[0].statement.is_some(), "a neighbor line is a bgp neighbor statement");
        assert!(find("config").lines.iter().any(|l| l.text == "hostname h"));
    }

    #[test]
    fn the_boxs_schema_becomes_the_same_model() {
        use prisma_proto::v1::{ConfigSchema, SchemaArgument, SchemaForm, SchemaMode, SchemaStatement};
        let arg = |name: &str, kind: &str, optional: bool| SchemaArgument { name: name.into(), kind: kind.into(), optional, ..Default::default() };
        let schema = ConfigSchema {
            modes: vec![SchemaMode {
                mode: "cgnat".into(),
                path: vec!["nat".into(), "cgnat".into()],
                roles: "administrator, cgnat-operator".into(),
                statements: vec![SchemaStatement {
                    words: vec!["logging".into(), "udp".into()],
                    forms: vec![
                        SchemaForm {
                            arguments: vec![
                                arg("<collector>", "address", false),
                                arg("src", "keyword", false),
                                arg("<source>", "address", false),
                                arg("port", "keyword", true),
                                SchemaArgument { name: "<1-65535>".into(), kind: "integer".into(), min: 1, max: 65535, optional: true, ..Default::default() },
                            ],
                        },
                        SchemaForm { arguments: vec![arg("disable", "keyword", false)] },
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let m = &from_schema(&schema)[0];
        assert_eq!((m.key.as_str(), m.roles.len()), ("nat > cgnat", 2));
        let t = &m.groups[0].statements[0].tokens;
        assert!(match_line(t, &w("logging udp 192.0.2.52 src 203.0.113.10 port 4739")).is_some());
        assert!(match_line(t, &w("logging udp 192.0.2.52 src 203.0.113.10")).is_some(), "port is optional");
        assert!(match_line(t, &w("logging udp 192.0.2.52 src 203.0.113.10 port")).is_none(), "port takes its value with it");
        assert!(match_line(t, &w("logging udp disable")).is_some());
        assert!(match_line(t, &w("logging udp 192.0.2.52 src 203.0.113.10 port 70000")).is_none(), "the box's range");
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
    fn a_real_boxs_schema_shapes_are_read() {
        use prisma_proto::v1::{SchemaArgument, SchemaForm, SchemaStatement};
        let arg = |name: &str, kind: &str, optional: bool| SchemaArgument { name: name.into(), kind: kind.into(), optional, ..Default::default() };
        // Placeholders in `words` (192.0.2.198, Prisma 0.149.22).
        let st = statement_from_schema(&SchemaStatement {
            words: vec!["<prefix>".into()],
            forms: vec![SchemaForm { arguments: vec![arg("next-hop", "keyword", false), arg("<next-hop>", "address", false)] }],
            ..Default::default()
        });
        assert!(match_line(&st.tokens, &w("0.0.0.0/0 next-hop 192.0.2.10")).is_some());
        // A range choice split as `1-4294967295>`.
        let st = statement_from_schema(&SchemaStatement {
            words: vec!["neighbor <address>".into(), "remote-as".into()],
            forms: vec![SchemaForm {
                arguments: vec![SchemaArgument { name: "x".into(), kind: "choice".into(), choices: vec!["1-4294967295>".into(), "internal".into(), "external".into()], ..Default::default() }],
            }],
            ..Default::default()
        });
        assert!(match_line(&st.tokens, &w("neighbor 192.0.2.10 remote-as 65000")).is_some());
        assert!(match_line(&st.tokens, &w("neighbor 192.0.2.10 remote-as internal")).is_some());
        // Keyword parts written in another order than the grammar's.
        let mode = Mode {
            key: "nat > cgnat".into(),
            title: "cgnat".into(),
            path: vec![],
            path_tokens: vec![],
            roles: vec![],
            groups: vec![Group {
                title: "cgnat".into(),
                statements: vec![Statement {
                    syntax: String::new(),
                    class: "text".into(),
                    tokens: parse_syntax("logging syslog <collector> enterprise <n> [port <n>] [facility <0-23>] [severity <0-7>] | disable"),
                }],
            }],
        };
        let l = classify(&mode, "logging syslog 192.0.2.196 port 1601 enterprise 67033 facility 16 severity 6");
        assert!(l.statement.is_some(), "port before enterprise");
        assert!(classify(&mode, "logging syslog 192.0.2.196 enterprise 67033 bogus 1").statement.is_none());
    }

    #[test]
    fn a_0_149_24_schema_places_arguments_among_the_words() {
        use prisma_proto::v1::{ConfigSchema, SchemaArgument, SchemaForm, SchemaMode, SchemaStatement};
        let arg = |name: &str, kind: &str, position: u32| SchemaArgument { name: name.into(), kind: kind.into(), position, ..Default::default() };
        let schema = |release: &str| ConfigSchema {
            release: release.into(),
            modes: vec![SchemaMode {
                mode: "router bgp".into(),
                path: vec!["router bgp <asn>".into()],
                statements: vec![
                    SchemaStatement {
                        words: vec!["neighbor".into(), "remote-as".into()],
                        forms: vec![
                            SchemaForm { arguments: vec![arg("<address>", "address", 1), SchemaArgument { name: "<1-4294967295>".into(), kind: "integer".into(), min: 1, max: 4294967295, position: 2, ..Default::default() }] },
                            SchemaForm { arguments: vec![arg("<address>", "address", 1), SchemaArgument { name: "internal|external".into(), kind: "choice".into(), choices: vec!["internal".into(), "external".into()], position: 2, ..Default::default() }] },
                        ],
                        ..Default::default()
                    },
                    SchemaStatement { words: vec!["next-hop".into()], forms: vec![SchemaForm { arguments: vec![arg("<prefix>", "prefix", 0), arg("<next-hop>", "address", 1)] }], ..Default::default() },
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        let m = &from_schema(&schema("0.149.24"))[0];
        let st = &m.groups[0].statements;
        assert!(match_line(&st[0].tokens, &w("neighbor 192.0.2.10 remote-as 65000")).is_some(), "{}", st[0].syntax);
        assert!(match_line(&st[0].tokens, &w("neighbor 192.0.2.10 remote-as internal")).is_some());
        assert!(match_line(&st[1].tokens, &w("0.0.0.0/0 next-hop 192.0.2.10")).is_some(), "{}", st[1].syntax);
        assert!(release_at_least("0.149.24", (0, 149, 24)) && !release_at_least("0.149.22", (0, 149, 24)));
    }

    #[test]
    fn every_statement_of_the_grammar_parses() {
        let n: usize = MODES.iter().flat_map(|m| &m.groups).map(|g| g.statements.len()).sum();
        assert!(n > 500, "{n} statements");
        assert!(MODES.iter().any(|m| m.key == "interface bond<n>"));
    }
}
