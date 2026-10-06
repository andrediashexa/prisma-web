//! The configuration as fields (Prisma 0.149.20 and 0.149.22, #46): GetConfig
//! read off the mock's configuration, and SetConfig / DeleteConfig turned into
//! the lines an operator would type, staged through the same `Config::edit` as
//! Edit, so the diff, the check and the gates see them as any other change.
//!
//! As on the box: an empty field mask sets every field; a BGP password is
//! never read back (`password_set`) and never echoed (`password <set, not
//! shown>` in the reply's lines); a family listed for a neighbour is set whole;
//! a neighbour is removed statement by statement, `remote-as` last.

use prisma_proto::v1::*;

use crate::config::{is_bundle, Config, CGNAT_PATH};

pub const MASKED: &str = "<set, not shown>";

/// A typed request the mock cannot turn into lines: INVALID_ARGUMENT with REASON_USAGE.
pub struct Usage(pub String);

fn usage<T>(m: impl Into<String>) -> Result<T, Usage> {
    Err(Usage(m.into()))
}

/// `MOCK_NO_TYPED=1`: a box before 0.149.20, without GetConfig/SetConfig/DeleteConfig, so
/// the forms' line implementation can be exercised (#46).
pub fn disabled() -> bool {
    std::env::var("MOCK_NO_TYPED").is_ok_and(|v| v == "1")
}

fn w(l: &str) -> Vec<&str> {
    l.split_whitespace().collect()
}

/// The word after `key`, if any.
fn after<'a>(w: &[&'a str], key: &str) -> Option<&'a str> {
    w.iter().position(|x| *x == key).and_then(|i| w.get(i + 1)).copied()
}

fn num(v: Option<&str>) -> u32 {
    v.and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// `neighbor X password <secret>` as `show running-config` prints it on the box.
pub fn mask(line: &str) -> String {
    let ws = w(line);
    let neighbor = ws.first() == Some(&"neighbor") || ws.get(1) == Some(&"neighbor");
    match ws.iter().position(|x| *x == "password") {
        Some(i) if neighbor && i + 1 < ws.len() => format!("{} password {MASKED}", ws[..i].join(" ")),
        _ => line.to_string(),
    }
}

// --- Reading ------------------------------------------------------------------

pub fn read(c: &Config, areas: &[String]) -> Result<TypedConfig, Usage> {
    const KNOWN: [&str; 11] = ["interfaces", "pools", "logging", "static", "bgp", "ospf", "ospf6", "isis", "interface_routing", "bfd", "nat64"];
    if let Some(a) = areas.iter().find(|a| !KNOWN.contains(&a.as_str())) {
        return usage(format!("unknown area {a}"));
    }
    let want = |a: &str| areas.is_empty() || areas.iter().any(|x| x == a);
    let mut t = TypedConfig { box_owned: crate::schema::box_owned(&c.render()), ..Default::default() };
    if want("interfaces") {
        t.interfaces = c.interfaces.iter().map(interface).collect();
    }
    if want("pools") {
        t.pools = c.pool_names().iter().map(|n| pool(c, n)).collect();
    }
    if want("logging") {
        t.logging = Some(crate::schema::logging(c.block(&CGNAT_PATH).map_or(&[][..], |b| &b.lines[..])));
    }
    if want("static") {
        t.static_routes = statics(c);
    }
    if want("bgp") {
        t.bgp = bgps(c);
    }
    if want("ospf") {
        t.ospf = ospf(c, 2);
    }
    if want("ospf6") {
        t.ospf6 = ospf(c, 3);
    }
    if want("isis") {
        t.isis = isis(c);
    }
    if want("interface_routing") {
        t.interface_routing = c.interfaces.iter().filter_map(interface_routing).collect();
    }
    if want("nat64") {
        t.nat64_pools = c.nat64_pool_names().iter().map(|n| nat64_pool(c, n)).collect();
    }
    if want("bfd") {
        t.bfd_peers = bfd_peers(c);
        t.bfd_profiles = bfd_profiles(c);
    }
    Ok(t)
}

fn extra_value<'a>(i: &'a crate::config::Iface, key: &str) -> Option<&'a str> {
    i.extra.iter().find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix(' ')))
}

fn interface(i: &crate::config::Iface) -> InterfaceConfig {
    let kind = if i.name == "lo" {
        "loopback"
    } else if is_bundle(&i.name) {
        "bundle"
    } else if i.name.contains('.') {
        "subinterface"
    } else {
        "port"
    };
    let vlan = extra_value(i, "vlan").map(w).unwrap_or_default();
    InterfaceConfig {
        name: i.name.clone(),
        kind: kind.into(),
        description: i.description.clone().unwrap_or_default(),
        mtu: i.mtu,
        shutdown: i.shutdown,
        ipv4: i.v4.clone(),
        ipv6: i.v6.clone(),
        cgnat_role: extra_value(i, "cgnat").unwrap_or_default().into(),
        vrf: num(extra_value(i, "vrf")),
        linux_name: extra_value(i, "linux-name").unwrap_or_default().into(),
        vlan_outer: num(vlan.first().copied()),
        vlan_inner: num(after(&vlan, "inner")),
        mac_address: extra_value(i, "mac-address").unwrap_or_default().into(),
        urpf: extra_value(i, "urpf").filter(|v| *v != "off").unwrap_or_default().into(),
        // The mock writes `ipv6 nd suppress-ra` to stop them; without it they are sent.
        router_advertisements: !i.extra.iter().any(|l| l == "ipv6 nd suppress-ra"),
        // PREF64 (0.150.2, #61): the NAT64 prefixes the advertisements carry.
        pref64: i.extra.iter().filter_map(|l| l.strip_prefix("ipv6 nd nat64 ")).map(|p| p.trim().to_string()).collect(),
        ..Default::default()
    }
}

/// The NAT64 prefixes the box's NAT64 pools translate ("" is the well-known one), #61.
fn nat64_prefixes(c: &Config) -> Vec<String> {
    c.nat64_pool_names()
        .iter()
        .map(|n| nat64_pool(c, n))
        .map(|p| if p.nat64_prefix.is_empty() { "64:ff9b::/96".to_string() } else { p.nat64_prefix })
        .collect()
}

fn pool(c: &Config, name: &str) -> PoolConfig {
    pool_at(c, "cgnat", name).0
}

/// A NAT64 pool (`nat > nat64`, Prisma 0.151.0, #68): the pool's fields and NAT64's own.
pub fn nat64_pool(c: &Config, name: &str) -> Nat64PoolConfig {
    let (p, subscriber_length, nat64_prefix) = pool_at(c, "nat64", name);
    Nat64PoolConfig {
        name: p.name,
        prefix_inside: p.prefix_inside,
        prefix_outside: p.prefix_outside,
        block_size: p.block_size,
        port_first: p.port_first,
        port_last: p.port_last,
        policy: p.policy,
        mode: p.mode,
        vrf: p.vrf,
        outside_vrf: p.outside_vrf,
        timeouts: p.timeouts,
        max_blocks: p.max_blocks,
        initial_allocation: p.initial_allocation,
        block_stride: p.block_stride,
        reserve: p.reserve,
        utilisation_alarm: p.utilisation_alarm,
        max_sessions: p.max_sessions,
        max_session_rate: p.max_session_rate,
        tcp_mss: p.tcp_mss,
        filter: p.filter,
        algs: p.algs,
        forwards: p.forwards,
        subscriber_length,
        nat64_prefix,
    }
}

/// The pool's lines at `nat > <level> > pool <name>`, and NAT64's two of them.
fn pool_at(c: &Config, level: &str, name: &str) -> (PoolConfig, u32, String) {
    let lines = c.block(&["nat", level, &format!("pool {name}")]).map(|b| b.lines.clone()).unwrap_or_default();
    let mut p = PoolConfig { name: name.into(), max_blocks: 1, ..Default::default() };
    let (mut subscriber_length, mut nat64_prefix) = (0, String::new());
    for l in &lines {
        let ws = w(l);
        match ws.as_slice() {
            ["prefix-inside", x] => p.prefix_inside.push((*x).into()),
            ["prefix-outside", x] => p.prefix_outside.push((*x).into()),
            // A side given by a list (0.151.12, #73).
            ["prefix-list-inside", x] => p.prefix_list_inside = (*x).into(),
            ["prefix-list-outside", x] => p.prefix_list_outside = (*x).into(),
            ["block-size", n] => p.block_size = num(Some(n)),
            ["ports", lo, hi] => (p.port_first, p.port_last) = (num(Some(lo)), num(Some(hi))),
            ["policy", v] => p.policy = (*v).into(),
            ["mode", v] => p.mode = (*v).into(),
            ["vrf", n] => p.vrf = Some(num(Some(n))),
            ["outside-vrf", n] => p.outside_vrf = Some(num(Some(n))),
            ["timeout", k, n] => {
                p.timeouts.insert((*k).into(), num(Some(n)));
            }
            ["max-blocks", n] => p.max_blocks = num(Some(n)),
            ["initial-allocation", n] => p.initial_allocation = num(Some(n)),
            ["block-stride", n] => p.block_stride = num(Some(n)),
            ["reserve", n] => p.reserve = num(Some(n)),
            ["bypass", "source", x] => p.bypass_source.push((*x).into()),
            ["bypass", "destination", x] => p.bypass_destination.push((*x).into()),
            ["utilisation-alarm", n] => p.utilisation_alarm = num(Some(n)),
            ["max-sessions", n] => p.max_sessions = num(Some(n)),
            ["max-session-rate", n] => p.max_session_rate = num(Some(n)),
            ["tcp-mss", v] => p.tcp_mss = (*v).into(),
            ["filter", v] => p.filter = (*v).into(),
            ["subscriber-length", n] => subscriber_length = num(Some(n)),
            ["nat64-prefix", x] => nat64_prefix = (*x).into(),
            ["alg", a, v] => {
                p.algs.insert((*a).into(), *v == "on");
            }
            _ => {}
        }
    }
    (p, subscriber_length, nat64_prefix)
}

