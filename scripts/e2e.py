#!/usr/bin/env python3
"""End-to-end test of prisma-web against the docker compose stack.

Checks through the API the acceptance criteria of issue #3 (gRPC integration),
using prisma-mock as the Prisma. It creates its own router and user, removes
them at the end, and reverts the configuration change it applies.

Usage:
    E2E_USER=admin E2E_PASSWORD=... scripts/e2e.py [--base http://[::1]]
    E2E_USER=admin E2E_PASSWORD=... scripts/e2e.py --lab https://192.0.2.166:50051 \
        --lab-profile host/prisma-api        # real Prisma: READ-ONLY, no commit

Uses only the standard library. Exits with code 1 on the first failed check.
"""

import argparse
import http.cookiejar
import ipaddress
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime

PASSED = 0


class Client:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + "/api" + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req, timeout=40) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            return e.code, (json.loads(raw) if raw else None)

    def get(self, p):
        return self.call("GET", p)

    def post(self, p, b=None):
        return self.call("POST", p, {} if b is None else b)

    def put(self, p, b):
        return self.call("PUT", p, b)

    def patch(self, p, b):
        return self.call("PATCH", p, b)

    def delete(self, p):
        return self.call("DELETE", p)


def check(cond, what, detail=None):
    global PASSED
    if not cond:
        print(f"FAILED: {what}")
        if detail is not None:
            print(f"        {json.dumps(detail, ensure_ascii=False)[:600]}")
        sys.exit(1)
    PASSED += 1
    print(f"ok      {what}")


def wait_for(fn, what, timeout=30):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        ok, last = fn()
        if ok:
            check(True, what)
            return last
        time.sleep(1)
    check(False, what, last)


def check_backfill(admin, R, iface, registered_at):
    """Samples older than the router's registration can only come from the box's history (#26)."""
    def older(path):
        b = admin.get(path)[1]
        return [x for x in b["samples"] if datetime.fromisoformat(x["timestamp"]).timestamp() < registered_at - 90]
    traffic = older(f"{R}/metrics/traffic?interface={iface}&minutes=1440")
    cgnat = older(f"{R}/metrics/cgnat?minutes=1440")
    check(traffic and cgnat, f"charts backfilled from GetHistory ({len(traffic)} traffic and {len(cgnat)} CGNAT points before registration)")


def tls_test(client, url, profile=None, server_name=None):
    body = {"api_url": url}
    if profile:
        body.update(tls_profile=profile, tls_server_name=server_name)
    return client.post("/routers/test", body)


def tls_checks(admin, args):
    """mTLS (issue #4): profiles, acceptance and every kind of refusal."""
    st, profiles = admin.get("/routers/tls-profiles")
    ids = {p["id"]: p for p in profiles or []}
    check(st == 200 and ids.get("dev/mock", {}).get("account") == "prisma-web-dev", "TLS profiles listed with the account (CN)", profiles)
    check("BEGIN" not in json.dumps(profiles), "profile listing exposes neither certificate nor key")
    m = args.tls_mock
    st, b = tls_test(admin, m, "dev/mock", args.server_name)
    check(st == 200 and b["account"] == "prisma-web-dev", "mTLS with the right profile connects and shows the account", b)
    check((b.get("access") or {}).get("role") == "administrator", "connection test shows the role the box gives the account (WhoAmI)", b)
    st, b = tls_test(admin, m, "dev/other-ca", args.server_name)
    check(st == 422 and "UnknownIssuer" in b["error"]["message"], "server from an unknown CA is refused", b)
    st, b = tls_test(admin, m, "dev/intruder", args.server_name)
    check(st == 422, "client from another CA is refused by the server", b)
    st, b = tls_test(admin, m, "dev/mock", "wrong-name")
    check(st == 422 and "wrong-name" in b["error"]["message"], "wrong server name is refused", b)
    st, b = tls_test(admin, m.replace("https://", "http://"))
    check(st == 422, "mTLS server refuses a connection without TLS", b)
    st, b = tls_test(admin, m)
    check(st == 422 and "TLS profile" in b["error"]["message"], "https:// without a profile is refused", b)
    st, b = tls_test(admin, args.mock, "dev/mock", args.server_name)
    check(st == 422, "profile with http:// is refused", b)
    # Uptime breakdown (Prisma 0.148.7, #20): prisma-mock-2 reports a dataplane
    # that restarted by itself.
    st, r = admin.post("/routers", {"name": f"e2e-tls-{uuid.uuid4().hex[:6]}", "api_url": m, "tls_profile": "dev/mock", "tls_server_name": args.server_name})
    check(st == 201, "router registered over mTLS", r)
    try:
        st, sysinfo = admin.get(f"/routers/{r['id']}/system")
        check(st == 200 and sysinfo.get("boot_time") and sysinfo.get("dataplane_restarted") is True,
              "mock with a restarted dataplane reports dataplane_restarted", sysinfo)
        candidate_expiry_checks(admin, f"/routers/{r['id']}")
        log_export_checks(admin, r["id"])
        st, b = admin.post(f"/routers/{r['id']}/system/reboot", {"confirm": r["name"]})
        check(st == 403 and "prisma-operator" in errmsg(b), "a box whose account has no operator refuses prisma-web, in its words (#50, #51)", b)
        s = wait_for(lambda: (lambda s: (s.get("access") is not None, s))(next(x for x in admin.get("/routers/status")[1] if x["id"] == r["id"])),
                     "WhoAmI of the 0.149.26 mock")
        check(s["access"].get("can_operate") is False, "and WhoAmI says so (can_operate false)", s["access"])
        st, evs = sse(admin, f"/routers/{r['id']}/system/upgrade", {"version": ""})
        check(st == 200 and any(e == "progress" and json.loads(d)["phase"] == "CHECKED" for e, d in evs),
              "the upgrade check is every account's since 0.149.26", evs if st != 200 else evs[:1])
        st, b = admin.post(f"/routers/{r['id']}/system/restart-dataplane", {"confirm": r["name"]})
        check(st == 409 and "#564" in errmsg(b), "a dataplane restart is refused before the box on 0.149.25 to 0.149.31 (prismarouting #564)", b)
    finally:
        admin.delete(f"/routers/{r['id']}")
    read_only_checks(admin, args)
    cgnat_operator_checks(admin, args)
    st, b = tls_test(admin, m, "../etc", args.server_name)
    check(st == 422 and "invalid TLS profile" in b["error"]["message"], "profile with ../ is refused", b)


def candidate_expiry_checks(admin, R):
    """prisma-mock-2 closes a candidate idle for 15 s, as the box does after 30 min (#11)."""
    st, c = admin.post(f"{R}/config/candidates")
    check(st == 200, "candidate opened on the short-idle mock", c)
    check(c.get("idle_seconds") == 15 and c.get("expires_at"), "the box says when the candidate expires (Prisma 0.149.18)", c)
    C = f"{R}/config/candidates/{c['candidate_id']}"
    st, b = admin.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["description e2e idle"]})
    check(st == 200, "edit within the idle limit", b)
    time.sleep(17)
    st, b = admin.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["mtu 1400"]})
    check(st == 410 and b["error"]["code"] == "candidate_expired" and "idle" in b["error"]["message"],
          "a candidate Prisma closed for idleness answers candidate_expired with the reason, not 'not found'", b)
    st, b = admin.get(f"{C}/compare")
    check(st == 404, "the expired candidate is forgotten by the back", b)


def config_model_checks(admin, R):
    """Structured configuration (#39): the grammar and the running configuration as instances of modes."""
    st, g = admin.get(f"{R}/config/grammar")
    keys = {m["key"] for m in (g or {}).get("modes", [])}
    n = sum(len(gr["statements"]) for m in g["modes"] for gr in m["groups"]) if st == 200 else 0
    check(st == 200 and n > 300 and {"config", "interface <name>", "nat > cgnat > pool <name>", "router bgp <asn>"} <= keys,
          f"the VTY's grammar is served mode by mode ({len(keys)} modes, {n} statements)", sorted(keys)[:10])
    check(g["source"].startswith("box "), f"the grammar comes from the box's GetSchema (Prisma 0.149.20): {g['source']}", g["source"])
    st, t = admin.get(f"{R}/config/tree")
    inst = {i["mode"]: i for i in (t or {}).get("instances", [])}
    pool = inst.get("nat > cgnat > pool <name>")
    check(st == 200 and pool and pool["path"] == ["nat", "cgnat", "pool RFC6598"] and all(l["statement"] for l in pool["lines"]),
          "the running configuration reads as instances, each pool line matched to its statement", pool)
    lines = [l for i in t["instances"] for l in i["lines"]]
    owned = [l for l in lines if l.get("owned")]
    check({l["text"] for l in owned} == {"log syslog informational", "service integrated-vtysh-config"} and all(l["owned"] for l in owned),
          "the box's own lines are marked read only, with the box's reason (TypedConfig.box_owned)", owned)
    mine = [l for l in lines if not l.get("owned")]
    known = sum(1 for l in mine if l["statement"])
    check(known >= len(mine) - 1, f"{known} of {len(mine)} of the operator's lines match a statement of the grammar",
          [l["text"] for l in mine if not l["statement"]])
    st, v = admin.post(f"{R}/config/validate", {"path": ["nat", "cgnat"], "lines": ["timeout udp 300"]})
    check(st == 200 and v["verdicts"][0]["ok"], "the VTY accepts a valid line in a throwaway candidate (ValidateLines)", v)
    st, v = admin.post(f"{R}/config/validate", {"path": ["interface lan0"], "lines": ["mtu 100"]})
    check(st == 200 and not v["verdicts"][0]["ok"] and v["verdicts"][0]["reason"] == "grammar" and v["verdicts"][0]["message"],
          "and refuses a wrong one with its reason, staging nothing", v)
    st, t2 = admin.get(f"{R}/config/tree")
    check(t2["revision"] == t["revision"], "a check changes nothing on the box")
    bs = next(l for l in pool["lines"] if l["text"].startswith("block-size"))
    check(list(bs["values"].values()) == ["256"], "a matched line gives its values, to fill the form", bs)


def routing_form_checks(admin, R):
    """Routing forms (#42, #43): the lines they send are accepted, rendered in their modes and removed by `no`."""
    st, t = admin.get(f"{R}/config/tree")
    inst = {tuple(i["path"]): i for i in (t or {}).get("instances", [])}
    bgp = next((p for p in inst if len(p) == 1 and p[0].startswith("router bgp ")), None)
    check(bgp and (bgp[0], "address-family ipv6 unicast") in inst and ("router static",) in inst and ("router ospf",) in inst
          and ("router ospf6",) in inst, "BGP with its IPv6 family, OSPF, OSPF6 and static routes read as instances", sorted(inst)[:12])
    statics = inst[("router static",)]["lines"]
    check(statics and all(l["statement"] for l in statics), "every static route matches the router static statement", statics)

    st, c = admin.post(f"{R}/config/candidates")
    cid = c["candidate_id"]
    C = f"{R}/config/candidates/{cid}"
    af4, af6 = [bgp[0], "address-family ipv4 unicast"], [bgp[0], "address-family ipv6 unicast"]
    edits = [
        (list(bgp), ["neighbor 192.0.2.77 remote-as 64777", "neighbor 192.0.2.77 description e2e peer", "neighbor 192.0.2.77 bfd",
                     "neighbor 2001:db8:77::1 remote-as 64777", "bgp router-id 203.0.113.10"]),
        (af4, ["neighbor 192.0.2.77 activate", "neighbor 192.0.2.77 route-map E2E-IN in", "network 198.51.100.0/24",
               "aggregate-address 198.51.100.0/22 summary-only", "redistribute connected"]),
        (af6, ["neighbor 2001:db8:77::1 activate", "network 2001:db8:77::/48"]),
        (["router ospf"], ["network 10.77.0.0/16 area 0.0.0.1", "area 0.0.0.1 stub", "passive-interface wan0",
                           "redistribute static metric 20 metric-type 1"]),
        (["router ospf6"], ["area 0.0.0.2 nssa", "redistribute connected route-map E2E"]),
        (["interface wan0"], ["ip ospf cost 10", "ipv6 ospf6 area 0", "ipv6 ospf6 passive"]),
        (["router static"], ["198.51.100.0/24 next-hop 203.0.113.9 distance 200", "2001:db8:77::/48 next-hop wan0"]),
    ]
    for path, lines in edits:
        st, b = admin.post(f"{C}/edit", {"path": path, "lines": lines})
        check(st == 200, f"the forms' lines are accepted at {' > '.join(path)}", b)
    st, b = admin.post(f"{C}/edit", {"path": ["router static"], "lines": ["198.51.100.0/24 next-hop 2001:db8::1"]})
    check(st == 422 and b["error"]["code"] == "router_rejected" and "family" in b["error"]["message"],
          "a static route through a next hop of the other family is refused", b)

    st, ct = admin.get(f"{R}/config/tree?candidate={cid}")
    ci = {tuple(i["path"]): i for i in (ct or {}).get("instances", [])}
    texts = lambda p: [l["text"] for l in ci.get(tuple(p), {"lines": []})["lines"]]
    check("neighbor 192.0.2.77 description e2e peer" in texts(bgp) and "neighbor 192.0.2.77 activate" in texts(af4)
          and "network 2001:db8:77::/48" in texts(af6), "neighbors render under router bgp and its families", [texts(bgp), texts(af4)])
    check("ipv6 ospf6 area 0" in texts(["interface wan0"]) and "2001:db8:77::/48 next-hop wan0" in texts(["router static"]),
          "interface OSPF lines and static routes render in their modes", texts(["interface wan0"]))
    matched = [l for p in (bgp, af4, af6, ("router ospf",), ("router ospf6",), ("interface wan0",), ("router static",))
               for l in ci.get(tuple(p), {"lines": []})["lines"]]
    # The grammar types a static next hop as an address: the route through an interface is the box's call (#43).
    matched = [l for l in matched if l["text"] != "2001:db8:77::/48 next-hop wan0"]
    check(all(l["statement"] for l in matched), f"all {len(matched)} other routing lines match a statement of the grammar",
          [l["text"] for l in matched if not l["statement"]])

    # A changed single value replaces its line; `no neighbor` takes the neighbor out of every family.
    admin.post(f"{C}/edit", {"path": list(bgp), "lines": ["neighbor 192.0.2.77 remote-as 64778", "no neighbor 2001:db8:77::1"]})
    st, ct = admin.get(f"{R}/config/tree?candidate={cid}")
    ci = {tuple(i["path"]): i for i in (ct or {}).get("instances", [])}
    check([x for x in texts(bgp) if "remote-as" in x and "192.0.2.77" in x] == ["neighbor 192.0.2.77 remote-as 64778"],
          "a new remote-as replaces the old one", texts(bgp))
    check(not any("2001:db8:77::1" in x for p in (bgp, af6) for x in texts(p)), "no neighbor removes it from router bgp and its families",
          [texts(bgp), texts(af6)])
    st, b = admin.post(f"{C}/commit", {"comment": "e2e: routing forms", "confirmed_minutes": 0, "acknowledge_remap": True})
    check(st == 200, "the routing changes commit", b)

    # The live state follows the configuration: a shut-down neighbor is Idle (Admin).
    st, c = admin.post(f"{R}/config/candidates")
    C = f"{R}/config/candidates/{c['candidate_id']}"
    admin.post(f"{C}/edit", {"path": list(bgp), "lines": ["neighbor 192.0.2.77 shutdown"]})
    st, b = admin.post(f"{C}/commit", {"comment": "e2e: shut down", "confirmed_minutes": 0})
    check(st == 200, "shutting a neighbor down commits", b)
    st, n = admin.get(f"{R}/bgp")
    peer = next((x for x in (n or {}).get("neighbors", []) if x["peer"] == "192.0.2.77"), None)
    check(peer and peer["state"] == "Idle (Admin)" and peer["remote_as"] == 64778 and peer["description"] == "e2e peer",
          "ListBgpNeighbors shows the configured neighbor, held down by shutdown", peer)

    st, c = admin.post(f"{R}/config/candidates", {"from_revision": 2})
    st, b = admin.post(f"{R}/config/candidates/{c['candidate_id']}/commit",
                       {"comment": "e2e: undo routing", "confirmed_minutes": 0, "acknowledge_remap": True, "acknowledge_diverge": True})
    check(st == 200, "the routing changes are rolled back", b)
    st, n = admin.get(f"{R}/bgp")
    check(not any(x["peer"] == "192.0.2.77" for x in n["neighbors"]), "the neighbor is gone after the rollback", n)


