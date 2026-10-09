#!/bin/sh
# Fetches the Prisma contract pinned in prisma-contract.lock from the private
# repository andrediashexa/prismarouting, checks each file's sha256 and
# generates the structured editor's grammar from the coverage map (#91).
#
# The token needs read access to prismarouting's contents: PRISMAROUTING_TOKEN,
# else GH_TOKEN, else the GitHub CLI's login. The files are git-ignored.
#
#   scripts/fetch-contract.sh
set -eu
cd "$(dirname "$0")/.."
REPO=andrediashexa/prismarouting
TOKEN=${PRISMAROUTING_TOKEN:-${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}}
[ -n "$TOKEN" ] || { echo "fetch-contract: set PRISMAROUTING_TOKEN (read access to $REPO)" >&2; exit 2; }
REF=$(awk '$1 == "release" { print $2 }' prisma-contract.lock)
grep -v '^#' prisma-contract.lock | awk 'NF == 3' | while read -r src dst sum; do
  mkdir -p "$(dirname "$dst")"
  curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/$REPO/contents/$src?ref=$REF" -o "$dst.part"
  got=$(sha256sum "$dst.part" | cut -d' ' -f1)
  if [ "$got" != "$sum" ]; then
    rm -f "$dst.part"
    echo "fetch-contract: $src at $REF has sha256 $got, the lock says $sum" >&2
    exit 1
  fi
  mv "$dst.part" "$dst"
  echo "$dst ($REF) ok"
done
python3 scripts/config-grammar.py