fn static_route(line: &str, vrf: &str) -> Option<StaticRouteConfig> {
    let ws = w(line);
    let [prefix, "next-hop", nh, rest @ ..] = ws.as_slice() else { return None };
    let d = rest.iter().position(|x| *x == "description");
    let opts = &rest[..d.unwrap_or(rest.len())];
    Some(StaticRouteConfig {
        prefix: (*prefix).into(),
        next_hop: (*nh).into(),
        distance: num(after(opts, "distance")),
        tag: num(after(opts, "tag")),
        description: d.map(|i| rest[i + 1..].join(" ")).unwrap_or_default(),
        vrf: vrf.into(),
        family: if prefix.contains(':') { "ipv6" } else { "ipv4" }.into(),
        extra: opts
            .iter()
            .enumerate()
            .filter(|(i, x)| !matches!(**x, "distance" | "tag") && !(i > &0 && matches!(opts[i - 1], "distance" | "tag")))
            .map(|(_, x)| x.to_string())
            .collect(),
        line: line.into(),
        ..Default::default()
    })
}

fn statics(c: &Config) -> Vec<StaticRouteConfig> {
    c.block(&["router static"]).map(|b| b.lines.iter().filter_map(|l| static_route(l, "")).collect()).unwrap_or_default()
}

/// The `router bgp` blocks: `router bgp <asn> [vrf <name>]`.
fn bgp_blocks(c: &Config) -> Vec<(String, String, String)> {
    c.blocks
        .iter()
        .filter(|b| b.path.len() == 1 && b.path[0].starts_with("router bgp "))
        .map(|b| {
            let ws = w(&b.path[0]);
            (b.path[0].clone(), ws.get(2).unwrap_or(&"").to_string(), after(&ws, "vrf").unwrap_or("").to_string())
        })
        .collect()
}

fn bgp_head(asn: &str, vrf: &str) -> String {
    if vrf.is_empty() { format!("router bgp {asn}") } else { format!("router bgp {asn} vrf {vrf}") }
}

fn neighbor<'a>(list: &'a mut Vec<BgpNeighborConfig>, address: &str) -> &'a mut BgpNeighborConfig {
    if let Some(i) = list.iter().position(|n| n.address == address) {
        return &mut list[i];
    }
    list.push(BgpNeighborConfig { address: address.into(), ..Default::default() });
    list.last_mut().expect("just pushed")
}

fn family_neighbor<'a>(list: &'a mut Vec<BgpNeighborFamilyConfig>, address: &str) -> &'a mut BgpNeighborFamilyConfig {
    if let Some(i) = list.iter().position(|n| n.neighbor == address) {
        return &mut list[i];
    }
    list.push(BgpNeighborFamilyConfig { neighbor: address.into(), ..Default::default() });
    list.last_mut().expect("just pushed")
}

fn redistribute(l: &str) -> Option<RedistributeConfig> {
    let ws = w(l);
    if ws.first() != Some(&"redistribute") || ws.len() < 2 {
        return None;
    }
    Some(RedistributeConfig {
        protocol: ws[1].into(),
        route_map: after(&ws, "route-map").unwrap_or_default().into(),
        metric: num(after(&ws, "metric")),
        metric_type: after(&ws, "metric-type").unwrap_or_default().into(),
        level: ws.iter().find(|x| x.starts_with("level-")).map(|x| x.to_string()).unwrap_or_default(),
        statement: l.into(),
        ..Default::default()
    })
}

fn bgps(c: &Config) -> Vec<BgpConfig> {
    let mut out = vec![];
    for (head, asn, vrf) in bgp_blocks(c) {
        let mut b = BgpConfig { asn, vrf, default_ipv4_unicast: true, ..Default::default() };
        for l in c.block(&[head.as_str()]).map(|b| b.lines.clone()).unwrap_or_default() {
            let ws = w(&l);
            match ws.as_slice() {
                ["bgp", "router-id", id] => b.router_id = (*id).into(),
                ["no", "bgp", "default", "ipv4-unicast"] => b.default_ipv4_unicast = false,
                ["bgp", "default", "ipv4-unicast"] => b.default_ipv4_unicast = true,
                ["neighbor", peer, rest @ ..] => {
                    let n = neighbor(&mut b.neighbors, peer);
                    match rest {
                        ["remote-as", v] => n.remote_as = (*v).into(),
                        ["description", d @ ..] => n.description = d.join(" "),
                        ["update-source", v] => n.update_source = (*v).into(),
                        ["timers", k, h] => (n.keepalive, n.holdtime) = (num(Some(k)), num(Some(h))),
                        ["password", ..] => n.password_set = true,
                        ["peer-group"] => n.is_peer_group = true,
                        ["peer-group", g] => n.peer_group = (*g).into(),
                        ["ebgp-multihop", v] => n.ebgp_multihop = num(Some(v)),
                        ["shutdown"] => n.shutdown = true,
                        ["bfd"] => n.bfd = true,
                        _ => n.other.push(l.clone()),
                    }
                }
                _ => b.other.push(l.clone()),
            }
        }
        for blk in c.blocks.iter().filter(|x| x.path.len() == 2 && x.path[0] == head && x.path[1].starts_with("address-family ")) {
            let fw = w(&blk.path[1]);
            let mut f = BgpFamilyConfig { afi: fw.get(1).unwrap_or(&"").to_string(), safi: fw.get(2).unwrap_or(&"unicast").to_string(), ..Default::default() };
            for l in &blk.lines {
                let ws = w(l);
                match ws.as_slice() {
                    ["network", rest @ ..] if !rest.is_empty() => f.networks.push(rest.join(" ")),
                    ["aggregate-address", p, rest @ ..] => f.aggregates.push(BgpAggregateConfig {
                        prefix: (*p).into(),
                        summary_only: rest.contains(&"summary-only"),
                        as_set: rest.contains(&"as-set"),
                        ..Default::default()
                    }),
                    ["redistribute", ..] => f.redistribute.extend(redistribute(l)),
                    ["neighbor", peer, rest @ ..] => {
                        let n = family_neighbor(&mut f.neighbors, peer);
                        match rest {
                            ["activate"] => n.activate = true,
                            ["route-map", m, "in"] => n.route_map_in = (*m).into(),
                            ["route-map", m, "out"] => n.route_map_out = (*m).into(),
                            ["prefix-list", m, "in"] => n.prefix_list_in = (*m).into(),
                            ["prefix-list", m, "out"] => n.prefix_list_out = (*m).into(),
                            ["maximum-prefix", v, ..] => n.maximum_prefix = num(Some(v)),
                            ["next-hop-self"] => n.next_hop_self = true,
                            ["soft-reconfiguration", "inbound"] => n.soft_reconfiguration_inbound = true,
                            ["default-originate"] => n.default_originate = true,
                            _ => n.other.push(l.clone()),
                        }
                    }
                    _ => f.other.push(l.clone()),
                }
            }
            b.families.push(f);
        }
        out.push(b);
    }
    out
}

fn ospf(c: &Config, version: u32) -> Vec<OspfConfig> {
    let (head, rid) = if version == 2 { ("router ospf", "ospf") } else { ("router ospf6", "ospf6") };
    let Some(blk) = c.block(&[head]) else { return vec![] };
    let mut o = OspfConfig { version, ..Default::default() };
    for l in &blk.lines {
        let ws = w(l);
        match ws.as_slice() {
            [k, "router-id", id] if *k == rid => o.router_id = (*id).into(),
            ["network", p, "area", a] => o.networks.push(OspfNetworkConfig { prefix: (*p).into(), area: (*a).into(), ..Default::default() }),
            ["area", a, rest @ ..] if matches!(rest, [] | ["stub"] | ["nssa"] | ["stub" | "nssa", "no-summary"]) => o.areas.push(OspfAreaConfig {
                area: (*a).into(),
                area_type: rest.first().copied().unwrap_or("normal").into(),
                no_summary: rest.contains(&"no-summary"),
                ..Default::default()
            }),
            ["area", a, ..] => match o.areas.iter_mut().find(|x| x.area == *a) {
                Some(x) => x.other.push(l.clone()),
                None => o.areas.push(OspfAreaConfig { area: (*a).into(), area_type: "normal".into(), other: vec![l.clone()], ..Default::default() }),
            },
            ["passive-interface", "default"] => o.passive_default = true,
            ["passive-interface", i] => o.passive.push((*i).into()),
            ["no", "passive-interface", i] => o.not_passive.push((*i).into()),
            ["redistribute", ..] => o.redistribute.extend(redistribute(l)),
            ["default-information", ..] => o.default_information = l.clone(),
            _ => o.other.push(l.clone()),
        }
    }
    vec![o]
}