def interface_form_checks(admin, R):
    """Interfaces form (#40): the port and bundle lines it writes are accepted, refused and read back as statements."""
    st, c = admin.post(f"{R}/config/candidates")
    C = f"{R}/config/candidates/{c['candidate_id']}"
    try:
        st, b = admin.post(f"{C}/edit", {"path": ["interface wan0"], "lines": [
            "no ipv6 address 2001:db8:100::2/64", "ipv6 address 2001:db8:100::3/64", "vrf 10", "cgnat outside"]})
        check(st == 200, "a port takes an IPv6 address swap, a VRF and its CGNAT side", b)
        st, b = admin.post(f"{C}/edit", {"path": ["interface bond7"], "lines": [
            "description e2e bundle", "member wg0", "lacp mode active", "ipv4 address 198.51.100.1/24"]})
        check(st == 200, "interface bond<n> creates a bundle with its members", b)
        st, b = admin.post(f"{C}/edit", {"path": ["interface bond8"], "lines": ["member wg0"]})
        check(st == 422 and "already a member of bond7" in b["error"]["message"], "a port joins one bundle at most", b)
        st, b = admin.post(f"{C}/edit", {"path": ["interface wan0"], "lines": ["member lan0"]})
        check(st == 422, "member is a bundle statement, refused on a port", b)
        st, b = admin.post(f"{C}/edit", {"path": ["interface wan0"], "lines": ["vrf 0"]})
        check(st == 422, "a VRF id out of range is refused by the box too", b)

        st, t = admin.get(f"{R}/config/tree?candidate={c['candidate_id']}")
        inst = {tuple(i["path"]): i for i in (t or {}).get("instances", [])}
        bond, wan = inst.get(("interface bond7",)), inst.get(("interface wan0",))
        check(st == 200 and bond and bond["mode"] == "interface bond<n>" and all(l["statement"] for l in bond["lines"]),
              "the new bundle reads back in the bundle mode, every line a statement", bond)
        texts = {l["text"]: l for l in (wan or {}).get("lines", [])}
        check({"vrf 10", "cgnat outside", "ipv6 address 2001:db8:100::3/64"} <= texts.keys()
              and all(texts[k]["statement"] for k in ["vrf 10", "cgnat outside", "ipv6 address 2001:db8:100::3/64"])
              and "ipv6 address 2001:db8:100::2/64" not in texts,
              "the port's new lines read back as statements, the removed address gone", sorted(texts))
        st, cmp = admin.get(f"{C}/compare")
        d = (cmp or {}).get("diff", "")
        check(st == 200 and "-  ipv6 address 2001:db8:100::2/64" in d and "+  ipv6 address 2001:db8:100::3/64" in d
              and "+ interface bond7" in d and "+  member wg0" in d, "the diff shows the address swap and the new bundle", d)
    finally:
        admin.delete(C)


TYPED_SECRET = "e2e-Secret-46"


def errmsg(b):
    """The refusal's message and its diagnostics' messages, as one text."""
    e = (b or {}).get("error") or {}
    return " ".join([e.get("message", "")] + [d.get("message", "") for d in (e.get("diagnostics") or {}).get("items", [])])


def typed_form_checks(admin, R):
    """The configuration as fields (Prisma 0.149.20/0.149.22, #46): GetConfig, SetConfig and
    DeleteConfig through the back end, staged in a candidate like Edit, a BGP password never shown."""
    st, t = admin.get(f"{R}/config/typed")
    check(st == 200 and t["source"] == "running" and t["interfaces"] and t["pools"] and t["logging"]["collectors"]
          and t["static_routes"] and t["bgp"] and t["ospf"] and t["ospf6"] and t["interface_routing"],
          "GetConfig answers every area, the routing half included (Prisma 0.149.22)", sorted(k for k, v in (t or {}).items() if v))
    st, t = admin.get(f"{R}/config/typed?areas=static,bgp")
    check(st == 200 and t["static_routes"] and t["bgp"] and not t["interfaces"] and not t["pools"],
          "GetConfig with areas answers only those", sorted(k for k, v in (t or {}).items() if v))
    bgp = t["bgp"][0]
    check(bgp["asn"] == "65000" and bgp["default_ipv4_unicast"] and any(n["address"] == "203.0.113.9" for n in bgp["neighbors"]),
          "the BGP process reads typed: its asn, neighbors and default ipv4-unicast", bgp)
    st, b = admin.get(f"{R}/config/typed?areas=nope")
    check(st == 422, "an unknown area is refused before the box", b)

    revisions = lambda: len(admin.get(f"{R}/config/revisions")[1]["revisions"])
    before = revisions()
    st, c = admin.post(f"{R}/config/candidates")
    cid = c["candidate_id"]
    T = f"{R}/config/typed/{cid}"
    try:
        st, b = admin.post(f"{T}/set", {"interface": {"name": "lan0", "mtu": 9000}, "fields": []})
        check(st == 422 and "empty mask" in b["error"]["message"], "a SetConfig without fields is refused: an empty mask sets every field", b)
        st, b = admin.post(f"{T}/set", {"interface": {"name": "lan0", "mtu": 9000}, "fields": ["mtu"]})
        check(st == 200 and b["lines"] == ["mtu 9000"] and b["path"] == ["interface lan0"],
              "SetConfig sets only the field named and answers the lines it staged (the description is kept)", b)
        st, b = admin.post(f"{T}/set", {"interface": {"name": "lan0", "mtu": 100}, "fields": ["mtu"]})
        check(st == 422 and b["error"]["code"] == "router_rejected", "a value the VTY refuses is refused as at the prompt", b)
        st, b = admin.post(f"{T}/set", {"interface": {"name": "lan0", "colour": 1}, "fields": ["colour"]})
        check(st == 422 and (b["error"].get("diagnostics") or {}).get("reason") == "usage", "an unknown field is REASON_USAGE", b)
        st, b = admin.post(f"{T}/set", {"pool": {"name": "E2E46", "prefix_inside": ["10.46.0.0/16"], "prefix_outside": ["198.51.100.32/28"],
                                                   "block_size": 512, "algs": {"sip": False}}, "fields": ["prefix_inside", "prefix_outside", "block_size", "algs"]})
        check(st == 200 and b["path"] == ["nat", "cgnat", "pool E2E46"] and "block-size 512" in b["lines"] and "alg sip off" in b["lines"],
              "a new pool is set as fields", b)
        # NAT64 under nat > nat64 (Prisma 0.151.0, #68; #59): IPv6 inside, a subscriber prefix length.
        st, b = admin.post(f"{T}/set", {"nat64_pool": {"name": "E2E64", "prefix_inside": ["2001:db8:1200::/40"], "prefix_outside": ["198.51.100.48/28"],
                                                         "subscriber_length": 56, "nat64_prefix": "2001:db8:64::/96", "mode": "bpa"},
                                        "fields": ["prefix_inside", "prefix_outside", "subscriber_length", "nat64_prefix", "mode"]})
        check(st == 200 and b["path"] == ["nat", "nat64", "pool E2E64"] and "prefix-inside 2001:db8:1200::/40" in b["lines"]
              and "subscriber-length 56" in b["lines"] and "nat64-prefix 2001:db8:64::/96" in b["lines"], "a NAT64 pool is set as fields under nat > nat64", b)
        st, b = admin.post(f"{T}/set", {"pool": {"name": "E2E64X", "prefix_inside": ["2001:db8:1300::/40"]}, "fields": ["prefix_inside"]})
        check(st == 422 and "nat > nat64" in errmsg(b), "an IPv6 inside prefix is refused on a CGNAT pool (0.151.0)", b)
        st, b = admin.post(f"{T}/set", {"pool": {"name": "E2E64"}, "fields": ["block_size"]})
        check(st == 422 and "is a pool under 'nat64'" in errmsg(b), "a NAT64 pool's name is refused as a CGNAT pool", b)
        st, b = admin.post(f"{T}/set", {"pool": {"name": "E2E46", "mode": "dynamic"}, "fields": ["mode"]})
        check(st == 422 and "bpa" in errmsg(b), "mode dynamic is refused: it is mode bpa (#573)", b)
        # BFD as fields (Prisma 0.150.12, #67): a profile, a session naming it, then removed.
        st, b = admin.post(f"{T}/set", {"bfd_profile": {"name": "e2e-fast", "timers": {"receive_interval_ms": 100, "transmit_interval_ms": 100, "detect_multiplier": 3}},
                                        "fields": ["timers.receive_interval_ms", "timers.transmit_interval_ms", "timers.detect_multiplier"]})
        check(st == 200 and b["path"] == ["bfd", "profile e2e-fast"] and "receive-interval 100" in b["lines"], "a BFD profile is set as fields", b)
        st, b = admin.post(f"{T}/set", {"bfd_peer": {"address": "192.0.2.46", "interface": "lan0", "profile": "e2e-fast"}, "fields": ["profile"]})
        check(st == 200 and b["path"] == ["bfd", "peer 192.0.2.46 interface lan0"] and "profile e2e-fast" in b["lines"], "a BFD session is set as fields, naming the profile", b)
        st, b = admin.post(f"{T}/set", {"bfd_peer": {"address": "192.0.2.46", "timers": {"colour": 1}}, "fields": ["timers.colour"]})
        check(st == 422 and (b["error"].get("diagnostics") or {}).get("reason") == "usage", "an unknown BFD timer is REASON_USAGE", b)
        st, cb = admin.get(f"{R}/config/typed?areas=bfd&candidate={cid}")
        bp = next((p for p in cb.get("bfd_peers", []) if p["address"] == "192.0.2.46"), {})
        bf = next((p for p in cb.get("bfd_profiles", []) if p["name"] == "e2e-fast"), {})
        check(bp.get("profile") == "e2e-fast" and bp.get("interface") == "lan0" and (bf.get("timers") or {}).get("receive_interval_ms") == 100,
              "the candidate reads BFD typed with what was set", [bp, bf])
        st, b = admin.post(f"{T}/delete", {"area": "bfd", "bfd_peer": {"address": "192.0.2.46", "interface": "lan0"}})
        check(st == 200 and b["lines"] == ["no peer 192.0.2.46 interface lan0"], "a BFD session is removed with DeleteConfig", b)
        st, b = admin.post(f"{T}/delete", {"area": "bfd", "name": "e2e-fast"})
        check(st == 200 and b["lines"] == ["no profile e2e-fast"], "a BFD profile is removed with DeleteConfig", b)
        # PREF64 (Prisma 0.150.2, #61): a prefix a NAT64 pool translates, on an interface that advertises.
        st, b = admin.post(f"{T}/set", {"interface": {"name": "lan0", "pref64": ["2001:db8:64::/96"]}, "fields": ["pref64"]})
        check(st == 200 and b["lines"] == ["ipv6 nd nat64 2001:db8:64::/96"], "PREF64 is set as a field on an advertising interface", b)
        st, b = admin.post(f"{T}/set", {"interface": {"name": "lan0", "pref64": ["2001:db8:65::/96"]}, "fields": ["pref64"]})
        check(st == 422 and "no NAT64 pool translates" in errmsg(b), "a PREF64 no NAT64 pool translates is refused in the box's words", b)
        st, b = admin.post(f"{T}/set", {"interface": {"name": "lan0", "pref64": ["2001:db8:64::/96"], "router_advertisements": False},
                                        "fields": ["pref64", "router_advertisements"]})
        check(st == 422 and "router advertisements" in errmsg(b), "PREF64 without router advertisements is refused", b)
        st, b = admin.post(f"{T}/set", {"nat64_pool": {"name": "E2E64", "algs": {"sip": True}}, "fields": ["algs"]})
        check(st == 422 and "NAT64" in errmsg(b), "an ALG other than FTP on a NAT64 pool is refused in the box's words", b)
        st, b = admin.post(f"{T}/set", {"nat64_pool": {"name": "E2E64", "algs": {"ftp": True}}, "fields": ["algs"]})
        check(st == 200 and "alg ftp on" in b["lines"], "FTP through a NAT64 pool is taken (Prisma 0.150.1, #60)", b)
        st, b = admin.post(f"{T}/set", {"logging": {"collectors": [{"transport": "tcp", "configured": True, "collector": "192.0.2.46", "port": 4746}]},
                                        "fields": ["collectors"]})
        check(st == 200 and b["lines"] == ["logging tcp 192.0.2.46 port 4746"], "a collector is set as fields", b)
        st, b = admin.post(f"{T}/set", {"static_route": {"prefix": "198.51.100.0/24", "next_hop": "203.0.113.9", "distance": 200, "description": "e2e 46"},
                                        "fields": ["distance", "description"]})
        check(st == 200 and b["lines"] == ["198.51.100.0/24 next-hop 203.0.113.9 distance 200 description e2e 46"], "a static route is set as one line", b)
        st, b = admin.post(f"{T}/set", {"static_route": {"prefix": "10.0.0.0/8", "next_hop": "203.0.113.9", "vrf": "blue"}, "fields": ["distance"]})
        check(st == 422 and (b["error"].get("diagnostics") or {}).get("reason") == "usage", "a VRF's static route is refused with REASON_USAGE", b)
        nb = {"asn": "65000", "neighbor": {"address": "192.0.2.46", "remote_as": "64746", "description": "e2e typed"}, "password": TYPED_SECRET,
              "families": [{"afi": "ipv4", "safi": "unicast", "settings": {"activate": True, "route_map_in": "E2E-IN", "route_map_out": "E2E-OUT"}}]}
        st, b = admin.post(f"{T}/set", {"bgp_neighbor": nb, "fields": ["remote_as", "description", "password", "families"]})
        check(st == 200 and b["lines"][0] == "neighbor 192.0.2.46 remote-as 64746" and "neighbor 192.0.2.46 password <set, not shown>" in b["lines"]
              and "address-family ipv4 unicast" in b["lines"] and " neighbor 192.0.2.46 route-map E2E-OUT out" in b["lines"],
              "a BGP neighbor is set as fields: router level first, then its family entered and left", b)
        check(TYPED_SECRET not in json.dumps(b), "the reply never echoes the password")
        st, b = admin.post(f"{T}/set", {"bgp_neighbor": {**nb, "password": ""}, "fields": ["password"]})
        check(st == 200 and b["lines"] == [], "an empty password, even named, never clears the one set", b)

        st, ct = admin.get(f"{R}/config/typed?areas=bgp,static,pools,nat64&candidate={cid}")
        n = next((x for x in ct["bgp"][0]["neighbors"] if x["address"] == "192.0.2.46"), None)
        fam = next(f for f in ct["bgp"][0]["families"] if f["afi"] == "ipv4")
        nf = next((x for x in fam["neighbors"] if x["neighbor"] == "192.0.2.46"), None)
        check(ct["source"] == "candidate" and n and n["password_set"] and nf and nf["route_map_in"] == "E2E-IN" and nf["route_map_out"] == "E2E-OUT"
              and any(p["name"] == "E2E46" for p in ct["pools"]), "the candidate reads typed with what was set: password_set, both route maps", [n, nf])
        p64 = next((p for p in ct.get("nat64_pools", []) if p["name"] == "E2E64"), {})
        check(p64.get("subscriber_length") == 56 and p64.get("nat64_prefix") == "2001:db8:64::/96" and not any(p["name"] == "E2E64" for p in ct["pools"]),
              "the NAT64 pool reads back in the nat64 area, not among the CGNAT pools (#68)", p64)
        check(TYPED_SECRET not in json.dumps(ct), "a password is never read back")
        st, cmp = admin.get(f"{R}/config/candidates/{cid}/compare")
        d = cmp["diff"]
        added = [l[1:].strip() for l in d.splitlines() if l.startswith("+")]
        check({"mtu 9000", "pool E2E46", "neighbor 192.0.2.46 password <set, not shown>"} <= set(added) and TYPED_SECRET not in d,
              "the typed edits are in the candidate's diff like any edit, the password masked", d)
        st, chk = admin.post(f"{R}/config/candidates/{cid}/check")
        check(st == 200 and chk["passed"], "the candidate with typed edits passes the check", chk)
        st, b = admin.post(f"{R}/config/candidates/{cid}/commit", {"comment": "e2e: typed forms", "confirmed_minutes": 0})
        check(st == 200, "the typed edits commit", b)
        st, aud = admin.get(f"/audit?action=config.commit&limit=5")
        check(TYPED_SECRET not in json.dumps(aud), "the commit's diff in the log carries no password")

        st, c = admin.post(f"{R}/config/candidates")
        cid = c["candidate_id"]
        T = f"{R}/config/typed/{cid}"
        st, b = admin.post(f"{T}/delete", {"area": "bgp", "name": "192.0.2.46", "asn": "65000"})
        lines = b.get("lines", []) if st == 200 else []
        check(st == 200 and lines[0] == "address-family ipv4 unicast" and lines[-1] == "no neighbor 192.0.2.46 remote-as 64746"
              and "no neighbor 192.0.2.46" not in lines and "no neighbor 192.0.2.46 password <set, not shown>" in lines,
              "DeleteConfig removes the neighbor statement by statement, family first and remote-as last, never a bare no neighbor", b)
        check(TYPED_SECRET not in json.dumps(b), "the removal's lines mask the password too")
        # A peer-group its members still name is refused, nothing staged (Prisma 0.149.23).
        admin.post(f"{R}/config/candidates/{cid}/edit", {"path": ["router bgp 65000"], "lines": [
            "neighbor E2E-GROUP peer-group", "neighbor E2E-GROUP remote-as 64746", "neighbor 192.0.2.47 peer-group E2E-GROUP"]})
        st, b = admin.post(f"{T}/delete", {"area": "bgp", "name": "E2E-GROUP", "asn": "65000"})
        check(st == 422 and (b["error"].get("diagnostics") or {}).get("reason") == "grammar" and "192.0.2.47" in errmsg(b),
              "removing a peer-group a member still names is refused, the message naming the member", b)
        st, b = admin.post(f"{R}/config/candidates/{cid}/edit", {"path": ["router bgp 65000"], "lines": ["no neighbor E2E-GROUP"]})
        check(st == 422 and "192.0.2.47" in errmsg(b), "and so is its bare no neighbor as a line", b)
        admin.post(f"{R}/config/candidates/{cid}/edit", {"path": ["router bgp 65000"], "lines": ["no neighbor 192.0.2.47", "no neighbor E2E-GROUP"]})
        st, b = admin.post(f"{T}/delete", {"area": "static", "prefix": "198.51.100.0/24", "next_hop": "203.0.113.9"})
        check(st == 200 and b["lines"] == ["no 198.51.100.0/24 next-hop 203.0.113.9 distance 200 description e2e 46"], "a static route is removed by prefix and next hop", b)
        st, b = admin.post(f"{T}/delete", {"area": "pools", "name": "E2E46"})
        check(st == 200 and b["lines"] == ["no pool E2E46"], "a pool is removed with DeleteConfig", b)
        st, chk = admin.post(f"{R}/config/candidates/{cid}/check")
        check(chk["remap"] and chk["diverge"], "the gates still apply to typed removals (remap for the pool, diverge for the neighbor)", chk)
        st, b = admin.post(f"{R}/config/candidates/{cid}/commit", {"comment": "e2e: typed removal", "acknowledge_remap": True, "acknowledge_diverge": True})
        check(st == 200, "the typed removals commit once acknowledged", b)
        st, running = admin.get(f"{R}/config/running")
        check("neighbor 192.0.2.46" not in running["text"] and "E2E46" not in running["text"] and "198.51.100.0/24 next-hop" not in running["text"],
              "the neighbor, the pool and the route are gone", running["text"])
    finally:
        admin.delete(f"{R}/config/candidates/{cid}")
        # Back to the configuration before these commits, even when a check failed.
        made = revisions() - before
        if made:
            st, c = admin.post(f"{R}/config/candidates", {"from_revision": made})
            admin.post(f"{R}/config/candidates/{c['candidate_id']}/commit",
                       {"comment": "e2e: undo typed", "acknowledge_remap": True, "acknowledge_diverge": True})
    st, running = admin.get(f"{R}/config/running")
    check("mtu 9000" not in running["text"] and "logging tcp" not in running["text"], "configuration back to before the typed checks")


