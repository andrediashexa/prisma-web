#!/bin/sh
# Fetches the Prisma contract pinned in prisma-contract.lock from the private
# repository andrediashexa/prismarouting, checks each file's sha256 and
# generates the structured editor's grammar from the coverage map (#91).
#
# Credentials, the first one set:
#   PRISMAROUTING_SSH_KEY  a read-only deploy key of prismarouting, the key itself (CI);
#   PRISMAROUTING_TOKEN    a token that can read prismarouting's contents;
#   GH_TOKEN, or the GitHub CLI's login.
# The files are git-ignored.
#
#   scripts/fetch-contract.sh
set -eu
cd "$(dirname "$0")/.."
REPO=andrediashexa/prismarouting
REF=$(awk '$1 == "release" { print $2 }' prisma-contract.lock)
ENTRIES=$(grep -v '^#' prisma-contract.lock | awk 'NF == 3')
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -n "${PRISMAROUTING_SSH_KEY:-}" ]; then
  # GitHub's host key, from https://api.github.com/meta: no trust on first use.
  echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" > "$TMP/known_hosts"
  printf '%s\n' "$PRISMAROUTING_SSH_KEY" > "$TMP/key"
  chmod 600 "$TMP/key"
  export GIT_SSH_COMMAND="ssh -i $TMP/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$TMP/known_hosts -o StrictHostKeyChecking=yes"
  git clone -q --depth 1 --branch "$REF" --filter=blob:none --no-checkout "git@github.com:$REPO.git" "$TMP/repo"
  echo "$ENTRIES" | while read -r src dst sum; do
    git -C "$TMP/repo" show "HEAD:$src" > "$TMP/$(echo "$src" | tr / _)"
  done
  get() { cp "$TMP/$(echo "$1" | tr / _)" "$2"; }
else
  TOKEN=${PRISMAROUTING_TOKEN:-${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}}
  [ -n "$TOKEN" ] || { echo "fetch-contract: set PRISMAROUTING_SSH_KEY or PRISMAROUTING_TOKEN (read access to $REPO)" >&2; exit 2; }
  get() {
    curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.raw" \
      "https://api.github.com/repos/$REPO/contents/$1?ref=$REF" -o "$2"
  }
fi

echo "$ENTRIES" | while read -r src dst sum; do
  mkdir -p "$(dirname "$dst")"
  get "$src" "$dst.part"
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