fn isis(c: &Config) -> Vec<IsisConfig> {
    c.blocks
        .iter()
        .filter(|b| b.path.len() == 1 && b.path[0].starts_with("router isis "))
        .map(|b| {
            let mut i = IsisConfig { tag: b.path[0]["router isis ".len()..].trim().into(), ..Default::default() };
            for l in &b.lines {
                let ws = w(l);
                match ws.as_slice() {
                    ["net", n] => i.nets.push((*n).into()),
                    ["is-type", t] => i.is_type = (*t).into(),
                    ["metric-style", s] => i.metric_style = (*s).into(),
                    ["redistribute", ..] => i.redistribute.extend(redistribute(l)),
                    _ => i.other.push(l.clone()),
                }
            }
            i
        })
        .collect()
}

fn interface_routing(i: &crate::config::Iface) -> Option<InterfaceRoutingConfig> {
    let mut r = InterfaceRoutingConfig { name: i.name.clone(), ..Default::default() };
    let mut any = false;
    for l in &i.extra {
        let ws = w(l);
        let routing = matches!(ws.as_slice(), ["ip", "ospf", ..] | ["ipv6", "ospf6", ..] | ["isis", ..] | ["ip" | "ipv6", "router", "isis", ..]);
        if !routing {
            continue;
        }
        any = true;
        match ws.as_slice() {
            ["ip", "ospf", "area", a] => r.ospf_area = (*a).into(),
            ["ip", "ospf", "cost", n] => r.ospf_cost = num(Some(n)),
            ["ip", "ospf", "passive"] => r.ospf_passive = true,
            ["ip", "ospf", "network", t] => r.ospf_network = (*t).into(),
            ["ip", "ospf", "hello-interval", n] => r.ospf_hello = num(Some(n)),
            ["ip", "ospf", "dead-interval", n] => r.ospf_dead = num(Some(n)),
            ["ipv6", "ospf6", "area", a] => r.ospf6_area = (*a).into(),
            ["ipv6", "ospf6", "cost", n] => r.ospf6_cost = num(Some(n)),
            ["ipv6", "ospf6", "passive"] => r.ospf6_passive = true,
            ["ip" | "ipv6", "router", "isis", t] => {
                if !r.isis_instances.iter().any(|x| x == t) {
                    r.isis_instances.push((*t).into());
                }
            }
            ["isis", "circuit-type", t] => r.isis_circuit_type = (*t).into(),
            ["isis", "metric", n, ..] => r.isis_metric = num(Some(n)),
            ["isis", "passive"] => r.isis_passive = true,
            _ => r.other.push(l.clone()),
        }
    }
    any.then_some(r)
}

// --- Writing --------------------------------------------------------------------

/// What a typed edit becomes: the path and the lines to stage there, in order.
/// A BGP neighbour's family lines go to their own mode; `shown` is the reply's
/// lines (the families entered and left, the password masked).
pub struct Plan {
    pub path: Vec<String>,
    pub steps: Vec<(Vec<String>, Vec<String>)>,
    pub shown: Vec<String>,
}

impl Plan {
    fn at(path: Vec<String>, lines: Vec<String>) -> Self {
        Self { shown: lines.iter().map(|l| mask(l)).collect(), steps: vec![(path.clone(), lines)], path }
    }
}