def syslog_guard_checks(admin, R):
    """The syslog disable guard (Prisma before 0.149.8, #31), on the line-only mock: the main
    mock reports 0.151.13 since #74."""
    st, revs3 = admin.get(f"{R}/config/revisions")
    st, c3 = admin.post(f"{R}/config/candidates")
    C3 = f"{R}/config/candidates/{c3['candidate_id']}"
    st, b = admin.post(f"{C3}/edit", {"path": ["nat", "cgnat"], "lines": ["logging syslog disable"]})
    check(st == 200, "logging syslog disable applied to a candidate", b)
    st, b = admin.post(f"{C3}/commit", {"comment": "e2e: syslog disable"})
    check(st == 409 and "0.149.8" in b["error"]["message"] and "never enabled" in b["error"]["message"],
          "disabling a never-enabled syslog on a box before 0.149.8 is refused with the reason", b)
    st, revs4 = admin.get(f"{R}/config/revisions")
    check(len(revs4["revisions"]) == len(revs3["revisions"]), "nothing was committed")
    admin.delete(C3)


def line_fallback_checks(admin, args):
    """A box without the typed calls (MOCK_NO_TYPED, prisma-mock-lines): the back end answers 501
    and the forms keep writing lines, which still work (#46)."""
    st, r = admin.post("/routers", {"name": f"e2e-lines-{uuid.uuid4().hex[:6]}", "api_url": args.lines_mock})
    check(st == 201, "router on the mock without the typed configuration registered", r)
    R = f"/routers/{r['id']}"
    try:
        wait_for(lambda: (lambda s: (bool(s) and s[0]["online"], s))([x for x in admin.get("/routers/status")[1] if x["id"] == r["id"]]),
                 "the line-only mock is online")
        st, b = admin.get(f"{R}/config/typed?areas=interfaces")
        check(st == 501 and b["error"]["code"] == "router_unimplemented", "GetConfig answers 501 there: the forms use lines", b)
        st, c = admin.post(f"{R}/config/candidates")
        C = f"{R}/config/candidates/{c['candidate_id']}"
        st, b = admin.post(f"{R}/config/typed/{c['candidate_id']}/set", {"interface": {"name": "lan0", "mtu": 9000}, "fields": ["mtu"]})
        check(st == 501, "and SetConfig too", b)
        st, b = admin.post(f"{C}/edit", {"path": ["router bgp 65000"], "lines": ["neighbor 192.0.2.47 remote-as 64747"]})
        check(st == 200, "a line edit still works on it", b)
        st, b = admin.post(f"{C}/edit", {"path": ["nat", "nat64", "pool E2E64L"],
                                         "lines": ["prefix-inside 2001:db8:1300::/40", "prefix-outside 198.51.100.80/28", "subscriber-length 56"]})
        check(st == 200, "a NAT64 pool is written as lines too (#59)", b)
        st, cmp = admin.get(f"{C}/compare")
        check(any(l.startswith("+") and l[1:].strip() == "neighbor 192.0.2.47 remote-as 64747" for l in cmp["diff"].splitlines()), "and reaches the diff", cmp)
        admin.delete(C)
        syslog_guard_checks(admin, R)
        st, b = admin.get(f"{R}/events")
        check(st == 501, "a box before 0.151.14 has no ListEvents: 501, the card not shown", b)
        s = next(x for x in admin.get("/routers/status")[1] if x["id"] == r["id"])
        check(s.get("system_service") is None, "a box before 0.149.25 has no SystemService: the clears are not offered", s)
        st, b = admin.post(f"{R}/clear", {"target": "interface_counters"})
        check(st == 501, "and Clear answers 501 there", b)
        st, b = sse(admin, f"{R}/logging/watch?seconds=3")
        check(st == 501, "and WatchLogging too", b)
        st, b = admin.get(f"{R}/cgnat/drops")
        check(st == 501, "and the typed show cgnat screens (0.150.3) too", b)
        st, b = admin.get(f"{R}/screens/hardware")
        check(st == 501, "and the 0.150.6 screens too", b)
    finally:
        admin.delete(R)


def clear_checks(admin, R, router_id):
    """OperationalService.Clear (Prisma 0.149.25, #48): each target reaches the box, refusals keep
    the box's words, and every clear is in the change log."""
    status = next(x for x in admin.get("/routers/status")[1] if x["id"] == router_id)
    check(status.get("system_service") == "serving", "the fleet status says the box has SystemService (and Clear)", status)
    peer = admin.get(f"{R}/bgp")[1]["neighbors"][0]["peer"]
    st, b = admin.post(f"{R}/clear", {"target": "bgp", "name": peer, "bgp": "soft_in"})
    check(st == 200 and b["command"] == f"clear ip bgp {peer} soft in", "a soft-in BGP clear reaches the box, which says the command", b)
    st, b = admin.post(f"{R}/clear", {"target": "bgp", "name": peer, "bgp": "hard"})
    n = next(n for n in admin.get(f"{R}/bgp")[1]["neighbors"] if n["peer"] == peer)
    check(st == 200 and n["uptime_seconds"] < 30, "a hard clear restarts the session", n)
    for target, name in [("interface_counters", ""), ("cgnat_subscriber", "100.64.0.10"), ("ospf_process", ""),
                         ("ospf_neighbor", "192.168.10.2"), ("isis_adjacency", "")]:
        st, b = admin.post(f"{R}/clear", {"target": target, "name": name})
        check(st == 200 and b["command"].startswith("clear "), f"Clear {target} reaches the box", b)
    st, b = admin.post(f"{R}/clear", {"target": "bgp", "name": "192.0.2.254"})
    check(st >= 400 and "Unknown neighbor" in errmsg(b), "an unknown neighbor is refused (FAILED_PRECONDITION) with the box's words", b)
    st, b = admin.post(f"{R}/clear", {"target": "interface_counters", "name": "two words"})
    check(st == 400 or st == 422, "a name that is not one word is refused (INVALID_ARGUMENT)", b)
    st, b = admin.post(f"{R}/clear", {"target": "everything"})
    check(st == 422 and b["error"]["code"] == "invalid", "an unknown target is refused before the box", b)
    st, audit = admin.get(f"/audit?router_id={router_id}&action=router.clear&limit=20")
    items = audit["items"]
    check(any(e["success"] and e["details"].get("command") == f"clear ip bgp {peer} soft in" for e in items)
          and any(not e["success"] for e in items), "every clear is in the change log, refused ones too", items[:3])


