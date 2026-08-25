#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

export DEEPCRM_ENV_FILE="${DEEPCRM_ENV_FILE:-/srv/deepcrm/.env}"

compose=(docker compose --project-name deepcrm --env-file "$DEEPCRM_ENV_FILE" -f infrastructure/compose/docker-compose.prod.yml)
bootstrap_args=()

if [[ $# -gt 1 || (${#} -eq 1 && ${1} != "--retry-terminal") ]]; then
  echo "usage: $0 [--retry-terminal]" >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  bootstrap_args+=("${1}")
fi

"${compose[@]}" build
"${compose[@]}" up -d postgres
"${compose[@]}" run --rm api node node_modules/prisma/build/index.js migrate deploy --schema packages/db/prisma/schema.prisma
"${compose[@]}" run --rm api node worker/dist/matching-bootstrap.js "${bootstrap_args[@]}"
"${compose[@]}" up -d
for _ in {1..30}; do
  if "${compose[@]}" exec -T api curl -sf http://localhost:5656/health; then
    exit 0
  fi
  sleep 2
done

"${compose[@]}" exec -T api curl -sf http://localhost:5656/health
