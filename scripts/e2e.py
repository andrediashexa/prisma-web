#!/usr/bin/env python3
"""Teste de ponta a ponta do prisma-web contra a stack do docker compose.

Verifica pela API os critérios de aceitação da issue #3 (integração gRPC),
usando o prisma-mock como Prisma. Cria um roteador e um usuário próprios e os
remove ao final, e desfaz a alteração de configuração que aplica.

Uso:
    E2E_USER=admin E2E_PASSWORD=... scripts/e2e.py [--base http://[::1]]
    E2E_USER=admin E2E_PASSWORD=... scripts/e2e.py --lab https://192.0.2.166:50051 \
        --lab-profile host/prisma-api        # Prisma real: SÓ LEITURA, nenhum commit

Só usa a biblioteca padrão. Sai com código 1 na primeira verificação que falhar.
"""

import argparse
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

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
        print(f"FALHOU: {what}")
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


def tls_test(client, url, profile=None, server_name=None):
    body = {"api_url": url}
    if profile:
        body.update(tls_profile=profile, tls_server_name=server_name)
    return client.post("/routers/test", body)


def tls_checks(admin, args):
    """mTLS (issue #4): perfis, aceitação e cada forma de recusa."""
    st, profiles = admin.get("/routers/tls-profiles")
    ids = {p["id"]: p for p in profiles or []}
    check(st == 200 and ids.get("dev/mock", {}).get("account") == "prisma-web-dev", "perfis TLS listados com a conta (CN)", profiles)
    check("BEGIN" not in json.dumps(profiles), "listagem de perfis não expõe certificado nem chave")
    m = args.tls_mock
    st, b = tls_test(admin, m, "dev/mock", args.server_name)
    check(st == 200 and b["account"] == "prisma-web-dev", "mTLS com o perfil certo conecta e mostra a conta", b)
    st, b = tls_test(admin, m, "dev/outra-ca", args.server_name)
    check(st == 422 and "UnknownIssuer" in b["error"]["message"], "servidor de CA desconhecida é recusado", b)
    st, b = tls_test(admin, m, "dev/intruso", args.server_name)
    check(st == 422, "cliente de outra CA é recusado pelo servidor", b)
    st, b = tls_test(admin, m, "dev/mock", "errado")
    check(st == 422 and "errado" in b["error"]["message"], "nome do servidor errado é recusado", b)
    st, b = tls_test(admin, m.replace("https://", "http://"))
    check(st == 422, "servidor mTLS não aceita conexão sem TLS", b)
    st, b = tls_test(admin, m)
    check(st == 422 and "perfil" in b["error"]["message"], "https:// sem perfil é recusado", b)
    st, b = tls_test(admin, args.mock, "dev/mock", args.server_name)
    check(st == 422, "perfil com http:// é recusado", b)
    st, b = tls_test(admin, m, "../etc", args.server_name)
    check(st == 422 and "inválido" in b["error"]["message"], "perfil com ../ é recusado", b)