def sse(client, path, body=None):
    """A Server-Sent Events body read to its end: (status, [(event, data)]) or (status, error JSON)."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(client.base + "/api" + path, data=data, method="GET" if body is None else "POST")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with client.opener.open(req, timeout=60) as r:
            out, event, data = [], "message", []
            for raw in r:
                line = raw.decode().rstrip("\n")
                if not line:
                    if data:
                        out.append((event, "\n".join(data)))
                    event, data = "message", []
                elif line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].lstrip(" "))
            return r.status, out
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else None)


def sse_until(client, path, done, timeout=30, on_open=None):
    """Reads a Server-Sent Events stream until `done(events)` holds or `timeout` passes, then
    closes it. `on_open(events)` runs once per event, for triggers. Returns (status, events)."""
    import socket
    req = urllib.request.Request(client.base + "/api" + path)
    out, event, data = [], "message", []
    try:
        r = client.opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else None)
    end = time.time() + timeout
    try:
        while time.time() < end and not done(out):
            try:
                raw = r.readline()
            except (socket.timeout, TimeoutError):
                break
            if not raw:
                break
            line = raw.decode().rstrip("\n")
            if not line:
                if data:
                    out.append((event, "\n".join(data)))
                    if on_open:
                        on_open(out)
                event, data = "message", []
            elif line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip(" "))
    finally:
        r.close()
    return 200, out


def bfd_checks(admin, R):
    """BFD sessions, typed and live (Prisma 0.150.10, #66)."""
    st, b = admin.get(f"{R}/screens/bfd-sessions")
    s = next((x for x in (b or {}).get("sessions", []) if x["peer"] == "192.168.10.2"), None)
    check(st == 200 and s and s["state"] == "UP" and s["detect_multiplier"] == 3 and b.get("text"),
          "BFD sessions read as fields: the state by name, the timers", b)
    triggered = []
    def flip(evs):
        if not triggered and any(json.loads(d)["kind"] == "INITIAL" for e, d in evs if e == "bfd"):
            triggered.append(1)
            admin.post(f"{R}/show", {"command": "mock bfd down 192.168.10.2"})
    changed = lambda evs: any(e == "bfd" and json.loads(d)["kind"] == "CHANGED" for e, d in evs)
    try:
        st, evs = sse_until(admin, f"{R}/bfd/watch", changed, timeout=20, on_open=flip)
        kinds = [json.loads(d) for e, d in evs if e == "bfd"] if st == 200 else []
        ch = next((k for k in kinds if k["kind"] == "CHANGED"), None)
        check(kinds[:1] and kinds[0]["kind"] == "INITIAL" and ch and ch["previous_state"] == "UP" and ch["session"]["state"] == "DOWN" and ch["at"],
              "WatchBfd sends each session, then a change as it happens", kinds[-2:] or evs)
    finally:
        admin.post(f"{R}/show", {"command": "mock bfd up 192.168.10.2"})


def log_watch_checks(admin, R, router_id):
    """TelemetryService.WatchLogging (Prisma 0.149.25, #49) relayed as Server-Sent Events."""
    st, evs = sse(admin, f"{R}/logging/watch?subscriber=100.64.7.7&event=alloc&seconds=3")
    check(st == 200 and evs and evs[-1][0] == "end", "a 3 s watch streams and ends by itself", evs[-3:] if isinstance(evs, list) else evs)
    logs = [json.loads(d) for e, d in evs if e == "log"]
    check([l["kind"] for l in logs[:2]] == ["STARTED", "BOOT"], "STARTED comes first, then BOOT", logs[:2])
    allocs = [l for l in logs if l["kind"] == "ALLOC"]
    check(allocs and all(l["subscriber"] == "100.64.7.7" and l["port_last"] > l["port_first"] for l in allocs)
          and not any(l["kind"] == "RELEASE" for l in logs), "only the subscriber's allocations, with their port range", allocs[:2])
    check(all(l["at"] for l in allocs), "each event carries its time", allocs[:1])
    st, evs = sse(admin, f"{R}/logging/watch?subscriber=2001:db8:1200:ab12::1&event=alloc&seconds=2")
    subs = {json.loads(d)["subscriber"] for e, d in evs if e == "log" and json.loads(d)["kind"] == "ALLOC"} if st == 200 else set()
    check(subs == {"2001:db8:1200:ab00::/56"}, "a NAT64 subscriber is watched by any address and shown as its delegated prefix (#59)", subs or evs)
    st, b = sse(admin, f"{R}/logging/watch?pool=no-such-pool&seconds=3")
    check(st >= 400 and "Unknown pool" in errmsg(b), "a filter the box refuses is answered in its words", b)
    st, b = sse(admin, f"{R}/logging/watch?port=40000")
    check(st == 422, "a port without its public address is refused before the box", b)
    st, audit = admin.get(f"/audit?router_id={router_id}&action=router.log_watch&limit=10")
    check(any(e["success"] and e["details"].get("subscriber") == "100.64.7.7" and e["details"].get("seconds") == 3 for e in audit["items"])
          and any(not e["success"] for e in audit["items"]), "each watch is in the audit log with its filters, refused ones too", audit["items"][:2])


def system_checks(admin, R, router_id):
    """SystemService (Prisma 0.149.25, #50) on the mock that lets prisma-web run it."""
    status = lambda: next(x for x in admin.get("/routers/status")[1] if x["id"] == router_id)
    name = next(r["name"] for r in admin.get("/routers")[1] if r["id"] == router_id)
    st, last = admin.get(f"{R}/system/upgrade")
    check(st == 200 and last["phase"] in ("PHASE_UNSPECIFIED", "API_RESTART", "FAILED"),
          "GetUpgradeStatus answers; a box with no run (the box's NOT_FOUND) reads as no run", last)
    st, b = admin.post(f"{R}/system/reboot", {"confirm": "not-the-name"})
    check(st == 422 and name in errmsg(b), "a reboot asks for the router's name, typed", b)
    st, b = admin.post(f"{R}/system/reboot", {"confirm": name})
    d = (b or {}).get("error", {}).get("diagnostics") or {}
    check(st >= 400 and d.get("reason") == "unsaved", "after the e2e commits the box refuses a reboot as unsaved (REASON_UNSAVED)", b)
    st, b = admin.post(f"{R}/system/reboot", {"confirm": name, "force": True})
    check(st == 200 and b["output"], "with force the reboot goes", b)
    s = status()
    check((s.get("maintenance") or {}).get("what") == "reboot" and s["maintenance"]["until"] is None,
          "the fleet shows the box in maintenance until it answers again", s.get("maintenance"))
    # The monitor leaves it alone meanwhile: no call every 5 s, probes 15 s or more apart (#52).
    # A poll already under way when the reboot was sent may still land (it times out in 4 s).
    time.sleep(5)
    t1 = status()["checked_at"]
    time.sleep(8)
    check(status()["checked_at"] == t1, "a box in maintenance is not polled every 5 s", (t1, status()["checked_at"]))
    st, b = admin.post(f"{R}/system/restart-dataplane", {"confirm": name})
    check(st == 200 and "restarted" in b["output"], "the dataplane restart answers when it has finished", b)
    check((status().get("maintenance") or {}).get("what") == "dataplane", "a restart that ran puts the box in maintenance (#57)", status().get("maintenance"))
    st, b = admin.post(f"{R}/show", {"command": "mock restart-dataplane apply-failed"})
    st, b = admin.post(f"{R}/system/restart-dataplane", {"confirm": name})
    d = (b or {}).get("error", {}).get("diagnostics") or {}
    check(st == 409 and d.get("reason") == "apply_failed" and (status().get("maintenance") or {}).get("what") == "dataplane",
          "an apply_failed restart is maintenance too: the box confirms by answering again (#57)", (b, status().get("maintenance")))
    st, evs = sse(admin, f"{R}/system/upgrade", {"version": ""})
    prog = [json.loads(d) for e, d in evs if e == "progress"] if st == 200 else []
    check(len(prog) == 1 and prog[0]["phase"] == "CHECKED" and prog[0]["newest"], "an upgrade with no version only checks: the newest release", evs)
    newest = prog[0]["newest"] if prog else ""
    st, b = sse(admin, f"{R}/system/upgrade", {"version": newest})
    check(st == 422, "an upgrade asks for the router's name too", b)
    st, evs = sse(admin, f"{R}/system/upgrade", {"version": newest, "confirm": name})
    phases = [json.loads(d)["phase"] for e, d in evs if e == "progress"] if st == 200 else []
    check(phases[:1] == ["STARTED"] and phases[-1:] == ["API_RESTART"] and "INSTALL" in phases and evs[-1][0] == "end",
          "the upgrade streams its phases up to API_RESTART, then ends", phases)
    m = status().get("maintenance") or {}
    check(m.get("what") == "upgrade" and m.get("until"), "after API_RESTART the box is in maintenance until api_away_seconds pass", m)
    st, last = admin.get(f"{R}/system/upgrade")
    check(st == 200 and last["phase"] == "API_RESTART" and last["version"] == newest, "GetUpgradeStatus reads the run back", last)
    wait_for(lambda: (lambda s: (not s.get("maintenance"), s))(status()), "and is out of maintenance once they have", timeout=20)
    st, evs = sse(admin, f"{R}/system/upgrade", {"version": "0.0.1", "confirm": name})
    failed = [json.loads(d) for e, d in evs if e == "progress" and json.loads(d)["phase"] == "FAILED"] if st == 200 else []
    check(failed and failed[0]["output"], "a failed upgrade carries the run's output", evs)
    check(not status().get("maintenance"), "and leaves no maintenance behind", status().get("maintenance"))
    st, audit = admin.get(f"/audit?router_id={router_id}&action=router.system.&limit=20")
    acts = {e["action"] for e in audit["items"]}
    check({"router.system.reboot", "router.system.restart-dataplane", "router.system.upgrade", "router.system.upgrade-check"} <= acts
          and any(not e["success"] for e in audit["items"]), "every attempt is in the audit log, refused ones too", sorted(acts))
    # 0.149.26 (#51): WhoAmI says the account may run them; a restart that loses the connection
    # (management on the dataplane, as on 192.0.2.198) leaves the box in maintenance.
    check((status().get("access") or {}).get("can_operate") is True, "WhoAmI says prisma-web's account may operate the box (can_operate)", status().get("access"))
    st, b = admin.post(f"{R}/show", {"command": "mock restart-dataplane drops"})
    check(st == 200, "mock: the next dataplane restart drops the connection", b)
    st, b = admin.post(f"{R}/system/restart-dataplane", {"confirm": name})
    check(st == 502, "a restart that loses the connection is not a refusal", b)
    m = status().get("maintenance") or {}
    check(m.get("what") == "dataplane" and m.get("until") is None, "and the box shows in maintenance until it answers again", m)
    st, audit = admin.get(f"/audit?router_id={router_id}&action=router.system.restart-dataplane&limit=1")
    check(audit["items"] and audit["items"][0]["details"].get("connection_lost") is True, "the audit log says the connection was lost", audit["items"][:1])


def cgnat_screen_checks(admin, R, router_id):
    """The rest of show cgnat, typed (Prisma 0.150.3, #63)."""
    for name, key in [("top", "subscribers"), ("blocks", "pools"), ("drops", "nodes"), ("memory", "heap_bytes"), ("algs", "pools"),
                      ("forwards", "forwards"), ("identity", "loaded"), ("ha", "fingerprint"), ("history", "verdict")]:
        st, b = admin.get(f"{R}/cgnat/{name}")
        check(st == 200 and key in b and b.get("text"), f"the {name} screen answers its fields and the router's screen", b)
    st, b = admin.get(f"{R}/cgnat/history")
    check(b.get("verdict") == "INTACT", "the history verdict reads by name", b)
    st, b = admin.get(f"{R}/cgnat/translation?address=203.0.113.70&port=8443")
    check(st == 200 and b["subscriber"].startswith("100.64.") and b["source"] == "BPA", "a public address and port lead to their subscriber", b)
    st, b = admin.get(f"{R}/cgnat/translation?address=192.0.2.1&port=80")
    check(st == 404 and "outside address" in errmsg(b), "an address no pool owns is NOT_FOUND, in the box's words", b)
    st, b = admin.get(f"{R}/cgnat/translation?address=nope&port=80")
    check(st == 422, "a bad address is refused before the box", b)
    st, audit = admin.get(f"/audit?router_id={router_id}&action=router.translation&limit=5")
    check(any(e["success"] and e["details"].get("port") == 8443 for e in audit["items"]), "each lookup is in the audit log", audit["items"][:2])


def sfp_checks(admin, R):
    """Third-party SFP+ modules, opt-in (Prisma 0.151.2, #69): read, and staged as lines."""
    st, s = admin.get(f"{R}/system")
    check(st == 200 and s.get("unsupported_sfp_configured") is False and s.get("unsupported_sfp_booted_known") is True and s.get("hardware_text"),
          "GetSystem says whether third-party SFP+ modules are allowed, configured and as booted", s)
    st, c = admin.post(f"{R}/config/candidates")
    C = f"{R}/config/candidates/{c['candidate_id']}"
    try:
        st, b = admin.post(f"{C}/edit", {"path": ["system", "hardware"], "lines": ["unsupported-sfp allow"]})
        check(st == 200, "unsupported-sfp allow is taken under system > hardware", b)
        st, cmp = admin.get(f"{C}/compare")
        check("unsupported-sfp allow" in cmp["diff"], "and reaches the diff", cmp)
    finally:
        admin.delete(C)


def next_hop_checks(admin, R):
    """A static route to blackhole, Null0, reject or an interface matches its statement (#71)."""
    st, c = admin.post(f"{R}/config/candidates")
    C = f"{R}/config/candidates/{c['candidate_id']}"
    try:
        routes = ["198.51.100.0/24 next-hop blackhole description pool", "198.51.100.64/26 next-hop Null0", "198.51.100.128/26 next-hop reject", "198.51.100.192/26 next-hop wan0"]
        st, b = admin.post(f"{C}/edit", {"path": ["router static"], "lines": routes})
        check(st == 200, "static routes to blackhole, Null0, reject and an interface are taken", b)
        st, t = admin.get(f"{R}/config/tree?candidate={c['candidate_id']}")
        lines = {l["text"]: l for i in t["instances"] for l in i["lines"]}
        check(all(lines.get(r, {}).get("statement") for r in routes), "and each matches the next-hop statement", [lines.get(r) for r in routes])
    finally:
        admin.delete(C)


def pending_configuration_checks(admin, R, router_id):
    """A configuration partially applied at boot (Prisma 0.151.5, #70): the health, the screen, save refused, given up."""
    status = lambda: next(x for x in admin.get("/routers/status")[1] if x["id"] == router_id)
    wait_for(lambda: (lambda s: (s.get("configuration") == "serving", s))(status()), "fleet status carries prisma.v1.Configuration's health (SERVING)")
    st, b = admin.get(f"{R}/screens/pending-configuration")
    check(st == 200 and not b.get("pending") and not b.get("left_out"), "with the whole configuration applied nothing is pending", b)
    st, b = admin.post(f"{R}/show", {"command": "mock pending on"})
    check(st == 200, "mock: a card missing at boot left part of the configuration out", b)
    try:
        wait_for(lambda: (lambda s: (s.get("configuration") == "not-serving", s))(status()), "a pending configuration shows in the fleet status", timeout=20)
        st, b = admin.get(f"{R}/screens/pending-configuration")
        check(st == 200 and b["pending"] and b["cards"] == ["wan9"] and "interface wan9" in b["left_out"] and b["since"] and b["path"],
              "GetPendingConfiguration names the missing card, the statements left out and since when", b)
        st, b = admin.post(f"{R}/config/save")
        check(st == 409 and "pending" in errmsg(b), "save is refused while part of the configuration is pending, in the box's words", b)
        st, b = admin.post(f"{R}/clear", {"target": "configuration_pending"})
        check(st == 200 and "clear configuration pending" in json.dumps(b), "clear configuration pending gives the statements up", b)
    finally:
        admin.post(f"{R}/show", {"command": "mock pending off"})
    wait_for(lambda: (lambda s: (s.get("configuration") == "serving", s))(status()), "SERVING again once they are given up", timeout=20)
    st, b = admin.get(f"{R}/screens/pending-configuration")
    check(st == 200 and not b.get("pending"), "and nothing is pending", b)


def screen_checks(admin, R, router_id):
    """The rest of the screens and the probes (Prisma 0.150.6, #64)."""
    for name, key in [("ospf-interfaces", "interfaces"), ("isis-interfaces", "circuits"), ("hardware", "nics"), ("routing-logging", "daemons")]:
        st, b = admin.get(f"{R}/screens/{name}")
        check(st == 200 and b.get(key) and b.get("text"), f"the {name} screen answers its fields and the router's screen", b)
    st, b = admin.get(f"{R}/screens/ospf-interfaces")
    check(any(i["mtu_stall"] for i in b["interfaces"]), "an OSPF interface whose MTU differs from the dataplane's is marked", b["interfaces"])
    for kind, name in [("mib", "PRISMA-MIB.txt"), ("zabbix", "prisma-zabbix-7.0.yaml")]:
        req = urllib.request.Request(admin.base + "/api" + f"{R}/snmp-file?kind={kind}")
        with admin.opener.open(req, timeout=20) as r:
            body = r.read().decode()
            check(r.status == 200 and name in r.headers.get("Content-Disposition", "") and "67033" in body,
                  f"the {kind} file downloads under the box's name, with its enterprise number", r.headers.get("Content-Disposition"))
    st, evs = sse(admin, f"{R}/probe/ping", {"host": "192.0.2.1", "count": 3})
    probes = [json.loads(d) for e, d in evs if e == "probe"] if st == 200 else []
    replies = [p for p in probes if p.get("reply")]
    ends = [p for p in probes if p.get("end")]
    check(len(replies) == 3 and ends and ends[0]["end"]["received"] == 3 and evs[-1][0] == "end", "a ping streams each reply, then its summary", probes[-2:] or evs)
    for tool, part in [("traceroute", "hop"), ("mtr", "mtr_hop")]:
        st, evs = sse(admin, f"{R}/probe/{tool}", {"host": "192.0.2.1", "count": 1})
        check(st == 200 and any(json.loads(d).get(part) for e, d in evs if e == "probe"), f"{tool} streams its hops", evs[-3:] if isinstance(evs, list) else evs)
    st, b = sse(admin, f"{R}/probe/ping", {"host": "bad;host"})
    check(st >= 400 and "Unknown host" in errmsg(b), "a host the box refuses is answered in its words", b)
    st, audit = admin.get(f"/audit?router_id={router_id}&action=router.command&limit=10")
    check(any(e["details"].get("command") == "ping 192.0.2.1" for e in audit["items"]), "each probe is recorded as a console command", audit["items"][:2])


def log_export_checks(admin, router_id):
    """CGNAT log export (Prisma 0.149.15, #34) on prisma-mock-2, which has all three streams."""
    R = f"/routers/{router_id}"
    st, lg = admin.get(f"{R}/logging")
    kinds = [s["kind"] for s in (lg or {}).get("streams", [])]
    check(st == 200 and kinds == ["syslog", "ipfix-tcp", "ipfix-udp"] and all(s["configured"] and s["delivering"] for s in lg["streams"]),
          "GetLogging lists the three streams, configured and delivering", lg)
    status = lambda: next(x for x in admin.get("/routers/status")[1] if x["id"] == router_id)
    wait_for(lambda: (lambda s: (s.get("log_export") == "serving", s))(status()), "fleet status carries the log export's health (SERVING)")
    st, b = admin.post(f"{R}/show", {"command": "mock log-export stall"})
    check(st == 200, "mock: the syslog collector stops taking anything", b)
    try:
        s = wait_for(lambda: (lambda s: (s.get("log_export") == "not-serving", s))(status()), "a stalled log export shows in the fleet status", timeout=20)
        check(s["online"] and s.get("health") == "serving", "a stalled log export does not make the router offline or not serving", s)
        lg = wait_for(lambda: (lambda b: (any(e["kind"] == "log-stalled" for e in b.get("events", [])), b))(admin.get(f"{R}/logging")[1]),
                      "the log-stalled event reaches the router's log events", timeout=20)
        sy = lg["streams"][0]
        check(not sy["delivering"] and sy["stalled_reason"] and sy["connection"] == "disconnected", "the syslog stream reads stalled, with the reason", sy)
        st, audit = admin.get(f"/audit?router_id={router_id}&action=box.log&limit=5")
        check(st == 200 and not audit["items"], "log export events stay out of the change log", audit)
    finally:
        admin.post(f"{R}/show", {"command": "mock log-export deliver"})
    wait_for(lambda: (lambda s: (s.get("log_export") == "serving", s))(status()), "SERVING again once the collector takes the backlog", timeout=20)


def health_checks(admin, router_id):
    """grpc.health.v1 in the monitor (#29); the mock's stats-segment hook stands in for a stuck dataplane."""
    status = lambda: next(x for x in admin.get("/routers/status")[1] if x["id"] == router_id)
    wait_for(lambda: (lambda s: (s.get("health") == "serving", s))(status()), "fleet status carries the health check (SERVING)")
    st, b = admin.post(f"/routers/{router_id}/show", {"command": "mock stats-segment down"})
    check(st == 200, "mock: dataplane statistics taken down", b)
    try:
        s = wait_for(lambda: (lambda s: (s.get("health") == "not-serving", s))(status()), "NOT_SERVING is reported as not serving", timeout=20)
        check("NOT_SERVING" in (s.get("error") or ""), "a NOT_SERVING router says why, not just offline", s)
    finally:
        admin.post(f"/routers/{router_id}/show", {"command": "mock stats-segment up"})
    wait_for(lambda: (lambda s: (s.get("health") == "serving" and s["online"], s))(status()), "SERVING again once the statistics answer", timeout=20)


def access_checks(admin, args):
    """Per-router access (#6): two routers, a viewer raised on one and hidden from the other."""
    sfx = uuid.uuid4().hex[:6]
    made_routers, made_user = [], None
    try:
        for n in ("a", "b"):
            st, r = admin.post("/routers", {"name": f"e2e-acc-{n}-{sfx}", "api_url": args.mock})
            check(st == 201, f"router {n} for the access checks", r)
            made_routers.append(r["id"])
        ra, rb = made_routers
        name, pw = f"e2e-acc-{sfx}", uuid.uuid4().hex
        st, u = admin.post("/users", {"username": name, "password": pw, "role": "viewer"})
        check(st == 201, "a viewer for the access checks", u)
        made_user = u["id"]
        v = Client(args.base)
        v.post("/auth/login", {"username": name, "password": pw})

        st, b = v.post(f"/routers/{ra}/config/candidates")
        check(st == 403, "with no grant the global role applies: a viewer cannot open a change", b)
        st, b = v.post(f"/routers/{ra}/clear", {"target": "interface_counters"})
        check(st == 403, "nor clear anything on the router (#48)", b)
        st, b = sse(v, f"/routers/{ra}/logging/watch?seconds=3")
        check(st == 403, "nor watch the CGNAT log, which says who had which address (#49)", b)
        st, b = v.get(f"/routers/{ra}/cgnat/translation?address=203.0.113.70&port=8443")
        check(st == 403, "nor look up who used a public address (#63)", b)
        st, b = v.get(f"/routers/{ra}/cgnat/top")
        check(st == 200, "but reads the other CGNAT screens", b)
        st, b = sse(v, f"/routers/{ra}/probe/ping", {"host": "192.0.2.1", "count": 1})
        check(st == 403, "nor run a probe from the router (#64)", b)
        st, b = admin.put(f"/users/{made_user}/access/{ra}", {"role": "operator"})
        check(st == 204, "admin raises the viewer to operator on router a", b)
        st, b = admin.put(f"/users/{made_user}/access/{rb}", {"role": "none"})
        check(st == 204, "admin hides router b from the viewer", b)

        listed = {r["id"]: r for r in v.get("/routers")[1]}
        check(ra in listed and rb not in listed and listed[ra]["my_role"] == "operator",
              "the router list shows a with the raised role and leaves b out", list(listed.values()))
        status_ids = {r["id"] for r in v.get("/routers/status")[1]}
        check(ra in status_ids and rb not in status_ids, "the fleet status leaves the hidden router out")
        st, b = v.get(f"/routers/{rb}/system")
        check(st == 404, "a hidden router answers as if it did not exist", b)
        st, c = v.post(f"/routers/{ra}/config/candidates")
        check(st == 200, "raised to operator on router a, the viewer opens a change there", c)
        st, b = v.post(f"/routers/{ra}/system/reboot", {"confirm": "e2e"})
        check(st == 403, "an operator may not reboot the router: an administrator's (#50)", b)
        v.delete(f"/routers/{ra}/config/candidates/{c['candidate_id']}")
        st, b = v.patch(f"/routers/{ra}", {"description": "nope"})
        check(st == 403, "a per-router grant never gives the router's registration", b)

        st, acc = admin.get(f"/users/{made_user}/access")
        roles = {x["router_id"]: x["role"] for x in acc}
        check(roles.get(ra) == "operator" and roles.get(rb) == "none", "the user's access is listed per router", acc)
        st, b = admin.put(f"/users/{made_user}/access/{ra}", {"role": None})
        check(st == 204, "admin revokes the grant on router a", b)
        st, b = v.post(f"/routers/{ra}/config/candidates")
        check(st == 403, "after the revoke the global role applies again", b)
        st, log = admin.get(f"/audit?action=user.access&limit=10")
        mine = [e for e in log["items"] if e["target"] == name]
        check({"user.access.grant", "user.access.revoke"} <= {e["action"] for e in mine},
              "the change log records granting and revoking access", mine)
        st, b = admin.put(f"/users/{admin.get('/auth/me')[1]['id']}/access/{ra}", {"role": "none"})
        check(st == 422, "a global administrator cannot be limited per router", b)
    finally:
        if made_user:
            admin.delete(f"/users/{made_user}")
        for rid in made_routers:
            admin.delete(f"/routers/{rid}")


def read_only_checks(admin, args):
    """A certificate the box maps to a read-only login (#28): shown, and refused by the back itself."""
    st, r = admin.post("/routers", {"name": f"e2e-ro-{uuid.uuid4().hex[:6]}", "api_url": args.tls_mock, "tls_profile": "dev/readonly", "tls_server_name": args.server_name})
    check(st == 201, "router registered with a read-only certificate", r)
    try:
        f = wait_for(
            lambda: (lambda s: (bool(s) and s[0]["online"] and s[0].get("access") is not None, s))(
                [x for x in admin.get("/routers/status")[1] if x["id"] == r["id"]]
            ),
            "fleet status carries the account's role",
        )[0]
        a = f["access"]
        check(a["account"] == "noc" and a["role"] == "read-only" and not a["can_configure"], f"role of the read-only certificate ({a['account']}: {a['role']})", a)
        st, b = admin.post(f"/routers/{r['id']}/config/candidates")
        check(st == 403 and b["error"]["code"] == "router_read_only" and "read-only" in b["error"]["message"],
              "the back refuses a candidate for a read-only account before asking the box", b)
    finally:
        admin.delete(f"/routers/{r['id']}")


def cgnat_operator_checks(admin, args):
    """A certificate the box maps to a cgnat-operator (#41): it changes nat > cgnat and nothing else."""
    st, r = admin.post("/routers", {"name": f"e2e-cg-{uuid.uuid4().hex[:6]}", "api_url": args.tls_mock, "tls_profile": "dev/cgnat", "tls_server_name": args.server_name})
    check(st == 201, "router registered with a cgnat-operator certificate", r)
    try:
        f = wait_for(
            lambda: (lambda s: (bool(s) and s[0]["online"] and s[0].get("access") is not None, s))(
                [x for x in admin.get("/routers/status")[1] if x["id"] == r["id"]]
            ),
            "fleet status carries the cgnat-operator's role",
        )[0]
        a = f["access"]
        check(a["role"] == "cgnat-operator" and not a["can_configure"] and a["can_configure_cgnat"], f"role of the CGNAT certificate ({a['account']}: {a['role']})", a)
        R = f"/routers/{r['id']}/config/candidates"
        st, c = admin.post(R)
        check(st == 200, "a cgnat-operator opens a candidate", c)
        C = f"{R}/{c['candidate_id']}"
        st, b = admin.post(f"{C}/edit", {"path": ["nat", "cgnat", "pool RFC6598"], "lines": ["max-blocks 4"]})
        check(st == 200, "a cgnat-operator changes a pool", b)
        st, b = admin.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["mtu 9000"]})
        check(st == 403 and b["error"]["code"] == "router_forbidden" and "cgnat-operator" in b["error"]["message"],
              "the box refuses a cgnat-operator's change outside nat > cgnat", b)
        admin.delete(C)
    finally:
        admin.delete(f"/routers/{r['id']}")


