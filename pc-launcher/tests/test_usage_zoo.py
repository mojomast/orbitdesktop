"""Zoo route identity must survive ledger normalization without invented prices."""
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import usage_ledger as ledger

OFF_PEAK_MONDAY_NOON = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc).timestamp()


class ZooUsage(unittest.TestCase):
    def test_explicit_zoo_wins_over_priority(self):
        for model in ("zoo:glm-5.3-flash", "zoo/glm-5.3-flash"):
            self.assertEqual(ledger.infer_route(model, None, {"priority": "high"}, "0.1.17"),
                             ("zoo", "explicit"))
            self.assertEqual(ledger._strip_route_prefix(model), "glm-5.3-flash")

    def test_recorded_deepseek_fallback_remains_deepseek(self):
        self.assertEqual(ledger.infer_route("zoo:glm-5.3-flash", {"to": "deepseek:deepseek-flash"}, {}, "0.1.17"),
                         ("deepseek", "explicit"))

    def test_zoo_does_not_borrow_deepseek_prices(self):
        record = {"route": "zoo", "gen_ai.request.model": "zoo:deepseek-flash",
                  "gen_ai.usage.input_tokens": 1000,
                  "gen_ai.usage.cache_read.input_tokens": 0,
                  "gen_ai.usage.output_tokens": 100, "ts_start": "2026-11-16T06:00:00Z"}
        result = ledger.price(record)
        self.assertIsNone(result["cost_usd_list"])
        self.assertIsNone(result["price_table_version"])
        self.assertEqual(result["cost_status"], "unknown")
        self.assertEqual(result["billing_mode"], "unknown")

    def test_zoo_attempt_is_schema_valid_and_preserves_real_usage(self):
        state = {"model": "zoo:glm-5.3-flash", "created_at": 1794809207,
                 "updated_at": 1794809232,
                 "brief": {"project": "smoke", "label": "T1", "run_id": "r1"}}
        result = {"source": {"model": state["model"], "launcher": "0.1.17"},
                  "observed": {"usage": {"prompt_tokens": 20, "completion_tokens": 66}}}
        record = ledger._attempt_record("att_zoo", state, result)
        schema = json.loads((ROOT / "usage-schema.v1.json").read_text(encoding="utf-8"))
        self.assertTrue(ledger.validate_record(record, schema))
        self.assertEqual(record["route"], "zoo")
        self.assertEqual(record["provider"], "zoo")
        self.assertEqual(record["input_tokens"], 20)
        self.assertEqual(record["output_tokens"], 66)
        self.assertEqual(record["cost_status"], "unknown")

    def test_missing_zoo_usage_stays_unknown(self):
        record = ledger._attempt_record("att_zoo", {"model": "zoo:glm-5.3-flash"}, {})
        self.assertIsNone(record["input_tokens"])
        self.assertIsNone(record["output_tokens"])
        self.assertEqual(record["usage_status"], "unknown")

    def test_hermes_zoo_billed_probe_row_is_not_priced_from_deepseek(self):
        row = {
            "session_id": "sess-zoo-probe",
            "model": "deepseek-v4.1-flash",
            "billing_provider": "zoo",
            "task": "coord",
            "input_tokens": 3500,
            "cache_read_tokens": 4000,
            "cache_write_tokens": 0,
            "output_tokens": 10,
            "reasoning_tokens": 0,
            "first_seen": OFF_PEAK_MONDAY_NOON,
            "last_seen": OFF_PEAK_MONDAY_NOON + 60,
        }
        record = ledger._hermes_record(dict(row))
        self.assertEqual(record["route"], "zoo")
        self.assertEqual(record["route_source"], "explicit")
        self.assertEqual(record["provider"], "zoo")
        self.assertEqual(record["gen_ai.provider.name"], "zoo")
        self.assertIsNone(record["cost_usd_list"])
        self.assertEqual(record["cost_status"], "unknown")
        self.assertIsNone(record["price_table_version"])
        self.assertEqual(record["billing_mode"], "unknown")
        self.assertTrue(ledger.validate_record(record, ledger._load_schema()))

    def test_hermes_unknown_billing_provider_stays_unpriced(self):
        row = {
            "session_id": "sess-other",
            "model": "deepseek-v4.1-flash",
            "billing_provider": "mystery",
            "task": "coord",
            "input_tokens": 3500,
            "cache_read_tokens": 4000,
            "cache_write_tokens": 0,
            "output_tokens": 10,
            "reasoning_tokens": 0,
            "first_seen": OFF_PEAK_MONDAY_NOON,
            "last_seen": OFF_PEAK_MONDAY_NOON + 60,
        }
        record = ledger._hermes_record(dict(row))
        self.assertEqual(record["route"], "unknown")
        self.assertEqual(record["provider"], "unknown")
        self.assertIsNone(record["cost_usd_list"])
        self.assertEqual(record["cost_status"], "unknown")
        self.assertIsNone(record["price_table_version"])

    def test_unknown_route_is_never_priced_from_deepseek(self):
        record = {"route": "unknown", "gen_ai.request.model": "deepseek-v4.1-flash",
                  "gen_ai.usage.input_tokens": 7500,
                  "gen_ai.usage.cache_read.input_tokens": 4000,
                  "gen_ai.usage.output_tokens": 10, "ts_start": "2026-11-16T12:00:00Z"}
        result = ledger.price(record)
        self.assertIsNone(result["cost_usd_list"])
        self.assertIsNone(result["price_table_version"])
        self.assertEqual(result["cost_status"], "unknown")

    def test_hermes_zoo_row_prices_from_zoo_table_when_present(self):
        prices = {
            "zoo-pricing-2026-11-16": {
                "price_version": "zoo-pricing-2026-11-16",
                "billing_mode": "metered",
                "models": {
                    "glm-5.3-flash": {
                        "off_peak": {"cache_hit": 0.002, "cache_miss": 0.20, "output": 0.90},
                        "peak": {"cache_hit": 0.004, "cache_miss": 0.40, "output": 1.80},
                    }
                },
            }
        }
        row = {
            "session_id": "sess-zoo-priced",
            "model": "zoo:glm-5.3-flash",
            "billing_provider": "zoo",
            "task": "coord",
            "input_tokens": 1_000_000,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "first_seen": OFF_PEAK_MONDAY_NOON,
            "last_seen": OFF_PEAK_MONDAY_NOON + 60,
        }
        record = ledger._hermes_record(dict(row), prices)
        self.assertEqual(record["route"], "zoo")
        self.assertEqual(record["provider"], "zoo")
        self.assertEqual(record["price_table_version"], "zoo-pricing-2026-11-16")
        self.assertEqual(record["cost_status"], "estimated")
        self.assertEqual(record["cost_usd_list"], 0.2)
        self.assertEqual(record["billing_mode"], "metered")

    def test_zoo_model_missing_from_zoo_table_stays_unknown(self):
        prices = {
            "zoo-pricing-2026-11-16": {
                "price_version": "zoo-pricing-2026-11-16",
                "billing_mode": "metered",
                "models": {
                    "glm-5.3-flash": {
                        "off_peak": {"cache_hit": 0.002, "cache_miss": 0.20, "output": 0.90},
                        "peak": {"cache_hit": 0.004, "cache_miss": 0.40, "output": 1.80},
                    }
                },
            }
        }
        record = {"route": "zoo", "gen_ai.request.model": "glm-9-unicorn",
                  "gen_ai.usage.input_tokens": 1000,
                  "gen_ai.usage.cache_read.input_tokens": 0,
                  "gen_ai.usage.output_tokens": 10, "ts_start": "2026-11-16T12:00:00Z"}
        result = ledger.price(record, prices)
        self.assertIsNone(result["cost_usd_list"])
        self.assertEqual(result["cost_status"], "unknown")


if __name__ == "__main__":
    unittest.main()
