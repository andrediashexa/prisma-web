#!/usr/bin/env python3
"""Verifica as regras de documentação do CONTRIBUTING.md.

- todo *.md versionado abre com TL;DR, responde 5W2H e cita a RFC 2119 se usa
  as palavras-chave;
- nenhum diagrama em ASCII art (diagramas são Mermaid);
- *.md e comentários de código em pt-BR, salvo as exceções nomeadas no bloco
  `language-exceptions` do CONTRIBUTING.md;
- VERSION igual à versão dos manifestos Cargo e npm.

O teste de idioma é uma heurística: compara palavras funcionais do inglês e do
português. Pega um texto escrito em inglês; não pega um erro de ortografia.

Uso: scripts/check-docs.py   (sai com 1 se algo falhar)
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
PT = re.compile(r"\b(de|que|não|para|com|uma|um|os|as|do|da|em|por|se|quando|é)\b", re.I)
ASCII_ART = re.compile(r"[┌┐└┘├┤┬┴│─]{2,}|\+-{3,}\+")

errors = []


def fail(path, msg):
    errors.append(f"{path}: {msg}")


def tracked(pattern):
    out = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", pattern],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [p for p in out.splitlines() if (ROOT / p).exists()]


def exceptions():
    text = (ROOT / "CONTRIBUTING.md").read_text()
    m = re.search(r"```text language-exceptions\n(.*?)```", text, re.S)
    if not m:
        sys.exit("CONTRIBUTING.md: bloco `language-exceptions` não encontrado")
    pats = [line.split("#")[0].strip() for line in m.group(1).splitlines()]
    return [p for p in pats if p]


EXC = exceptions()


def excepted(path):
    return any(fnmatch.fnmatch(path, p) or (p.endswith("/**") and path.startswith(p[:-2])) for p in EXC)


def english(text):
    en, pt = len(EN.findall(text)), len(PT.findall(text))
    return en >= 8 and en > pt


def strip_code(md):
    return re.sub(r"```.*?```", "", md, flags=re.S)


# ---- *.md
for path in tracked("*.md"):
    if "node_modules/" in path or excepted(path):
        continue
    text = (ROOT / path).read_text()
    head = "\n".join(text.splitlines()[:12])
    if "TL;DR" not in head:
        fail(path, "não abre com TL;DR (nas primeiras linhas)")
    if "5W2H" not in text:
        fail(path, "não responde 5W2H")
    prose = strip_code(text)
    if RFC_WORDS.search(prose) and "2119" not in text:
        fail(path, "usa palavras-chave da RFC 2119 sem citá-la")
    for block in re.findall(r"```(\w*)\n(.*?)```", text, re.S):
        if block[0] != "mermaid" and ASCII_ART.search(block[1]):
            fail(path, "diagrama em ASCII art; use Mermaid")
    if english(prose):
        fail(path, "parece estar em inglês (idioma do projeto: pt-BR)")

# ---- comentários de código
# Em Rust/TS só // e /* */ são comentário: `#` abre atributos (`#[derive]`).
LINE_COMMENT = re.compile(r"//[/!]?\s?(.*)$", re.M)
BLOCK_COMMENT = re.compile(r"/\*+(.*?)\*/", re.S)
for pattern in ("back/**/*.rs", "front/src/**/*.ts", "front/src/**/*.tsx", "scripts/*.py"):
    for path in tracked(pattern):
        if excepted(path):
            continue
        src = (ROOT / path).read_text()
        if path.endswith(".py"):
            comments = re.findall(r"#\s?(.*)$", src, re.M) + re.findall(r'"""(.*?)"""', src, re.S)
        else:
            comments = LINE_COMMENT.findall(src) + BLOCK_COMMENT.findall(src)
        # Strings e URLs dentro de linhas de código não são comentário de verdade.
        text = " ".join(c for c in comments if not c.strip().startswith(("http", "eslint", "@")))
        if english(text):
            fail(path, "comentários parecem estar em inglês (idioma do projeto: pt-BR)")

# ---- versões
version = (ROOT / "VERSION").read_text().strip()
if not re.fullmatch(r"0\.\d+\.\d+", version):
    fail("VERSION", f"'{version}' não é 0.x.y")
cargo = re.search(r'\[workspace\.package\].*?^version\s*=\s*"([^"]+)"', (ROOT / "back/Cargo.toml").read_text(), re.S | re.M)
if not cargo or cargo.group(1) != version:
    fail("back/Cargo.toml", f"versão {cargo and cargo.group(1)} ≠ VERSION {version}")
npm = json.loads((ROOT / "front/package.json").read_text())["version"]
if npm != version:
    fail("front/package.json", f"versão {npm} ≠ VERSION {version}")

# ---- exceções que não existem mais (a lista não pode guardar lixo)
for p in EXC:
    base = p[:-3] if p.endswith("/**") else p
    if not (ROOT / base).exists():
        fail("CONTRIBUTING.md", f"exceção de idioma aponta para algo que não existe: {p}")

if errors:
    print("\n".join(errors))
    print(f"\n{len(errors)} problema(s)")
    sys.exit(1)
print("documentação ok")