def commit_lines(admin, R, edits, comment, **acks):
    """One candidate with the edits, checked and committed; returns the check and the commit's answer."""
    st, c = admin.post(f"{R}/config/candidates")
    C = f"{R}/config/candidates/{c['candidate_id']}"
    for path, lines in edits:
        st, b = admin.post(f"{C}/edit", {"path": path, "lines": lines})
        check(st == 200, f"edit {' > '.join(path)}: {' ; '.join(lines)}", b)
    st, chk = admin.post(f"{C}/check")
    st, b = admin.post(f"{C}/commit", {"comment": comment, **acks})
    if st != 200:
        admin.delete(C)
    return chk, st, b


def box_log_checks(admin, R):
    """`show log` and why each start (Prisma 0.151.14, #75), on the mock that reports 0.151.14."""
    st, b = admin.get(f"{R}/events")
    kinds = [e["kind"] for e in (b or {}).get("events", [])]
    check(st == 200 and "boot" in kinds and b.get("text"), "ListEvents answers the box's record, the boot in it, and show log's screen", kinds[:5])
    commits = [e for e in b["events"] if e["kind"] == "commit"]
    check(commits and commits[-1]["source"] == "api" and commits[-1]["origin"] == "the API" and commits[-1]["account"] and commits[-1]["time"],
          "a commit through the API is in it, with its account, origin and time", commits[-1:])
    st, b = admin.get(f"{R}/events?last=1")
    check(st == 200 and len(b["events"]) == 1 and b["events"][0]["kind"] == kinds[-1], "last=1 is the newest one", b["events"])
    st, b = admin.get(f"{R}/events?source=api&since=1h")
    check(st == 200 and b["events"] and all(e["source"] == "api" for e in b["events"]), "source and since filter it", len(b.get("events", [])))
    st, b = admin.get(f"{R}/events?since=yesterday")
    check(st == 422 and "is not a time" in errmsg(b), "a since the box does not take is refused, in its words", b)
    st, sy = admin.get(f"{R}/system")
    check(st == 200 and sy.get("control_plane_start_cause") == "boot", "GetSystem says why the routing daemons last started", sy.get("control_plane_start_cause"))
    for cause, restarted in [("unexpected", True), ("operator", True), ("boot", True)]:
        st, b = admin.post(f"{R}/show", {"command": f"mock dataplane-start {cause}"})
        st, sy = admin.get(f"{R}/system")
        check(sy.get("dataplane_start_cause") == cause and sy.get("dataplane_restarted") == restarted,
              f"mock: a dataplane start for {cause} reads as dataplane_start_cause {cause}", {k: sy.get(k) for k in ("dataplane_start_cause", "dataplane_restarted")})
    st, b = admin.get(f"{R}/events?source=dataplane&last=3")
    causes = [e["cause"] for e in b["events"] if e["kind"] == "start"]
    check(causes[-3:] == ["unexpected", "operator", "boot"] and b["events"][-3]["severity"] == "warning",
          "each start is in the log with its cause, an unexpected one a warning", causes)


