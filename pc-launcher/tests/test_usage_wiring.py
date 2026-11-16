"""End-to-end wiring tests: launcher receipts -> merged bee.usage/v1 ledger -> report.

Runs the real usage_ingest_service.py and usage_report.py as subprocesses over
temporary receipt directories. Stdlib only, no network.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

PC_LAUNCHER = Path(__file__).resolve().parents[1]
SCRIPTS = PC_LAUNCHER / "scripts"
SERVICE = SCRIPTS / "usage_ingest_service.py"
REPORT = SCRIPTS / "usage_report.py"
PRICES = PC_LAUNCHER / "prices.json"
USAGE_SCHEMA = json.loads((PC_LAUNCHER / "usage-schema.v1.json").read_text(encoding="utf-8"))
UNIT = PC_LAUNCHER.parent / "contrib" / "rizzstack-observability" / "usage-ingest.service"
sys.path.insert(0, str(SCRIPTS))
import usage_ledger as ledger  # noqa: E402

CLEAN_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp")}


def run_service(mode, *extra):
    return subprocess.run(
        [sys.executable, str(SERVICE), mode, *extra],
        capture_output=True, text=True, env=CLEAN_ENV,
    )


def run_report(*extra):
    return subprocess.run(
        [sys.executable, str(REPORT), *extra],
        capture_output=True, text=True, env=CLEAN_ENV,
    )


def status_lines(stdout):
    return [json.loads(line) for line in stdout.strip().splitlines() if line]


def write_receipt(directory, attempt_id, usage, *, model="deepseek-v4.1-flash", launcher="0.1.14",
                  created=None, project="demo", result=None):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    created = datetime.now(timezone.utc).timestamp() if created is None else created
    state = {
        "attempt_id": attempt_id,
        "state": "done",
        "created_at": created,
        "updated_at": created + 60,
        "model": model,
        "model_history": [{"model": model, "at": created}],
        "brief": {"project": project, "role": "work", "label": "task-1", "card_id": f"card-{attempt_id}"},
        "run_id": f"run-{attempt_id}",
    }
    (directory / f"{attempt_id}.json").write_text(json.dumps(state), encoding="utf-8")
    if result is None:
        result = {
            "schema": "orbit.local-worker.result/v1",
            "attempt_id": attempt_id,
            "source": {"project": project, "kind": "opencode", "model": model, "launcher": launcher},
            "observed": {"usage": usage, "tool_calls": 2, "stop_reason": "end_turn"},
        }
        (directory / f"{attempt_id}.result.json").write_text(json.dumps(result), encoding="utf-8")
        return
    (directory / f"{attempt_id}.result.json").write_text(result, encoding="utf-8")


class IngestServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.attempts = self.dir / "attempts"
        self.ledger = self.dir / "state" / "bee" / "usage.jsonl"
        self.common = (
            "--attempts", str(self.attempts),
            "--ledger", str(self.ledger),
            "--prices", str(PRICES),
        )

    def tearDown(self):
        self.temp.cleanup()

    def ledger_records(self):
        if not self.ledger.exists():
            return []
        return [json.loads(line) for line in self.ledger.read_text(encoding="utf-8").splitlines() if line]

    def test_receipt_to_ledger_to_report(self):
        write_receipt(self.attempts, "att-deep", {"inputTokens": 1_000_000, "cachedReadTokens": 0, "outputTokens": 0})
        write_receipt(self.attempts, "att-zoo", {"prompt_tokens": 20, "completion_tokens": 66},
                      model="zoo:glm-5.3-flash", launcher="0.1.17")
        first = run_service("once", *self.common)
        self.assertEqual(first.returncode, 0, first.stderr)
        status = status_lines(first.stdout)[-1]
        self.assertEqual(status["schema"], "bee.usage-ingest/v1")
        self.assertTrue(status["ok"])
        self.assertEqual(status["sources"], {"launcher_attempts": "ok"})
        self.assertEqual(status["added"], 2)
        self.assertEqual(status["parse_errors"], [])

        records = {record["key"]: record for record in self.ledger_records()}
        self.assertEqual(sorted(records), ["attempt:att-deep", "attempt:att-zoo"])
        for record in records.values():
            self.assertEqual(record["schema_version"], "bee.usage/v1")
            self.assertTrue(ledger.validate_record(record, USAGE_SCHEMA), record["key"])
        zoo = records["attempt:att-zoo"]
        self.assertEqual(zoo["route"], "zoo")
        self.assertEqual(zoo["provider"], "zoo")
        self.assertEqual(zoo["gen_ai.provider.name"], "zoo")
        self.assertEqual(zoo["requested_model"], "zoo:glm-5.3-flash")
        self.assertEqual(zoo["input_tokens"], 20)
        self.assertEqual(zoo["output_tokens"], 66)
        self.assertIsNone(zoo["cost_usd_list"])
        self.assertEqual(zoo["cost_status"], "unknown")
        deep = records["attempt:att-deep"]
        self.assertEqual(deep["route"], "deepseek")
        self.assertEqual(deep["cost_status"], "estimated")
        self.assertGreater(deep["cost_usd_list"], 0)

        day = datetime.fromtimestamp(
            json.loads((self.attempts / "att-deep.json").read_text(encoding="utf-8"))["created_at"],
            tz=timezone.utc,
        ).date().isoformat()
        report = run_report("--ledger", str(self.ledger), "--day", day, "--tz-offset-hours", "0", "--full")
        self.assertEqual(report.returncode, 0, report.stderr)
        report_json = json.loads(report.stdout)
        self.assertEqual(report_json["totals"]["records"], 2)
        self.assertEqual(report_json["totals"]["usd_unknown_records"], 1)
        self.assertGreater(report_json["totals"]["usd_total"], 0)
        routes = {group["group"] for group in report_json["groups"]["route"]}
        self.assertIn("zoo", routes)
        self.assertIn("deepseek", routes)
        zoo_group = next(group for group in report_json["groups"]["route"] if group["group"] == "zoo")
        self.assertEqual(zoo_group["usd_total"], 0)
        self.assertEqual(zoo_group["usd_unknown_records"], 1)
        deepseek_group = next(group for group in report_json["groups"]["route"] if group["group"] == "deepseek")
        self.assertGreater(deepseek_group["usd_total"], 0)

    def test_once_is_idempotent_through_key_dedupe(self):
        write_receipt(self.attempts, "att-idem", {"inputTokens": 10, "outputTokens": 5})
        first = run_service("once", *self.common)
        second = run_service("once", *self.common)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(status_lines(first.stdout)[-1]["added"], 1)
        self.assertEqual(status_lines(second.stdout)[-1]["added"], 0)
        self.assertEqual(len(self.ledger_records()), 1)

    def test_torn_result_json_is_parse_failure_retried_next_cycle(self):
        write_receipt(self.attempts, "att-torn", {"inputTokens": 10, "outputTokens": 5},
                      result='{"schema": "orbit.local-worker.result/v1", "attempt_i')
        write_receipt(self.attempts, "att-good", {"inputTokens": 10, "outputTokens": 5})
        first = run_service("once", *self.common)
        self.assertEqual(first.returncode, 0, first.stderr)
        status = status_lines(first.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["parse_errors"], [{"attempt_id": "att-torn", "reason": "parse_failure"}])
        self.assertEqual([record["key"] for record in self.ledger_records()], ["attempt:att-good"])

        write_receipt(self.attempts, "att-torn", {"inputTokens": 10, "outputTokens": 5})
        second = run_service("once", *self.common)
        self.assertEqual(second.returncode, 0, second.stderr)
        status = status_lines(second.stdout)[-1]
        self.assertEqual(status["parse_errors"], [])
        self.assertEqual(status["added"], 1)
        self.assertEqual(sorted(record["key"] for record in self.ledger_records()),
                         ["attempt:att-good", "attempt:att-torn"])

    def test_missing_attempts_dir_recorded_as_source_missing(self):
        first = run_service("once", *self.common)
        self.assertEqual(first.returncode, 0, first.stderr)
        status = status_lines(first.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["sources"]["launcher_attempts"], "missing")
        self.assertEqual(status["receipt_pairs"], 0)
        self.assertEqual(self.ledger_records(), [])

    def test_backfill_ingests_full_backlog_then_dedupes(self):
        for index in range(3):
            write_receipt(self.attempts, f"att-back-{index}", {"inputTokens": 10, "outputTokens": 5})
        first = run_service("backfill", *self.common)
        second = run_service("backfill", *self.common)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(status_lines(first.stdout)[-1]["added"], 3)
        self.assertEqual(status_lines(second.stdout)[-1]["added"], 0)
        self.assertEqual(status_lines(first.stdout)[-1]["mode"], "backfill")
        self.assertEqual(len(self.ledger_records()), 3)

    def test_run_mode_survives_torn_receipts_across_cycles(self):
        write_receipt(self.attempts, "att-run", {"inputTokens": 10, "outputTokens": 5},
                      result='{"schema": "orbit.local-worker.resu')
        write_receipt(self.attempts, "att-run-ok", {"inputTokens": 10, "outputTokens": 5})
        result = run_service("run", *self.common, "--interval", "0.1", "--max-cycles", "2",
                             "--state", str(self.dir / "status.json"))
        self.assertEqual(result.returncode, 0, result.stderr)
        statuses = status_lines(result.stdout)
        self.assertEqual([status["cycle"] for status in statuses], [1, 2])
        self.assertEqual([status["mode"] for status in statuses], ["run", "run"])
        self.assertTrue(all(status["ok"] for status in statuses))
        self.assertEqual(statuses[0]["parse_errors"], [{"attempt_id": "att-run", "reason": "parse_failure"}])
        persisted = json.loads((self.dir / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(persisted["cycle"], 2)
        self.assertEqual(persisted["ledger_records"], 1)

    def test_state_file_written_atomically_for_once(self):
        write_receipt(self.attempts, "att-state", {"inputTokens": 10, "outputTokens": 5})
        state_path = self.dir / "once-status.json"
        result = run_service("once", *self.common, "--state", str(state_path))
        self.assertEqual(result.returncode, 0, result.stderr)
        persisted = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["added"], 1)
        self.assertFalse(state_path.with_name(state_path.name + ".tmp").exists())


class UnitFileTests(unittest.TestCase):
    def test_unit_carries_protect_system_strict_class(self):
        text = UNIT.read_text(encoding="utf-8")
        for directive in ("ProtectSystem=strict", "ProtectHome=read-only", "NoNewPrivileges=true",
                          "PrivateTmp=true", "ReadWritePaths=", "UMask=0077"):
            self.assertIn(directive, text, directive)
        # Deliberately ABSENT (each aborts a user unit with exit 218
        # EXIT_NAMESPACE before ExecStart on this systemd 255 host, probed
        # individually): PrivateDevices, ProtectKernelLogs,
        # ProtectKernelModules, ProtectClock. See the README enforcement
        # note for the full probe table.
        for absent in ("PrivateDevices=true", "ProtectKernelLogs=true",
                       "ProtectKernelModules=true", "ProtectClock=true"):
            self.assertNotIn(absent, text, absent + " aborts user units on systemd 255 (exit 218)")
        self.assertIn("usage_ingest_service.py run", text)
        self.assertIn(".orbit-launcher/attempts", text)

    def test_unit_passes_systemd_analyze_user_verify(self):
        if shutil.which("systemd-analyze") is None:
            self.skipTest("systemd-analyze not installed")
        result = subprocess.run(
            ["systemd-analyze", "--user", "verify", str(UNIT)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
