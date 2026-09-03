#!/bin/sh
# Apply the onboarding migrations to the Engelbart database.
#
#   sh scripts/db-migrate.sh
#
# Asks once for the Postgres connection string (Supabase dashboard -> Connect
# -> Session pooler, port 5432), keeps it in .env.db (git-ignored, mode 600),
# installs psql through Homebrew if this machine has none, and runs the four
# migration files in order (the hc profile one first: the live project had
# never received it, which is what left hc_profiles without tech_level). Re-running is safe: every statement is
# "if not exists" / "create or replace".
set -eu
cd "$(dirname "$0")/.."

if [ ! -s .env.db ]; then
  printf 'Postgres connection string (postgresql://postgres.<ref>:<password>@...pooler.supabase.com:5432/postgres): '
  IFS= read -r url
  case "$url" in postgresql://*|postgres://*) ;; *) echo "that is not a postgresql:// URL" >&2; exit 1;; esac
  umask 077
  printf '%s\n' "$url" > .env.db
  echo "saved to .env.db"
fi
url=$(cat .env.db)

PSQL=$(command -v psql || true)
if [ -z "$PSQL" ]; then
  for candidate in /opt/homebrew/opt/libpq/bin/psql /usr/local/opt/libpq/bin/psql; do
    [ -x "$candidate" ] && PSQL="$candidate" && break
  done
fi
if [ -z "$PSQL" ]; then
  echo "installing psql (brew install libpq)..."
  brew install -q libpq
  PSQL=$(ls /opt/homebrew/opt/libpq/bin/psql /usr/local/opt/libpq/bin/psql 2>/dev/null | head -1)
fi

HC=../claude-plugins
for file in \
  supabase/migrations/20260902100000_engelbart_invite_gate_restored.sql \
  supabase/migrations/20260902110000_engelbart_onboarding.sql \
  "$HC/supabase/migrations/20260831190000_hc_reader_profile.sql" \
  "$HC/supabase/migrations/20260902120000_hc_reader_knowledge.sql"; do
  echo "== $file"
  "$PSQL" "$url" -v ON_ERROR_STOP=1 -q -f "$file"
done
echo "all four migrations applied"