def lab(admin, args):
    """Prisma real: só chamadas de leitura. Nada de candidate, commit ou console."""
    st, b = tls_test(admin, args.lab, args.lab_profile, args.server_name)
    check(st == 200 and b.get("release"), f"mTLS com o Prisma real ({b.get('release') if st == 200 else '?'}), conta {b.get('account') if st == 200 else '?'}", b)
    name = f"e2e-lab-{uuid.uuid4().hex[:6]}"
    st, r = admin.post("/routers", {"name": name, "api_url": args.lab, "tls_profile": args.lab_profile, "tls_server_name": args.server_name})
    check(st == 201, "cadastro temporário do Prisma real", r)
    R = f"/routers/{r['id']}"
    try:
        st_lab = wait_for(
            lambda: (lambda s: (bool(s) and s[0]["online"], s))([x for x in admin.get("/routers/status")[1] if x["id"] == r["id"]]),
            "Prisma real online no status da frota",
        )[0]
        check(st_lab["version"]["hostname"] and st_lab["system"]["hostname"], f"hostname do Prisma real preenchido ({st_lab['version']['hostname']})", st_lab)
        for path, key in [("/interfaces", "interfaces"), ("/pools", "pools"), ("/bgp", "neighbors")]:
            st, b = admin.get(R + path)
            check(st == 200 and key in b, f"GET {path} responde", b)
        st, b = admin.get(R + "/interfaces")
        check(not any(i["name"].startswith("tap") for i in b["interfaces"]), "interfaces tap* do linux_cp escondidas")
        st, b = admin.get(R + "/config/running")
        check(st == 200 and "interface " in b["text"], "GetRunning do Prisma real")
        wait_for(
            lambda: (lambda b: (b["live"] and len(b["samples"]) >= 2, b))(
                admin.get(f"{R}/metrics/traffic?interface={b_if}&minutes=5")[1]
            ),
            "telemetria ao vivo do Prisma real",
            timeout=40,
        ) if (b_if := next((i["name"] for i in admin.get(R + "/interfaces")[1]["interfaces"] if i["link_up"]), None)) else check(False, "nenhuma interface com link para medir")
    finally:
        admin.delete(R)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("E2E_BASE", "http://[::1]"))
    ap.add_argument("--mock", default=os.environ.get("E2E_MOCK_URL", "http://prisma-mock:50051"))
    ap.add_argument("--tls-mock", default="https://prisma-mock-2:50051", help="mock com mTLS")
    ap.add_argument("--lab", help="Prisma real; roda só as verificações de leitura")
    ap.add_argument("--lab-profile", default="host/prisma-api")
    ap.add_argument("--server-name", default="prisma-api")
    args = ap.parse_args()
    user, password = os.environ.get("E2E_USER"), os.environ.get("E2E_PASSWORD")
    if not user or not password:
        sys.exit("defina E2E_USER e E2E_PASSWORD (um administrador)")

    admin = Client(args.base)
    st, _ = admin.post("/auth/login", {"username": user, "password": password})
    check(st == 200, f"login do administrador em {args.base}")

    if args.lab:
        lab(admin, args)
        print(f"\n{PASSED} verificações passaram (Prisma real, só leitura)")
        return

    tls_checks(admin, args)

    suffix = uuid.uuid4().hex[:6]
    router_id = op_id = None
    try:
        # --- cadastro ---------------------------------------------------------
        st, b = admin.post("/routers/test", {"api_url": "http://2001:db8::1:50051"})
        check(st == 422 and "colchetes" in b["error"]["message"], "IPv6 sem colchetes é recusado", b)
        st, b = admin.post("/routers/test", {"api_url": args.mock})
        check(st == 200 and b.get("release"), "teste de conexão devolve GetVersion", b)

        st, b = admin.post("/routers", {"name": f"e2e-{suffix}", "api_url": args.mock})
        check(st == 201, "cadastro do roteador de teste", b)
        router_id = b["id"]
        R = f"/routers/{router_id}"

        fleet = wait_for(
            lambda: (lambda s: (bool(s) and s[0]["online"], s))(
                [r for r in admin.get("/routers/status")[1] if r["id"] == router_id]
            ),
            "roteador aparece online no status da frota",
        )
        f = fleet[0]
        check(f["version"] and f["system"] and f["sessions"] is not None, "status traz GetVersion, GetSystem e GetSessionsSummary", f)

        # --- telemetria --------------------------------------------------------
        series = wait_for(
            lambda: (lambda b: (b["live"] and len(b["samples"]) >= 2, b))(
                admin.get(f"{R}/metrics/traffic?interface=wan0&minutes=5")[1]
            ),
            "telemetria ao vivo com ao menos 2 taxas calculadas para wan0",
            timeout=40,
        )
        check(all(s["rx_bps"] >= 0 and s["tx_bps"] >= 0 for s in series["samples"]), "taxas nunca negativas")

        # --- fluxo de configuração ------------------------------------------------
        st, running = admin.get(f"{R}/config/running")
        check(st == 200 and "interface lan0" in running["text"], "GetRunning devolve o texto do VTY")

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
            "recusa do VTY chega com caminho, linha e mensagem",
            b,
        )
        st, b = admin.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["mtu 9000"]})
        check(st == 200, "edit aceito", b)
        st, b = admin.post(f"{C}/edit", {"path": ["nat", "cgnat", "pool RFC6598"], "lines": ["block-size 512"]})
        check(st == 200, "edit no pool CGNAT", b)

        st, cmp = admin.get(f"{C}/compare")
        check(st == 200 and cmp["changed"] and "mtu 9000" in cmp["diff"], "Compare mostra o diff", cmp)
        st, chk = admin.post(f"{C}/check")
        check(st == 200 and chk["passed"] and chk["remap"], "Check aprova e acusa o portão remap", chk)

        # --- posse do candidate ---------------------------------------------------
        op_name, op_pw = f"e2e-op-{suffix}", uuid.uuid4().hex
        st, b = admin.post("/users", {"username": op_name, "password": op_pw, "role": "operator"})
        check(st == 201, "cria operador de teste", b)
        op_id = b["id"]
        op = Client(args.base)
        st, _ = op.post("/auth/login", {"username": op_name, "password": op_pw})
        check(st == 200, "login do operador")
        st, b = op.post(f"{C}/edit", {"path": ["interface lan0"], "lines": ["mtu 1500"]})
        check(st == 409, "outro usuário não mexe no candidate alheio", b)

        # --- commit ------------------------------------------------------------
        st, b = admin.post(f"{C}/commit", {"comment": "e2e"})
        check(st == 409 and b["error"]["code"] == "router_refused", "commit sem reconhecer o remap é recusado", b)
        st, b = admin.post(
            f"{C}/commit",
            {"comment": "e2e jumbo", "confirmed_minutes": 2, "acknowledge_remap": True},
        )
        check(st == 200 and b["revision"] and b["confirm_deadline"], "commit confirmed aceito com prazo", b)

        st, revs = admin.get(f"{R}/config/revisions")
        check(
            revs["revisions"][0]["comment"] == f"[prisma-web:{user}] e2e jumbo",
            "comentário do commit leva o usuário da web",
            revs["revisions"][0],
        )
        st, p = admin.get(f"{R}/config/pending")
        check(p["pending"] and p["pending"]["can_confirm"] and p["pending"]["by"] == user, "commit pendente visível para o autor", p)
        st, p_op = op.get(f"{R}/config/pending")
        check(p_op["pending"] and not p_op["pending"]["can_confirm"], "outro operador não pode confirmar", p_op)
        st, b = op.post(f"{R}/config/confirm")
        check(st == 409, "confirmação por outro operador é recusada", b)
        st, b = admin.post(f"{R}/config/confirm")
        check(st == 200, "autor confirma", b)
        st, p = admin.get(f"{R}/config/pending")
        check(p["pending"] is None, "nada mais pendente após confirmar", p)

        st, audit = admin.get(f"/audit?router_id={router_id}&limit=50")
        actions = [e["action"] for e in audit["items"]]
        commit = next((e for e in audit["items"] if e["action"] == "config.commit" and e["success"]), None)
        check(commit and "mtu 9000" in commit["details"]["diff"], "log guarda o diff do commit", commit)
        check(any(e["action"] == "config.commit" and not e["success"] for e in audit["items"]), "log guarda o commit recusado")
        check("config.confirm" in actions, "log guarda a confirmação", actions)

        # --- desfaz: volta à revisão anterior ------------------------------------------
        st, c2 = admin.post(f"{R}/config/candidates", {"from_revision": 1})
        C2 = f"{R}/config/candidates/{c2['candidate_id']}"
        st, b = admin.post(f"{C2}/commit", {"comment": "e2e: desfaz", "acknowledge_remap": True})
        check(st == 200, "rollback para a revisão anterior", b)
        st, running2 = admin.get(f"{R}/config/running")
        check("mtu 9000" not in running2["text"], "configuração voltou ao que era", running2["revision"])
        st, revs2 = admin.get(f"{R}/config/revisions")
        check(len(revs2["revisions"]) == n_revs0 + 2, "duas revisões novas (commit e rollback)")

        # --- console ---------------------------------------------------------------
        st, b = admin.post(f"{R}/show", {"command": "show bgp summary"})
        check(st == 200 and "Neighbor" in b["text"], "console executa show", b)
        st, b = admin.post(f"{R}/show", {"command": "configure terminal"})
        check(st == 422, "console recusa comando de configuração", b)
        st, audit = admin.get(f"/audit?router_id={router_id}&action=router.command&limit=5")
        check(len(audit["items"]) >= 2, "comandos do console vão para o log", audit)
        st, b = Client(args.base).post(f"{R}/show", {"command": "show version"})
        check(st == 401, "console exige sessão")

        # --- operacional -------------------------------------------------------------
        for path, key in [("/pools", "pools"), ("/bgp", "neighbors"), ("/interfaces", "interfaces")]:
            st, b = admin.get(R + path)
            check(st == 200 and b[key], f"GET {path} devolve {key}", b)
    finally:
        if op_id:
            admin.delete(f"/users/{op_id}")
        if router_id:
            admin.delete(f"/routers/{router_id}")

    print(f"\n{PASSED} verificações passaram")


if __name__ == "__main__":
    main()
