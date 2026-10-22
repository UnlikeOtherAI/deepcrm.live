#!/usr/bin/env bash
set -euo pipefail
umask 077

# The October contact-point migration has one statement. A previous release
# reached it with an enum owned by postgres while Prisma connects as deepcrm.
# Repair that ownership and let Prisma replay the original migration.
cd "$(dirname "$0")/../.."
migration=20261019150000_contact_point_policy_resource
sql_file="packages/db/prisma/migrations/$migration/migration.sql"
db_container=${DEEPCRM_MIGRATION_DB_CONTAINER:-postgres}

db_query() {
  docker exec "$db_container" psql -X -v ON_ERROR_STOP=1 -U postgres -d deepcrm -At -c "$1"
}

failed_checksum=$(db_query "SELECT checksum FROM _prisma_migrations WHERE migration_name = '$migration' AND finished_at IS NULL AND rolled_back_at IS NULL")
[[ -n "$failed_checksum" ]] || exit 0
[[ "$failed_checksum" != *$'\n'* ]] || { echo 'multiple failed contact-point migrations require review' >&2; exit 1; }
expected_checksum=$(sha256sum "$sql_file")
expected_checksum=${expected_checksum%% *}
[[ "$failed_checksum" == "$expected_checksum" ]] || { echo 'failed migration checksum differs from reviewed SQL' >&2; exit 1; }

enum_owner=$(db_query "SELECT pg_get_userbyid(typowner) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'PolicyResourceType'")
[[ "$enum_owner" == postgres || "$enum_owner" == deepcrm ]] || { echo 'unexpected contact-point enum owner' >&2; exit 1; }
enum_value=$(db_query "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typnamespace = 'public'::regnamespace AND t.typname = 'PolicyResourceType' AND e.enumlabel = 'contact_point'")
[[ -z "$enum_value" ]] || { echo 'contact-point enum was partially applied; review before recovery' >&2; exit 1; }

backup_dir=${DEEPCRM_MIGRATION_BACKUP_DIR:-/srv/deepcrm/.deploy-backups}
install -d -m 0700 "$backup_dir"
backup=$(mktemp "$backup_dir/${migration}.XXXXXXXX.dump")
docker exec "$db_container" pg_dump -U postgres -d deepcrm -Fc > "$backup"
[[ -s "$backup" ]] || { echo 'migration recovery backup is empty' >&2; exit 1; }
echo "DeepCRM migration recovery backup: $backup"

if [[ "$enum_owner" == postgres ]]; then
  db_query 'ALTER TYPE public."PolicyResourceType" OWNER TO deepcrm' >/dev/null
fi

docker compose --project-name deepcrm --env-file "$DEEPCRM_ENV_FILE" \
  -f infrastructure/compose/docker-compose.prod.yml run --rm --no-deps --pull never api \
  node node_modules/prisma/build/index.js migrate resolve --rolled-back "$migration" \
  --schema packages/db/prisma/schema.prisma
