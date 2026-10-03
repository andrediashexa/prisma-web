#!/usr/bin/env python3
"""Extracts the VTY's configuration grammar from docs/prisma-api-coverage.md.

The coverage map is vendored from prismarouting, generated there from the
VTY's own grammar (#558). Its "Configuration: <area>" sections say how each
mode is entered (the EditRequest.path), who may change it, and every
statement's syntax. This writes them to back/crates/server/src/config_grammar.json,
which the back end embeds for the structured editor (#39) until the box
answers GetSchema.

    scripts/config-grammar.py          # regenerate
    scripts/config-grammar.py --check  # fail if the JSON is stale (check-docs runs it)
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs/prisma-api-coverage.md"
OUT = ROOT / "back/crates/server/src/config_grammar.json"


def parse(text):
    areas, cur = [], None
    for line in text.splitlines():
        m = re.match(r"^## Configuration: (.+)$", line)
        if m:
            cur = {"title": m.group(1), "path": None, "roles": [], "statements": []}
            areas.append(cur)
            continue
        if line.startswith("## "):
            cur = None
            continue
        if cur is None:
            continue
        m = re.match(r"^Entered with `([^`]*)`; `EditRequest.path` = `(\[.*\])`; changed by: ([^.]*)\.", line)
        if m:
            cur["entered_with"] = m.group(1)
            cur["path"] = m.group(2)
            cur["roles"] = [r.strip() for r in m.group(3).split(",") if r.strip()]
            continue
        m = re.match(r"^\| `(.+?)` \| ([a-z/]+) \| (.*?) \| (.*?) \|$", line)
        if m and m.group(2) != "n/a":
            cur["statements"].append({"syntax": m.group(1).replace("\\|", "|"), "class": m.group(2), "notes": m.group(4).strip()})
    # "..." in a path is the enclosing mode's path: the nearest earlier area whose
    # last path element is the mode the "Entered with" names before this one.
    for i, a in enumerate(areas):
        p = a["path"] or "[]"
        if not p.startswith("[..."):
            a["path"] = json.loads(p)
            continue
        tail = json.loads("[" + p.split(",", 1)[1]) if "," in p else []
        hops = [h.strip() for h in a["entered_with"].split(" > ")]
        before = hops[-2].split(" ")[0] if len(hops) >= 2 else ""
        parent = next((b["path"] for b in reversed(areas[:i]) if b["path"] and b["path"][-1].split(" ")[0] == before), None)
        if parent is None and tail:
            # "... > address-family: neighbor": statements of a mode already named; its own path.
            same = next((b["path"] for b in reversed(areas[:i]) if b["path"] and b["path"][-1] == tail[-1]), None)
            a["path"] = same or tail
        else:
            a["path"] = (parent or []) + tail
    return [a for a in areas if a["statements"]]


def main():
    areas = parse(SRC.read_text())
    out = json.dumps({"source": "docs/prisma-api-coverage.md", "areas": areas}, indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != out:
            sys.exit(f"{OUT.relative_to(ROOT)} is stale: run scripts/config-grammar.py")
        return
    OUT.write_text(out)
    n = sum(len(a["statements"]) for a in areas)
    print(f"{len(areas)} areas, {n} statements -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
