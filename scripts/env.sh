#!/bin/sh
# Load env and run a command. Pass --prod anywhere for .env.production.
#
# Usage:
#   ./scripts/env.sh <command>          # loads .env.local
#   ./scripts/env.sh --prod <command>   # loads .env.production
#   pnpm db:migrate                     # loads .env.local (via package.json)
#   pnpm db:migrate --prod              # loads .env.production

ENV_FILE=".env.local"
CMD=""
for arg in "$@"; do
  case "$arg" in
    --prod) ENV_FILE=".env.production" ;;
    *) CMD="${CMD:+$CMD }\"$arg\"" ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found (run from repo root)" >&2
  exit 1
fi

set -a; . "./$ENV_FILE"; set +a
eval $CMD
