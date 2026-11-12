"""Tests for the opt-in bee usage OTLP exporter (no external network)."""
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import usage_otlp  # noqa: E402


def make_record(**overrides):
    record = {
        "schema": "bee.usage/v1",
        "key": "attempt:att-1",
        "ts_start": "2026-01-01T00:00:00Z",
        "ts_end": "2026-01-01T00:00:01.500000Z",
        "duration_s": 1.5,
        "queue_s": 0.0,
        "trace_id": None,
        "project": "proj",
        "card_id": "card-1",
        "run_id": "run-1",
        "role": "work",
        "attempt_id": "att-1",
        "verify_of": None,
        "retry_of": None,
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "bee-work",
        "gen_ai.provider.name": "deepseek",
        "bee.route": "go",
        "bee.route_source": "explicit",
        "gen_ai.request.model": "deepseek-v4.1-flash",
        "gen_ai.response.model": "deepseek-v4.1-flash",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.cache_read.input_tokens": 40,
        "gen_ai.usage.cache_write.input_tokens": 5,
        "gen_ai.usage.output_tokens": 25,
        "gen_ai.usage.reasoning.output_tokens": 10,
        "usage_raw": {"input_tokens": 100, "note": "drop me"},
        "cost": {
            "usd": 0.0125,
            "status": "estimated",
            "billing_mode": "metered",
            "price_version": "p1",
            "price_period": "off_peak",
            "allowance_usd": 1.0,
            "allowance_pct": 1.25,
        },
        "reliability": {
            "http_429": 0,
            "retries": 1,
            "fallback": None,
            "error_type": None,
            "stop_reason": "end_turn",
            "tool_calls": 2,
        },
        "runtime": {"launcher": "v1", "harness": "opencode"},
        "objective_text": "must never leave the ledger",
    }
    record.update(overrides)
    return record


def run_cli(argv):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = usage_otlp.main(argv)
    return code, json.loads(output.getvalue())


class _CaptureServer:
    def __init__(self):
        bodies = self.bodies = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                bodies.append((self.headers.get("Content-Type"), self.rfile.read(length)))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}/v1/traces"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class RecordToSpan(unittest.TestCase):
    def test_attribute_whitelist_drops_usage_raw_and_unknown_keys(self):
        span = usage_otlp.record_to_span(make_record())
        self.assertIsNotNone(span)
        attrs = span["attributes"]
        self.assertIn("gen_ai.usage.input_tokens", attrs)
        self.assertIn("bee.cost.usd", attrs)
        self.assertIn("bee.http_429", attrs)
        self.assertNotIn("usage_raw", attrs)
        self.assertNotIn("objective_text", attrs)
        self.assertNotIn("run_id", attrs)
        self.assertNotIn("cost", attrs)

        allowed = {
            name for name in make_record() if name.startswith("gen_ai.")
        } | {
            "bee.route",
            "bee.role",
            "bee.project",
            "bee.card_id",
            "bee.attempt_id",
            "bee.verify_of",
            "bee.cost.usd",
            "bee.cost.status",
            "bee.cost.billing_mode",
            "bee.cost.price_version",
            "bee.cost.allowance_pct",
            "bee.http_429",
            "bee.retries",
            "bee.fallback",
            "bee.launcher",
        }
        self.assertEqual(set(attrs), {name for name in allowed if name in attrs})
        self.assertTrue(set(attrs).issubset(allowed))

    def test_ids_are_deterministic(self):
        record = make_record(trace_id=None)
        key = record["key"]
        first = usage_otlp.record_to_span(record)
        second = usage_otlp.record_to_span(record)
        self.assertEqual(first["trace_id"], hashlib.sha256(key.encode()).hexdigest()[:32])
        self.assertEqual(first["span_id"], hashlib.sha256(key.encode()).hexdigest()[:16])
        self.assertEqual((first["trace_id"], first["span_id"]), (second["trace_id"], second["span_id"]))

    def test_supplied_trace_id_is_used(self):
        trace = "a" * 32
        span = usage_otlp.record_to_span(make_record(trace_id=trace))
        self.assertEqual(span["trace_id"], trace)

    def test_null_attributes_are_omitted(self):
        record = make_record(
            project=None,
            verify_of=None,
            **{
                "gen_ai.response.model": None,
                "cost": {
                    "usd": None,
                    "status": "unknown",
                    "billing_mode": "subscription_allowance",
                    "price_version": None,
                    "allowance_usd": None,
                    "allowance_pct": None,
                },
                "reliability": {
                    "http_429": None,
                    "retries": None,
                    "fallback": None,
                    "error_type": None,
                },
                "runtime": {"launcher": None, "harness": "opencode"},
            },
        )
        attrs = usage_otlp.record_to_span(record)["attributes"]
        for missing in (
            "bee.project",
            "bee.verify_of",
            "bee.cost.usd",
            "bee.cost.price_version",
            "bee.cost.allowance_pct",
            "bee.http_429",
            "bee.retries",
            "bee.fallback",
            "bee.launcher",
            "gen_ai.response.model",
        ):
            self.assertNotIn(missing, attrs)

    def test_missing_timestamp_uses_the_other_and_both_missing_skips(self):
        only_end = usage_otlp.record_to_span(make_record(ts_start=None))
        self.assertEqual(only_end["start_ns"], only_end["end_ns"])
        only_start = usage_otlp.record_to_span(make_record(ts_end=None))
        self.assertEqual(only_start["start_ns"], only_start["end_ns"])
        self.assertIsNone(usage_otlp.record_to_span(make_record(ts_start=None, ts_end=None)))

    def test_error_type_sets_error_status(self):
        span = usage_otlp.record_to_span(
            make_record(reliability={"http_429": 2, "retries": 1, "error_type": "timeout"})
        )
        self.assertEqual(span["status"]["code"], "ERROR")


