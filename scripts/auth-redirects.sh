#!/usr/bin/env bash
# Adds the sign-in and localhost pages to the Supabase auth redirect allowlist,
# so a password-reset link (and a local signup confirmation) can come back to
# them. Idempotent: entries already present are left alone.
#
# Auth: the Supabase CLI's login token from the macOS keychain, or
# SUPABASE_ACCESS_TOKEN in the environment. The token is never printed.
#
#   bash scripts/auth-redirects.sh          # apply
#   bash scripts/auth-redirects.sh --show   # print the current list and exit
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-tynpqxepuyyvxqdwzhkj}"
API="https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth"
WANT=(
  "https://berkeley.mathetic.com/engelbart/signin"
  "https://berkeley-research-*-mathetic.vercel.app/engelbart/signin"
  "http://localhost:3000/engelbart/signin"
  "http://localhost:3000/engelbart/setup"
)

TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN="$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "No Supabase access token: run 'supabase login' or set SUPABASE_ACCESS_TOKEN." >&2
  exit 1
fi

current="$(curl -sf -H "Authorization: Bearer $TOKEN" "$API" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("uri_allow_list") or "")')"
echo "Current allowlist:"
echo "$current" | tr ',' '\n' | sed 's/^/  /'

if [ "${1:-}" = "--show" ]; then exit 0; fi

merged="$current"
added=0
for url in "${WANT[@]}"; do
  case ",$merged," in
    *",$url,"*) ;;
    *) merged="${merged:+$merged,}$url"; added=$((added + 1)); echo "  + $url" ;;
  esac
done
if [ "$added" -eq 0 ]; then echo "Nothing to add."; exit 0; fi

python3 -c 'import json,sys; print(json.dumps({"uri_allow_list": sys.argv[1]}))' "$merged" \
  | curl -sf -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- "$API" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("Now:"); [print("  " + u) for u in (d.get("uri_allow_list") or "").split(",")]'