def edit_words_checks(admin, R, router_id):
    """`replace pattern` and `rename` (Prisma 0.151.13, #74), on the mock that reports 0.151.13."""
    s = next(x for x in admin.get("/routers/status")[1] if x["id"] == router_id)
    check((s.get("version") or {}).get("release", "").startswith("0.151.14"), "the main mock reports 0.151.14 (replace and rename since 0.151.13)", s.get("version"))
    st, c = admin.post(f"{R}/config/candidates")
    C = f"{R}/config/candidates/{c['candidate_id']}"
    try:
        st, b = admin.post(f"{C}/edit", {"path": [], "lines": ["ip prefix-list E2E-RN seq 10 permit 100.81.0.0/22"]})
        st, b = admin.post(f"{C}/edit", {"path": ["nat", "cgnat", "pool E2E-RN"],
                                         "lines": ["prefix-list-inside E2E-RN", "prefix-outside 198.51.100.112/28", "block-size 512"]})
        check(st == 200, "a pool on a list in the candidate", b)
        at = ["nat", "cgnat", "pool E2E-RN"]
        st, b = admin.post(f"{C}/edit", {"path": at, "lines": ['replace pattern "block-size 512" with "block-size 1024" | compare']})
        st2, t = admin.get(C)
        check(st == 200 and "+ block-size 1024" in b["output"] and "block-size 512" in t["text"],
              "replace with | compare answers the difference and stages nothing", b)
        st, b = admin.post(f"{C}/edit", {"path": at, "lines": ['replace pattern "block-size (\\d+)" with "block-size 2\\1"']})
        st2, t = admin.get(C)
        check(st == 200 and "block-size 2512" in t["text"], "replace stages it, a group in the replacement", (b, t["text"][-400:]))
        st, b = admin.post(f"{C}/edit", {"path": [], "lines": ["rename ip prefix-list E2E-RN to E2E-RN2"]})
        st2, t = admin.get(C)
        check(st == 200 and "ip prefix-list E2E-RN2 seq 10" in t["text"] and "prefix-list-inside E2E-RN2" in t["text"],
              "rename renames the list and the pool's reference to it", b)
        st, b = admin.post(f"{C}/edit", {"path": at, "lines": ['replace pattern "x*" with "y"']})
        check(st >= 400 and "empty string" in errmsg(b), "a pattern that matches an empty string is refused, in the box's words", b)
        st, b = admin.post(f"{C}/edit", {"path": [], "lines": [f"rename nat cgnat pool E2E-RN to {'RFC6598'}"]})
        check(st >= 400 and "exists" in errmsg(b), "a rename to a name taken is refused", b)
    finally:
        admin.delete(C)


def pool_list_checks(admin, R):
    """A CGNAT pool's sides as prefix-lists (Prisma 0.151.12, #73), on the mock."""
    lists = ['ip prefix-list E2E-SUBS seq 5 deny 100.80.1.0/24 description "management"', "ip prefix-list E2E-SUBS seq 10 permit 100.80.0.0/22",
             "ip prefix-list E2E-PUB seq 10 permit 198.51.100.64/28"]
    pool = ["nat", "cgnat", "pool E2E-LISTS"]
    st, g = admin.get(f"{R}/config/grammar")
    pm = next((m for m in g["modes"] if m["key"] == "nat > cgnat > pool <name>"), None)
    check(pm and any(s["syntax"].startswith("prefix-list-inside") for gr in pm["groups"] for s in gr["statements"]),
          "the grammar has prefix-list-inside under a CGNAT pool", None)
    chk, st, b = commit_lines(admin, R, [([], lists), (pool, ["prefix-list-inside E2E-SUBS", "prefix-list-outside E2E-PUB", "block-size 512"])], "e2e: pool on lists")
    check(st == 200, "a pool given by an inside and an outside prefix-list commits", b)
    try:
        st, ps = admin.get(f"{R}/pools")
        p = next((x for x in ps["pools"] if x["name"] == "E2E-LISTS"), {})
        check(p.get("prefix_list_inside") == "E2E-SUBS" and p.get("prefix_list_outside") == "E2E-PUB"
              and p.get("prefixes_inside") == ["100.80.0.0/24", "100.80.2.0/23"] and p.get("untranslated") == ["100.80.1.0/24"]
              and p.get("prefixes_outside") == ["198.51.100.64/28"] and p.get("capacity", 0) > 0,
              "ListPools names the lists and what they resolve to: permits less denies, the denied source untranslated", p)
        st, t = admin.get(f"{R}/config/typed?areas=pools")
        tp = next((x for x in t["pools"] if x["name"] == "E2E-LISTS"), {})
        check(tp.get("prefix_list_inside") == "E2E-SUBS" and tp.get("prefix_list_outside") == "E2E-PUB" and not tp.get("prefix_inside"),
              "GetConfig reads the pool's sides as lists, no typed prefixes", tp)
        st, tree = admin.get(f"{R}/config/tree")
        lines = {l["text"]: l for i in tree["instances"] for l in i["lines"]}
        check(all(lines.get(x, {}).get("statement") for x in lists + ["prefix-list-inside E2E-SUBS"]),
              "each list entry, its description included, and the pool's list line match a statement",
              [x for x in lists + ["prefix-list-inside E2E-SUBS"] if not lines.get(x, {}).get("statement")])
        chk, st, b = commit_lines(admin, R, [(pool, ["prefix-inside 10.0.0.0/8"])], "e2e: both ways")
        check(st == 409 and "prefix-inside and prefix-list-inside both given" in errmsg(b) and not chk["passed"],
              "a side given both ways is refused at the check and the commit, naming the pool and the side", b)
        chk, st, b = commit_lines(admin, R, [(pool, ["prefix-list-outside E2E-NONE"])], "e2e: no such list")
        check(st == 409 and "'E2E-NONE' does not exist" in errmsg(b), "a list that does not exist is refused at commit", b)
        chk, st, b = commit_lines(admin, R, [([], ["ip prefix-list E2E-PUB seq 10 permit 198.51.100.80/28"])], "e2e: the list moves", acknowledge_remap=True)
        check(st == 200 and any("E2E-LISTS" in r for r in chk.get("remap", [])), "a change to a list re-maps the pools using it (the remap gate)", chk)
    finally:
        commit_lines(admin, R, [(["nat", "cgnat"], ["no pool E2E-LISTS"]), ([], ["no ip prefix-list E2E-SUBS", "no ip prefix-list E2E-PUB"])],
                     "e2e: undo pool on lists", acknowledge_remap=True)


def cgnat_forms_checks(admin, R):
    """CGNAT forms (#41): a pool created, changed and removed; a collector set, reflected by GetLogging, disabled."""
    revisions = lambda: len(admin.get(f"{R}/config/revisions")[1]["revisions"])
    before = revisions()
    try:
        pools = lambda: [p["name"] for p in admin.get(f"{R}/pools")[1]["pools"]]
        tcp = lambda: admin.get(f"{R}/logging")[1]["streams"][1]
        pool = ["nat", "cgnat", "pool E2E41"]
        chk, st, b = commit_lines(admin, R, [
            (pool, ["prefix-inside 10.41.0.0/16", "prefix-outside 198.51.100.0/28", "block-size 512", "max-blocks 4", "alg sip off"]),
            (["nat", "cgnat"], ["logging tcp 192.0.2.61 port 4740"]),
        ], "e2e: new pool and collector")
        check(st == 200 and not chk["remap"], "a new pool and an IPFIX collector commit without a gate", [chk, b])
        check(pools() == ["RFC6598", "E2E41"], "ListPools reports the new pool", pools())
        t = tcp()
        check(t["kind"] == "ipfix-tcp" and t["configured"] and t["collector"] == "192.0.2.61:4740",
              "GetLogging reflects the collector the configuration set", t)
        st, tree = admin.get(f"{R}/config/tree")
        inst = next((i for i in tree["instances"] if i["path"] == pool), None)
        check(inst and all(l["statement"] for l in inst["lines"]), "the new pool reads back as its statements", inst)

        chk, st, b = commit_lines(admin, R, [(pool, ["block-size 1024"])], "e2e: block size")
        check(st == 409 and any("E2E41" in x for x in chk["remap"]), "a new block size on the pool needs the remap acknowledged", [chk, b])
        chk, st, b = commit_lines(admin, R, [(pool, ["block-size 1024", "no prefix-outside 198.51.100.0/28", "prefix-outside 198.51.100.16/28"])],
                                  "e2e: block size", acknowledge_remap=True)
        check(st == 200, "acknowledged, the block size and prefixes change", b)
        p = next(x for x in admin.get(f"{R}/pools")[1]["pools"] if x["name"] == "E2E41")
        check(p["block_size"] == 1024 and p["prefixes_outside"] == ["198.51.100.16/28"], "the pool reports its new block size and prefix", p)

        chk, st, b = commit_lines(admin, R, [(["nat", "cgnat"], ["no pool E2E41", "logging tcp disable"])], "e2e: remove", acknowledge_remap=True)
        check(st == 200 and any("E2E41" in x for x in chk["remap"]), "removing the pool is gated as a remap and commits once acknowledged", [chk, b])
        check(pools() == ["RFC6598"], "the pool is gone", pools())
        check(not tcp()["configured"], "a disabled collector reads not configured", tcp())
    finally:
        # Back to the configuration before these commits, even when a check failed.
        made = revisions() - before
        if made:
            st, c = admin.post(f"{R}/config/candidates", {"from_revision": made})
            admin.post(f"{R}/config/candidates/{c['candidate_id']}/commit", {"comment": "e2e: undo CGNAT forms", "acknowledge_remap": True})
    st, running = admin.get(f"{R}/config/running")
    check(st == 200 and "logging tcp" not in running["text"] and "E2E41" not in running["text"], "configuration back to before the CGNAT checks", running)


def route_key(r):
    return (r["vrf"], r["prefix"], r["protocol"], r["distance"])


def route_checks(admin, R):
    """Typed route table (RouteService, #27) on the mock: paging, filters, summary."""
    st, summary = admin.get(R + "/routes/summary")
    counts = (summary or {}).get("counts", [])
    rib = {(c["vrf"], c["family"], c["protocol"]): c["rib"] for c in counts}
    check(st == 200 and {v for v, _, _ in rib} == {"default", "red"} and {f for _, f, _ in rib} == {4, 6}
          and {"bgp", "connected", "static", "ospf"} <= {p for _, _, p in rib},
          "GetRouteSummary counts per VRF, family and protocol", summary)
    check(all(0 <= c["fib"] <= c["rib"] for c in counts) and any(c["fib"] < c["rib"] for c in counts),
          "summary keeps RIB and FIB apart", counts)
    expected = sum(rib.values())

    st, first = admin.get(R + "/routes?page_size=5000")
    check(st == 200 and len(first["routes"]) == 5000 and first["next_page_token"] and first["snapshot_at"],
          "ListRoutes answers one page of 5000 with a next-page token", {k: first[k] for k in first if k != "routes"} if first else first)
    check(not first["total_known"], "the first page does not claim a total it has not read yet")
    seen, token, pages, last = [route_key(r) for r in first["routes"]], first["next_page_token"], 1, first
    while token:
        # page_size is per call, not part of the snapshot.
        st, last = admin.get(f"{R}/routes?page_size=5000&page_token={token}")
        check(st == 200 and last["snapshot_at"] == first["snapshot_at"], f"page {pages + 1} continues the same snapshot", last and {k: last[k] for k in last if k != "routes"})
        seen += [route_key(r) for r in last["routes"]]
        token, pages = last["next_page_token"], pages + 1
    check(pages >= 3 and last["total_known"] and last["total"] == len(seen) == expected,
          f"paging through {pages} pages reads the whole table once ({len(seen)} routes, as the summary counts)",
          {"pages": pages, "seen": len(seen), "total": last["total"], "summary": expected})
    check(len(set(seen)) == len(seen), "no route is paged twice")

    st, b = admin.get(R + "/routes?page_size=9000")
    check(st == 200 and len(b["routes"]) == 5000, "page_size is capped at 5000", len((b or {}).get("routes", [])))

    st, b = admin.get(R + "/routes?vrf=red&family=6&protocol=bgp&page_size=5000")
    check(st == 200 and b["routes"] and all((r["vrf"], r["family"], r["protocol"]) == ("red", 6, "bgp") for r in b["routes"])
          and len(b["routes"]) == rib[("red", 6, "bgp")], "filter by VRF, family and protocol matches the summary", b and len(b["routes"]))
    net = ipaddress.ip_network("23.0.0.0/16")
    st, b = admin.get(R + "/routes?prefix=23.0.0.0/16&page_size=5000")
    inside = (b or {}).get("routes", [])
    check(st == 200 and inside and all(ipaddress.ip_network(r["prefix"]).subnet_of(net) for r in inside),
          f"prefix filter lists the prefix and what is inside it ({len(inside)} routes)", b)
    st, b = admin.get(R + "/routes?prefix=23.0.0.0/16&selected=true&page_size=5000")
    sel = (b or {}).get("routes", [])
    check(st == 200 and sel and all(r["selected"] for r in sel) and len(sel) < len(inside),
          "selected-only drops the routes FRR did not select", [len(sel), len(inside)])

    st, b = admin.get(R + "/routes?family=5")
    check(st == 422, "an unknown family is refused", b)
    st, b = admin.get(R + "/routes?vrf=nope")
    check(st == 404, "an unknown VRF answers NOT_FOUND, as Prisma 0.149.4 does", b)
    st, b = admin.get(R + "/routes?page_token=999999.0")
    check(st == 409 and b["error"]["code"] == "router_refused", "a token of a dropped snapshot answers 409", b)
    st, _ = Client(admin.base).get(R + "/routes")
    check(st == 401, "the route table requires a session")


