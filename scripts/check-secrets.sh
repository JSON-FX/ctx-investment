#!/usr/bin/env bash
#
# Refuse to let real data reach a public repository.
#
# The design spec, §10, requires this and three plans went by without anyone
# building it. It scans what git is about to record — the staged index by
# default — for credentials and for the identifiers that would tie this
# repository to a real trading account.
#
#   scripts/check-secrets.sh            # staged changes (what a commit records)
#   scripts/check-secrets.sh --all      # every tracked file
#   scripts/check-secrets.sh --range A..B
#
# Install as a pre-commit hook:
#   ln -sf ../../scripts/check-secrets.sh .git/hooks/pre-commit
#
# Exits non-zero on a hit, naming the file and the pattern.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

MODE="${1:---staged}"

# Credential shapes. These are patterns, never real values — this file is
# itself scanned, so it must not contain a live secret.
CRED_PATTERNS=(
  'eyJ[A-Za-z0-9_-]{20,}\.'                 # a JWT: header.payload
  'sb_secret_[A-Za-z0-9_-]{16,}'            # Supabase secret key
  'sbp_[A-Za-z0-9]{40,}'                    # Supabase personal token
  'service_role[[:space:]]*[:=][[:space:]]*[A-Za-z0-9]'  # an assigned service key
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'postgres://[^:]*:[^@]*@'                   # a DSN carrying a password
  'postgresql://[^:]*:[^@]*@'
)

# Identifiers that would tie this public repository to a real account. The MT5
# number and Supabase project ref are the ones that matter; the rest are
# supporting detail that would confirm an inference.
IDENTITY_PATTERNS=(
  '16005689'                                   # the live MT5 account
  'mkfabzqlxzeidfblxzhq'                       # the Supabase project ref
  'ICMarketsSC'                                # the live broker server
  'Raw Trading Ltd'
  'd9ce1958-32d7-4a7a-99cd-c4291782e066'       # the account owner's user id
  'help\.copytraderx@gmail\.com'
)

case "$MODE" in
  --all)   FILES=$(git ls-files) ;;
  --range) FILES=$(git diff --name-only --diff-filter=ACMR "${2:?--range needs A..B}") ;;
  *)       FILES=$(git diff --cached --name-only --diff-filter=ACMR) ;;
esac

# The scanner names the very strings it looks for, so exclude it from its own
# scan. Lockfiles are generated and enormous.
FILES=$(printf '%s\n' "$FILES" \
  | grep -v '^scripts/check-secrets\.sh$' \
  | grep -v '^pnpm-lock\.yaml$' \
  | grep -v '^\.gitignore$')

[ -z "$FILES" ] && { echo "check-secrets: nothing to scan"; exit 0; }

FAIL=0
report() {
  printf '  %-28s %s\n' "$1" "$2"
  FAIL=1
}

while IFS= read -r f; do
  [ -f "$f" ] || continue
  # Skip anything that is not text.
  file --mime-type -b "$f" 2>/dev/null | grep -q '^text/' || continue

  for p in "${CRED_PATTERNS[@]}"; do
    if grep -qE "$p" "$f" 2>/dev/null; then
      [ "$FAIL" -eq 0 ] && echo "check-secrets: FAILED" && echo
      report "credential" "$f  (matched /$p/)"
    fi
  done
  for p in "${IDENTITY_PATTERNS[@]}"; do
    if grep -qE "$p" "$f" 2>/dev/null; then
      [ "$FAIL" -eq 0 ] && echo "check-secrets: FAILED" && echo
      report "real identifier" "$f  (matched /$p/)"
    fi
  done
done <<< "$FILES"

if [ "$FAIL" -ne 0 ]; then
  cat <<'MSG'

This repository is public. Nothing above may be committed.

If the match is a false positive — a fixture that happens to contain the
digits, say — change the fixture rather than weakening this check. Real
figures belong in the runtime environment or in a git-ignored *.local.md
note, per the design spec §10.
MSG
  exit 1
fi

echo "check-secrets: clean ($(printf '%s\n' "$FILES" | wc -l | tr -d ' ') file(s) scanned)"
exit 0
