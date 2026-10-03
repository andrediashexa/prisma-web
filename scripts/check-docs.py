#!/usr/bin/env python3
"""Checks the documentation rules of CONTRIBUTING.md.

- every tracked *.md opens with a TL;DR, answers 5W2H and cites RFC 2119 when
  it uses its keywords;
- no ASCII-art diagram (diagrams are Mermaid);
- *.md files and source comments are in English, except the paths named in the
  `language-exceptions` block of CONTRIBUTING.md;
- VERSION matches the Cargo and npm manifests and has major version 0;
- CHANGELOG headings read `## X.Y.Z - <name> — YYYY-MM-DD` and git tags `X.Y.Z`.

The language test is a heuristic: it compares function words of English and
Portuguese. It catches a text written in Portuguese; it does not catch a typo.

Usage: scripts/check-docs.py   (exits 1 when anything fails)
"""

import fnmatch
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RFC_WORDS = re.compile(r"\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|RECOMMENDED|OPTIONAL)\b")
EN = re.compile(r"\b(the|and|is|are|this|that|with|for|from|which|when|should|would|it)\b", re.I)
PT = re.compile(r"\b(de|que|não|para|com|uma|um|os|as|do|da|em|por|se|quando|é|são|está)\b", re.I)
ASCII_ART = re.compile(r"[┌┐└┘├┤┬┴│─]{2,}|\+-{3,}\+")

errors = []


def fail(path, msg):
    errors.append(f"{path}: {msg}")


def tracked(pattern):
    out = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", pattern],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [p for p in out.splitlines() if (ROOT / p).exists()]


def block(name):
    text = (ROOT / "CONTRIBUTING.md").read_text()
    m = re.search(rf"```text {name}\n(.*?)```", text, re.S)
    if not m:
        sys.exit(f"CONTRIBUTING.md: no `{name}` block")
    pats = [line.split("#")[0].strip() for line in m.group(1).splitlines()]
    return [p for p in pats if p]


EXC = block("language-exceptions")
GENERATED = block("generated-files")


def matches(path, pats):
    return any(fnmatch.fnmatch(path, p) or (p.endswith("/**") and path.startswith(p[:-2])) for p in pats)


def excepted(path):
    return matches(path, EXC) or matches(path, GENERATED)


def portuguese(text):
    en, pt = len(EN.findall(text)), len(PT.findall(text))
    return pt >= 8 and pt > en


def strip_code(md):
    return re.sub(r"```.*?```", "", md, flags=re.S)


# ---- *.md
for path in tracked("*.md"):
    if "node_modules/" in path or excepted(path):
        continue
    text = (ROOT / path).read_text()
    head = "\n".join(text.splitlines()[:12])
    if "TL;DR" not in head:
        fail(path, "does not open with a TL;DR (in its first lines)")
    if "5W2H" not in text:
        fail(path, "does not answer 5W2H")
    prose = strip_code(text)
    if RFC_WORDS.search(prose) and "2119" not in text:
        fail(path, "uses RFC 2119 keywords without citing RFC 2119")
    for block in re.findall(r"```(\w*)\n(.*?)```", text, re.S):
        if block[0] != "mermaid" and ASCII_ART.search(block[1]):
            fail(path, "ASCII-art diagram; use Mermaid")
    if portuguese(prose):
        fail(path, "looks like Portuguese (the project language is English)")

# ---- source comments
# In Rust/TS only // and /* */ are comments: `#` opens attributes (`#[derive]`).
LINE_COMMENT = re.compile(r"//[/!]?\s?(.*)$", re.M)
BLOCK_COMMENT = re.compile(r"/\*+(.*?)\*/", re.S)
for pattern in ("back/**/*.rs", "front/src/**/*.ts", "front/src/**/*.tsx", "scripts/*.py", "scripts/*.sh"):
    for path in tracked(pattern):
        if excepted(path):
            continue
        src = (ROOT / path).read_text()
        if path.endswith((".py", ".sh")):
            comments = re.findall(r"#\s?(.*)$", src, re.M) + re.findall(r'"""(.*?)"""', src, re.S)
        else:
            comments = LINE_COMMENT.findall(src) + BLOCK_COMMENT.findall(src)
        # URLs and tool directives inside comments are not prose.
        text = " ".join(c for c in comments if not c.strip().startswith(("http", "eslint", "@", "!")))
        if portuguese(text):
            fail(path, "comments look like Portuguese (the project language is English)")

# ---- versions
version = (ROOT / "VERSION").read_text().strip()
if not re.fullmatch(r"0\.\d+\.\d+", version):
    fail("VERSION", f"'{version}' is not 0.x.y (a major version is not allowed yet)")
cargo = re.search(r'\[workspace\.package\].*?^version\s*=\s*"([^"]+)"', (ROOT / "back/Cargo.toml").read_text(), re.S | re.M)
if not cargo or cargo.group(1) != version:
    fail("back/Cargo.toml", f"version {cargo and cargo.group(1)} != VERSION {version}")
npm = json.loads((ROOT / "front/package.json").read_text())["version"]
if npm != version:
    fail("front/package.json", f"version {npm} != VERSION {version}")

# ---- version format (CONTRIBUTING, section 5)
HEADING = re.compile(r"^## 0\.\d+\.\d+ - \S.* — \d{4}-\d{2}-\d{2}$")
for line in (ROOT / "CHANGELOG.md").read_text().splitlines():
    if line.startswith("## ") and not HEADING.match(line):
        fail("CHANGELOG.md", f"heading not in the format '## X.Y.Z - <name> — YYYY-MM-DD': {line}")
tags = subprocess.run(["git", "tag", "--list"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
for tag in tags:
    if not re.fullmatch(r"0\.\d+\.\d+", tag):
        fail("git tag", f"'{tag}' is not in the X.Y.Z format with major version 0")

# ---- the structured editor's grammar matches the vendored coverage map (#39)
import subprocess
_g = subprocess.run([sys.executable, str(ROOT / "scripts/config-grammar.py"), "--check"], capture_output=True, text=True)
if _g.returncode != 0:
    fail("back/crates/server/src/config_grammar.json", (_g.stderr or _g.stdout).strip())

# ---- exceptions that no longer exist (the lists must not keep dead entries)
for p in EXC + GENERATED:
    base = p[:-3] if p.endswith("/**") else p
    if not (ROOT / base).exists():
        fail("CONTRIBUTING.md", f"language exception points at something that does not exist: {p}")

if errors:
    print("\n".join(errors))
    print(f"\n{len(errors)} problem(s)")
    sys.exit(1)
print("documentation ok")
