//! GetSchema, GetConfig's box-owned lines and logging, and ValidateLines
//! (Prisma 0.149.20, #44). The grammar is the one the back end embeds from the
//! coverage map, turned into the box's schema messages, so the back end's
//! conversion is exercised end to end.

use prisma_proto::v1::{
    BoxOwnedLine, BoxOwnedStatement, ConfigSchema, LogCollectorConfig, LoggingConfig, SchemaArgument, SchemaForm, SchemaMode,
    SchemaStatement,
};
use prisma_proto::vty::{parse_statement, Kind, Tok};
use serde::Deserialize;

#[derive(Deserialize)]
struct Grammar {
    areas: Vec<Area>,
}

#[derive(Deserialize)]
struct Area {
    title: String,
    path: Vec<String>,
    roles: Vec<String>,
    #[serde(default)]
    entered_with: String,
    statements: Vec<Stmt>,
}

#[derive(Deserialize)]
struct Stmt {
    syntax: String,
}

/// The lines the mock's configuration carries that are the box's own, as on a real box.
pub const BOX_OWNED: [(&str, &str); 2] = [
    ("log syslog informational", "FRR's own logging, set by the box"),
    ("service integrated-vtysh-config", "FRR's single configuration file, set by the box"),
];

pub fn schema() -> ConfigSchema {
    let g: Grammar = serde_json::from_str(include_str!("../../server/src/config_grammar.json")).expect("grammar");
    let mut modes: Vec<SchemaMode> = vec![];
    for a in g.areas {
        let statements: Vec<SchemaStatement> = a.statements.iter().filter(|s| !s.syntax.starts_with("no ")).map(|s| statement(&a.path, &s.syntax)).collect();
        match modes.iter_mut().find(|m| m.path == a.path) {
            Some(m) => m.statements.extend(statements),
            None => modes.push(SchemaMode {
                mode: a.title,
                path: a.path,
                enter: a.entered_with,
                roles: a.roles.join(", "),
                statements,
                ..Default::default()
            }),
        }
    }
    ConfigSchema {
        modes,
        release: "0.149.24-mock".into(),
        digest: "mock".into(),
        box_owned: BOX_OWNED.iter().map(|(p, w)| BoxOwnedStatement { pattern: (*p).into(), why: (*w).into(), ..Default::default() }).collect(),
        ..Default::default()
    }
}

fn statement(path: &[String], syntax: &str) -> SchemaStatement {
    // As the box types them: an address family's prefixes are of either family (#42).
    let toks = parse_statement(path, syntax);
    let words: Vec<String> = toks.iter().map_while(|t| if let Tok::Word { w } = t { Some(w.clone()) } else { None }).collect();
    let rest = &toks[words.len()..];
    let forms = match rest {
        [Tok::Alt { options }] if options.iter().any(|o| o.len() > 1 || !matches!(o[0], Tok::Word { .. })) => {
            options.iter().map(|o| SchemaForm { arguments: args(o, false), ..Default::default() }).collect()
        }
        [] => vec![],
        _ => vec![SchemaForm { arguments: args(rest, false), ..Default::default() }],
    };
    // As 0.149.24 places them: every argument after the leading words (#47).
    let mut forms = forms;
    for f in &mut forms {
        for a in &mut f.arguments {
            a.position = words.len() as u32;
        }
    }
    SchemaStatement { removable: true, no_words: words.clone(), words, forms, ..Default::default() }
}

fn args(toks: &[Tok], optional: bool) -> Vec<SchemaArgument> {
    let mut out = vec![];
    for t in toks {
        match t {
            Tok::Word { w } => out.push(SchemaArgument { name: w.clone(), kind: "keyword".into(), optional, ..Default::default() }),
            Tok::Param { label, kind, rest, .. } => {
                let (k, min, max) = match kind {
                    Kind::Int { min, max } => ("integer", *min as i64, *max as i64),
                    Kind::Ipv4 => ("ipv4_address", 0, 0),
                    Kind::Ipv4Prefix => ("ipv4_prefix", 0, 0),
                    Kind::Ipv6 => ("ipv6_address", 0, 0),
                    Kind::Ipv6Prefix => ("ipv6_prefix", 0, 0),
                    Kind::Address => ("address", 0, 0),
                    Kind::Prefix => ("prefix", 0, 0),
                    _ if *rest => ("text", 0, 0),
                    _ => ("word", 0, 0),
                };
                out.push(SchemaArgument { name: format!("<{label}>"), kind: k.into(), min, max, optional, ..Default::default() });
            }
            Tok::Opt { items } => out.extend(args(items, true)),
            Tok::Alt { options } => {
                let words: Option<Vec<String>> =
                    options.iter().map(|o| if let [Tok::Word { w }] = o.as_slice() { Some(w.clone()) } else { None }).collect();
                match words {
                    Some(choices) => out.push(SchemaArgument { name: choices.join("|"), kind: "choice".into(), choices, optional, ..Default::default() }),
                    // Nested alternatives with values: the mock offers the first.
                    None => out.extend(args(&options[0], optional)),
                }
            }
        }
    }
    out
}

/// The box-owned lines of a rendered configuration.
pub fn box_owned(text: &str) -> Vec<BoxOwnedLine> {
    text.lines()
        .filter_map(|l| BOX_OWNED.iter().find(|(p, _)| l.trim() == *p))
        .map(|(p, w)| BoxOwnedLine { line: (*p).into(), why: (*w).into(), ..Default::default() })
        .collect()
}

/// The log collectors a configuration's `nat > cgnat` block sets.
pub fn logging(cgnat_lines: &[String]) -> LoggingConfig {
    let find = |t: &str| cgnat_lines.iter().find(|l| l.starts_with(&format!("logging {t} ")) && !l.ends_with(" disable"));
    let collectors = ["udp", "tcp", "syslog"]
        .iter()
        .map(|t| {
            let line = find(t);
            let w: Vec<&str> = line.map(|l| l.split_whitespace().collect()).unwrap_or_default();
            let after = |k: &str| w.iter().position(|x| *x == k).and_then(|i| w.get(i + 1)).and_then(|v| v.parse::<u32>().ok());
            LogCollectorConfig {
                transport: (*t).into(),
                configured: line.is_some(),
                collector: w.get(2).copied().unwrap_or_default().into(),
                port: after("port").unwrap_or(0),
                source: w.iter().position(|x| *x == "src").and_then(|i| w.get(i + 1)).copied().unwrap_or_default().into(),
                enterprise: after("enterprise").unwrap_or(0),
                facility: after("facility"),
                severity: after("severity"),
                ..Default::default()
            }
        })
        .collect();
    LoggingConfig { enabled: cgnat_lines.iter().any(|l| l == "logging enable"), collectors, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_covers_every_mode_and_types_arguments() {
        let s = schema();
        assert!(s.modes.len() > 20 && s.modes.iter().any(|m| m.path == ["nat", "cgnat", "pool <name>"]));
        let cgnat = s.modes.iter().find(|m| m.path == ["nat", "cgnat"]).unwrap();
        let udp = cgnat.statements.iter().find(|st| st.words == ["timeout", "udp"]).unwrap();
        assert_eq!(udp.forms[0].arguments[0].kind, "integer");
        let log = cgnat.statements.iter().find(|st| st.words == ["logging", "udp"]).unwrap();
        assert_eq!(log.forms.len(), 2, "a collector or disable");
    }
}
