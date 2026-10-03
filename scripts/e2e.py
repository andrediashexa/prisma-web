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
    finally:
        admin.delete(f"/routers/{r['id']}")
    read_only_checks(admin, args)
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
    check(st == 200 and n > 500 and {"config", "interface <name>", "nat > cgnat > pool <name>", "router bgp <asn>"} <= keys,
          f"the VTY's grammar is served mode by mode ({len(keys)} modes, {n} statements)", sorted(keys)[:10])
    st, t = admin.get(f"{R}/config/tree")
    inst = {i["mode"]: i for i in (t or {}).get("instances", [])}
    pool = inst.get("nat > cgnat > pool <name>")
    check(st == 200 and pool and pool["path"] == ["nat", "cgnat", "pool RFC6598"] and all(l["statement"] for l in pool["lines"]),
          "the running configuration reads as instances, each pool line matched to its statement", pool)
    lines = [l for i in t["instances"] for l in i["lines"]]
    known = sum(1 for l in lines if l["statement"])
    check(known >= len(lines) - 1, f"{known} of {len(lines)} configured lines match a statement of the grammar",
          [l["text"] for l in lines if not l["statement"]])
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
        (af4, ["neighbor 192.0.2.77 activate", "neighbor 192.0.2.77 route-map E2E-IN", "network 198.51.100.0/24",
               "aggregate-address 198.51.100.0/22 summary-only", "redistribute connected"]),
        (af6, ["neighbor 2001:db8:77::1 activate", "network 2001:db8:77::/48"]),
        (["router ospf"], ["network 10.77.0.0/16 area 0.0.0.1", "area 0.0.0.1", "passive-interface wan0",
                           "redistribute static metric 20 metric-type 1"]),
        (["router ospf6"], ["area 0", "redistribute connected route-map E2E"]),
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
        check(st_lab["version"]["hostname"] and st_lab["system"]["hostname"], f"real Prisma hostname filled in ({st_lab['version']['hostname']})", st_lab)
        for path, key in [("/interfaces", "interfaces"), ("/pools", "pools"), ("/bgp", "neighbors")]:
            st, b = admin.get(R + path)
            check(st == 200 and key in b, f"GET {path} answers", b)
        st, b = admin.get(R + "/interfaces")
        check(not any(i["name"].startswith("tap") for i in b["interfaces"]), "linux_cp tap* interfaces hidden")
        st, b = admin.get(R + "/config/running")
        check(st == 200 and "interface " in b["text"], "GetRunning from the real Prisma")
        st, t = admin.get(R + "/config/tree")
        lines = [l for i in (t or {}).get("instances", []) for l in i["lines"]]
        known = sum(1 for l in lines if l["statement"])
        check(st == 200 and lines and known / len(lines) >= 0.8,
              f"the real configuration reads as a structure: {known} of {len(lines)} lines match the grammar",
              [l["text"] for l in lines if not l["statement"]])
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("E2E_BASE", "http://[::1]"))
    ap.add_argument("--mock", default=os.environ.get("E2E_MOCK_URL", "http://prisma-mock:50051"))
    ap.add_argument("--tls-mock", default="https://prisma-mock-2:50051", help="mock with mTLS")
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

        # --- syslog disable guard (Prisma before 0.149.8, #31) ----------------------
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
    finally:
        if op_id:
            admin.delete(f"/users/{op_id}")
        if router_id:
            admin.delete(f"/routers/{router_id}")

    print(f"\n{PASSED} checks passed")


if __name__ == "__main__":
    main()
