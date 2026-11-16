"""Zoo route identity must survive ledger normalization without invented prices."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import usage_ledger as ledger


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


if __name__ == "__main__":
    unittest.main()
