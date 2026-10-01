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
    finally:
        admin.delete(f"/routers/{r['id']}")
    read_only_checks(admin, args)
    st, b = tls_test(admin, m, "../etc", args.server_name)
    check(st == 422 and "invalid TLS profile" in b["error"]["message"], "profile with ../ is refused", b)


def candidate_expiry_checks(admin, R):
    """prisma-mock-2 closes a candidate idle for 15 s, as the box does after 30 min (#11)."""
    st, c = admin.post(f"{R}/config/candidates")
    check(st == 200, "candidate opened on the short-idle mock", c)
    C = f"{R}/config/candidates/{c['candidate_id']}"
    st, b = admin.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["description e2e idle"]})
    check(st == 200, "edit within the idle limit", b)
    time.sleep(17)
    st, b = admin.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["mtu 1400"]})
    check(st == 410 and b["error"]["code"] == "candidate_expired" and "idle" in b["error"]["message"],
          "a candidate Prisma closed for idleness answers candidate_expired with the reason, not 'not found'", b)
    st, b = admin.get(f"{C}/compare")
    check(st == 404, "the expired candidate is forgotten by the back", b)


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
        check(st_lab["version"]["hostname"] and st_lab["system"]["hostname"], f"real Prisma hostname filled in ({st_lab['version']['hostname']})", st_lab)
        for path, key in [("/interfaces", "interfaces"), ("/pools", "pools"), ("/bgp", "neighbors")]:
            st, b = admin.get(R + path)
            check(st == 200 and key in b, f"GET {path} answers", b)
        st, b = admin.get(R + "/interfaces")
        check(not any(i["name"].startswith("tap") for i in b["interfaces"]), "linux_cp tap* interfaces hidden")
        st, b = admin.get(R + "/config/running")
        check(st == 200 and "interface " in b["text"], "GetRunning from the real Prisma")
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
