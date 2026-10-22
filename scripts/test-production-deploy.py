"""Exercise deployment ordering and failure gates without Docker or production access."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = (r"C:\Program Files\Git\bin\bash.exe" if os.name == "nt" else shutil.which("bash"))


class DeploymentTests(unittest.TestCase):
    def run_deploy(self, failure="", image="deepcrm-app:test", args=()):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            temp = Path(directory)
            docker = temp / "docker"
            docker.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\n'
                              '[[ -z "$FAIL_AT" || "$*" != *"$FAIL_AT"* ]]\n', encoding="utf-8")
            docker.chmod(0o755)
            log = temp / "calls"
            env = dict(os.environ, PATH=str(temp) + os.pathsep + os.environ["PATH"],
                       DOCKER_LOG=str(log), FAIL_AT=failure, DEEPCRM_IMAGE=image)
            result = subprocess.run([BASH, str(ROOT / "infrastructure/compose/redeploy.sh"), *args],
                                    env=env, capture_output=True, text=True)
            return result.returncode, log.read_text().splitlines() if log.exists() else []

    def test_release_order_and_retry(self):
        code, calls = self.run_deploy(args=("--retry-terminal",))
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 6)
        self.assertIn("image inspect deepcrm-app:test", calls[0])
        self.assertIn("postgres", calls[1])
        self.assertIn("migrate deploy", calls[2])
        self.assertIn("matching-bootstrap.js --retry-terminal", calls[3])
        self.assertIn("up -d --no-build --pull never", calls[4])
        self.assertIn("/health", calls[5])
        self.assertTrue(all("--pull never" in call for call in calls[2:5]))

    def test_missing_image_stops_before_database(self):
        code, calls = self.run_deploy(failure="image inspect")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(calls), 1)

    def test_missing_release_is_rejected(self):
        code, calls = self.run_deploy(image="")
        self.assertNotEqual(code, 0)
        self.assertEqual(calls, [])

    def test_migration_and_bootstrap_failures_stop_startup(self):
        for failure, count in (("migrate deploy", 3), ("matching-bootstrap", 4)):
            with self.subTest(failure=failure):
                code, calls = self.run_deploy(failure=failure)
                self.assertNotEqual(code, 0)
                self.assertEqual(len(calls), count)

    def test_production_compose_has_no_build(self):
        compose = (ROOT / "infrastructure/compose/docker-compose.prod.yml").read_text()
        self.assertNotIn("build:", compose)
        self.assertEqual(compose.count("image: ${DEEPCRM_IMAGE:?"), 2)


if __name__ == "__main__":
    unittest.main()
