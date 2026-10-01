//! Routing policies of the mock (Prisma 0.148.12: ListPolicies,
//! GetPolicyCounters, TestPolicy). Two fixed policies, counters that grow with
//! time, and a small simulation: enough for prisma-web to exercise every field.

use std::collections::HashMap;

use prisma_proto::v1::*;
use tonic::Status;

const ATTACH_POINTS: &[&str] = &["import", "export", "table", "vrf-import", "fib bgp", "fib static", "ospf static"];

pub fn policies() -> Vec<Policy> {
    vec![
        Policy {
            name: "TRANSIT-IN".into(),
            terms: vec![
                PolicyTerm {
                    name: "bogons".into(),
                    then: "reject".into(),
                    lines: vec!["from prefix-list BOGONS".into()],
                    ..Default::default()
                },
                PolicyTerm {
                    name: "cust".into(),
                    then: "accept".into(),
                    lines: vec!["from community CUSTOMERS".into(), "then local-preference 200".into()],
                    ..Default::default()
                },
                PolicyTerm { name: "rest".into(), then: "accept".into(), lines: vec![], ..Default::default() },
            ],
            default_action: "reject".into(),
            text: "policy-statement TRANSIT-IN\n term bogons\n  from prefix-list BOGONS\n  then reject\n term cust\n  from community CUSTOMERS\n  then local-preference 200\n  then accept\n term rest\n  then accept\n default-action reject\n".into(),
            applied: vec!["bgp neighbor 203.0.113.9 import".into(), "bgp neighbor 2001:db8:100::1 import".into()],
            ..Default::default()
        },
        Policy {
            name: "CUSTOMER-OUT".into(),
            terms: vec![
                PolicyTerm {
                    name: "own".into(),
                    then: "accept".into(),
                    lines: vec!["from prefix-list OWN-PREFIXES".into()],
                    ..Default::default()
                },
                PolicyTerm {
                    name: "unused".into(),
                    then: "accept".into(),
                    lines: vec!["from protocol isis".into()],
                    ..Default::default()
                },
            ],
            default_action: "reject".into(),
            text: "policy-statement CUSTOMER-OUT\n term own\n  from prefix-list OWN-PREFIXES\n  then accept\n term unused\n  from protocol isis\n  then accept\n default-action reject\n".into(),
            applied: vec!["bgp neighbor 203.0.113.9 export".into(), "ospf export".into()],
            ..Default::default()
        },
    ]
}

/// Hits grow with the mock's uptime, so the UI sees them move.
pub fn counters(policy: &str, uptime: u64) -> Result<Vec<PolicyUseCounters>, Status> {
    let all = policies();
    if !policy.is_empty() && !all.iter().any(|p| p.name == policy) {
        return Err(Status::not_found(format!("no policy {policy}")));
    }
    let t = uptime / 10;
    let hits = |policy: &str, term: &str, h: u64| PolicyTermHits { policy: policy.into(), term: term.into(), hits: h, compiled: true, ..Default::default() };
    let mut uses = vec![
        PolicyUseCounters {
            policy: "TRANSIT-IN".into(),
            attach_point: "import".into(),
            applied_at: vec!["bgp neighbor 203.0.113.9 import".into(), "bgp neighbor 2001:db8:100::1 import".into()],
            route_map: "TRANSIT-IN".into(),
            daemon: "bgpd".into(),
            called: false,
            counted: true,
            terms: vec![
                hits("TRANSIT-IN", "bogons", 12 + t / 50),
                hits("TRANSIT-IN", "cust", 4_210 + t),
                hits("TRANSIT-IN", "rest", 1_198_000 + 7 * t),
                hits("TRANSIT-IN", "", 0),
            ],
            ..Default::default()
        },
        PolicyUseCounters {
            policy: "CUSTOMER-OUT".into(),
            attach_point: "export".into(),
            applied_at: vec!["bgp neighbor 203.0.113.9 export".into()],
            route_map: "CUSTOMER-OUT".into(),
            daemon: "bgpd".into(),
            called: false,
            counted: true,
            terms: vec![
                hits("CUSTOMER-OUT", "own", 64 + t / 100),
                // A term with no clause at this use: `from protocol isis` means nothing to bgpd.
                PolicyTermHits { policy: "CUSTOMER-OUT".into(), term: "unused".into(), hits: 0, compiled: false, ..Default::default() },
                hits("CUSTOMER-OUT", "", 3 + t / 200),
            ],
            ..Default::default()
        },
        PolicyUseCounters {
            policy: "CUSTOMER-OUT".into(),
            attach_point: "ospf static".into(),
            applied_at: vec!["ospf export".into()],
            route_map: "CUSTOMER-OUT-ospf".into(),
            daemon: "ospfd".into(),
            called: false,
            // The daemon reported no such map: no counter, which is not zero.
            counted: false,
            terms: vec![],
            ..Default::default()
        },
    ];
    if !policy.is_empty() {
        uses.retain(|u| u.policy == policy);
    }
    Ok(uses)
}

