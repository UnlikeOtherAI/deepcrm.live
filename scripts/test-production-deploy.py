"""Exercise deployment ordering and failure gates without Docker or production access."""
import os
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = (r"C:\Program Files\Git\bin\bash.exe" if os.name == "nt" else shutil.which("bash"))


class DeploymentTests(unittest.TestCase):
    def run_deploy(self, failure="", image="deepcrm-app:test", args=(), recovery="",
                   owner="postgres", enum_value=""):
        with tempfile.TemporaryDirectory(dir=ROOT if os.name == "nt" else None) as directory:
            temp = Path(directory)
            docker = temp / "docker"
            docker.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n'
                              'if [[ "$*" == *"pg_dump"* ]]; then printf "backup"; fi\n'
                              'if [[ "$*" == *"SELECT checksum FROM _prisma_migrations"* ]]; then printf "%s" "$RECOVER_CHECKSUM"; fi\n'
                              'if [[ "$*" == *"SELECT pg_get_userbyid(typowner)"* ]]; then printf "%s" "${RECOVER_OWNER:-postgres}"; fi\n'
                              'if [[ "$*" == *"SELECT enumlabel FROM pg_enum"* ]]; then printf "%s" "$RECOVER_ENUM_VALUE"; fi\n'
                              '[[ -z "$FAIL_AT" || "$*" != *"$FAIL_AT"* ]]\n', encoding="utf-8")
            docker.chmod(0o755)
            log = temp / "calls"
            backup_dir = str(temp / "backups")
            if os.name == "nt":
                backup_dir = "/" + backup_dir[0].lower() + backup_dir[2:].replace("\\", "/")
            env = dict(os.environ, PATH=str(temp) + os.pathsep + os.environ["PATH"],
                       DOCKER_LOG=str(log), FAIL_AT=failure, DEEPCRM_IMAGE=image,
                       RECOVER_CHECKSUM=recovery, RECOVER_OWNER=owner,
                       RECOVER_ENUM_VALUE=enum_value,
                       DEEPCRM_MIGRATION_BACKUP_DIR=backup_dir)
            result = subprocess.run([BASH, str(ROOT / "infrastructure/compose/redeploy.sh"), *args],
                                    env=env, capture_output=True, text=True)
            self.last_stderr = result.stderr
            return result.returncode, log.read_text().splitlines() if log.exists() else []

    def test_release_order_and_retry(self):
        code, calls = self.run_deploy(args=("--retry-terminal",))
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 7)
        self.assertIn("image inspect deepcrm-app:test", calls[0])
        self.assertIn("postgres", calls[1])
        self.assertIn("SELECT checksum FROM _prisma_migrations", calls[2])
        self.assertIn("migrate deploy", calls[3])
        self.assertIn("matching-bootstrap.js --retry-terminal", calls[4])
        self.assertIn("up -d --no-build --pull never", calls[5])
        self.assertIn("/health", calls[6])
        self.assertTrue(all("--pull never" in call for call in calls[3:6]))

    def test_missing_image_stops_before_database(self):
        code, calls = self.run_deploy(failure="image inspect")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(calls), 1)

    def test_missing_release_is_rejected(self):
        code, calls = self.run_deploy(image="")
        self.assertNotEqual(code, 0)
        self.assertEqual(calls, [])

    def test_migration_and_bootstrap_failures_stop_startup(self):
        for failure, count in (("migrate deploy", 4), ("matching-bootstrap", 5)):
            with self.subTest(failure=failure):
                code, calls = self.run_deploy(failure=failure)
                self.assertNotEqual(code, 0)
                self.assertEqual(len(calls), count)

    @unittest.skipIf(os.name == "nt", "backup permission check requires a Linux filesystem")
    def test_failed_enum_owner_migration_repairs_and_replays(self):
        sql = ROOT / "packages/db/prisma/migrations/20261019150000_contact_point_policy_resource/migration.sql"
        checksum = hashlib.sha256(sql.read_bytes()).hexdigest()
        code, calls = self.run_deploy(recovery=checksum)
        self.assertEqual(code, 0, (self.last_stderr, calls))
        self.assertEqual(len(calls), 12)
        self.assertIn("pg_dump", calls[5])
        self.assertIn('ALTER TYPE public."PolicyResourceType" OWNER TO deepcrm', calls[6])
        self.assertIn("migrate resolve --rolled-back 20261019150000_contact_point_policy_resource", calls[7])
        self.assertIn("migrate deploy", calls[8])

    def test_unknown_failed_migration_stops_without_mutation(self):
        code, calls = self.run_deploy(recovery="unexpected-checksum")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(calls), 3)

    @unittest.skipIf(os.name == "nt", "backup permission check requires a Linux filesystem")
    def test_retry_after_owner_transfer_replays_without_second_transfer(self):
        sql = ROOT / "packages/db/prisma/migrations/20261019150000_contact_point_policy_resource/migration.sql"
        checksum = hashlib.sha256(sql.read_bytes()).hexdigest()
        code, calls = self.run_deploy(recovery=checksum, owner="deepcrm")
        self.assertEqual(code, 0, (self.last_stderr, calls))
        self.assertFalse(any("ALTER TYPE" in call for call in calls))
        self.assertTrue(any("migrate resolve --rolled-back" in call for call in calls))

    def test_partially_applied_enum_stops_before_backup_or_resolve(self):
        sql = ROOT / "packages/db/prisma/migrations/20261019150000_contact_point_policy_resource/migration.sql"
        checksum = hashlib.sha256(sql.read_bytes()).hexdigest()
        code, calls = self.run_deploy(recovery=checksum, enum_value="contact_point")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(calls), 5)

    def test_production_compose_has_no_build(self):
        compose = (ROOT / "infrastructure/compose/docker-compose.prod.yml").read_text()
        self.assertNotIn("build:", compose)
        self.assertEqual(compose.count("image: ${DEEPCRM_IMAGE:?"), 2)


if __name__ == "__main__":
    unittest.main()
