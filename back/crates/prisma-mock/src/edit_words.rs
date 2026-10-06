//! `replace pattern` and `rename` (Prisma 0.151.13, prismarouting #585, prisma-web #74): two
//! lines Edit takes that change the candidate as a whole. As the box, where the mock can:
//! a pattern is matched against each statement on its own, never across one; a level covers
//! the statements inside it, not its own header; a match of nothing and a line break are
//! refused; `| compare` stages nothing. The mock replaces in its blocks and prefix-lists (not
//! in the interfaces it keeps as fields), and renames pools and IPv4 prefix-lists.

use regex::Regex;

use crate::config::Config;

/// The line's words, a double-quoted run one word (`\"` a quote in it); `None` with a quote open.
fn tokens(line: &str) -> Option<Vec<(String, bool)>> {
    let (mut out, mut cur, mut quoted, mut inq, mut esc) = (vec![], String::new(), false, false, false);
    for ch in line.chars() {
        if inq {
            if esc {
                if ch != '"' {
                    cur.push('\\');
                }
                cur.push(ch);
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                inq = false;
            } else {
                cur.push(ch);
            }
            continue;
        }
        if ch == '"' {
            (inq, quoted) = (true, true);
        } else if ch.is_whitespace() {
            if !cur.is_empty() || quoted {
                out.push((std::mem::take(&mut cur), quoted));
            }
            quoted = false;
        } else {
            cur.push(ch);
        }
    }
    if inq {
        return None;
    }
    if !cur.is_empty() || quoted {
        out.push((cur, quoted));
    }
    Some(out)
}

/// What an edit word did: the candidate after it (`None` for `| compare`) and the output.
pub struct Done {
    pub config: Option<Config>,
    pub output: String,
}

/// `Some` when the line is `replace` or `rename`, with what it did or why it is refused.
pub fn apply(c: &Config, path: &[String], line: &str) -> Option<Result<Done, String>> {
    let first = line.split_whitespace().next()?;
    match first {
        "replace" => Some(replace(c, path, line)),
        "rename" => Some(rename(c, path, line)),
        _ => None,
    }
}

const USAGE: &str = "usage: replace pattern <regex> with <replacement> [upto <n>] [| compare]";

fn replace(c: &Config, path: &[String], line: &str) -> Result<Done, String> {
    let mut w = tokens(line).ok_or("a quote is left open")?;
    w.remove(0);
    let (mut compare, mut upto) = (false, None);
    for _ in 0..2 {
        let n = w.len();
        if n > 4 && w[n - 2] == ("|".into(), false) && w[n - 1] == ("compare".into(), false) && !compare {
            compare = true;
            w.truncate(n - 2);
        } else if n > 4 && w[n - 2] == ("upto".into(), false) && upto.is_none() {
            upto = Some(w[n - 1].0.parse::<usize>().ok().filter(|n| *n >= 1).ok_or("upto: a number of substitutions, 1 or more")?);
            w.truncate(n - 2);
        }
    }
    if w.len() != 4 || w[0] != ("pattern".into(), false) || w[2] != ("with".into(), false) || w[1].0.is_empty() {
        return Err(USAGE.into());
    }
    let rx = Regex::new(&w[1].0).map_err(|e| format!("% the pattern is not a regular expression: {e}"))?;
    // Python's `\1` in the replacement is the regex crate's `${1}`.
    let repl = Regex::new(r"\\(\d)").unwrap().replace_all(&w[3].0, "$${$1}").into_owned();
    let mut next = c.clone();
    let (mut count, mut changed, mut diff) = (0usize, 0usize, vec![]);
    let mut one = |stmt: &mut String| -> Result<(), String> {
        let left = upto.map(|u| u.saturating_sub(count));
        if left == Some(0) {
            return Ok(());
        }
        let hits: Vec<_> = rx.find_iter(stmt).take(left.unwrap_or(usize::MAX)).collect();
        if hits.is_empty() {
            return Ok(());
        }
        if hits.iter().any(|m| m.start() == m.end()) {
            return Err(format!("% the pattern matches an empty string in: {stmt}"));
        }
        let new = rx.replacen(stmt, hits.len(), repl.as_str()).into_owned();
        if new.contains(['\n', '\r']) {
            return Err(format!("% the replacement breaks a statement in two: {stmt}"));
        }
        count += hits.len();
        if new != *stmt {
            changed += 1;
            diff.push(format!("- {stmt}"));
            diff.push(format!("+ {new}"));
            *stmt = new;
        }
        Ok(())
    };
    if path.is_empty() {
        for l in next.lists.iter_mut() {
            one(l)?;
        }
    }
    for b in next.blocks.iter_mut().filter(|b| b.path.starts_with(path)) {
        for l in b.lines.iter_mut() {
            one(l)?;
        }
    }
    if count == 0 {
        return Err("% the pattern matches nothing here".into());
    }
    let summary = format!("{count} substitution(s) in {changed} statement(s)");
    let output = [diff, vec![summary]].concat().join("\n");
    Ok(Done { config: (!compare).then_some(next), output })
}