pub fn test(req: &TestPolicyRequest) -> Result<TestPolicyResponse, Status> {
    let policy = policies()
        .into_iter()
        .find(|p| p.name == req.policy)
        .ok_or_else(|| Status::not_found(format!("no policy {}", req.policy)))?;
    let at = if req.attach_point.is_empty() { "import" } else { req.attach_point.as_str() };
    if !ATTACH_POINTS.contains(&at) {
        return Err(Status::invalid_argument(format!("test policy: no use '{at}'")));
    }
    for k in req.attributes.keys() {
        if !["community", "as-path", "local-preference", "med", "next-hop", "neighbor", "origin"].contains(&k.as_str()) {
            return Err(Status::invalid_argument(format!("test policy: no attribute '{k}'")));
        }
    }
    let mut route: HashMap<String, String> = req.attributes.clone();
    route.insert("prefix".into(), req.prefix.clone());
    let mut notes = vec![];
    if req.rib {
        route = HashMap::from([("prefix".into(), req.prefix.clone()), ("next-hop".into(), "203.0.113.9".into())]);
        notes.push(format!("route {} read from the RIB of vrf {}", req.prefix, if req.vrf.is_empty() { "default" } else { &req.vrf }));
    }

    let bogon = ["10.", "192.168.", "172.16.", "0.", "2001:db8:dead:"].iter().any(|b| req.prefix.starts_with(b));
    let customer = route.get("community").is_some_and(|c| c.split_whitespace().any(|x| x == "65001:10"));
    let mut steps = vec![];
    let mut assumed = vec![];
    let (verdict, term) = match policy.name.as_str() {
        "TRANSIT-IN" => {
            steps.push(step(&policy.name, "bogons", if bogon { "match" } else { "no match" }, "prefix-list BOGONS"));
            if bogon {
                ("reject", "bogons")
            } else {
                if !route.contains_key("community") {
                    assumed.push("community not given: taken as not matching CUSTOMERS".into());
                }
                steps.push(step(&policy.name, "cust", if customer { "match" } else { "no match" }, "community CUSTOMERS"));
                if customer {
                    ("accept", "cust")
                } else {
                    steps.push(step(&policy.name, "rest", "match", "no from: matches every route"));
                    ("accept", "rest")
                }
            }
        }
        _ => {
            let own = req.prefix.starts_with("203.0.113.") || req.prefix.starts_with("2001:db8:200:");
            steps.push(step(&policy.name, "own", if own { "match" } else { "no match" }, "prefix-list OWN-PREFIXES"));
            if own {
                ("accept", "own")
            } else {
                steps.push(step(&policy.name, "unused", "unknown", "from protocol isis: no clause at this use"));
                steps.push(step(&policy.name, "", "match", "default-action reject"));
                ("reject", "")
            }
        }
    };
    let mut route_after = HashMap::new();
    if verdict == "accept" {
        route_after = route.clone();
        if term == "cust" {
            route_after.insert("local-preference".into(), "200".into());
        }
    }
    let said = if at == "export" && term == "cust" { vec!["local-preference: not sent to an eBGP peer".into()] } else { vec![] };
    Ok(TestPolicyResponse {
        verdict: verdict.into(),
        decided_by: if term.is_empty() { format!("{}'s default-action", policy.name) } else { format!("term {term}") },
        decided_policy: policy.name.clone(),
        decided_term: term.into(),
        attach_point: at.into(),
        route_map: policy.name.clone(),
        daemon: "bgpd".into(),
        route,
        route_after,
        steps,
        assumed,
        notes,
        said,
        refused: vec![],
        ..Default::default()
    })
}

fn step(policy: &str, term: &str, outcome: &str, why: &str) -> TestPolicyStep {
    TestPolicyStep { policy: policy.into(), term: term.into(), outcome: outcome.into(), why: why.into(), ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(policy: &str, prefix: &str, attrs: &[(&str, &str)]) -> TestPolicyRequest {
        TestPolicyRequest {
            policy: policy.into(),
            prefix: prefix.into(),
            attributes: attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn test_policy_decides_and_refuses() {
        let r = test(&req("TRANSIT-IN", "10.1.0.0/16", &[])).unwrap();
        assert_eq!((r.verdict.as_str(), r.decided_term.as_str()), ("reject", "bogons"));
        let r = test(&req("TRANSIT-IN", "198.51.100.0/24", &[("community", "65001:10")])).unwrap();
        assert_eq!((r.verdict.as_str(), r.decided_term.as_str()), ("accept", "cust"));
        assert_eq!(r.route_after["local-preference"], "200");
        assert_eq!(test(&req("NOPE", "198.51.100.0/24", &[])).unwrap_err().code(), tonic::Code::NotFound);
        let mut bad = req("TRANSIT-IN", "198.51.100.0/24", &[]);
        bad.attach_point = "nowhere".into();
        assert_eq!(test(&bad).unwrap_err().code(), tonic::Code::InvalidArgument);
    }

    #[test]
    fn counters_distinguish_no_counter_from_zero() {
        let uses = counters("", 1000).unwrap();
        assert!(uses.iter().any(|u| !u.counted && u.terms.is_empty()));
        assert!(uses.iter().flat_map(|u| &u.terms).any(|t| !t.compiled));
        assert_eq!(counters("NOPE", 0).unwrap_err().code(), tonic::Code::NotFound);
        assert!(counters("TRANSIT-IN", 0).unwrap().iter().all(|u| u.policy == "TRANSIT-IN"));
    }
}