def lab(admin, args):
    """Real Prisma: read calls only. No candidate, commit or console."""
    st, b = tls_test(admin, args.lab, args.lab_profile, args.server_name)
    check(st == 200 and b.get("release"), f"mTLS with the real Prisma ({b.get('release') if st == 200 else '?'}), account {b.get('account') if st == 200 else '?'}", b)
    a = b.get("access") or {}
    check(a.get("role"), f"WhoAmI on the real Prisma: {a.get('account')} is {a.get('role')} (configure: {a.get('can_configure')}, CGNAT: {a.get('can_configure_cgnat')})", b)
    name = f"e2e-lab-{uuid.uuid4().hex[:6]}"
    registered_at = time.time()
    st, r = admin.post("/routers", {"name": name, "api_url": args.lab, "tls_profile": args.lab_profile, "tls_server_name": args.server_name})
    check(st == 201, "temporary registration of the real Prisma", r)
    R = f"/routers/{r['id']}"
    try:
        st_lab = wait_for(
            lambda: (lambda s: (bool(s) and s[0]["online"], s))([x for x in admin.get("/routers/status")[1] if x["id"] == r["id"]]),
            "real Prisma online in the fleet status",
        )[0]
        check(st_lab.get("health") == "serving", f"health check of the real Prisma: {st_lab.get('health')}", st_lab)
        st, lg = admin.get(R + "/logging")
        if st == 501:
            check(True, "GetLogging not on this box (before 0.149.15)")
        else:
            check(st == 200 and [s["kind"] for s in lg["streams"]] == ["syslog", "ipfix-tcp", "ipfix-udp"],
                  f"GetLogging of the real Prisma ({sum(s['configured'] for s in lg['streams'])} of 3 streams configured, log export {st_lab.get('log_export')})", lg)
        # Prisma 0.151.14 (#75): read only, the box's log and the start causes.
        st, ev = admin.get(R + "/events?last=20")
        if st == 501:
            check(True, "ListEvents not on this box (before 0.151.14)")
        else:
            check(st == 200 and isinstance(ev.get("events"), list), f"the real Prisma's log: {len(ev.get('events', []))} events", ev.get("text", "")[:200])
            st, sy = admin.get(R + "/system")
            check(st == 200, f"the real Prisma's start causes: dataplane '{sy.get('dataplane_start_cause')}', routing '{sy.get('control_plane_start_cause')}'", None)
        # Prisma 0.151.5 (#70): read only, the health and the screen.
        if st_lab.get("configuration"):
            st, pc = admin.get(R + "/screens/pending-configuration")
            check(st == 200 and (pc.get("pending") or False) == (st_lab["configuration"] == "not-serving"),
                  f"the real Prisma's pending configuration: {st_lab['configuration']}, {len((pc or {}).get('left_out') or [])} statements left out", pc)
        else:
            check(True, "prisma.v1.Configuration not in this box's health (before 0.151.5)")
        check(st_lab["version"]["hostname"] and st_lab["system"]["hostname"], f"real Prisma hostname filled in ({st_lab['version']['hostname']})", st_lab)
        for path, key in [("/interfaces", "interfaces"), ("/pools", "pools"), ("/bgp", "neighbors")]:
            st, b = admin.get(R + path)
            check(st == 200 and key in b, f"GET {path} answers", b)
        st, b = admin.get(R + "/interfaces")
        check(not any(i["name"].startswith("tap") for i in b["interfaces"]), "linux_cp tap* interfaces hidden")
        st, b = admin.get(R + "/config/running")
        check(st == 200 and "interface " in b["text"], "GetRunning from the real Prisma")
        st, g = admin.get(R + "/config/grammar")
        check(st == 200 and g["source"], f"the real Prisma's grammar source: {g['source']}", g.get("source"))
        st, t = admin.get(R + "/config/tree")
        lines = [l for i in (t or {}).get("instances", []) for l in i["lines"]]
        if g["source"].startswith("box"):
            # With the box's own grammar every operator line is a statement; only the box's lines stay read only (#45).
            mine = [l for l in lines if not l.get("owned")]
            check(all(l["statement"] for l in mine),
                  f"every operator line of the real Prisma matches its GetSchema ({len(mine)} lines, {len(lines) - len(mine)} box-owned)",
                  [l["text"] for l in mine if not l["statement"]])
        known = sum(1 for l in lines if l["statement"])
        check(st == 200 and lines and known / len(lines) >= 0.8,
              f"the real configuration reads as a structure: {known} of {len(lines)} lines match the grammar",
              [l["text"] for l in lines if not l["statement"]])
        lab_typed_checks(admin, R)
        # Third-party SFP+ modules (0.151.2, #69): read only.
        st, s = admin.get(f"{R}/system")
        if "unsupported_sfp_configured" in (s or {}) and s.get("hardware_text"):
            check(True, f"the real Prisma's SFP+ setting: configured {s['unsupported_sfp_configured']}, booted {s.get('unsupported_sfp_booted')} (known {s.get('unsupported_sfp_booted_known')})")
        else:
            check(True, "no SFP+ setting: a box before 0.151.2")
        # BFD as fields (0.150.12, #67): read only.
        st, b = admin.get(f"{R}/config/typed?areas=bfd")
        if st == 200:
            check(True, f"the real Prisma's BFD configuration as fields: {len(b.get('bfd_peers', []))} sessions, {len(b.get('bfd_profiles', []))} profiles")
        else:
            check(st in (422, 501), f"no typed BFD configuration: a box before 0.150.12 ({st})", b)
        # BFD (0.150.10, #66): the list and a short watch, reads only.
        st, b = admin.get(f"{R}/screens/bfd-sessions")
        if st == 501:
            check(True, "no typed BFD: a box before 0.150.10")
        else:
            check(st == 200 and b.get("answered") is not None, f"the real Prisma's BFD sessions: {len(b.get('sessions', []))} (answered {b.get('answered')})", b)
            st, evs = sse_until(admin, f"{R}/bfd/watch", lambda evs: len(evs) > 1, timeout=6)
            check(st == 200 and evs and evs[0][0] == "open" and not any(e == "error" for e, _ in evs),
                  f"a short BFD watch on the real Prisma opens at once: {[json.loads(d)['kind'] for e, d in evs if e == 'bfd'][:5]}", evs)
        # The 0.150.6 screens and SNMP files (#64): reads only; no probe from a real box.
        st, b = admin.get(f"{R}/screens/hardware")
        if st == 501:
            check(True, "no 0.150.6 screens: a box before 0.150.6")
        else:
            for name in ("ospf-interfaces", "isis-interfaces", "hardware", "routing-logging"):
                st, b = admin.get(f"{R}/screens/{name}")
                check(st == 200 and b.get("text") is not None, f"the real Prisma's {name} screen ({st})", b if st != 200 else None)
            for kind in ("mib", "zabbix"):
                req = urllib.request.Request(admin.base + "/api" + f"{R}/snmp-file?kind={kind}")
                try:
                    with admin.opener.open(req, timeout=30) as r:
                        check(r.status == 200 and r.read(), f"the real Prisma's {kind} file: {r.headers.get('Content-Disposition')}")
                except urllib.error.HTTPError as e:
                    check(e.code in (409, 422) and errmsg(json.loads(e.read() or b"{}")), f"the real Prisma could not make its {kind} file, in its words ({e.code})")
        # The typed show cgnat screens (0.150.3, #63): reads only; no translation lookup.
        st, b = admin.get(f"{R}/cgnat/drops")
        if st == 501:
            check(True, "no typed show cgnat screens: a box before 0.150.3")
        else:
            for name in ("top", "drops", "memory", "blocks", "identity", "history", "algs", "forwards", "ha"):
                st, b = admin.get(f"{R}/cgnat/{name}")
                check(st == 200 and b.get("text") is not None, f"the real Prisma's {name} screen ({st})", b if st != 200 else None)
        # WatchLogging only reads the box's observation ring: a 3 s watch, read-only (#49).
        if st_lab.get("system_service"):
            check(True, f"WhoAmI can_operate on the real Prisma: {(st_lab.get('access') or {}).get('can_operate')} (#51)")
            # GetUpgradeStatus and an upgrade check change nothing on the box (#50).
            st, last = admin.get(f"{R}/system/upgrade")
            check(st in (200, 403), f"GetUpgradeStatus on the real Prisma ({st}): {last.get('phase') if st == 200 else errmsg(last)}", last)
            st, evs = sse(admin, f"{R}/system/upgrade", {"version": ""})
            if st == 200:
                prog = [json.loads(d) for e, d in evs if e == "progress"]
                check(prog and prog[0]["phase"] in ("CHECKED", "FAILED"), f"an upgrade check on the real Prisma: {[(p['phase'], p['newest'] or p['message']) for p in prog]}", evs)
            else:
                check(st == 403 and errmsg(evs), f"the real Prisma refuses the upgrade check to prisma-web, in its words: {errmsg(evs)}", evs)
            st, evs = sse(admin, f"{R}/logging/watch?seconds=3")
            if st == 200:
                kinds = [json.loads(d)["kind"] for e, d in evs if e == "log"]
                check(kinds[:1] == ["STARTED"] and evs[-1][0] == "end", f"a 3 s live log watch on the real Prisma: {kinds[:6]}", evs[-3:])
            else:
                check(st in (403, 502, 409, 422) and errmsg(evs), f"the real Prisma refuses the live log with its words ({st}): {errmsg(evs)}", evs)
        else:
            check(True, "no SystemService health: a box before 0.149.25, no clears or live log offered")
        st, pol = admin.get(R + "/policies")
        st2, cnt = admin.get(R + "/policies/counters")
        check(st == 200 and st2 == 200, f"policies and counters of the real Prisma ({len(pol['policies'])} policies, {len(cnt['uses'])} uses)", [pol, cnt])
        st, b = admin.post(R + "/policies/test", {"policy": "E2E-NO-SUCH-POLICY", "prefix": "192.0.2.0/24"})
        check(st == 404, "TestPolicy of an unknown policy on the real Prisma answers NOT_FOUND", b)
        st, b = admin.get(R + "/routes?page_size=100")
        if st == 501:
            check(b["error"]["code"] == "router_unimplemented", "real Prisma without RouteService answers 501, the UI falls back to text", b)
        else:
            check(st == 200 and "routes" in b and b["snapshot_at"],
                  f"ListRoutes on the real Prisma ({len(b['routes'])} routes on the first page, total {b['total'] if b['total_known'] else 'not known yet'})", b)
            if b["next_page_token"]:
                st, b2 = admin.get(f"{R}/routes?page_size=100&page_token={b['next_page_token']}")
                check(st == 200 and b2["snapshot_at"] == b["snapshot_at"], f"second page of the real Prisma's snapshot ({len(b2['routes'])} routes)", b2)
            st, s_ = admin.get(R + "/routes/summary")
            check(st == 200 and "counts" in s_,
                  f"GetRouteSummary on the real Prisma ({sum(c['rib'] for c in s_['counts'])} routes in the RIB, {sum(c['fib'] for c in s_['counts'])} in the FIB)", s_)
        st, b = admin.get(R + "/system")
        check(st == 200 and b.get("boot_time") and b.get("last_boot_reason"),
              f"uptime breakdown of the real Prisma (last boot: {b.get('last_boot_reason')}, dataplane restarted: {b.get('dataplane_restarted')})", b)
        check(b.get("memory_total_bytes", 0) > 0 and len(b.get("worker_load") or []) == b.get("workers"),
              f"memory and worker load of the real Prisma ({b.get('memory_used_bytes', 0) >> 20} / {b.get('memory_total_bytes', 0) >> 20} MiB, "
              f"busy {', '.join(str(w['busy_ratio']) for w in b.get('worker_load') or [])})", b)
        st, b = admin.get(R + "/interfaces")
        check(all("speed_bps" in i for i in b["interfaces"]),
              "interfaces of the real Prisma carry speed_bps (" + ", ".join(f"{i['name']}={i.get('speed_bps')}" for i in b["interfaces"]) + ")", b)
        wait_for(
            lambda: (lambda b: (b["live"] and len(b["samples"]) >= 2, b))(
                admin.get(f"{R}/metrics/traffic?interface={b_if}&minutes=5")[1]
            ),
            "live telemetry from the real Prisma",
            timeout=40,
        ) if (b_if := next((i["name"] for i in admin.get(R + "/interfaces")[1]["interfaces"] if i["link_up"]), None)) else check(False, "no interface with link to measure")
        uptime = admin.get(R + "/system")[1].get("uptime_seconds") or 0
        if uptime < 600:
            # GetHistory does not survive a reboot: a box just up has no past to give.
            check(True, f"history check skipped: the box booted {uptime} s ago")
        else:
            check_backfill(admin, R, b_if, registered_at)
    finally:
        admin.delete(R)