fn rename(c: &Config, path: &[String], line: &str) -> Result<Done, String> {
    let w = tokens(line).ok_or("a quote is left open")?;
    let words: Vec<String> = path.iter().flat_map(|p| p.split_whitespace().map(String::from)).chain(w.into_iter().skip(1).map(|t| t.0)).collect();
    let n = words.len();
    if n < 4 || words[n - 2] != "to" {
        return Err("usage: rename <what> <name> to <new-name>".into());
    }
    let (what, old, new) = (&words[..n - 3], &words[n - 3], &words[n - 1]);
    if new.is_empty() || new.contains(char::is_whitespace) {
        return Err("% a name is one word".into());
    }
    let mut next = c.clone();
    let what: Vec<&str> = what.iter().map(String::as_str).collect();
    match what.as_slice() {
        ["nat", level @ ("cgnat" | "nat64"), "pool"] => {
            let names = if *level == "cgnat" { c.pool_names() } else { c.nat64_pool_names() };
            if !names.contains(old) {
                return Err(format!("% no pool {old} under nat {level}"));
            }
            if c.pool_names().contains(new) || c.nat64_pool_names().contains(new) {
                return Err(format!("% a pool {new} exists"));
            }
            for b in next.blocks.iter_mut().filter(|b| b.path.len() >= 3 && b.path[0] == "nat" && b.path[1] == *level && b.path[2] == format!("pool {old}")) {
                b.path[2] = format!("pool {new}");
            }
        }
        ["ip", "prefix-list"] => {
            let head = |n: &str| format!("ip prefix-list {n} ");
            if !c.lists.iter().any(|l| l.starts_with(&head(old))) {
                return Err(format!("% no ip prefix-list {old}"));
            }
            if c.lists.iter().any(|l| l.starts_with(&head(new))) {
                return Err(format!("% an ip prefix-list {new} exists"));
            }
            for l in next.lists.iter_mut().filter(|l| l.starts_with(&head(old))) {
                *l = format!("{}{}", head(new), &l[head(old).len()..]);
            }
            // Its references: a pool's side, a neighbor's filter.
            for b in next.blocks.iter_mut() {
                for l in b.lines.iter_mut() {
                    let ws: Vec<&str> = l.split_whitespace().collect();
                    if let Some(i) = ws.iter().position(|w| matches!(*w, "prefix-list-inside" | "prefix-list-outside" | "prefix-list")) {
                        if ws.get(i + 1) == Some(&old.as_str()) {
                            let mut ws: Vec<String> = ws.iter().map(|w| w.to_string()).collect();
                            ws[i + 1] = new.clone();
                            *l = ws.join(" ");
                        }
                    }
                }
            }
        }
        ["ipv6", "prefix-list"] | ["route-map"] | ["interface"] => return Err("% the simulated router renames pools and IPv4 prefix-lists only".into()),
        ["router", "bgp", _, "peer-group"] => return Err("% the simulated router renames pools and IPv4 prefix-lists only".into()),
        _ => {
            return Err("% rename takes: nat cgnat pool <name>, nat nat64 pool <name>, ip prefix-list <name>, ipv6 prefix-list <name>, route-map <name>, router bgp <AS> peer-group <name>, interface <name>".into())
        }
    }
    Ok(Done { config: Some(next), output: format!("renamed {} {old} to {new}", what.join(" ")) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn a_pattern_replaces_statement_by_statement() {
        let mut c = Config::seed("t");
        c.edit(&p(&["nat", "cgnat", "pool A"]), &p(&["prefix-inside 10.0.0.0/8", "prefix-outside 198.51.100.0/28", "block-size 512"])).ok().unwrap();
        let at = p(&["nat", "cgnat"]);
        let d = apply(&c, &at, r#"replace pattern "block-size 512" with "block-size 1024" | compare"#).unwrap().unwrap();
        assert!(d.config.is_none(), "compare stages nothing");
        assert!(d.output.contains("- block-size 512\n+ block-size 1024"), "{}", d.output);
        let d = apply(&c, &at, r#"replace pattern "198\.51\.100\.(\d+)" with "203.0.113.\1""#).unwrap().unwrap();
        assert!(d.config.unwrap().render().contains("prefix-outside 203.0.113.0/28"));
        assert!(apply(&c, &at, r#"replace pattern "x*" with "y""#).unwrap().is_err(), "an empty match is refused");
        assert!(apply(&c, &at, r#"replace pattern "nope" with "y""#).unwrap().is_err(), "nothing matched");
        assert!(apply(&c, &at, r#"replace pattern "a" with"#).unwrap().is_err(), "usage");
        let d = apply(&c, &at, r#"replace pattern "\d" with "9" upto 2 | compare"#).unwrap().unwrap();
        assert!(d.output.ends_with("2 substitution(s) in 1 statement(s)"), "{}", d.output);
    }

    #[test]
    fn a_rename_follows_its_references() {
        let mut c = Config::seed("t");
        c.edit(&[], &p(&["ip prefix-list SUBS seq 10 permit 100.64.0.0/22"])).ok().unwrap();
        c.edit(&p(&["nat", "cgnat", "pool A"]), &p(&["prefix-list-inside SUBS", "prefix-outside 198.51.100.0/28"])).ok().unwrap();
        let d = apply(&c, &[], "rename ip prefix-list SUBS to CUSTOMERS").unwrap().unwrap();
        let t = d.config.unwrap().render();
        assert!(t.contains("ip prefix-list CUSTOMERS seq 10 permit 100.64.0.0/22") && t.contains("prefix-list-inside CUSTOMERS") && !t.contains("SUBS"), "{t}");
        let d = apply(&c, &p(&["nat", "cgnat"]), "rename pool A to B").unwrap().unwrap();
        assert!(d.config.unwrap().pool_names().contains(&"B".to_string()));
        assert!(apply(&c, &[], &format!("rename nat cgnat pool A to {}", crate::config::SEED_POOL)).unwrap().is_err(), "a name taken");
        assert!(apply(&c, &[], "rename nat cgnat pool NOPE to B").unwrap().is_err());
    }
}
