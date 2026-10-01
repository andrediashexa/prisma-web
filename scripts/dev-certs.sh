#!/bin/sh
# Gera certificados de DESENVOLVIMENTO para o mock com mTLS (issue #4).
#
#   dev-certs/mock-server/        server.crt, server.key, clients-ca.crt  -> prisma-mock-2
#   dev-certs/profiles/mock/      ca.crt + prisma-web-dev.{crt,key}       -> perfil "dev/mock"
#   dev-certs/profiles/outra-ca/  ca.crt de outra CA                      -> o cliente MUST recusar o servidor
#   dev-certs/profiles/intruso/   CA certa + cliente de outra CA          -> o servidor MUST recusar o cliente
#
# Nada disto serve para um Prisma real: o equipamento usa a CA do operador
# (docs/prisma-api.md). dev-certs/ é ignorado pelo git. Só refaz com --force.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dev-certs"
if [ -d "$OUT/profiles/mock" ] && [ "${1:-}" != "--force" ]; then
  echo "dev-certs já existe (use --force para refazer)"
  exit 0
fi
rm -rf "$OUT"
umask 027
mkdir -p "$OUT/ca" "$OUT/mock-server" "$OUT/profiles/mock" "$OUT/profiles/outra-ca" "$OUT/profiles/intruso"
cd "$OUT/ca"

ca() { # nome, CN
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$2" -keyout "$1.key" -out "$1.crt" 2>/dev/null
}
sign() { # ca, saída, CN, extensões
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$3" -keyout "$2.key" -out "$2.csr" 2>/dev/null
  printf '%s\n' "$4" > "$2.ext"
  openssl x509 -req -in "$2.csr" -CA "$1.crt" -CAkey "$1.key" -CAcreateserial -days 825 \
    -extfile "$2.ext" -out "$2.crt" 2>/dev/null
  rm -f "$2.csr" "$2.ext"
}

ca dev-ca "prisma-web dev clients"
ca outra-ca "outra CA"
# Nome do servidor igual ao do Prisma real (prisma-api) e o nome do container no SAN.
sign dev-ca server prisma-api "subjectAltName=DNS:prisma-api,DNS:prisma-mock-2"
sign dev-ca prisma-web-dev prisma-web-dev "extendedKeyUsage=clientAuth"
sign outra-ca intruso intruso "extendedKeyUsage=clientAuth"

cp server.crt server.key "$OUT/mock-server/"
cp dev-ca.crt "$OUT/mock-server/clients-ca.crt"
cp dev-ca.crt "$OUT/profiles/mock/ca.crt"
cp prisma-web-dev.crt prisma-web-dev.key "$OUT/profiles/mock/"
cp outra-ca.crt "$OUT/profiles/outra-ca/ca.crt"
cp intruso.crt intruso.key "$OUT/profiles/outra-ca/"
cp dev-ca.crt "$OUT/profiles/intruso/ca.crt"
cp intruso.crt intruso.key "$OUT/profiles/intruso/"

# openssl grava chaves com 0600, ignorando o umask; o back lê pelo grupo (como no Prisma real, 0640).
chmod 0640 "$OUT"/mock-server/server.key "$OUT"/profiles/*/*.key

echo "certificados de desenvolvimento em $OUT"
echo "se o back e o prisma-mock-2 já estavam no ar: docker compose restart back prisma-mock-2"