/// Every field named is a field of the object: an unknown one is REASON_USAGE, as on the box.
fn mask_of<'a>(fields: &'a [String], known: &[&'a str]) -> Result<Vec<&'a str>, Usage> {
    if let Some(f) = fields.iter().find(|f| !known.contains(&f.as_str())) {
        return usage(format!("unknown field {f}"));
    }
    // An empty mask is every field, to the value sent (docs/prisma-api.md).
    Ok(if fields.is_empty() { known.to_vec() } else { fields.iter().map(String::as_str).collect() })
}

fn swap(out: &mut Vec<String>, old: &str, new: &str, line: impl Fn(&str) -> String, clear: &str) {
    if old == new {
        return;
    }
    if new.is_empty() {
        out.push(clear.to_string());
    } else {
        out.push(line(new));
    }
}

fn list(out: &mut Vec<String>, old: &[String], new: &[String], line: impl Fn(&str) -> String) {
    for x in old.iter().filter(|x| !new.contains(x)) {
        out.push(format!("no {}", line(x)));
    }
    for x in new.iter().filter(|x| !old.contains(x)) {
        out.push(line(x));
    }
}

const IFACE_FIELDS: [&str; 14] = [
    "description", "mtu", "shutdown", "ipv4", "ipv6", "cgnat_role", "vrf", "linux_name", "vlan", "mac_address", "urpf",
    "router_advertisements", "name", "pref64",
];

pub fn set_interface(c: &Config, i: &InterfaceConfig, fields: &[String]) -> Result<Plan, Usage> {
    let named = mask_of(fields, &IFACE_FIELDS)?;
    if i.name.is_empty() {
        return usage("an interface needs its name");
    }
    let cur = c.iface(&i.name).map(interface).unwrap_or(InterfaceConfig { name: i.name.clone(), mtu: 1500, router_advertisements: true, ..Default::default() });
    if c.iface(&i.name).is_none() && !is_bundle(&i.name) {
        return usage(format!("interface {} does not exist", i.name));
    }
    // PREF64 (0.150.2, #61): only where advertisements are sent, and only a prefix a NAT64 pool
    // translates, refused as the box's commit check words it.
    let pref64 = if named.contains(&"pref64") { &i.pref64 } else { &cur.pref64 };
    let ra = if named.contains(&"router_advertisements") { i.router_advertisements } else { cur.router_advertisements };
    if !pref64.is_empty() && !ra {
        return usage(format!("% {}: ipv6 nd nat64 needs router advertisements (no ipv6 nd suppress-ra)", i.name));
    }
    let translated = nat64_prefixes(c);
    if let Some(p) = pref64.iter().find(|p| !translated.contains(p)) {
        return usage(format!("% ipv6 nd nat64 {p}: no NAT64 pool translates this prefix"));
    }
    let mut out = vec![];
    for f in named {
        match f {
            "pref64" => list(&mut out, &cur.pref64, &i.pref64, |p| format!("ipv6 nd nat64 {p}")),
            "description" => swap(&mut out, &cur.description, i.description.trim(), |v| format!("description {v}"), "no description"),
            "mtu" if i.mtu != cur.mtu => out.push(if i.mtu == 0 { "no mtu".into() } else { format!("mtu {}", i.mtu) }),
            "shutdown" if i.shutdown != cur.shutdown => out.push(if i.shutdown { "shutdown" } else { "no shutdown" }.into()),
            "ipv4" => list(&mut out, &cur.ipv4, &i.ipv4, |a| format!("ipv4 address {a}")),
            "ipv6" => list(&mut out, &cur.ipv6, &i.ipv6, |a| format!("ipv6 address {a}")),
            "cgnat_role" => swap(&mut out, &cur.cgnat_role, &i.cgnat_role, |v| format!("cgnat {v}"), "no cgnat"),
            "vrf" if i.vrf != cur.vrf => out.push(if i.vrf == 0 { "no vrf".into() } else { format!("vrf {}", i.vrf) }),
            "linux_name" => swap(&mut out, &cur.linux_name, i.linux_name.trim(), |v| format!("linux-name {v}"), "no linux-name"),
            "mac_address" => swap(&mut out, &cur.mac_address, i.mac_address.trim(), |v| format!("mac-address {v}"), "no mac-address"),
            "urpf" => swap(&mut out, &cur.urpf, &i.urpf, |v| format!("urpf {v}"), "no urpf"),
            "router_advertisements" if i.router_advertisements != cur.router_advertisements => {
                out.push(if i.router_advertisements { "no ipv6 nd suppress-ra" } else { "ipv6 nd suppress-ra" }.into())
            }
            "vlan" if (i.vlan_outer, i.vlan_inner) != (cur.vlan_outer, cur.vlan_inner) => out.push(match (i.vlan_outer, i.vlan_inner) {
                (0, _) => "no vlan".into(),
                (o, 0) => format!("vlan {o}"),
                (o, n) => format!("vlan {o} inner {n}"),
            }),
            _ => {}
        }
    }
    Ok(Plan::at(vec![format!("interface {}", i.name)], out))
}

const POOL_FIELDS: [&str; 25] = [
    "name", "prefix_inside", "prefix_outside", "prefix_list_inside", "prefix_list_outside", "block_size", "ports", "policy", "mode", "vrf", "outside_vrf", "timeouts", "max_blocks",
    "initial_allocation", "block_stride", "reserve", "bypass_source", "bypass_destination", "utilisation_alarm", "max_sessions",
    "max_session_rate", "tcp_mss", "filter", "algs", "forwards",
];
/// A NAT64 pool's (0.151.0, #68): no bypass, and NAT64's two.
const NAT64_FIELDS: [&str; 23] = [
    "name", "prefix_inside", "prefix_outside", "block_size", "ports", "policy", "mode", "vrf", "outside_vrf", "timeouts", "max_blocks",
    "initial_allocation", "block_stride", "reserve", "utilisation_alarm", "max_sessions", "max_session_rate", "tcp_mss", "filter",
    "algs", "forwards", "subscriber_length", "nat64_prefix",
];

/// A CGNAT pool (`nat > cgnat`). Since 0.151.0 a NAT64 pool is not one (#68).
pub fn set_pool(c: &Config, p: &PoolConfig, fields: &[String]) -> Result<Plan, Usage> {
    let named = mask_of(fields, &POOL_FIELDS)?;
    if c.nat64_pool_names().contains(&p.name) {
        return usage(format!("% '{}' is a pool under 'nat64'", p.name));
    }
    if named.contains(&"prefix_inside") && p.prefix_inside.iter().any(|x| x.contains(':')) {
        return usage("% an IPv6 inside prefix is a NAT64 pool's: it goes under nat > nat64");
    }
    set_pool_at(c, "cgnat", p, &named)
}

/// A NAT64 pool (`nat > nat64`, 0.151.0, #68): IPv6 inside prefixes, FTP the only ALG (0.150.1,
/// #60), no bypass, and its subscriber length and NAT64 prefix.
pub fn set_nat64_pool(c: &Config, n: &Nat64PoolConfig, fields: &[String]) -> Result<Plan, Usage> {
    let named = mask_of(fields, &NAT64_FIELDS)?;
    if c.pool_names().contains(&n.name) {
        return usage(format!("% '{}' is a pool under 'cgnat'", n.name));
    }
    let (cur, cur_len, cur_prefix) = pool_at(c, "nat64", &n.name);
    let has = |f: &str| named.contains(&f);
    let inside = if has("prefix_inside") { &n.prefix_inside } else { &cur.prefix_inside };
    if has("prefix_inside") && !inside.iter().all(|x| x.contains(':')) {
        return usage("% a NAT64 pool's inside prefixes are IPv6");
    }
    let algs = if has("algs") { &n.algs } else { &cur.algs };
    if let Some(a) = algs.iter().filter(|(a, on)| **on && a.as_str() != "ftp").map(|(a, _)| a).next() {
        return usage(format!("% alg {a} cannot be used on a NAT64 pool"));
    }
    let p = PoolConfig {
        name: n.name.clone(),
        prefix_inside: n.prefix_inside.clone(),
        prefix_outside: n.prefix_outside.clone(),
        block_size: n.block_size,
        port_first: n.port_first,
        port_last: n.port_last,
        policy: n.policy.clone(),
        mode: n.mode.clone(),
        vrf: n.vrf,
        outside_vrf: n.outside_vrf,
        timeouts: n.timeouts.clone(),
        max_blocks: n.max_blocks,
        initial_allocation: n.initial_allocation,
        block_stride: n.block_stride,
        reserve: n.reserve,
        utilisation_alarm: n.utilisation_alarm,
        max_sessions: n.max_sessions,
        max_session_rate: n.max_session_rate,
        tcp_mss: n.tcp_mss.clone(),
        filter: n.filter.clone(),
        algs: n.algs.clone(),
        forwards: n.forwards.clone(),
        ..Default::default()
    };
    let common: Vec<&str> = named.iter().copied().filter(|f| !matches!(*f, "subscriber_length" | "nat64_prefix")).collect();
    let mut plan = set_pool_at(c, "nat64", &p, &common)?;
    let mut extra = vec![];
    if has("subscriber_length") && n.subscriber_length != cur_len {
        extra.push(if n.subscriber_length == 0 { "no subscriber-length".into() } else { format!("subscriber-length {}", n.subscriber_length) });
    }
    if has("nat64_prefix") && n.nat64_prefix != cur_prefix {
        extra.push(if n.nat64_prefix.is_empty() { "no nat64-prefix".into() } else { format!("nat64-prefix {}", n.nat64_prefix) });
    }
    plan.shown.extend(extra.iter().cloned());
    if let Some((_, lines)) = plan.steps.first_mut() {
        lines.extend(extra);
    }
    Ok(plan)
}

/// What both levels share; `mode` is "deterministic" or "bpa" since 0.151.0 (#68).
fn set_pool_at(c: &Config, level: &str, p: &PoolConfig, named: &[&str]) -> Result<Plan, Usage> {
    if p.name.trim().is_empty() || p.name.contains(char::is_whitespace) {
        return usage("a pool needs a one-word name");
    }
    if named.contains(&"mode") && p.mode == "dynamic" {
        return usage("% mode dynamic is mode bpa since 0.151.0");
    }
    let names = if level == "nat64" { c.nat64_pool_names() } else { c.pool_names() };
    let exists = names.contains(&p.name);
    let cur = if exists { pool_at(c, level, &p.name).0 } else { PoolConfig { name: p.name.clone(), max_blocks: 1, ..Default::default() } };
    let named = named.to_vec();
    let mut out = vec![];
    // A number whose default is "no statement": 0 (or 1 for max-blocks) removes it.
    let scalar = |out: &mut Vec<String>, key: &str, old: u32, new: u32, default: u32| {
        if old != new {
            out.push(if new == default { format!("no {key}") } else { format!("{key} {new}") });
        }
    };
    for f in named {
        match f {
            "prefix_inside" => list(&mut out, &cur.prefix_inside, &p.prefix_inside, |x| format!("prefix-inside {x}")),
            "prefix_outside" => list(&mut out, &cur.prefix_outside, &p.prefix_outside, |x| format!("prefix-outside {x}")),
            // A side's list (0.151.12, #73): "" writes `no prefix-list-<side>`. Both ways on one
            // side are refused at commit, not here.
            "prefix_list_inside" | "prefix_list_outside" => {
                let side = if f == "prefix_list_inside" { "inside" } else { "outside" };
                let (old, new) = if side == "inside" { (&cur.prefix_list_inside, &p.prefix_list_inside) } else { (&cur.prefix_list_outside, &p.prefix_list_outside) };
                if old != new {
                    out.push(if new.is_empty() { format!("no prefix-list-{side}") } else { format!("prefix-list-{side} {new}") });
                }
            }
            // No `no` form on the VTY: it can be changed, not cleared (#41).
            "block_size" if p.block_size != cur.block_size => {
                if p.block_size == 0 {
                    return usage("block_size cannot be unset; give a size");
                }
                out.push(format!("block-size {}", p.block_size));
            }
            "mode" | "policy" => {
                let (old, new) = if f == "mode" { (&cur.mode, &p.mode) } else { (&cur.policy, &p.policy) };
                if old != new {
                    if new.is_empty() {
                        return usage(format!("{f} cannot be unset"));
                    }
                    out.push(format!("{f} {new}"));
                }
            }
            "ports" if (p.port_first, p.port_last) != (cur.port_first, cur.port_last) => {
                out.push(if p.port_first == 0 && p.port_last == 0 { "no ports".into() } else { format!("ports {} {}", p.port_first, p.port_last) })
            }
            "vrf" | "outside_vrf" => {
                let (old, new, key) = if f == "vrf" { (cur.vrf, p.vrf, "vrf") } else { (cur.outside_vrf, p.outside_vrf, "outside-vrf") };
                if old != new {
                    out.push(match new {
                        None => format!("no {key}"),
                        Some(v) => format!("{key} {v}"),
                    });
                }
            }
            "timeouts" => {
                for k in cur.timeouts.keys().filter(|k| !p.timeouts.contains_key(*k)) {
                    out.push(format!("no timeout {k}"));
                }
                let mut keys: Vec<_> = p.timeouts.keys().collect();
                keys.sort();
                for k in keys {
                    if cur.timeouts.get(k) != p.timeouts.get(k) {
                        out.push(format!("timeout {k} {}", p.timeouts[k]));
                    }
                }
            }
            "max_blocks" => scalar(&mut out, "max-blocks", cur.max_blocks.max(1), p.max_blocks.max(1), 1),
            "initial_allocation" => scalar(&mut out, "initial-allocation", cur.initial_allocation, p.initial_allocation, 0),
            "block_stride" => scalar(&mut out, "block-stride", cur.block_stride, p.block_stride, 0),
            "reserve" => scalar(&mut out, "reserve", cur.reserve, p.reserve, 0),
            "utilisation_alarm" => scalar(&mut out, "utilisation-alarm", cur.utilisation_alarm, p.utilisation_alarm, 0),
            "max_sessions" => scalar(&mut out, "max-sessions", cur.max_sessions, p.max_sessions, 0),
            "max_session_rate" => scalar(&mut out, "max-session-rate", cur.max_session_rate, p.max_session_rate, 0),
            "bypass_source" => list(&mut out, &cur.bypass_source, &p.bypass_source, |x| format!("bypass source {x}")),
            "bypass_destination" => list(&mut out, &cur.bypass_destination, &p.bypass_destination, |x| format!("bypass destination {x}")),
            "tcp_mss" => swap(&mut out, &cur.tcp_mss, &p.tcp_mss, |v| format!("tcp-mss {v}"), "no tcp-mss"),
            "filter" => swap(&mut out, &cur.filter, &p.filter, |v| format!("filter {v}"), "no filter"),
            // Only the ALGs the operator chose: the map is set whole.
            "algs" => {
                for (a, on) in &cur.algs {
                    if !p.algs.contains_key(a) {
                        out.push(format!("no alg {a} {}", if *on { "on" } else { "off" }));
                    }
                }
                let mut keys: Vec<_> = p.algs.keys().collect();
                keys.sort();
                for a in keys {
                    if cur.algs.get(a) != p.algs.get(a) {
                        out.push(format!("alg {a} {}", if p.algs[a] { "on" } else { "off" }));
                    }
                }
            }
            "forwards" if !p.forwards.is_empty() => return usage("the mock does not write port forwards"),
            _ => {}
        }
    }
    Ok(Plan::at(vec!["nat".into(), level.into(), format!("pool {}", p.name)], out))
}

fn collector_line(c: &LogCollectorConfig) -> Result<String, Usage> {
    if !c.configured {
        return Ok(format!("logging {} disable", c.transport));
    }
    if c.collector.is_empty() {
        return usage(format!("a {} collector needs its address", c.transport));
    }
    let port = if c.port > 0 { format!(" port {}", c.port) } else { String::new() };
    Ok(match c.transport.as_str() {
        "udp" if c.source.is_empty() => return usage("a UDP collector needs its source address"),
        "udp" => format!("logging udp {} src {}{port}", c.collector, c.source),
        "tcp" => format!("logging tcp {}{port}", c.collector),
        "syslog" => {
            let mut l = format!("logging syslog {} enterprise {}{port}", c.collector, c.enterprise);
            if let Some(f) = c.facility {
                l.push_str(&format!(" facility {f}"));
            }
            if let Some(s) = c.severity {
                l.push_str(&format!(" severity {s}"));
            }
            l
        }
        t => return usage(format!("unknown transport {t}")),
    })
}

pub fn set_logging(c: &Config, l: &LoggingConfig, fields: &[String]) -> Result<Plan, Usage> {
    let named = mask_of(fields, &["enabled", "collectors"])?;
    let lines = c.block(&CGNAT_PATH).map(|b| b.lines.clone()).unwrap_or_default();
    let mut out = vec![];
    for f in named {
        match f {
            "enabled" => {
                let on = lines.iter().any(|x| x == "logging enable");
                if on != l.enabled {
                    out.push(if l.enabled { "logging enable" } else { "logging disable" }.into());
                }
            }
            // A collector not listed is left alone; one listed with configured false is disabled.
            _ => {
                for col in &l.collectors {
                    let line = collector_line(col)?;
                    let current = lines.iter().find(|x| x.starts_with(&format!("logging {} ", col.transport)));
                    if current != Some(&line) {
                        out.push(line);
                    }
                }
            }
        }
    }
    Ok(Plan::at(CGNAT_PATH.map(String::from).to_vec(), out))
}

fn route_line(r: &StaticRouteConfig) -> String {
    let mut l = format!("{} next-hop {}", r.prefix, r.next_hop);
    for x in r.extra.iter().filter(|x| !x.is_empty()) {
        l.push_str(&format!(" {x}"));
    }
    if r.distance > 0 {
        l.push_str(&format!(" distance {}", r.distance));
    }
    if r.tag > 0 {
        l.push_str(&format!(" tag {}", r.tag));
    }
    if !r.description.trim().is_empty() {
        l.push_str(&format!(" description {}", r.description.trim()));
    }
    l
}

/// A route is its prefix and next hop: typed again it is replaced whole, the
/// fields not named kept from the candidate.
pub fn set_static(c: &Config, r: &StaticRouteConfig, fields: &[String]) -> Result<Plan, Usage> {
    let named = mask_of(fields, &["prefix", "next_hop", "distance", "tag", "description", "extra", "family", "vrf", "line"])?;
    if !r.vrf.is_empty() {
        return usage(format!("a route of VRF {} is a line of its vrf block; edit it through Edit", r.vrf));
    }
    if r.prefix.is_empty() || r.next_hop.is_empty() {
        return usage("a static route needs its prefix and next hop");
    }
    let cur = statics(c).into_iter().find(|x| x.prefix == r.prefix && x.next_hop == r.next_hop);
    let mut next = cur.clone().unwrap_or(StaticRouteConfig { prefix: r.prefix.clone(), next_hop: r.next_hop.clone(), ..Default::default() });
    for f in named {
        match f {
            "distance" => next.distance = r.distance,
            "tag" => next.tag = r.tag,
            "description" => next.description = r.description.clone(),
            "extra" => next.extra = r.extra.clone(),
            _ => {}
        }
    }
    let line = route_line(&next);
    let lines = if cur.is_some_and(|c| c.line == line) { vec![] } else { vec![line] };
    Ok(Plan::at(vec!["router static".into()], lines))
}

const NEIGHBOR_FIELDS: [&str; 10] = [
    "remote_as", "description", "update_source", "timers", "password", "peer_group", "ebgp_multihop", "shutdown", "bfd", "families",
];

fn family_path(head: &str, afi: &str, safi: &str) -> Vec<String> {
    vec![head.to_string(), format!("address-family {afi} {}", if safi.is_empty() { "unicast" } else { safi })]
}

/// The lines that take what a family says about `peer` from `old` to `new` (set whole).
fn family_lines(peer: &str, old: &BgpNeighborFamilyConfig, new: &BgpNeighborFamilyConfig) -> Vec<String> {
    let mut out = vec![];
    let n = |s: &str| format!("neighbor {peer} {s}");
    let flag = |out: &mut Vec<String>, o: bool, v: bool, s: &str| {
        if o != v {
            out.push(if v { n(s) } else { format!("no {}", n(s)) });
        }
    };
    flag(&mut out, old.activate, new.activate, "activate");
    for (o, v, kind, dir) in [
        (&old.route_map_in, &new.route_map_in, "route-map", "in"),
        (&old.route_map_out, &new.route_map_out, "route-map", "out"),
        (&old.prefix_list_in, &new.prefix_list_in, "prefix-list", "in"),
        (&old.prefix_list_out, &new.prefix_list_out, "prefix-list", "out"),
    ] {
        if o != v {
            if !o.is_empty() {
                out.push(format!("no {}", n(&format!("{kind} {o} {dir}"))));
            }
            if !v.is_empty() {
                out.push(n(&format!("{kind} {v} {dir}")));
            }
        }
    }
    if old.maximum_prefix != new.maximum_prefix {
        out.push(if new.maximum_prefix == 0 { format!("no {}", n("maximum-prefix")) } else { n(&format!("maximum-prefix {}", new.maximum_prefix)) });
    }
    flag(&mut out, old.next_hop_self, new.next_hop_self, "next-hop-self");
    flag(&mut out, old.soft_reconfiguration_inbound, new.soft_reconfiguration_inbound, "soft-reconfiguration inbound");
    flag(&mut out, old.default_originate, new.default_originate, "default-originate");
    out
}

/// The statements of a router-level neighbour as they are written, for its removal.
fn neighbor_lines(c: &Config, path: &[String], peer: &str) -> Vec<String> {
    let head = format!("neighbor {peer} ");
    c.blocks.iter().find(|b| b.path == path).map(|b| b.lines.iter().filter(|l| l.starts_with(&head)).cloned().collect()).unwrap_or_default()
}

fn find_bgp(c: &Config, asn: &str, vrf: &str) -> Result<(String, BgpConfig), Usage> {
    let head = bgp_head(asn, vrf);
    let b = bgps(c).into_iter().find(|b| b.asn == asn && b.vrf == vrf);
    match b {
        Some(b) => Ok((head, b)),
        None => usage(format!("no {head} in this configuration")),
    }
}

pub fn set_bgp_neighbor(c: &Config, e: &BgpNeighborEdit, fields: &[String]) -> Result<Plan, Usage> {
    let named = mask_of(fields, &NEIGHBOR_FIELDS)?;
    let Some(n) = &e.neighbor else { return usage("a neighbour edit needs its neighbor") };
    if n.address.is_empty() {
        return usage("a neighbour needs its address");
    }
    let (head, b) = find_bgp(c, &e.asn, &e.vrf)?;
    let peer = &n.address;
    let cur = b.neighbors.iter().find(|x| &x.address == peer).cloned();
    let old = cur.clone().unwrap_or_default();
    let line = |s: String| format!("neighbor {peer} {s}");
    let mut top = vec![];
    for f in &named {
        match *f {
            "remote_as" if n.remote_as != old.remote_as && !n.remote_as.is_empty() => top.push(line(format!("remote-as {}", n.remote_as))),
            "remote_as" if n.remote_as.is_empty() && cur.is_none() && n.peer_group.is_empty() => return usage("a new neighbour needs remote_as or a peer_group"),
            _ => {}
        }
    }
    for f in &named {
        let text = |out: &mut Vec<String>, o: &str, v: &str, key: &str| {
            if o != v {
                out.push(if v.is_empty() { format!("no neighbor {peer} {key}") } else { line(format!("{key} {v}")) });
            }
        };
        match *f {
            "peer_group" => text(&mut top, &old.peer_group, &n.peer_group, "peer-group"),
            "description" => text(&mut top, &old.description, n.description.trim(), "description"),
            "update_source" => text(&mut top, &old.update_source, &n.update_source, "update-source"),
            // Write only: set when given, never cleared by its absence.
            "password" if !e.password.is_empty() => top.push(line(format!("password {}", e.password))),
            "ebgp_multihop" if n.ebgp_multihop != old.ebgp_multihop => {
                top.push(if n.ebgp_multihop == 0 { format!("no neighbor {peer} ebgp-multihop") } else { line(format!("ebgp-multihop {}", n.ebgp_multihop)) })
            }
            "timers" if (n.keepalive, n.holdtime) != (old.keepalive, old.holdtime) => top.push(if n.keepalive == 0 && n.holdtime == 0 {
                format!("no neighbor {peer} timers")
            } else {
                line(format!("timers {} {}", n.keepalive, n.holdtime))
            }),
            "shutdown" if n.shutdown != old.shutdown => top.push(if n.shutdown { line("shutdown".into()) } else { format!("no neighbor {peer} shutdown") }),
            "bfd" if n.bfd != old.bfd => top.push(if n.bfd { line("bfd".into()) } else { format!("no neighbor {peer} bfd") }),
            _ => {}
        }
    }
    let mut plan = Plan::at(vec![head.clone()], top);
    if named.contains(&"families") {
        for fe in &e.families {
            let safi = if fe.safi.is_empty() { "unicast" } else { fe.safi.as_str() };
            let old = b
                .families
                .iter()
                .find(|f| f.afi == fe.afi && f.safi == safi)
                .and_then(|f| f.neighbors.iter().find(|x| &x.neighbor == peer))
                .cloned()
                .unwrap_or_default();
            // A family listed is set whole: what its settings leave out is removed.
            let new = BgpNeighborFamilyConfig { neighbor: peer.clone(), ..fe.settings.clone().unwrap_or_default() };
            let lines = family_lines(peer, &old, &new);
            if lines.is_empty() {
                continue;
            }
            plan.shown.push(format!("address-family {} {safi}", fe.afi));
            plan.shown.extend(lines.iter().map(|l| format!(" {}", mask(l))));
            plan.shown.push("exit-address-family".into());
            plan.steps.push((family_path(&head, &fe.afi, safi), lines));
        }
    }
    Ok(plan)
}

pub fn delete(c: &Config, r: &DeleteConfigRequest) -> Result<Plan, Usage> {
    match r.area.as_str() {
        "pools" if c.pool_names().contains(&r.name) => Ok(Plan::at(CGNAT_PATH.map(String::from).to_vec(), vec![format!("no pool {}", r.name)])),
        "pools" => usage(format!("no pool {}", r.name)),
        "nat64" if c.nat64_pool_names().contains(&r.name) => Ok(Plan::at(vec!["nat".into(), "nat64".into()], vec![format!("no pool {}", r.name)])),
        "nat64" => usage(format!("no NAT64 pool {}", r.name)),
        "logging" if ["udp", "tcp", "syslog"].contains(&r.transport.as_str()) => {
            Ok(Plan::at(CGNAT_PATH.map(String::from).to_vec(), vec![format!("logging {} disable", r.transport)]))
        }
        "logging" => usage("transport is udp, tcp or syslog"),
        "static" => match statics(c).into_iter().find(|x| x.prefix == r.prefix && x.next_hop == r.next_hop) {
            Some(x) => Ok(Plan::at(vec!["router static".into()], vec![format!("no {}", x.line)])),
            None => usage(format!("no static route {} via {}", r.prefix, r.next_hop)),
        },
        // Statement by statement, read off the candidate: each family's, then the
        // router level's, `remote-as` last. A bare `no neighbor X` is a statement of
        // its own on this VTY, which frr-reload refuses next to family statements.
        "bgp" => {
            let (head, b) = find_bgp(c, &r.asn, &r.vrf)?;
            let peer = &r.name;
            if !b.neighbors.iter().any(|n| &n.address == peer) {
                return usage(format!("no neighbor {peer} in {head}"));
            }
            let mut plan = Plan { path: vec![head.clone()], steps: vec![], shown: vec![] };
            for f in &b.families {
                let path = family_path(&head, &f.afi, &f.safi);
                let lines: Vec<String> = neighbor_lines(c, &path, peer).iter().map(|l| format!("no {l}")).collect();
                if lines.is_empty() {
                    continue;
                }
                plan.shown.push(format!("address-family {} {}", f.afi, f.safi));
                plan.shown.extend(lines.iter().map(|l| format!(" {}", mask(l))));
                plan.shown.push("exit-address-family".into());
                plan.steps.push((path, lines));
            }
            let all = neighbor_lines(c, &[head.clone()], peer);
            let (remote, rest): (Vec<_>, Vec<_>) = all.into_iter().partition(|l| l.starts_with(&format!("neighbor {peer} remote-as ")));
            let lines: Vec<String> = rest.into_iter().chain(remote).map(|l| format!("no {l}")).collect();
            plan.shown.extend(lines.iter().map(|l| mask(l)));
            plan.steps.push((vec![head], lines));
            Ok(plan)
        }
        "interfaces" => usage("an interface is not removed through DeleteConfig on the mock"),
        "bfd" => delete_bfd(c, r),
        a => usage(format!("unknown area {a}")),
    }
}

/// Whether a typed edit stays in `nat > cgnat`, all a cgnat-operator may change (#41).
pub fn is_cgnat(o: &set_config_request::Object) -> bool {
    matches!(o, set_config_request::Object::Pool(_) | set_config_request::Object::Logging(_) | set_config_request::Object::Nat64Pool(_))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn apply(c: &mut Config, p: &Plan) {
        for (path, lines) in &p.steps {
            c.edit(path, lines).ok().expect("the mock takes its own lines");
        }
    }

    #[test]
    fn reads_every_area_off_the_lines() {
        let mut c = Config::seed("x");
        c.edit(&s(&["router bgp 65000"]), &s(&["neighbor 203.0.113.9 password s3cret", "bgp log-neighbor-changes"])).ok().unwrap();
        c.edit(&s(&["router bgp 65000", "address-family ipv4 unicast"]), &s(&["neighbor 203.0.113.9 route-map IN in", "neighbor 203.0.113.9 route-map OUT out", "network 198.51.100.0/24", "aggregate-address 198.51.100.0/22 summary-only", "redistribute connected route-map RM"])).ok().unwrap();
        let t = read(&c, &[]).ok().unwrap();
        assert_eq!(t.interfaces.len(), 5);
        assert_eq!(t.interfaces.iter().find(|i| i.name == "lo").unwrap().kind, "loopback");
        assert_eq!(t.pools[0].block_size, 256);
        assert_eq!(t.pools[0].prefix_inside, ["100.64.0.0/10"]);
        assert_eq!(t.static_routes.len(), 2);
        let b = &t.bgp[0];
        assert!(b.default_ipv4_unicast && b.other == ["bgp log-neighbor-changes"]);
        let n = b.neighbors.iter().find(|n| n.address == "203.0.113.9").unwrap();
        assert!(n.password_set && n.remote_as == "64500");
        assert!(!format!("{t:?}").contains("s3cret"), "a password is never read");
        let v4 = b.families.iter().find(|f| f.afi == "ipv4").unwrap();
        let nf = &v4.neighbors[0];
        assert_eq!((nf.route_map_in.as_str(), nf.route_map_out.as_str()), ("IN", "OUT"), "both directions are kept");
        assert_eq!(v4.networks, ["198.51.100.0/24"]);
        assert!(v4.aggregates[0].summary_only && v4.redistribute[0].route_map == "RM");
        assert_eq!(t.ospf[0].networks[0].area, "0");
        assert_eq!(t.ospf[0].passive, ["lan0.20"]);
        assert_eq!(t.ospf6[0].version, 3);
        assert_eq!(t.interface_routing.iter().find(|i| i.name == "lan0").unwrap().ospf6_area, "0");
        assert!(read(&c, &s(&["bgpx"])).is_err());
        let only = read(&c, &s(&["static"])).ok().unwrap();
        assert!(only.interfaces.is_empty() && only.bgp.is_empty() && only.static_routes.len() == 2);
    }

    #[test]
    fn an_interface_is_set_to_the_fields_named() {
        let mut c = Config::seed("x");
        let i = InterfaceConfig { name: "wan0".into(), mtu: 9000, description: String::new(), ipv4: s(&["192.0.2.1/24"]), ..Default::default() };
        let p = set_interface(&c, &i, &s(&["mtu"])).ok().unwrap();
        assert_eq!(p.shown, ["mtu 9000"], "only the field named: the description is not cleared");
        let p = set_interface(&c, &i, &s(&["mtu", "description", "ipv4"])).ok().unwrap();
        assert_eq!(p.shown, ["mtu 9000", "no description", "no ipv4 address 203.0.113.10/29", "ipv4 address 192.0.2.1/24"]);
        let p = set_interface(&c, &i, &[]).ok().unwrap();
        assert!(p.shown.contains(&"no ipv6 address 2001:db8:100::2/64".to_string()), "an empty mask sets every field: {:?}", p.shown);
        assert!(set_interface(&c, &i, &s(&["colour"])).is_err());
        let p = set_interface(&c, &InterfaceConfig { name: "wan0".into(), cgnat_role: "outside".into(), vrf: 5, router_advertisements: false, ..Default::default() }, &s(&["cgnat_role", "vrf", "router_advertisements"])).ok().unwrap();
        apply(&mut c, &p);
        let w = interface(c.iface("wan0").unwrap());
        assert_eq!((w.cgnat_role.as_str(), w.vrf, w.router_advertisements), ("outside", 5, false));
    }

    #[test]
    fn pools_and_collectors_are_written_as_their_lines() {
        let mut c = Config::seed("x");
        let mut p = pool(&c, "RFC6598");
        p.block_size = 512;
        p.algs.insert("sip".into(), false);
        p.max_sessions = 100;
        let plan = set_pool(&c, &p, &s(&["block_size", "algs", "max_sessions"])).ok().unwrap();
        assert_eq!(plan.shown, ["block-size 512", "alg sip off", "max-sessions 100"]);
        apply(&mut c, &plan);
        assert_eq!(c.pool_block_size("RFC6598"), 512);
        let new = PoolConfig { name: "BIZ".into(), prefix_inside: s(&["10.0.0.0/8"]), prefix_outside: s(&["198.51.100.0/28"]), ..Default::default() };
        assert_eq!(set_pool(&c, &new, &s(&["prefix_inside", "prefix_outside"])).ok().unwrap().path, ["nat", "cgnat", "pool BIZ"]);
        // NAT64 under nat > nat64 (0.151.0, #68): IPv6 inside, a subscriber length; FTP its only ALG.
        let v6 = Nat64PoolConfig {
            name: "NAT64".into(),
            prefix_inside: s(&["2001:db8:1200::/40"]),
            prefix_outside: s(&["198.51.100.64/28"]),
            subscriber_length: 56,
            ..Default::default()
        };
        let plan = set_nat64_pool(&c, &v6, &s(&["prefix_inside", "prefix_outside", "subscriber_length"])).ok().unwrap();
        assert_eq!(plan.path, ["nat", "nat64", "pool NAT64"]);
        assert!(plan.shown.contains(&"subscriber-length 56".to_string()), "{:?}", plan.shown);
        let mut alg = v6.clone();
        alg.algs.insert("ftp".into(), true);
        assert!(set_nat64_pool(&c, &alg, &s(&["prefix_inside", "prefix_outside", "algs"])).is_ok(), "FTP through NAT64 (0.150.1)");
        alg.algs.insert("sip".into(), true);
        assert!(set_nat64_pool(&c, &alg, &s(&["prefix_inside", "prefix_outside", "algs"])).is_err(), "no other ALG on a NAT64 pool");
        let v4inside = PoolConfig { name: "X".into(), prefix_inside: s(&["2001:db8::/40"]), ..Default::default() };
        assert!(set_pool(&c, &v4inside, &s(&["prefix_inside"])).is_err(), "an IPv6 inside prefix is not a CGNAT pool's");
        let dynamic = PoolConfig { name: "BIZ".into(), mode: "dynamic".into(), ..Default::default() };
        assert!(set_pool(&c, &dynamic, &s(&["mode"])).is_err(), "mode dynamic is mode bpa (0.151.0)");
        let l = LoggingConfig {
            collectors: vec![LogCollectorConfig { transport: "udp".into(), configured: true, collector: "192.0.2.9".into(), source: "203.0.113.10".into(), port: 2055, ..Default::default() }],
            ..Default::default()
        };
        assert_eq!(set_logging(&c, &l, &s(&["collectors"])).ok().unwrap().shown, ["logging udp 192.0.2.9 src 203.0.113.10 port 2055"]);
        let bad = LoggingConfig { collectors: vec![LogCollectorConfig { transport: "udp".into(), configured: true, collector: "192.0.2.9".into(), ..Default::default() }], ..Default::default() };
        assert!(set_logging(&c, &bad, &s(&["collectors"])).is_err(), "a UDP collector with no source");
    }

    #[test]
    fn a_static_route_is_retyped_whole_and_a_vrf_route_is_refused() {
        let mut c = Config::seed("x");
        let r = StaticRouteConfig { prefix: "0.0.0.0/0".into(), next_hop: "203.0.113.9".into(), distance: 10, description: "dflt".into(), ..Default::default() };
        let p = set_static(&c, &r, &s(&["distance"])).ok().unwrap();
        assert_eq!(p.shown, ["0.0.0.0/0 next-hop 203.0.113.9 distance 10"], "the description not named is kept from the candidate (none)");
        apply(&mut c, &p);
        let p = set_static(&c, &StaticRouteConfig { description: "dflt".into(), ..r.clone() }, &s(&["description"])).ok().unwrap();
        assert_eq!(p.shown, ["0.0.0.0/0 next-hop 203.0.113.9 distance 10 description dflt"]);
        assert!(set_static(&c, &StaticRouteConfig { vrf: "blue".into(), ..r }, &s(&["distance"])).is_err());
        let d = delete(&c, &DeleteConfigRequest { area: "static".into(), prefix: "::/0".into(), next_hop: "2001:db8:100::1".into(), ..Default::default() }).ok().unwrap();
        assert_eq!(d.shown, ["no ::/0 next-hop 2001:db8:100::1"]);
    }

    #[test]
    fn a_neighbor_is_set_by_difference_and_removed_statement_by_statement() {
        let mut c = Config::seed("x");
        let e = BgpNeighborEdit {
            asn: "65000".into(),
            neighbor: Some(BgpNeighborConfig { address: "192.0.2.1".into(), remote_as: "64510".into(), description: "Peer".into(), ..Default::default() }),
            password: "s3cret".into(),
            families: vec![BgpNeighborFamilyEdit {
                afi: "ipv4".into(),
                safi: "unicast".into(),
                settings: Some(BgpNeighborFamilyConfig { activate: true, route_map_in: "IN".into(), ..Default::default() }),
            }],
            ..Default::default()
        };
        let p = set_bgp_neighbor(&c, &e, &s(&["remote_as", "description", "password", "families"])).ok().unwrap();
        assert_eq!(p.path, ["router bgp 65000"]);
        assert_eq!(p.shown[0], "neighbor 192.0.2.1 remote-as 64510", "remote-as first: it creates the neighbour");
        assert!(p.shown.contains(&format!("neighbor 192.0.2.1 password {MASKED}")));
        assert!(!p.shown.iter().any(|l| l.contains("s3cret")), "the reply never echoes the password");
        assert!(p.steps[0].1.contains(&"neighbor 192.0.2.1 password s3cret".to_string()), "the box is given the real one");
        assert_eq!(&p.shown[p.shown.len() - 4..], ["address-family ipv4 unicast", " neighbor 192.0.2.1 activate", " neighbor 192.0.2.1 route-map IN in", "exit-address-family"]);
        apply(&mut c, &p);
        assert!(!c.render().contains("s3cret"), "show running-config masks it too");

        // An empty password with the field named is not a clearing.
        let again = BgpNeighborEdit { password: String::new(), families: vec![], ..e.clone() };
        assert!(set_bgp_neighbor(&c, &again, &s(&["password", "description"])).ok().unwrap().steps[0].1.is_empty());
        // A family listed is set whole: the route-map it does not name goes.
        let whole = BgpNeighborEdit {
            families: vec![BgpNeighborFamilyEdit { afi: "ipv4".into(), safi: "unicast".into(), settings: Some(BgpNeighborFamilyConfig { activate: true, ..Default::default() }) }],
            ..again.clone()
        };
        let p = set_bgp_neighbor(&c, &whole, &s(&["families"])).ok().unwrap();
        assert_eq!(p.steps[1].1, ["no neighbor 192.0.2.1 route-map IN in"]);
        let back = set_bgp_neighbor(&c, &e, &s(&["families"])).ok().unwrap();
        apply(&mut c, &back);

        let d = delete(&c, &DeleteConfigRequest { area: "bgp".into(), name: "192.0.2.1".into(), asn: "65000".into(), ..Default::default() }).ok().unwrap();
        assert_eq!(d.shown.first().map(String::as_str), Some("address-family ipv4 unicast"), "each family's statements first: {:?}", d.shown);
        assert_eq!(d.shown.last().map(String::as_str), Some("no neighbor 192.0.2.1 remote-as 64510"), "remote-as last");
        assert!(!d.shown.iter().any(|l| l == "no neighbor 192.0.2.1"), "never a bare no neighbor");
        assert!(d.shown.contains(&format!("no neighbor 192.0.2.1 password {MASKED}")));
        apply(&mut c, &d);
        assert!(!c.render().contains("192.0.2.1"));
        assert!(set_bgp_neighbor(&c, &BgpNeighborEdit { asn: "1".into(), ..e }, &s(&["description"])).is_err(), "no such router bgp");
    }
}

// --- BFD (Prisma 0.150.12, #67) -------------------------------------------------

/// A `bfd` timer statement and its BfdTimers field: number ones.
const BFD_NUMBERS: [(&str, &str); 6] = [
    ("detect-multiplier", "detect_multiplier"),
    ("receive-interval", "receive_interval_ms"),
    ("transmit-interval", "transmit_interval_ms"),
    ("minimum-ttl", "minimum_ttl"),
    ("echo receive-interval", "echo_receive_interval_ms"),
    ("echo transmit-interval", "echo_transmit_interval_ms"),
];
/// ... and the flags.
const BFD_FLAGS: [(&str, &str); 3] = [("echo-mode", "echo_mode"), ("passive-mode", "passive_mode"), ("shutdown", "shutdown")];

fn bfd_number(t: &BfdTimers, f: &str) -> u32 {
    match f {
        "detect_multiplier" => t.detect_multiplier,
        "receive_interval_ms" => t.receive_interval_ms,
        "transmit_interval_ms" => t.transmit_interval_ms,
        "minimum_ttl" => t.minimum_ttl,
        "echo_receive_interval_ms" => t.echo_receive_interval_ms,
        _ => t.echo_transmit_interval_ms,
    }
}

fn bfd_flag(t: &BfdTimers, f: &str) -> bool {
    match f {
        "echo_mode" => t.echo_mode,
        "passive_mode" => t.passive_mode,
        _ => t.shutdown,
    }
}

/// A session's or profile's lines into its timers; the rest (and `profile` on a session) apart.
fn bfd_body(lines: &[String]) -> (BfdTimers, Option<String>, Vec<String>) {
    let mut t = BfdTimers::default();
    let (mut profile, mut other) = (None, vec![]);
    for l in lines {
        if let Some(p) = l.strip_prefix("profile ") {
            profile = Some(p.trim().to_string());
            continue;
        }
        let num = BFD_NUMBERS.iter().find_map(|(k, f)| l.strip_prefix(k).and_then(|r| r.trim().parse::<u32>().ok()).map(|n| (*f, n)));
        match num {
            Some((f, n)) => match f {
                "detect_multiplier" => t.detect_multiplier = n,
                "receive_interval_ms" => t.receive_interval_ms = n,
                "transmit_interval_ms" => t.transmit_interval_ms = n,
                "minimum_ttl" => t.minimum_ttl = n,
                "echo_receive_interval_ms" => t.echo_receive_interval_ms = n,
                _ => t.echo_transmit_interval_ms = n,
            },
            None => match BFD_FLAGS.iter().find(|(k, _)| l == k) {
                Some((_, "echo_mode")) => t.echo_mode = true,
                Some((_, "passive_mode")) => t.passive_mode = true,
                Some(_) => t.shutdown = true,
                None => other.push(l.clone()),
            },
        }
    }
    (t, profile, other)
}

/// `peer <address> [multihop] [local-address X] [interface I] [vrf V]` from its fields.
fn bfd_header(p: &BfdPeerConfig) -> String {
    let mut h = format!("peer {}", p.address);
    if p.multihop {
        h += " multihop";
    }
    for (k, v) in [("local-address", &p.local_address), ("interface", &p.interface), ("vrf", &p.vrf)] {
        if !v.is_empty() {
            h += &format!(" {k} {v}");
        }
    }
    h
}

fn bfd_peer_of(header: &str, lines: &[String]) -> Option<BfdPeerConfig> {
    let w: Vec<&str> = header.split_whitespace().collect();
    let (&"peer", rest) = w.split_first()? else { return None };
    let (address, rest) = rest.split_first()?;
    let mut p = BfdPeerConfig { address: (*address).into(), header: header.into(), ..Default::default() };
    let mut i = 0;
    while i < rest.len() {
        match (rest[i], rest.get(i + 1)) {
            ("multihop", _) => {
                p.multihop = true;
                i += 1;
            }
            ("local-address", Some(v)) => {
                p.local_address = (*v).into();
                i += 2;
            }
            ("interface", Some(v)) => {
                p.interface = (*v).into();
                i += 2;
            }
            ("vrf", Some(v)) => {
                p.vrf = (*v).into();
                i += 2;
            }
            _ => i += 1,
        }
    }
    let (timers, profile, other) = bfd_body(lines);
    p.timers = Some(timers);
    p.profile = profile.unwrap_or_default();
    p.other = other;
    Some(p)
}

pub fn bfd_peers(c: &Config) -> Vec<BfdPeerConfig> {
    c.blocks
        .iter()
        .filter(|b| b.path.len() == 2 && b.path[0] == "bfd" && b.path[1].starts_with("peer "))
        .filter_map(|b| bfd_peer_of(&b.path[1], &b.lines))
        .collect()
}

pub fn bfd_profiles(c: &Config) -> Vec<BfdProfileConfig> {
    c.blocks
        .iter()
        .filter(|b| b.path.len() == 2 && b.path[0] == "bfd")
        .filter_map(|b| b.path[1].strip_prefix("profile ").map(|n| (n.trim().to_string(), &b.lines)))
        .map(|(name, lines)| {
            let (timers, _, other) = bfd_body(lines);
            BfdProfileConfig { name, timers: Some(timers), other }
        })
        .collect()
}

/// The timer lines a mask names, from `old` to `new`; `timers` names them all.
fn bfd_timer_lines(fields: &[&str], old: &BfdTimers, new: &BfdTimers) -> Vec<String> {
    let named = |f: &str| fields.contains(&"timers") || fields.contains(&format!("timers.{f}").as_str());
    let mut out = vec![];
    for (k, f) in BFD_NUMBERS {
        let (o, n) = (bfd_number(old, f), bfd_number(new, f));
        if named(f) && o != n {
            // 0 is not stated: FRR's default applies.
            out.push(if n == 0 { format!("no {k}") } else { format!("{k} {n}") });
        }
    }
    for (k, f) in BFD_FLAGS {
        let (o, n) = (bfd_flag(old, f), bfd_flag(new, f));
        if named(f) && o != n {
            out.push(if n { k.to_string() } else { format!("no {k}") });
        }
    }
    out
}

fn bfd_mask(fields: &[String], extra: &[&'static str]) -> Result<Vec<String>, Usage> {
    let ok = |f: &str| {
        f == "timers" || extra.contains(&f) || f.strip_prefix("timers.").is_some_and(|t| BFD_NUMBERS.iter().chain(BFD_FLAGS.iter()).any(|(_, x)| *x == t))
    };
    if let Some(f) = fields.iter().find(|f| !ok(f)) {
        return usage(format!("unknown field {f}"));
    }
    Ok(fields.to_vec())
}

pub fn set_bfd_peer(c: &Config, p: &BfdPeerConfig, fields: &[String]) -> Result<Plan, Usage> {
    if p.address.parse::<std::net::IpAddr>().is_err() {
        return usage(format!("% '{}' is not a peer address", p.address));
    }
    let fields = bfd_mask(fields, &["profile"])?;
    let fields: Vec<&str> = fields.iter().map(String::as_str).collect();
    let header = bfd_header(p);
    let existing = bfd_peers(c).into_iter().find(|x| bfd_header(x) == header);
    let new = existing.is_none();
    let cur = existing.unwrap_or_default();
    let mut lines = vec![];
    if fields.contains(&"profile") && p.profile != cur.profile {
        lines.push(if p.profile.is_empty() { format!("no profile {}", cur.profile) } else { format!("profile {}", p.profile) });
    }
    lines.extend(bfd_timer_lines(&fields, &cur.timers.unwrap_or_default(), &p.timers.unwrap_or_default()));
    let mut plan = Plan::at(vec!["bfd".into(), header.clone()], lines);
    if new {
        plan.shown.insert(0, header);
    }
    Ok(plan)
}

pub fn set_bfd_profile(c: &Config, p: &BfdProfileConfig, fields: &[String]) -> Result<Plan, Usage> {
    if p.name.trim().is_empty() || p.name.contains(char::is_whitespace) {
        return usage("a profile needs a one-word name");
    }
    let fields = bfd_mask(fields, &[])?;
    let fields: Vec<&str> = fields.iter().map(String::as_str).collect();
    let existing = bfd_profiles(c).into_iter().find(|x| x.name == p.name);
    let new = existing.is_none();
    let cur = existing.unwrap_or_default();
    let lines = bfd_timer_lines(&fields, &cur.timers.unwrap_or_default(), &p.timers.unwrap_or_default());
    let mut plan = Plan::at(vec!["bfd".into(), format!("profile {}", p.name)], lines);
    if new {
        plan.shown.insert(0, format!("profile {}", p.name));
    }
    Ok(plan)
}

pub fn delete_bfd(c: &Config, r: &DeleteConfigRequest) -> Result<Plan, Usage> {
    if let Some(p) = &r.bfd_peer {
        let header = bfd_header(p);
        if !bfd_peers(c).iter().any(|x| bfd_header(x) == header) {
            return usage(format!("no {header}"));
        }
        return Ok(Plan::at(vec!["bfd".into()], vec![format!("no {header}")]));
    }
    if !r.name.is_empty() {
        if !bfd_profiles(c).iter().any(|x| x.name == r.name) {
            return usage(format!("no profile {}", r.name));
        }
        return Ok(Plan::at(vec!["bfd".into()], vec![format!("no profile {}", r.name)]));
    }
    Ok(Plan::at(vec![], vec!["no bfd".into()]))
}