class OtlpBody(unittest.TestCase):
    def test_int_and_double_attribute_typing_and_resource_scope(self):
        span = usage_otlp.record_to_span(make_record())
        body = usage_otlp.build_otlp_json([span])
        resource = body["resourceSpans"][0]["resource"]["attributes"]
        self.assertIn({"key": "service.name", "value": {"stringValue": "orbit-bees"}}, resource)
        self.assertIn(
            {"key": "openinference.project.name", "value": {"stringValue": "bees"}}, resource
        )
        scope = body["resourceSpans"][0]["scopeSpans"][0]["scope"]["name"]
        self.assertEqual(scope, "orbit-bees.usage_otlp")

        exported = body["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
        self.assertEqual(len(exported["traceId"]), 32)
        self.assertEqual(len(exported["spanId"]), 16)
        self.assertIsInstance(exported["startTimeUnixNano"], str)
        self.assertIsInstance(exported["endTimeUnixNano"], str)
        attributes = {item["key"]: item["value"] for item in exported["attributes"]}
        self.assertEqual(attributes["gen_ai.usage.input_tokens"], {"intValue": 100})
        self.assertEqual(attributes["bee.cost.usd"], {"doubleValue": 0.0125})
        self.assertEqual(attributes["bee.cost.allowance_pct"], {"doubleValue": 1.25})
        self.assertEqual(attributes["bee.http_429"], {"intValue": 0})
        self.assertEqual(attributes["bee.route"], {"stringValue": "go"})
        self.assertNotIn("usage_raw", attributes)


class ExportBehaviour(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ledger = Path(self.temp.name) / "usage.jsonl"
        self.ledger.write_text(
            "\n".join(json.dumps(make_record(key=f"attempt:{i}", attempt_id=f"att-{i}")) for i in range(3))
            + "\n",
            encoding="utf-8",
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_disabled_without_endpoint(self):
        with mock.patch.dict("os.environ", {"BEE_USAGE_OTLP_ENDPOINT": ""}):
            code, result = run_cli(["export", "--ledger", str(self.ledger)])
        self.assertEqual(code, 0)
        self.assertEqual(result, {"ok": True, "exported": 0, "reason": "disabled"})

    def test_loopback_only_refusal(self):
        endpoint = "http://192.0.2.10:4318/v1/traces"
        code, result = run_cli(["export", "--ledger", str(self.ledger), "--endpoint", endpoint])
        self.assertEqual(code, 1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "NonLoopbackEndpoint")
        self.assertTrue(usage_otlp._is_loopback_endpoint("http://localhost:4318/v1/traces"))
        self.assertTrue(usage_otlp._is_loopback_endpoint("http://127.0.0.1:4318/v1/traces"))
        self.assertTrue(usage_otlp._is_loopback_endpoint("http://[::1]:4318/v1/traces"))
        self.assertFalse(usage_otlp._is_loopback_endpoint(endpoint))

    def test_dry_run_reports_count_and_size_without_sending(self):
        server = _CaptureServer()
        try:
            code, result = run_cli(
                [
                    "export",
                    "--ledger",
                    str(self.ledger),
                    "--endpoint",
                    server.endpoint,
                    "--dry-run",
                ]
            )
        finally:
            server.close()
        self.assertEqual(code, 0)
        self.assertEqual(result["spans"], 3)
        self.assertGreater(result["bytes"], 0)
        self.assertEqual(result["exported"], 0)
        self.assertEqual(server.bodies, [])
        self.assertFalse(Path(str(self.ledger) + ".otlp-state.json").exists())

    def test_json_post_and_state_dedupe(self):
        server = _CaptureServer()
        state = Path(self.temp.name) / "state.json"
        try:
            with mock.patch.object(usage_otlp, "_sdk_available", return_value=False):
                code, first = run_cli(
                    [
                        "export",
                        "--ledger",
                        str(self.ledger),
                        "--endpoint",
                        server.endpoint,
                        "--state",
                        str(state),
                    ]
                )
                self.assertEqual((code, first), (0, {"ok": True, "exported": 3}))
                self.assertEqual(len(server.bodies), 1)
                content_type, body = server.bodies[0]
                self.assertEqual(content_type, "application/json")
                posted = json.loads(body)
                spans = posted["resourceSpans"][0]["scopeSpans"][0]["spans"]
                self.assertEqual(len(spans), 3)
                posted_keys = {
                    item["key"]
                    for span in spans
                    for item in span["attributes"]
                }
                self.assertIn("gen_ai.usage.input_tokens", posted_keys)
                self.assertNotIn("usage_raw", posted_keys)
                self.assertNotIn("objective_text", posted_keys)

                code, second = run_cli(
                    [
                        "export",
                        "--ledger",
                        str(self.ledger),
                        "--endpoint",
                        server.endpoint,
                        "--state",
                        str(state),
                    ]
                )
                self.assertEqual((code, second), (0, {"ok": True, "exported": 0}))
                self.assertEqual(len(server.bodies), 1)
        finally:
            server.close()

        saved = json.loads(state.read_text(encoding="utf-8"))
        self.assertEqual(len(saved["exported"]), 3)

    def test_batches_are_capped_at_one_hundred(self):
        ledger = Path(self.temp.name) / "many.jsonl"
        ledger.write_text(
            "\n".join(json.dumps(make_record(key=f"attempt:{i}")) for i in range(150)) + "\n",
            encoding="utf-8",
        )
        server = _CaptureServer()
        try:
            with mock.patch.object(usage_otlp, "_sdk_available", return_value=False):
                code, result = run_cli(
                    [
                        "export",
                        "--ledger",
                        str(ledger),
                        "--endpoint",
                        server.endpoint,
                        "--state",
                        str(Path(self.temp.name) / "many.state.json"),
                    ]
                )
        finally:
            server.close()
        self.assertEqual(code, 0)
        self.assertEqual(result["exported"], 150)
        self.assertEqual(len(server.bodies), 2)
        counts = [len(json.loads(body)["resourceSpans"][0]["scopeSpans"][0]["spans"]) for _, body in server.bodies]
        self.assertEqual(counts, [100, 50])


if __name__ == "__main__":
    unittest.main()
