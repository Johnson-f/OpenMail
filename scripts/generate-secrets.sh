#!/bin/sh
# Writes Config/Secrets.xcconfig from the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$root/.env"
out="$root/Config/Secrets.xcconfig"

value() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$env_file" | tail -n 1 | sed -E "s/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^[\"']//; s/[\"']$//"
}

[ -f "$env_file" ] || { echo "error: $env_file not found" >&2; exit 1; }
client_id="$(value GOOGLE_CLIENT_ID)"
client_secret="$(value GOOGLE_CLIENT_SECRET)"
[ -n "$client_id" ] && [ -n "$client_secret" ] || { echo "error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env" >&2; exit 1; }
case "$client_id$client_secret" in
  *//*) echo "error: values containing // can't be stored in an xcconfig" >&2; exit 1 ;;
esac

umask 077
printf 'GOOGLE_CLIENT_ID = %s\nGOOGLE_CLIENT_SECRET = %s\n' "$client_id" "$client_secret" > "$out"
echo "Wrote $out"
