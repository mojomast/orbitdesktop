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
import usage_ingest_service as ingest_service  # noqa: E402
import usage_ledger as ledger  # noqa: E402

CLEAN_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp")}


def run_service(mode, *extra, env=None):
    return subprocess.run(
        [sys.executable, str(SERVICE), mode, *extra],
        capture_output=True, text=True, env=env or CLEAN_ENV,
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


def write_event(directory, name, event):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{name}.json").write_text(json.dumps(event), encoding="utf-8")


def landed_event(attempt_id, usage=None, *, model="deepseek-v4.1-flash", launcher="0.1.14",
                 fallback=None, brief=None, ts="2026-11-16T12:00:00Z", payload=None):
    payload = dict(payload or {})
    payload.setdefault("attempt_id", attempt_id)
    if usage is not None and "observed" not in payload:
        payload["observed"] = {"usage": usage, "tool_calls": 1, "stop_reason": "end_turn"}
    source = {}
    if model is not None:
        source["model"] = model
    if launcher is not None:
        source["launcher"] = launcher
    if fallback is not None:
        source["fallback"] = fallback
    if source and "source" not in payload:
        payload["source"] = source
    if brief is not None:
        payload["brief"] = brief
    return {"type": "rizzstack.bee.landed.v1", "ts": ts, "payload": payload}


def canonical_landed_event(attempt_id, usage=None, *, backend=None, task_id="task-canonical",
                           feature_id="feature-demo", job_id="job-canonical", state="landed",
                           time="2026-11-16T12:00:00Z", data=None):
    """Mirror the canonical envelope bundlebees_plugin.bee_events.build_event writes.

    Per review-od-pr38.md B1 the real producer emits CloudEvents envelopes with
    data/datacontenttype/id/source/specversion/time/type at the top level and
    the landed facts (attempt_id, backend, lease, result, state, task_id,
    feature_id, job_id, schema, source_rev) inside `data`; `payload` is not an
    allowed envelope key. This synthetic helper is legacy-shape coverage only,
    NOT the canonical-identity proof: the producer identity is pinned by
    REAL_CAPTURED_LANDED_EVENT below, a real bee-landed event captured verbatim
    from the coordinator default outbox
    (~/.hermes/plugin-data/bundlebees/events/outbox/
    urn:rizzstack:bee-landed:026a2c5be5061b1bd32b35ea57ea616f.json), whose
    data.schema ("rizzstack.bee-landed/1") and envelope id prefix
    ("urn:rizzstack:bee-landed:") match bundlebees_plugin.bee_events SCHEMA and
    EVENT_ID_PREFIX. (The r2 repair's claim that no live outbox or bee_events
    import exists on this host was false, per review-od-pr38-r2.md B1.)
    """
    body = dict(data or {})
    body.setdefault("schema", "rizzstack.bee.landed.v1")
    body.setdefault("attempt_id", attempt_id)
    body.setdefault("task_id", task_id)
    body.setdefault("feature_id", feature_id)
    body.setdefault("job_id", job_id)
    body.setdefault("state", state)
    body.setdefault("backend", dict(backend or {}))
    body.setdefault("lease", {"lease_id": f"lease-{attempt_id}"})
    body.setdefault("source_rev", "3cc5aa87d242fa71b05b0fa48b0c37de0281a3dd")
    if usage is not None:
        body.setdefault("result", {
            "schema": "orbit.local-worker.result/v1",
            "attempt_id": attempt_id,
            "observed": {"usage": usage, "tool_calls": 1, "stop_reason": "end_turn"},
        })
    return {
        "specversion": "1.0",
        "type": "rizzstack.bee.landed.v1",
        "source": "/bundlebees/bee-coordinator",
        "id": f"landed-{attempt_id}",
        "time": time,
        "datacontenttype": "application/json",
        "data": body,
    }


# A real bee-landed event, inlined VERBATIM (single line, exactly as captured)
# from the coordinator default outbox file
# urn:rizzstack:bee-landed:026a2c5be5061b1bd32b35ea57ea616f.json
# (attempt att_c3d1fdc1a72a4f2f, project smoke-20261120, state failed). This is
# the canonical-identity fixture for the producer contract; canonical_landed_event
# above stays only as legacy-shape coverage.
REAL_CAPTURED_LANDED_EVENT = json.loads(
    '''{"data":{"attempt_id":"att_c3d1fdc1a72a4f2f","backend":{"harness":"factory-driver"},"coordinator":{"identity":"factory-driver"},"feature_id":"smoke-20261120","job_id":"smoke-20261120","lease":{"assigned_files":["smoke/answer.py"],"sha256":"2f09d41b913d0db185f4331eddcc64cb0665841ee2682bd84b50cfbeb23cabd0"},"result":{"available":false},"schema":"rizzstack.bee-landed/1","source_rev":"dde2aa42d09c05e43895b3120cb3312f765eb876","state":"failed","task_id":"T1"},"datacontenttype":"application/json","id":"urn:rizzstack:bee-landed:026a2c5be5061b1bd32b35ea57ea616f","source":"rizzstack://bundlebees","specversion":"1.0","time":"2026-11-15T00:35:24Z","type":"rizzstack.bee.landed.v1"}''')


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


class OutboxIngestTests(unittest.TestCase):
    """--source outbox: coordinator-local rizzstack.bee.landed.v1 events."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.attempts = self.dir / "attempts"
        self.outbox = self.dir / "outbox"
        self.ledger = self.dir / "state" / "bee" / "usage.jsonl"
        self.zero_skipped = {"unrelated_type": 0, "no_usage_payload": 0, "missing_attempt_id": 0}

    def tearDown(self):
        self.temp.cleanup()

    def ledger_records(self):
        if not self.ledger.exists():
            return []
        return [json.loads(line) for line in self.ledger.read_text(encoding="utf-8").splitlines() if line]

    def outbox_args(self, *, with_attempts=True, outbox=None):
        extra = []
        if with_attempts:
            extra += ["--attempts", str(self.attempts)]
        extra += ["--ledger", str(self.ledger), "--prices", str(PRICES),
                  "--source", "outbox", "--outbox", str(outbox or self.outbox)]
        return tuple(extra)

    def test_outbox_landed_event_builds_schema_valid_ledger_record(self):
        write_event(self.outbox, "evt-1", landed_event(
            "att-out-1", {"inputTokens": 7500, "cachedReadTokens": 0, "outputTokens": 10},
            brief={"project": "demo", "role": "work", "card_id": "card-out-1", "run_id": "run-out-1"}))
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["sources"], {"outbox": "ok"})
        self.assertNotIn("attempts_dir", status)
        self.assertEqual(status["outbox_files"], 1)
        self.assertEqual(status["outbox_events"], 1)
        self.assertEqual(status["outbox_records"], 1)
        self.assertEqual(status["outbox_skipped"], self.zero_skipped)
        self.assertEqual(status["added"], 1)
        self.assertEqual(status["parse_errors"], [])
        records = self.ledger_records()
        self.assertEqual([record["key"] for record in records], ["attempt:att-out-1"])
        record = records[0]
        self.assertEqual(record["schema_version"], "bee.usage/v1")
        self.assertTrue(ledger.validate_record(record, USAGE_SCHEMA), record["key"])
        self.assertEqual(record["route"], "deepseek")
        self.assertEqual(record["provider"], "deepseek")
        self.assertEqual(record["input_tokens"], 7500)
        self.assertEqual(record["cache_read_tokens"], 0)
        self.assertEqual(record["output_tokens"], 10)
        self.assertEqual(record["ts_start"], "2026-11-16T12:00:00Z")
        self.assertIsNone(record["ts_end"])
        self.assertIsNone(record["duration_s"])
        self.assertEqual(record["cost_status"], "estimated")
        self.assertGreater(record["cost_usd_list"], 0)

    def test_outbox_zoo_event_preserves_zoo_identity_and_unknown_cost(self):
        write_event(self.outbox, "evt-zoo", landed_event(
            "att-zoo-out", {"prompt_tokens": 20, "completion_tokens": 66},
            model="zoo:glm-5.3-flash", launcher="0.1.17",
            brief={"project": "demo", "role": "work", "card_id": "card-zoo", "run_id": "run-zoo"}))
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["added"], 1)
        record = self.ledger_records()[0]
        self.assertTrue(ledger.validate_record(record, USAGE_SCHEMA), record["key"])
        self.assertEqual(record["route"], "zoo")
        self.assertEqual(record["route_source"], "explicit")
        self.assertEqual(record["provider"], "zoo")
        self.assertEqual(record["gen_ai.provider.name"], "zoo")
        self.assertEqual(record["requested_model"], "zoo:glm-5.3-flash")
        self.assertEqual(record["input_tokens"], 20)
        self.assertEqual(record["output_tokens"], 66)
        self.assertIsNone(record["cost_usd_list"])
        self.assertEqual(record["cost_status"], "unknown")
        self.assertIsNone(record["price_table_version"])
        self.assertEqual(record["billing_mode"], "unknown")

    def test_outbox_fallback_preserves_deepseek_route(self):
        write_event(self.outbox, "evt-fb", landed_event(
            "att-fb", {"inputTokens": 100, "cachedReadTokens": 0, "outputTokens": 5},
            model="zoo:glm-5.3-flash", launcher="0.1.17",
            fallback={"to": "deepseek:deepseek-flash"},
            brief={"project": "demo", "role": "work", "card_id": "card-fb", "run_id": "run-fb"}))
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertEqual(status["added"], 1)
        record = self.ledger_records()[0]
        self.assertEqual(record["route"], "deepseek")
        self.assertEqual(record["route_source"], "explicit")
        self.assertEqual(record["provider"], "deepseek")
        self.assertEqual(record["fallback"], "deepseek")
        self.assertEqual(record["retry_count"], 1)

    def test_outbox_events_without_usage_payload_are_skipped_and_counted(self):
        write_event(self.outbox, "evt-none", landed_event("att-none"))
        write_event(self.outbox, "evt-null",
                    landed_event("att-null", payload={"observed": {"usage": None}}))
        write_event(self.outbox, "evt-empty", landed_event("att-empty", {}))
        write_event(self.outbox, "evt-junk", landed_event("att-junk", {"not_tokens": 5}))
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["outbox_events"], 4)
        self.assertEqual(status["outbox_records"], 0)
        self.assertEqual(status["outbox_skipped"],
                         {"unrelated_type": 0, "no_usage_payload": 4, "missing_attempt_id": 0})
        self.assertEqual(status["added"], 0)
        self.assertEqual(self.ledger_records(), [])

    def test_outbox_unrelated_type_missing_attempt_id_and_torn_file_are_counted(self):
        other = landed_event("att-x", {"inputTokens": 1, "outputTokens": 1})
        other["type"] = "rizzstack.bee.dropped.v1"
        write_event(self.outbox, "evt-other", other)
        write_event(self.outbox, "evt-no-id", landed_event(None, {"inputTokens": 1, "outputTokens": 1}))
        self.outbox.mkdir(parents=True, exist_ok=True)
        (self.outbox / "evt-torn.json").write_text(
            '{"type": "rizzstack.bee.landed.v1", "paylo', encoding="utf-8")
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["outbox_events"], 2)
        self.assertEqual(status["outbox_records"], 0)
        self.assertEqual(status["outbox_skipped"],
                         {"unrelated_type": 1, "no_usage_payload": 0, "missing_attempt_id": 1})
        self.assertEqual(status["parse_errors"], [{"event": "evt-torn", "reason": "parse_failure"}])
        self.assertEqual(status["added"], 0)
        self.assertEqual(self.ledger_records(), [])

    def test_receipts_and_outbox_compose_without_double_counting(self):
        write_receipt(self.attempts, "att-both", {"inputTokens": 111, "outputTokens": 5})
        write_event(self.outbox, "evt-both",
                    landed_event("att-both", {"prompt_tokens": 999, "completion_tokens": 999}))
        write_receipt(self.attempts, "att-only-launcher", {"inputTokens": 10, "outputTokens": 5})
        write_event(self.outbox, "evt-only-outbox",
                    landed_event("att-only-outbox", {"inputTokens": 7, "outputTokens": 3}))
        first = run_service("once", *self.outbox_args(with_attempts=True))
        self.assertEqual(first.returncode, 0, first.stderr)
        status = status_lines(first.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["sources"], {"launcher_attempts": "ok", "outbox": "ok"})
        self.assertEqual(status["receipt_pairs"], 2)
        self.assertEqual(status["outbox_records"], 2)
        self.assertEqual(status["added"], 3)
        self.assertEqual(status["skipped"], 1)
        records = {record["key"]: record for record in self.ledger_records()}
        self.assertEqual(sorted(records),
                         ["attempt:att-both", "attempt:att-only-launcher", "attempt:att-only-outbox"])
        self.assertEqual(records["attempt:att-both"]["input_tokens"], 111)
        second = run_service("once", *self.outbox_args(with_attempts=True))
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(status_lines(second.stdout)[-1]["added"], 0)
        self.assertEqual(len(self.ledger_records()), 3)

    def test_outbox_backfill_is_idempotent(self):
        write_event(self.outbox, "evt-b1", landed_event("att-b1", {"inputTokens": 5, "outputTokens": 1}))
        write_event(self.outbox, "evt-b2", landed_event("att-b2", {"inputTokens": 6, "outputTokens": 2}))
        first = run_service("backfill", *self.outbox_args(with_attempts=False))
        second = run_service("backfill", *self.outbox_args(with_attempts=False))
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(status_lines(first.stdout)[-1]["mode"], "backfill")
        self.assertEqual(status_lines(first.stdout)[-1]["added"], 2)
        self.assertEqual(status_lines(second.stdout)[-1]["added"], 0)
        self.assertEqual(len(self.ledger_records()), 2)

    def test_outbox_missing_dir_is_recorded_missing(self):
        result = run_service("once", *self.outbox_args(with_attempts=False,
                                                        outbox=self.dir / "nope"))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["sources"], {"outbox": "missing"})
        self.assertEqual(status["outbox_files"], 0)
        self.assertEqual(status["added"], 0)
        self.assertEqual(self.ledger_records(), [])

    def test_outbox_default_path_derives_from_home(self):
        home = self.dir / "home"
        env = dict(CLEAN_ENV)
        env["HOME"] = str(home)
        result = run_service("once", "--ledger", str(self.ledger), "--prices", str(PRICES),
                             "--source", "outbox", env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertEqual(status["sources"], {"outbox": "missing"})
        self.assertEqual(status["outbox_dir"],
                         str(home / ".hermes" / "plugin-data" / "bundlebees" / "events" / "outbox"))

    def test_outbox_event_array_file_and_epoch_timestamp(self):
        good = landed_event("att-arr", {"inputTokens": 5, "outputTokens": 1}, ts=1794809207)
        empty = landed_event("att-arr-empty")
        write_event(self.outbox, "evt-batch", [good, empty])
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["outbox_files"], 1)
        self.assertEqual(status["outbox_events"], 2)
        self.assertEqual(status["outbox_records"], 1)
        self.assertEqual(status["outbox_skipped"]["no_usage_payload"], 1)
        records = self.ledger_records()
        self.assertEqual([record["key"] for record in records], ["attempt:att-arr"])
        expected_ts = datetime.fromtimestamp(1794809207, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        self.assertEqual(records[0]["ts_start"], expected_ts)
        self.assertTrue(ledger.validate_record(records[0], USAGE_SCHEMA), records[0]["key"])

    def test_source_selection_validation(self):
        base = ("--ledger", str(self.ledger), "--prices", str(PRICES))
        unknown = run_service("once", *base, "--source", "bogus")
        self.assertEqual(unknown.returncode, 2)
        self.assertIn("bogus", unknown.stderr)
        none = run_service("once", *base)
        self.assertEqual(none.returncode, 2)
        self.assertIn("no ingest source selected", none.stderr)
        missing_attempts = run_service("once", *base, "--source", "receipts")
        self.assertEqual(missing_attempts.returncode, 2)
        self.assertIn("--attempts", missing_attempts.stderr)

    def test_canonical_build_event_envelope_ingests_usage_from_data(self):
        event = canonical_landed_event(
            "att-canonical-zoo", {"prompt_tokens": 20, "completion_tokens": 66},
            backend={"model": "zoo:glm-5.3-flash"})
        write_event(self.outbox, "evt-canonical", event)
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["outbox_events"], 1)
        self.assertEqual(status["outbox_records"], 1)
        self.assertEqual(status["outbox_skipped"], self.zero_skipped)
        self.assertEqual(status["added"], 1)
        self.assertEqual(status["parse_errors"], [])
        records = self.ledger_records()
        self.assertEqual([record["key"] for record in records], ["attempt:att-canonical-zoo"])
        record = records[0]
        self.assertTrue(ledger.validate_record(record, USAGE_SCHEMA), record["key"])
        self.assertEqual(record["attempt_id"], "att-canonical-zoo")
        self.assertEqual(record["route"], "zoo")
        self.assertEqual(record["route_source"], "explicit")
        self.assertEqual(record["provider"], "zoo")
        self.assertEqual(record["gen_ai.provider.name"], "zoo")
        self.assertEqual(record["requested_model"], "zoo:glm-5.3-flash")
        self.assertEqual(record["input_tokens"], 20)
        self.assertEqual(record["output_tokens"], 66)
        self.assertIsNone(record["cost_usd_list"])
        self.assertEqual(record["cost_status"], "unknown")
        self.assertEqual(record["ts_start"], "2026-11-16T12:00:00Z")
        self.assertEqual(record["card_id"], "task-canonical")
        self.assertEqual(record["project"], "feature-demo")
        self.assertEqual(record["run_id"], "job-canonical")
        self.assertTrue(record["join_complete"])

    def test_canonical_envelope_backend_fallback_resolves_deepseek(self):
        event = canonical_landed_event(
            "att-canonical-fb", {"inputTokens": 100, "cachedReadTokens": 0, "outputTokens": 5},
            backend={"model": "deepseek-v4.1-flash", "fallback": "deepseek:deepseek-flash"})
        write_event(self.outbox, "evt-canonical-fb", event)
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["outbox_records"], 1)
        self.assertEqual(status["outbox_skipped"], self.zero_skipped)
        record = self.ledger_records()[0]
        self.assertTrue(ledger.validate_record(record, USAGE_SCHEMA), record["key"])
        self.assertEqual(record["route"], "deepseek")
        self.assertEqual(record["route_source"], "explicit")
        self.assertEqual(record["provider"], "deepseek")
        self.assertEqual(record["fallback"], "deepseek")
        self.assertEqual(record["retry_count"], 1)
        self.assertEqual(record["cost_status"], "estimated")
        self.assertGreater(record["cost_usd_list"], 0)

    def test_canonical_envelope_without_usage_still_skipped(self):
        write_event(self.outbox, "evt-canonical-none", canonical_landed_event("att-canonical-none"))
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["outbox_events"], 1)
        self.assertEqual(status["outbox_records"], 0)
        self.assertEqual(status["outbox_skipped"],
                         {"unrelated_type": 0, "no_usage_payload": 1, "missing_attempt_id": 0})
        self.assertEqual(self.ledger_records(), [])

    def test_canonical_data_state_is_mapped_as_string_not_receipt_dict(self):
        event = canonical_landed_event(
            "att-canonical-state", {"input_tokens": 5, "output_tokens": 1},
            backend={"model": "zoo:glm-5.3-flash"})
        attempt_id, state, result, skip = ingest_service._outbox_parts(event)
        self.assertIsNone(skip)
        self.assertEqual(attempt_id, "att-canonical-state")
        self.assertIsInstance(state, dict)
        self.assertEqual(state.get("state"), "landed")
        self.assertEqual(result["observed"]["usage"], {"input_tokens": 5, "output_tokens": 1})
        self.assertEqual(result["source"]["model"], "zoo:glm-5.3-flash")


    def test_real_captured_event_constants_match_the_producer(self):
        event = REAL_CAPTURED_LANDED_EVENT
        self.assertEqual(event["data"]["schema"], "rizzstack.bee-landed/1")
        self.assertTrue(event["id"].startswith("urn:rizzstack:bee-landed:"))
        self.assertEqual(event["source"], "rizzstack://bundlebees")
        self.assertEqual(event["type"], "rizzstack.bee.landed.v1")
        self.assertEqual(event["specversion"], "1.0")
        self.assertEqual(event["datacontenttype"], "application/json")
        self.assertIn(event["data"]["state"], {"succeeded", "failed", "cancelled", "accepted"})

    def test_real_captured_event_ingests_usage_from_data(self):
        event = json.loads(json.dumps(REAL_CAPTURED_LANDED_EVENT))
        event["data"].setdefault("result", {}).setdefault("observed", {})[
            "usage"] = {"input_tokens": 40, "output_tokens": 9}
        write_event(self.outbox, event["id"], event)
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        status = status_lines(result.stdout)[-1]
        self.assertTrue(status["ok"])
        self.assertEqual(status["outbox_events"], 1)
        self.assertEqual(status["outbox_records"], 1)
        self.assertEqual(status["outbox_skipped"], self.zero_skipped)
        self.assertEqual(status["added"], 1)
        self.assertEqual(status["parse_errors"], [])
        records = self.ledger_records()
        self.assertEqual([r["key"] for r in records], ["attempt:att_c3d1fdc1a72a4f2f"])
        record = records[0]
        self.assertTrue(ledger.validate_record(record, USAGE_SCHEMA), record["key"])
        self.assertEqual(record["input_tokens"], 40)
        self.assertEqual(record["output_tokens"], 9)
        self.assertIsNone(record["cost_usd_list"])
        self.assertEqual(record["cost_status"], "unknown")
        self.assertTrue(record["join_complete"])

    def test_real_captured_event_backend_model_resolves_provider(self):
        event = json.loads(json.dumps(REAL_CAPTURED_LANDED_EVENT))
        event["data"]["backend"] = {"model": "zoo:glm-5.3-flash"}
        event["data"].setdefault("result", {}).setdefault("observed", {})[
            "usage"] = {"input_tokens": 3, "output_tokens": 1}
        write_event(self.outbox, event["id"], event)
        result = run_service("once", *self.outbox_args(with_attempts=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.ledger_records()[0]
        self.assertTrue(ledger.validate_record(record, USAGE_SCHEMA), record["key"])
        self.assertEqual(record["route"], "zoo")
        self.assertEqual(record["route_source"], "explicit")
        self.assertEqual(record["provider"], "zoo")
        self.assertEqual(record["requested_model"], "zoo:glm-5.3-flash")



class UnitFileTests(unittest.TestCase):
    def test_unit_carries_protect_system_strict_class(self):
        text = UNIT.read_text(encoding="utf-8")
        for directive in ("ProtectSystem=strict", "ProtectHome=read-only", "NoNewPrivileges=true",
                          "PrivateTmp=true", "ReadWritePaths=", "UMask=0077"):
            self.assertIn(directive, text, directive)
        # Deliberately ABSENT (each aborts a user unit with exit 218
        # CAPABILITIES before ExecStart on this systemd 255 host, probed
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
