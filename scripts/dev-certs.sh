#!/bin/sh
# Generates DEVELOPMENT certificates for the mock with mTLS (issue #4).
#
#   dev-certs/mock-server/        server.crt, server.key, clients-ca.crt  -> prisma-mock-2
#   dev-certs/profiles/mock/      ca.crt + prisma-web-dev.{crt,key}       -> profile "dev/mock"
#   dev-certs/profiles/other-ca/  ca.crt of another CA                    -> the client MUST reject the server
#   dev-certs/profiles/intruder/   right CA + client of another CA         -> the server MUST reject the client
#
# None of this is for a real Prisma: the box uses the operator's CA
# (docs/prisma-api.md). dev-certs/ is ignored by git. Regenerates only with --force.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dev-certs"
if [ -d "$OUT/profiles/intruder" ] && [ "${1:-}" != "--force" ]; then
  echo "dev-certs already exists (use --force to regenerate)"
  exit 0
fi
rm -rf "$OUT"
umask 027
mkdir -p "$OUT/ca" "$OUT/mock-server" "$OUT/profiles/mock" "$OUT/profiles/other-ca" "$OUT/profiles/intruder"
cd "$OUT/ca"

ca() { # name, CN
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$2" -keyout "$1.key" -out "$1.crt" 2>/dev/null
}
sign() { # ca, output, CN, extensions
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$3" -keyout "$2.key" -out "$2.csr" 2>/dev/null
  printf '%s\n' "$4" > "$2.ext"
  openssl x509 -req -in "$2.csr" -CA "$1.crt" -CAkey "$1.key" -CAcreateserial -days 825 \
    -extfile "$2.ext" -out "$2.crt" 2>/dev/null
  rm -f "$2.csr" "$2.ext"
}

ca dev-ca "prisma-web dev clients"
ca other-ca "other CA"
# Server name matches the real Prisma's (prisma-api), plus the container name in the SAN.
sign dev-ca server prisma-api "subjectAltName=DNS:prisma-api,DNS:prisma-mock-2"
sign dev-ca prisma-web-dev prisma-web-dev "extendedKeyUsage=clientAuth"
sign other-ca intruder intruder "extendedKeyUsage=clientAuth"

cp server.crt server.key "$OUT/mock-server/"
cp dev-ca.crt "$OUT/mock-server/clients-ca.crt"
cp dev-ca.crt "$OUT/profiles/mock/ca.crt"
cp prisma-web-dev.crt prisma-web-dev.key "$OUT/profiles/mock/"
cp other-ca.crt "$OUT/profiles/other-ca/ca.crt"
cp intruder.crt intruder.key "$OUT/profiles/other-ca/"
cp dev-ca.crt "$OUT/profiles/intruder/ca.crt"
cp intruder.crt intruder.key "$OUT/profiles/intruder/"

# openssl writes keys as 0600, ignoring the umask; the back end reads them through the group (0640, as on the real Prisma).
chmod 0640 "$OUT"/mock-server/server.key "$OUT"/profiles/*/*.key

echo "development certificates in $OUT"
echo "if back and prisma-mock-2 were already running: docker compose restart back prisma-mock-2"
