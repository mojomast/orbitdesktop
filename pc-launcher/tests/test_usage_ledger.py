"""Tests for the bee.usage/v1 ledger builder. Stdlib only, no network."""
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

PC_LAUNCHER = Path(__file__).resolve().parents[1]
SCRIPT = PC_LAUNCHER / "scripts" / "usage_ledger.py"
PRICES = PC_LAUNCHER / "prices.json"
sys.path.insert(0, str(PC_LAUNCHER / "scripts"))
import usage_ledger as ledger  # noqa: E402


def epoch(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp()


OFF_PEAK = epoch(2026, 9, 10, 12, 0)
PEAK = epoch(2026, 9, 14, 2, 0)


def write_attempt(directory, attempt_id, usage, *, created=OFF_PEAK, updated=None, model="deepseek-v4.1-flash",
                  launcher="0.1.14", fallback=None, brief=None, rate_limited=0, model_history=None,
                  tool_calls=2, stop_reason="end_turn", error=None, project="demo", result_usage=True):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    updated = created + 60 if updated is None else updated
    state = {
        "attempt_id": attempt_id,
        "state": "done",
        "created_at": created,
        "updated_at": updated,
        "rate_limited": rate_limited,
        "model": model,
        "fallback": fallback,
        "model_history": model_history if model_history is not None else [{"model": model, "at": created}],
        "brief": brief if brief is not None else {"project": project, "role": "work", "label": "task-1"},
        "run_id": "run-abc123",
    }
    (directory / f"{attempt_id}.json").write_text(json.dumps(state), encoding="utf-8")
    if not result_usage:
        return
    result = {
        "schema": "orbit.local-worker.result/v1",
        "attempt_id": attempt_id,
        "source": {"project": project, "kind": "opencode", "model": model, "fallback": fallback, "launcher": launcher},
        "observed": {"usage": usage, "tool_calls": tool_calls, "stop_reason": stop_reason, "error": error},
    }
    (directory / f"{attempt_id}.result.json").write_text(json.dumps(result), encoding="utf-8")


def load_prices():
    return json.loads(PRICES.read_text(encoding="utf-8"))


def sample_record(**overrides):
    record = {
        "bee.route": "deepseek_direct",
        "gen_ai.request.model": "deepseek-v4.1-flash",
        "gen_ai.response.model": "deepseek-v4.1-flash",
        "gen_ai.usage.input_tokens": 1_000_000,
        "gen_ai.usage.cache_read.input_tokens": 0,
        "gen_ai.usage.cache_write.input_tokens": 0,
        "gen_ai.usage.output_tokens": 0,
        "ts_start": "2026-09-10T12:00:00Z",
        "ts_end": None,
    }
    record.update(overrides)
    return record


class NormalizeUsageTests(unittest.TestCase):
    def test_camelcase_json_string_has_no_double_counting(self):
        raw = json.dumps({
            "inputTokens": 140,
            "cachedReadTokens": 49536,
            "outputTokens": 866,
            "thoughtTokens": 163,
            "totalTokens": 50705,
        })
        usage = ledger.normalize_usage(raw)
        self.assertEqual(usage["input_tokens"], 49676)
        self.assertEqual(usage["cache_read_input_tokens"], 49536)
        self.assertEqual(usage["cache_write_input_tokens"], 0)
        self.assertEqual(usage["output_tokens"], 1029)
        self.assertEqual(usage["reasoning_output_tokens"], 163)

    def test_raw_deepseek_usage(self):
        usage = ledger.normalize_usage({
            "prompt_tokens": 1000,
            "prompt_cache_hit_tokens": 400,
            "prompt_cache_miss_tokens": 600,
            "completion_tokens": 200,
            "completion_tokens_details": {"reasoning_tokens": 50},
        })
        self.assertEqual(usage["input_tokens"], 1000)
        self.assertEqual(usage["cache_read_input_tokens"], 400)
        self.assertEqual(usage["cache_write_input_tokens"], 0)
        self.assertEqual(usage["output_tokens"], 200)
        self.assertEqual(usage["reasoning_output_tokens"], 50)

    def test_missing_usage_is_all_null(self):
        usage = ledger.normalize_usage(None)
        self.assertTrue(all(value is None for value in usage.values()))

    def test_snake_case_usage_is_already_canonical(self):
        usage = ledger.normalize_usage({
            "input_tokens": 1000,
            "output_tokens": 200,
            "cache_read_tokens": 400,
            "reasoning_tokens": 50,
        })
        self.assertEqual(usage["input_tokens"], 1000)
        self.assertEqual(usage["cache_read_input_tokens"], 400)
        self.assertEqual(usage["output_tokens"], 200)
        self.assertEqual(usage["reasoning_output_tokens"], 50)


class AttemptRecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.prices = load_prices()

    def tearDown(self):
        self.temp.cleanup()

    def test_camelcase_attempt_prices_off_peak(self):
        raw = json.dumps({
            "inputTokens": 140,
            "cachedReadTokens": 49536,
            "outputTokens": 866,
            "thoughtTokens": 163,
        })
        write_attempt(self.dir, "att-0001", raw, created=OFF_PEAK,
                      brief={"project": "demo", "role": "work", "card_id": "card-123"})
        records = ledger.records_from_attempts(self.dir, prices=self.prices)
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["schema"], "bee.usage/v1")
        self.assertEqual(record["key"], "attempt:att-0001")
        self.assertEqual(record["gen_ai.usage.input_tokens"], 49676)
        self.assertEqual(record["gen_ai.usage.cache_read.input_tokens"], 49536)
        self.assertEqual(record["gen_ai.usage.output_tokens"], 1029)
        self.assertEqual(record["gen_ai.usage.reasoning.output_tokens"], 163)
        self.assertEqual(record["cost"]["price_period"], "off_peak")
        self.assertEqual(record["cost"]["status"], "estimated")
        self.assertEqual(round(record["cost"]["usd"], 6), 0.000787)
        self.assertEqual(record["trace_id"], hashlib.sha256(b"card-123").hexdigest()[:32])
        self.assertEqual(record["role"], "work")
        self.assertEqual(record["gen_ai.agent.name"], "bee-work")

    def test_raw_deepseek_usage_and_numeric_raw(self):
        raw = {
            "prompt_tokens": 1000,
            "prompt_cache_hit_tokens": 400,
            "prompt_cache_miss_tokens": 600,
            "completion_tokens": 200,
            "completion_tokens_details": {"reasoning_tokens": 50},
        }
        write_attempt(self.dir, "att-0002", raw)
        record = ledger.records_from_attempts(self.dir, prices=self.prices)[0]
        self.assertEqual(record["gen_ai.usage.input_tokens"], 1000)
        self.assertEqual(record["gen_ai.usage.cache_read.input_tokens"], 400)
        self.assertEqual(record["gen_ai.usage.output_tokens"], 200)
        self.assertEqual(record["usage_raw"]["completion_tokens_details"]["reasoning_tokens"], 50)

    def test_peak_costs_more_than_off_peak(self):
        usage = {"inputTokens": 1000, "cachedReadTokens": 0, "outputTokens": 500}
        write_attempt(self.dir, "att-off", usage, created=OFF_PEAK)
        write_attempt(self.dir, "att-peak", usage, created=PEAK)
        records = {record["key"]: record for record in ledger.records_from_attempts(self.dir, prices=self.prices)}
        off = records["attempt:att-off"]["cost"]
        peak = records["attempt:att-peak"]["cost"]
        self.assertEqual(off["price_period"], "off_peak")
        self.assertEqual(peak["price_period"], "peak")
        self.assertEqual(off["usd"], 0.00045)
        self.assertEqual(peak["usd"], 0.0009)
        self.assertGreater(peak["usd"], off["usd"])

    def test_attempt_without_result_is_skipped(self):
        write_attempt(self.dir, "att-state", {"inputTokens": 1}, result_usage=False)
        write_attempt(self.dir, "att-done", {"inputTokens": 1, "outputTokens": 1})
        records = ledger.records_from_attempts(self.dir, prices=self.prices)
        self.assertEqual([record["key"] for record in records], ["attempt:att-done"])

    def test_verify_role_from_verify_of(self):
        write_attempt(self.dir, "att-verify", {"inputTokens": 1, "outputTokens": 1},
                      brief={"project": "demo", "verify_of": "att-work-0001"})
        record = ledger.records_from_attempts(self.dir, prices=self.prices)[0]
        self.assertEqual(record["role"], "verify")
        self.assertEqual(record["gen_ai.agent.name"], "bee-verify")
        self.assertEqual(record["verify_of"], "att-work-0001")

    def test_no_objective_http_or_path_leak(self):
        brief = {
            "project": "demo",
            "role": "work",
            "objective": "secret objective marker http_token relative/path keep-out",
            "commands": ["cat relative/path"],
            "label": "task-1",
        }
        write_attempt(self.dir, "att-leak", {"inputTokens": 1, "outputTokens": 1}, brief=brief,
                      error="failed at relative/path via http_token")
        records = ledger.records_from_attempts(self.dir, prices=self.prices)

        parts = []

        def collect(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key != "http_429":
                        parts.append(key)
                    collect(item)
            elif isinstance(value, list):
                for item in value:
                    collect(item)
            elif value is not None:
                parts.append(str(value))

        collect(records)
        blob = "\n".join(parts).lower()
        self.assertNotIn("objective", blob)
        self.assertNotIn("http", blob)
        self.assertNotIn("relative/path", blob)
        self.assertEqual(records[0]["project"], "demo")


class RouteTests(unittest.TestCase):
    def test_explicit_route_markers(self):
        self.assertEqual(ledger.infer_route("go:deepseek-v4.1-flash", None, {}, "0.1.14"), ("go", "explicit"))
        self.assertEqual(ledger.infer_route("deepseek:deepseek-v4.1-flash", None, {}, "0.1.14"),
                         ("deepseek_direct", "explicit"))
        self.assertEqual(ledger.infer_route("other-model", "deepseek", {}, "0.1.14"),
                         ("deepseek_direct", "explicit"))
        self.assertEqual(ledger.infer_route("other-model", {"to": "deepseek:foo"}, {}, "0.1.14"),
                         ("deepseek_direct", "explicit"))
        self.assertEqual(ledger.infer_route("other-model", None, {"priority": "high"}, "0.1.14"),
                         ("deepseek_direct", "explicit"))

    def test_launcher_version_inference(self):
        for version in ("0.1.12", "0.1.13", "0.1.14"):
            self.assertEqual(ledger.infer_route("deepseek-v4.1-flash", None, {}, version),
                             ("deepseek_direct", "inferred"))
        for version in ("0.1.15", "0.1.16", "0.2.0"):
            self.assertEqual(ledger.infer_route("deepseek-v4.1-flash", None, {}, version),
                             ("go", "inferred"))

    def test_unknown_route(self):
        self.assertEqual(ledger.infer_route("some-model", None, {}, "0.1.14"), ("unknown", "inferred"))
        self.assertEqual(ledger.infer_route("deepseek-v4.1-flash", None, {}, "0.1.9"),
                         ("unknown", "inferred"))


class PricesFileTests(unittest.TestCase):
    def test_snapshots_have_exact_rates(self):
        prices = load_prices()
        deepseek = prices["deepseek-pricing-2026-09-10"]
        self.assertEqual(deepseek["source"], "api-docs.deepseek.com/quick_start/pricing")
        for model in ("deepseek-flash", "deepseek-v4.1-flash", "deepseek-v4-flash"):
            rates = deepseek["models"][model]
            self.assertEqual(rates["off_peak"], {"cache_hit": 0.003, "cache_miss": 0.15, "output": 0.60})
            self.assertEqual(rates["peak"], {"cache_hit": 0.006, "cache_miss": 0.30, "output": 1.20})
        pro = deepseek["models"]["deepseek-v4-pro"]
        self.assertEqual(pro["off_peak"], {"cache_hit": 0.022, "cache_miss": 0.66, "output": 1.98})
        self.assertEqual(pro["peak"], {"cache_hit": 0.044, "cache_miss": 1.32, "output": 3.96})

        go = prices["opencode-go-2026-11-12"]
        self.assertEqual(go["source"], "opencode.ai/docs/console/go")
        self.assertEqual(go["billing_mode"], "subscription_allowance")
        self.assertEqual(go["monthly_allowance_usd"], 100)
        self.assertEqual(go["window_share"], {"5h": 0.2, "week": 0.5, "month": 1.0})
        self.assertEqual(go["models"]["deepseek-v4.1-flash"]["off_peak"],
                         {"cache_hit": 0.003, "cache_miss": 0.15, "output": 0.60})
        self.assertIn("not modelled", prices["note"])


class PriceTests(unittest.TestCase):
    def setUp(self):
        self.prices = load_prices()

    def test_go_record_gets_allowance(self):
        record = sample_record(**{
            "bee.route": "go",
            "gen_ai.request.model": "go:deepseek-v4.1-flash",
            "gen_ai.usage.input_tokens": 1_000_000,
            "gen_ai.usage.cache_read.input_tokens": 0,
            "gen_ai.usage.output_tokens": 0,
        })
        cost = ledger.price(record, self.prices)
        self.assertEqual(cost["billing_mode"], "subscription_allowance")
        self.assertEqual(cost["price_version"], "opencode-go-2026-11-12")
        self.assertEqual(cost["usd"], 0.15)
        self.assertEqual(cost["allowance_usd"], 100)
        self.assertEqual(cost["allowance_pct"], 0.15)
        self.assertEqual(cost["status"], "estimated")

    def test_unknown_model_has_null_usd(self):
        record = sample_record(**{"gen_ai.request.model": "mystery-model"})
        cost = ledger.price(record, self.prices)
        self.assertIsNone(cost["usd"])
        self.assertEqual(cost["status"], "unknown")

    def test_missing_tokens_has_null_usd(self):
        record = sample_record(**{"gen_ai.usage.input_tokens": None})
        cost = ledger.price(record, self.prices)
        self.assertIsNone(cost["usd"])
        self.assertEqual(cost["status"], "unknown")

    def test_pro_rates(self):
        record = sample_record(**{
            "gen_ai.request.model": "deepseek-v4-pro",
            "gen_ai.usage.input_tokens": 1_000_000,
            "gen_ai.usage.cache_read.input_tokens": 0,
            "gen_ai.usage.output_tokens": 1_000_000,
        })
        off = ledger.price(record, self.prices)
        self.assertEqual(off["usd"], 2.64)
        peak_record = dict(record, ts_start="2026-09-14T02:00:00Z")
        peak = ledger.price(peak_record, self.prices)
        self.assertEqual(peak["usd"], 5.28)


class HermesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "state.db"
        connection = sqlite3.connect(self.db)
        connection.execute(
            "CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, task TEXT, "
            "api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, "
            "cache_write_tokens INTEGER, reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, "
            "cost_status TEXT, first_seen REAL, last_seen REAL)"
        )
        connection.execute(
            "INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("sess-1", "deepseek-v4.1-flash", "deepseek", "coord", 2, 1000, 200, 500, 0, 50, 999.0, None,
             "estimated", OFF_PEAK, OFF_PEAK + 60),
        )
        connection.commit()
        connection.close()
        self.prices = load_prices()

    def tearDown(self):
        self.temp.cleanup()

    def test_coordinator_mapping_and_recomputed_cost(self):
        records = ledger.records_from_hermes(self.db, prices=self.prices)
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["key"], "coord:sess-1:deepseek-v4.1-flash")
        self.assertEqual(record["role"], "coordinator")
        self.assertEqual(record["gen_ai.agent.name"], "beekeeper")
        self.assertEqual(record["bee.route"], "deepseek_direct")
        self.assertEqual(record["gen_ai.provider.name"], "deepseek")
        self.assertEqual(record["gen_ai.usage.input_tokens"], 1500)
        self.assertEqual(record["gen_ai.usage.cache_read.input_tokens"], 500)
        self.assertEqual(record["gen_ai.usage.output_tokens"], 200)
        self.assertEqual(record["gen_ai.usage.reasoning.output_tokens"], 50)
        self.assertEqual(record["runtime"], {"launcher": None, "harness": "hermes"})
        self.assertEqual(record["usage_raw"]["hermes_estimated_cost_usd"], 999.0)
        self.assertEqual(record["cost"]["usd"], 0.000272)
        self.assertNotEqual(record["cost"]["usd"], 999.0)

    def test_since_filter(self):
        records = ledger.records_from_hermes(self.db, since_epoch=OFF_PEAK + 120, prices=self.prices)
        self.assertEqual(records, [])

    def test_missing_database_is_empty(self):
        self.assertEqual(ledger.records_from_hermes(Path(self.temp.name) / "missing.db"), [])


class AppendAndCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.ledger = self.dir / "nested" / "usage.jsonl"
        self.prices = load_prices()

    def tearDown(self):
        self.temp.cleanup()

    def test_append_is_idempotent(self):
        attempts = self.dir / "attempts"
        write_attempt(attempts, "att-1001", {"inputTokens": 10, "outputTokens": 5})
        records = ledger.records_from_attempts(attempts, prices=self.prices)
        self.assertEqual(ledger.append_new(records, self.ledger), 1)
        self.assertEqual(ledger.append_new(records, self.ledger), 0)
        self.assertEqual(ledger.append_new(records + records, self.ledger), 0)
        self.assertEqual(len(self.ledger.read_text(encoding="utf-8").splitlines()), 1)

    def test_cli_build_twice_is_idempotent(self):
        attempts = self.dir / "attempts"
        write_attempt(attempts, "att-2001", {"inputTokens": 20, "outputTokens": 10})
        command = [sys.executable, str(SCRIPT), "build", "--attempts", str(attempts),
                   "--ledger", str(self.ledger), "--prices", str(PRICES)]
        first = subprocess.run(command, capture_output=True, text=True, check=True)
        second = subprocess.run(command, capture_output=True, text=True, check=True)
        first_line = json.loads(first.stdout.strip().splitlines()[-1])
        second_line = json.loads(second.stdout.strip().splitlines()[-1])
        self.assertEqual(first_line, {"ok": True, "added": 1, "skipped": 0, "ledger_records": 1})
        self.assertEqual(second_line, {"ok": True, "added": 0, "skipped": 1, "ledger_records": 1})

    def test_help_exits_zero(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("build", result.stdout)


if __name__ == "__main__":
    unittest.main()