def lab_typed_checks(admin, R):
    """Read-only typed reads of a real box (#46): GetConfig where it answers, the line fallback where it does not.
    No candidate is opened: SetConfig and DeleteConfig are never called on a real box."""
    st, t = admin.get(f"{R}/config/typed")
    if st == 501:
        check(t["error"]["code"] == "router_unimplemented", "real Prisma without GetConfig (before 0.149.20): 501, the forms keep the lines", t)
        return
    check(st == 200 and t["source"] == "running" and t["revision"], f"GetConfig on the real Prisma: revision {t.get('revision')}", t.get("revision"))
    st, run = admin.get(f"{R}/config/running")
    text = run["text"]
    names = [i["name"] for i in t["interfaces"]]
    check(names and all(f"interface {n}" in text for n in names), f"typed interfaces are the running configuration's ({', '.join(names)})", names)
    check([c["transport"] for c in t["logging"]["collectors"]] == ["udp", "tcp", "syslog"],
          f"typed log collectors: the three, in order ({sum(c['configured'] for c in t['logging']['collectors'])} configured)", t["logging"])
    check(all(f"pool {p['name']}" in text for p in t["pools"]), f"typed pools are the running configuration's ({len(t['pools'])})", [p["name"] for p in t["pools"]])
    st, rt = admin.get(f"{R}/config/typed?areas=static,bgp,ospf,ospf6,isis,interface_routing")
    if st == 501:
        check(rt["error"]["code"] == "router_unimplemented", "real Prisma without the typed routing areas (before 0.149.22): 501, the routing forms keep the lines", rt)
        return
    statics, bgp = rt["static_routes"], rt["bgp"]
    neighbors = [n for b in bgp for n in b["neighbors"]]
    check(st == 200, f"typed routing reads on the real Prisma: {len(statics)} static routes, {len(bgp)} BGP processes, {len(neighbors)} neighbors, "
          f"{len(rt['ospf'])}+{len(rt['ospf6'])} OSPF, {len(rt['isis'])} IS-IS, {len(rt['interface_routing'])} interfaces with IGP settings", None)
    check(all(r["prefix"] in text for r in statics if not r["vrf"]), "each top-level static route is in the running configuration", [r["line"] for r in statics])
    check(all(f"router bgp {b['asn']}" in text for b in bgp), "each router bgp is in the running configuration", [b["asn"] for b in bgp])
    check(all(f"neighbor {n['address']} " in text for n in neighbors), "each typed neighbor is in the running configuration", [n["address"] for n in neighbors])
    # A password is never read: no field carries one, whatever password_set says.
    secrets = [l for l in text.splitlines() if " password " in l and "<set, not shown>" not in l and "neighbor" in l]
    flat = json.dumps(rt)
    check(all(l.split(" password ", 1)[1].strip() not in flat for l in secrets), f"no BGP password in the typed read ({sum(n['password_set'] for n in neighbors)} set)")
    others = sum(len(b["other"]) + sum(len(f["other"]) for f in b["families"]) for b in bgp)
    check(True, f"read-only `other` statements kept per block: {others} in BGP")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("E2E_BASE", "http://[::1]"))
    ap.add_argument("--mock", default=os.environ.get("E2E_MOCK_URL", "http://prisma-mock:50051"))
    ap.add_argument("--tls-mock", default="https://prisma-mock-2:50051", help="mock with mTLS")
    ap.add_argument("--lines-mock", default="http://prisma-mock-lines:50051", help="mock without the typed configuration (MOCK_NO_TYPED)")
    ap.add_argument("--lab", help="real Prisma; runs only the read checks")
    ap.add_argument("--lab-profile", default="host/prisma-api")
    ap.add_argument("--server-name", default="prisma-api")
    args = ap.parse_args()
    user, password = os.environ.get("E2E_USER"), os.environ.get("E2E_PASSWORD")
    if not user or not password:
        sys.exit("set E2E_USER and E2E_PASSWORD (an administrator)")

    admin = Client(args.base)
    st, _ = admin.post("/auth/login", {"username": user, "password": password})
    check(st == 200, f"administrator login at {args.base}")

    if args.lab:
        lab(admin, args)
        print(f"\n{PASSED} checks passed (real Prisma, read-only)")
        return

    tls_checks(admin, args)
    access_checks(admin, args)

    suffix = uuid.uuid4().hex[:6]
    router_id = op_id = None
    try:
        # --- registration -----------------------------------------------------
        st, b = admin.post("/routers/test", {"api_url": "http://2001:db8::1:50051"})
        check(st == 422 and "brackets" in b["error"]["message"], "IPv6 without brackets is refused", b)
        st, b = admin.post("/routers/test", {"api_url": args.mock})
        check(st == 200 and b.get("release"), "connection test returns GetVersion", b)

        registered_at = time.time()
        st, b = admin.post("/routers", {"name": f"e2e-{suffix}", "api_url": args.mock})
        check(st == 201, "test router registered", b)
        router_id = b["id"]
        R = f"/routers/{router_id}"

        fleet = wait_for(
            lambda: (lambda s: (bool(s) and s[0]["online"], s))(
                [r for r in admin.get("/routers/status")[1] if r["id"] == router_id]
            ),
            "router shows online in the fleet status",
        )
        f = fleet[0]
        check(f["version"] and f["system"] and f["sessions"] is not None, "status carries GetVersion, GetSystem and GetSessionsSummary", f)
        health_checks(admin, router_id)
        config_model_checks(admin, R)
        routing_form_checks(admin, R)
        interface_form_checks(admin, R)
        typed_form_checks(admin, R)
        clear_checks(admin, R, router_id)
        log_watch_checks(admin, R, router_id)
        cgnat_screen_checks(admin, R, router_id)
        screen_checks(admin, R, router_id)
        sfp_checks(admin, R)
        bfd_checks(admin, R)
        pending_configuration_checks(admin, R, router_id)
        next_hop_checks(admin, R)
        pool_list_checks(admin, R)
        edit_words_checks(admin, R, router_id)
        box_log_checks(admin, R)
        line_fallback_checks(admin, args)
        st, lg = admin.get(f"{R}/logging")
        check(st == 200 and len(lg["streams"]) == 3 and not any(s["configured"] for s in lg["streams"]),
              "a box with no log export lists three unconfigured streams", lg)

        # --- telemetry ---------------------------------------------------------
        series = wait_for(
            lambda: (lambda b: (b["live"] and len(b["samples"]) >= 2, b))(
                admin.get(f"{R}/metrics/traffic?interface=wan0&minutes=5")[1]
            ),
            "live telemetry with at least 2 computed rates for wan0",
            timeout=40,
        )
        check(all(s["rx_bps"] >= 0 and s["tx_bps"] >= 0 for s in series["samples"]), "rates never negative")
        check_backfill(admin, R, "wan0", registered_at)

        # --- configuration flow ---------------------------------------------------
        st, running = admin.get(f"{R}/config/running")
        check(st == 200 and "interface lan0" in running["text"], "GetRunning returns the VTY text")

        st, revs0 = admin.get(f"{R}/config/revisions")
        n_revs0 = len(revs0["revisions"])

        st, c = admin.post(f"{R}/config/candidates")
        check(st == 200 and c["candidate_id"], "OpenCandidate", c)
        C = f"{R}/config/candidates/{c['candidate_id']}"

        st, b = admin.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["mtu 1000"]})
        items = (b or {}).get("error", {}).get("diagnostics", {}) or {}
        items = items.get("items", [])
        check(
            st == 422 and items and items[0]["line"] == "mtu 1000" and items[0]["path"] == ["interface lan0"],
            "VTY refusal arrives with path, line and message",
            b,
        )
        check(b["error"]["diagnostics"].get("reason") == "grammar", "the refusal carries its reason by name (Prisma 0.149.18)", b["error"]["diagnostics"])
        st, b = admin.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["mtu 9000"]})
        check(st == 200, "edit accepted", b)
        st, b = admin.post(f"{C}/edit", {"path": ["nat", "cgnat", "pool RFC6598"], "lines": ["block-size 512"]})
        check(st == 200, "edit on the CGNAT pool", b)

        st, cmp = admin.get(f"{C}/compare")
        check(st == 200 and cmp["changed"] and "mtu 9000" in cmp["diff"], "Compare shows the diff", cmp)
        st, chk = admin.post(f"{C}/check")
        check(st == 200 and chk["passed"] and chk["remap"], "Check passes and flags the remap gate", chk)

        # --- candidate ownership --------------------------------------------------
        op_name, op_pw = f"e2e-op-{suffix}", uuid.uuid4().hex
        st, b = admin.post("/users", {"username": op_name, "password": op_pw, "role": "operator"})
        check(st == 201, "creates the test operator", b)
        op_id = b["id"]
        op = Client(args.base)
        st, _ = op.post("/auth/login", {"username": op_name, "password": op_pw})
        check(st == 200, "operator login")
        st, b = op.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["mtu 1500"]})
        check(st == 409, "another user cannot touch someone else's candidate", b)

        # --- commit ------------------------------------------------------------
        st, b = admin.post(f"{C}/commit", {"comment": "e2e"})
        check(st == 409 and b["error"]["code"] == "router_refused", "commit without acknowledging the remap is refused", b)
        d = b["error"].get("diagnostics") or {}
        check(d.get("reason") == "gate_remap" and d.get("gate_items"), "the gate refusal names its gate and what it is about", d)
        st, b = admin.post(
            f"{C}/commit",
            {"comment": "e2e jumbo", "confirmed_minutes": 2, "acknowledge_remap": True},
        )
        check(st == 200 and b["revision"] and b["confirm_deadline"], "commit confirmed accepted with a deadline", b)
        web_revision = b["revision"]

        st, revs = admin.get(f"{R}/config/revisions")
        check(
            revs["revisions"][0]["comment"] == f"[prisma-web:{user}] e2e jumbo",
            "commit comment carries the web user",
            revs["revisions"][0],
        )
        st, p = admin.get(f"{R}/config/pending")
        check(p["pending"] and p["pending"]["can_confirm"] and p["pending"]["by"] == user, "pending commit visible to the author", p)
        check(p["pending"]["source"] == "box" and p["pending"]["deadline"] and p["pending"]["revision"],
              "the pending window is read from the box (GetPendingConfirm), with its deadline and revision", p)
        st, p_op = op.get(f"{R}/config/pending")
        check(p_op["pending"] and not p_op["pending"]["can_confirm"], "another operator cannot confirm", p_op)
        st, b = op.post(f"{R}/config/confirm")
        check(st == 409, "confirmation by another operator is refused", b)
        st, b = admin.post(f"{R}/config/confirm")
        check(st == 200, "author confirms", b)
        st, p = admin.get(f"{R}/config/pending")
        check(p["pending"] is None, "nothing pending after confirming", p)

        st, audit = admin.get(f"/audit?router_id={router_id}&limit=50")
        actions = [e["action"] for e in audit["items"]]
        commit = next((e for e in audit["items"] if e["action"] == "config.commit" and e["success"]), None)
        check(commit and "mtu 9000" in commit["details"]["diff"], "log keeps the commit diff", commit)
        check(any(e["action"] == "config.commit" and not e["success"] for e in audit["items"]), "log keeps the refused commit")
        check("config.confirm" in actions, "log keeps the confirmation", actions)
        # The box's commit event carries the revision (Prisma 0.149.2): matched, not logged twice (#30).
        time.sleep(2)
        st, audit = admin.get(f"/audit?router_id={router_id}&action=box.commit&limit=20")
        dup = [e for e in audit["items"] if (e.get("details") or {}).get("revision") == web_revision]
        check(not dup, f"the web commit's own event ({web_revision}) is not logged again as a change on the device", dup)

        # --- undo: back to the previous revision ---------------------------------------
        st, c2 = admin.post(f"{R}/config/candidates", {"from_revision": 1})
        C2 = f"{R}/config/candidates/{c2['candidate_id']}"
        st, b = admin.post(f"{C2}/commit", {"comment": "e2e: undo", "acknowledge_remap": True})
        check(st == 200, "rollback to the previous revision", b)
        st, running2 = admin.get(f"{R}/config/running")
        check("mtu 9000" not in running2["text"], "configuration is back to what it was", running2["revision"])
        st, revs2 = admin.get(f"{R}/config/revisions")
        check(len(revs2["revisions"]) == n_revs0 + 2, "two new revisions (commit and rollback)")

        cgnat_forms_checks(admin, R)

        # --- stale base: reopen and apply again (#10) ---------------------------------
        st, ca = admin.post(f"{R}/config/candidates")
        CA = f"{R}/config/candidates/{ca['candidate_id']}"
        admin.post(f"{CA}/edit", {"path": ["interface lan0"], "lines": ["description e2e mine"]})
        st, cb = admin.post(f"{R}/config/candidates")
        CB = f"{R}/config/candidates/{cb['candidate_id']}"
        admin.post(f"{CB}/edit", {"path": ["interface wg0"], "lines": ["description e2e theirs"]})
        st, b = admin.post(f"{CB}/commit", {"comment": "e2e: someone else"})
        check(st == 200, "another change lands first", b)
        st, b = admin.post(f"{CA}/commit", {"comment": "e2e: mine"})
        check(st == 409 and b["error"]["code"] == "candidate_stale" and "reopen" in b["error"]["message"],
              "a commit on a moved base answers candidate_stale and says to reopen", b)
        admin.delete(CA)
        st, cc = admin.post(f"{R}/config/candidates")
        CC = f"{R}/config/candidates/{cc['candidate_id']}"
        st, b = admin.post(f"{CC}/edit", {"path": ["interface lan0"], "lines": ["description e2e mine"]})
        st, cmp = admin.get(f"{CC}/compare")
        diff = cmp.get("diff", "")
        added = [l for l in diff.splitlines() if l.startswith("+")]
        removed = [l for l in diff.splitlines() if l.startswith("-")]
        check(st == 200 and any("description e2e mine" in l for l in added) and not any("e2e theirs" in l for l in removed),
              "re-applied on the new base, the diff adds my line and does not revert theirs", diff)
        admin.delete(CC)
        st, b = admin.post(f"{R}/config/candidates", {"from_revision": 1})
        st, b = admin.post(f"{R}/config/candidates/{b['candidate_id']}/commit", {"comment": "e2e: undo theirs"})
        check(st == 200, "the other change is undone", b)

        # --- console ---------------------------------------------------------------
        st, b = admin.post(f"{R}/show", {"command": "show bgp summary"})
        check(st == 200 and "Neighbor" in b["text"], "console runs show", b)
        st, b = admin.post(f"{R}/show", {"command": "configure terminal"})
        check(st == 422, "console refuses a configuration command", b)
        st, audit = admin.get(f"/audit?router_id={router_id}&action=router.command&limit=5")
        check(len(audit["items"]) >= 2, "console commands go to the log", audit)
        st, b = Client(args.base).post(f"{R}/show", {"command": "show version"})
        check(st == 401, "console requires a session")

        # Prisma 0.148.4/0.148.5: a long Show holds the account's operational
        # process, and the status monitor times out behind it (issue #14).
        import threading
        result = {}
        t = threading.Thread(
            target=lambda: result.update(r=admin.post(f"{R}/show", {"command": "ping 2001:db8:100::1 count 40"}))
        )
        t.start()
        seen = []
        for _ in range(11):
            time.sleep(1)
            s_ = next(x for x in admin.get("/routers/status")[1] if x["id"] == router_id)
            seen.append("busy" if s_.get("busy") else ("online" if s_["online"] else "OFFLINE"))
        t.join()
        check(result["r"][0] == 200, "long ping through the console finishes", result.get("r"))
        check("busy" in seen, "the monitor marks the router as busy during the command", seen)
        check("OFFLINE" not in seen, f"a long console command does not take the router offline ({', '.join(seen)})", seen)

        # --- operational -------------------------------------------------------------
        for path, key in [("/pools", "pools"), ("/bgp", "neighbors"), ("/interfaces", "interfaces")]:
            st, b = admin.get(R + path)
            check(st == 200 and b[key], f"GET {path} returns {key}", b)
        st, b = admin.get(R + "/system")
        check(st == 200 and b.get("boot_time") and b.get("dataplane_restarted") is False,
              "uptime breakdown present, no dataplane restart on the plain mock", b)
        # Memory, worker load and link speed in numbers (Prisma 0.149.2, #25).
        loads = b.get("worker_load") or []
        check(b.get("memory_total_bytes", 0) > 0 and 0 < b.get("memory_used_bytes", 0) <= b["memory_total_bytes"]
              and 0 < b.get("memory_hugepages_bytes", 0) <= b["memory_used_bytes"],
              "GetSystem carries memory in numbers, hugepages within the used", b)
        check(len(loads) == b["workers"] and all(0 <= w["busy_ratio"] <= 1 and "vectors_per_call" in w and "loops_per_second" in w for w in loads),
              f"GetSystem carries a WorkerLoad per worker ({', '.join(str(w['busy_ratio']) for w in loads)} busy)", b)
        st, b = admin.get(R + "/interfaces")
        speeds = {i["name"]: i.get("speed_bps") for i in b["interfaces"]}
        check(st == 200 and speeds.get("wan0") == 10_000_000_000 and speeds.get("lan0.20") == 4_294_967_295_000 and speeds.get("wg0") == 0,
              "interfaces carry speed_bps: 10G, VPP's unknown (4294967295000) and none", speeds)

        # --- routing policies (Prisma 0.148.12, #21) -------------------------------
        st, b = admin.get(R + "/policies")
        names = [p["name"] for p in (b or {}).get("policies", [])]
        check(st == 200 and "TRANSIT-IN" in names, "ListPolicies lists the policies with their terms", b)
        st, b = admin.get(R + "/policies/counters")
        uses = (b or {}).get("uses", [])
        check(st == 200 and any(not u["counted"] for u in uses), "counters keep 'no counter' apart from zero", b)
        check(any(not t["compiled"] for u in uses for t in u["terms"]), "counters mark a term not compiled at a use", b)
        st, b = admin.get(R + "/policies/counters?policy=NOPE")
        check(st == 404, "counters of an unknown policy answer NOT_FOUND", b)
        st, b = admin.post(R + "/policies/test", {"policy": "TRANSIT-IN", "prefix": "10.1.0.0/16", "attach_point": "import"})
        check(st == 200 and b["verdict"] == "reject" and b["decided_term"] == "bogons" and b["steps"],
              "TestPolicy: a bogon is rejected by term bogons", b)
        st, b = admin.post(R + "/policies/test", {"policy": "TRANSIT-IN", "prefix": "198.51.100.0/24",
                                                  "attributes": {"community": "65001:10"}})
        check(st == 200 and b["verdict"] == "accept" and b["route_after"].get("local-preference") == "200",
              "TestPolicy: a customer route is accepted and shows the route after the sets", b)
        st, b = admin.post(R + "/policies/test", {"policy": "NOPE", "prefix": "198.51.100.0/24"})
        check(st == 404 and "NOPE" in b["error"]["message"], "TestPolicy of an unknown policy answers NOT_FOUND", b)
        st, b = admin.post(R + "/policies/test", {"policy": "TRANSIT-IN", "prefix": "198.51.100.0/24", "attach_point": "nowhere"})
        check(st == 422, "TestPolicy at an unknown attach point answers INVALID_ARGUMENT", b)

        route_checks(admin, R)
        # Last: they leave the box in maintenance, where the monitor and telemetry leave it alone (#52).
        system_checks(admin, R, router_id)
    finally:
        if op_id:
            admin.delete(f"/users/{op_id}")
        if router_id:
            admin.delete(f"/routers/{router_id}")

    print(f"\n{PASSED} checks passed")


if __name__ == "__main__":
    main()
