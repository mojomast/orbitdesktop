"""Tests for the opt-in bee usage OTLP exporter (no external network)."""
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import usage_otlp  # noqa: E402


def make_record(**overrides):
    record = {
        "schema_version": "bee.usage/v1",
        "key": "attempt:att-1",
        "attempt_id": "att-1",
        "card_id": "card-1",
        "run_id": "run-1",
        "project": "proj",
        "role": "work",
        "join_complete": True,
        "verify_of": None,
        "retry_of": None,
        "ts_start": "2026-01-01T00:00:00Z",
        "ts_end": "2026-01-01T00:00:01.500000Z",
        "duration_s": 1.5,
        "queue_s": 0.0,
        "trace_id": None,
        "requested_model": "deepseek-v4.1-flash",
        "served_model": "deepseek-v4.1-flash",
        "served_model_source": "explicit",
        "provider": "deepseek",
        "route": "go",
        "route_source": "explicit",
        "fallback": None,
        "fallback_reason": None,
        "http_429_count": 0,
        "retry_count": 1,
        "error_type": None,
        "stop_reason": "end_turn",
        "tool_calls": 2,
        "usage_status": "known",
        "input_tokens": 100,
        "cache_read_tokens": 40,
        "cache_write_tokens": 5,
        "output_tokens": 25,
        "reasoning_tokens": 10,
        "usage_raw": {"input_tokens": 100, "note": "drop me"},
        "cost_usd_list": 0.0125,
        "cost_status": "estimated",
        "billing_mode": "metered",
        "price_table_version": "p1",
        "price_period": "off_peak",
        "go_allowance": {
            "raw": {"allowance": "drop me"},
            "pct_used": 1.25,
            "pct_source": "opencode.allowance",
            "allowance_usd": 1.0,
        },
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "bee-work",
        "gen_ai.provider.name": "deepseek",
        "gen_ai.request.model": "deepseek-v4.1-flash",
        "gen_ai.response.model": "deepseek-v4.1-flash",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.cache_read.input_tokens": 40,
        "gen_ai.usage.cache_write.input_tokens": 5,
        "gen_ai.usage.output_tokens": 25,
        "gen_ai.usage.reasoning.output_tokens": 10,
        "launcher": "v1",
        "harness": "opencode",
        "objective_text": "must never leave the ledger",
    }
    record.update(overrides)
    return record


def run_cli(argv):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = usage_otlp.main(argv)
    return code, json.loads(output.getvalue())


class _FakeOtel:
    def __init__(self):
        self.modules = {}
        self.readable_spans = []
        self.exporters = []


def _install_fake_otel() -> _FakeOtel:
    """Register a minimal in-memory OpenTelemetry SDK for the send path."""
    fake = _FakeOtel()

    def add(name, **attrs):
        module = types.ModuleType(name)
        module.__path__ = []
        for key, value in attrs.items():
            setattr(module, key, value)
        fake.modules[name] = module
        return module

    class TraceFlags:
        SAMPLED = 1

        def __init__(self, flags=0):
            self.flags = flags

    class SpanContext:
        def __init__(self, trace_id, span_id, is_remote=False, trace_flags=None):
            self.trace_id = trace_id
            self.span_id = span_id
            self.is_remote = is_remote
            self.trace_flags = trace_flags

    class SpanKind:
        INTERNAL = "INTERNAL"

    class StatusCode:
        ERROR = "ERROR"
        UNSET = "UNSET"

    class Status:
        def __init__(self, status_code):
            self.status_code = status_code

    class Resource:
        def __init__(self, attributes):
            self.attributes = attributes

        @classmethod
        def create(cls, attributes):
            return cls(dict(attributes))

    class ReadableSpan:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            for key, value in kwargs.items():
                setattr(self, key, value)
            fake.readable_spans.append(self)

    class SpanExportResult:
        SUCCESS = "success"

    class OTLPSpanExporter:
        def __init__(self, endpoint=None, timeout=None):
            self.endpoint = endpoint
            self.timeout = timeout
            self.exported = []
            self.shutdown_called = False
            fake.exporters.append(self)

        def export(self, spans):
            self.exported = list(spans)
            return SpanExportResult.SUCCESS

        def shutdown(self):
            self.shutdown_called = True

    otel = add("opentelemetry")
    trace = add(
        "opentelemetry.trace",
        TraceFlags=TraceFlags,
        SpanContext=SpanContext,
        SpanKind=SpanKind,
        Status=Status,
        StatusCode=StatusCode,
    )
    exporter = add("opentelemetry.exporter")
    otlp = add("opentelemetry.exporter.otlp")
    proto = add("opentelemetry.exporter.otlp.proto")
    http = add("opentelemetry.exporter.otlp.proto.http")
    trace_exporter = add(
        "opentelemetry.exporter.otlp.proto.http.trace_exporter",
        OTLPSpanExporter=OTLPSpanExporter,
    )
    sdk = add("opentelemetry.sdk")
    resources = add("opentelemetry.sdk.resources", Resource=Resource)
    sdk_trace = add("opentelemetry.sdk.trace", ReadableSpan=ReadableSpan)
    sdk_export = add("opentelemetry.sdk.trace.export", SpanExportResult=SpanExportResult)

    otel.trace = trace
    otel.exporter = exporter
    otel.sdk = sdk
    exporter.otlp = otlp
    otlp.proto = proto
    proto.http = http
    http.trace_exporter = trace_exporter
    sdk.resources = resources
    sdk.trace = sdk_trace
    sdk_trace.export = sdk_export
    return fake


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
    def test_attribute_whitelist_drops_raw_and_unknown_keys(self):
        span = usage_otlp.record_to_span(make_record())
        self.assertIsNotNone(span)
        attrs = span["attributes"]
        self.assertIn("gen_ai.usage.input_tokens", attrs)
        self.assertIn("bee.cost_usd_list", attrs)
        self.assertIn("bee.http_429_count", attrs)
        self.assertIn("bee.go_allowance.pct_used", attrs)
        self.assertNotIn("usage_raw", attrs)
        self.assertNotIn("bee.usage_raw", attrs)
        self.assertNotIn("go_allowance", attrs)
        self.assertNotIn("bee.go_allowance.raw", attrs)
        self.assertNotIn("objective_text", attrs)
        self.assertNotIn("run_id", attrs)
        self.assertNotIn("harness", attrs)
        self.assertNotIn("bee.harness", attrs)
        self.assertNotIn("cost", attrs)
        self.assertNotIn("reliability", attrs)
        self.assertNotIn("runtime", attrs)

        allowed = {name for name in make_record() if name.startswith("gen_ai.")} | {
            "bee.schema_version",
            "bee.route",
            "bee.role",
            "bee.project",
            "bee.card_id",
            "bee.run_id",
            "bee.attempt_id",
            "bee.verify_of",
            "bee.requested_model",
            "bee.served_model",
            "bee.usage_status",
            "bee.cost_usd_list",
            "bee.cost_status",
            "bee.billing_mode",
            "bee.price_table_version",
            "bee.go_allowance.pct_used",
            "bee.http_429_count",
            "bee.retry_count",
            "bee.fallback",
            "bee.fallback_reason",
            "bee.launcher",
        }
        self.assertEqual(set(attrs), {name for name in allowed if name in attrs})
        self.assertTrue(set(attrs).issubset(allowed))

    def test_flat_fields_are_mapped_to_bee_attributes(self):
        attrs = usage_otlp.record_to_span(make_record(run_id="run-9", card_id="card-9"))[
            "attributes"
        ]
        self.assertEqual(attrs["bee.schema_version"], "bee.usage/v1")
        self.assertEqual(attrs["bee.route"], "go")
        self.assertEqual(attrs["bee.run_id"], "run-9")
        self.assertEqual(attrs["bee.card_id"], "card-9")
        self.assertEqual(attrs["bee.requested_model"], "deepseek-v4.1-flash")
        self.assertEqual(attrs["bee.served_model"], "deepseek-v4.1-flash")
        self.assertEqual(attrs["bee.usage_status"], "known")
        self.assertEqual(attrs["bee.cost_usd_list"], 0.0125)
        self.assertEqual(attrs["bee.cost_status"], "estimated")
        self.assertEqual(attrs["bee.billing_mode"], "metered")
        self.assertEqual(attrs["bee.price_table_version"], "p1")
        self.assertEqual(attrs["bee.go_allowance.pct_used"], 1.25)
        self.assertEqual(attrs["bee.http_429_count"], 0)
        self.assertEqual(attrs["bee.retry_count"], 1)
        self.assertEqual(attrs["bee.launcher"], "v1")

    def test_fallback_fields_come_from_flat_record(self):
        attrs = usage_otlp.record_to_span(
            make_record(
                route="deepseek",
                go_allowance=None,
                fallback="deepseek",
                fallback_reason="quota_exhausted",
            )
        )["attributes"]
        self.assertEqual(attrs["bee.fallback"], "deepseek")
        self.assertEqual(attrs["bee.fallback_reason"], "quota_exhausted")
        self.assertNotIn("bee.go_allowance.pct_used", attrs)

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
            requested_model=None,
            served_model=None,
            usage_status=None,
            cost_usd_list=None,
            price_table_version=None,
            http_429_count=None,
            retry_count=None,
            fallback=None,
            fallback_reason=None,
            go_allowance=None,
            launcher=None,
            **{
                "gen_ai.response.model": None,
                "gen_ai.usage.cache_write.input_tokens": None,
            },
        )
        attrs = usage_otlp.record_to_span(record)["attributes"]
        for missing in (
            "bee.project",
            "bee.verify_of",
            "bee.requested_model",
            "bee.served_model",
            "bee.usage_status",
            "bee.cost_usd_list",
            "bee.price_table_version",
            "bee.http_429_count",
            "bee.retry_count",
            "bee.fallback",
            "bee.fallback_reason",
            "bee.go_allowance.pct_used",
            "bee.launcher",
            "gen_ai.response.model",
            "gen_ai.usage.cache_write.input_tokens",
        ):
            self.assertNotIn(missing, attrs)

    def test_missing_timestamp_uses_the_other_and_both_missing_skips(self):
        only_end = usage_otlp.record_to_span(make_record(ts_start=None))
        self.assertEqual(only_end["start_ns"], only_end["end_ns"])
        only_start = usage_otlp.record_to_span(make_record(ts_end=None))
        self.assertEqual(only_start["start_ns"], only_start["end_ns"])
        self.assertIsNone(usage_otlp.record_to_span(make_record(ts_start=None, ts_end=None)))

    def test_error_type_sets_error_status(self):
        span = usage_otlp.record_to_span(make_record(error_type="timeout"))
        self.assertEqual(span["status"]["code"], "ERROR")

    def test_absent_error_type_is_unset(self):
        span = usage_otlp.record_to_span(make_record(error_type=None))
        self.assertEqual(span["status"]["code"], "UNSET")


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
        self.assertEqual(attributes["bee.cost_usd_list"], {"doubleValue": 0.0125})
        self.assertEqual(attributes["bee.go_allowance.pct_used"], {"doubleValue": 1.25})
        self.assertEqual(attributes["bee.http_429_count"], {"intValue": 0})
        self.assertEqual(attributes["bee.retry_count"], {"intValue": 1})
        self.assertEqual(attributes["bee.route"], {"stringValue": "go"})
        self.assertNotIn("usage_raw", attributes)
        self.assertNotIn("bee.go_allowance.raw", attributes)


class SdkPath(unittest.TestCase):
    def test_sdk_path_sets_identity_and_resource(self):
        fake = _install_fake_otel()
        span = usage_otlp.record_to_span(make_record(trace_id="b" * 32))
        with mock.patch.dict(sys.modules, fake.modules):
            self.assertTrue(usage_otlp._sdk_available())
            usage_otlp._send_sdk([span], "http://127.0.0.1:4318/v1/traces", 3.0)

        self.assertEqual(len(fake.exporters), 1)
        exporter = fake.exporters[0]
        self.assertEqual(exporter.endpoint, "http://127.0.0.1:4318/v1/traces")
        self.assertEqual(exporter.timeout, 3.0)
        self.assertTrue(exporter.shutdown_called)
        self.assertEqual(exporter.exported, fake.readable_spans)

        exported = fake.readable_spans[0]
        self.assertEqual(exported.context.trace_id, int("b" * 32, 16))
        self.assertEqual(exported.context.span_id, int(span["span_id"], 16))
        self.assertEqual(exported.start_time, span["start_ns"])
        self.assertEqual(exported.end_time, span["end_ns"])
        self.assertEqual(exported.attributes, span["attributes"])
        self.assertEqual(exported.resource.attributes["service.name"], "orbit-bees")
        self.assertEqual(exported.resource.attributes["openinference.project.name"], "bees")
        self.assertEqual(exported.status.status_code, "UNSET")

    def test_sdk_path_marks_error_status(self):
        fake = _install_fake_otel()
        span = usage_otlp.record_to_span(make_record(error_type="timeout"))
        with mock.patch.dict(sys.modules, fake.modules):
            usage_otlp._send_sdk([span], "http://127.0.0.1:4318/v1/traces", 1.0)
        self.assertEqual(fake.readable_spans[0].status.status_code, "ERROR")

    def test_export_prefers_sdk_when_importable(self):
        fake = _install_fake_otel()
        with tempfile.TemporaryDirectory() as temp:
            ledger = Path(temp) / "usage.jsonl"
            ledger.write_text(json.dumps(make_record()) + "\n", encoding="utf-8")
            with mock.patch.dict(sys.modules, fake.modules):
                with mock.patch.object(usage_otlp, "_post_json") as post_json:
                    code, result = run_cli(
                        [
                            "export",
                            "--ledger",
                            str(ledger),
                            "--endpoint",
                            "http://127.0.0.1:4318/v1/traces",
                            "--state",
                            str(Path(temp) / "state.json"),
                        ]
                    )
        self.assertEqual(code, 0)
        self.assertEqual(result, {"ok": True, "exported": 1})
        post_json.assert_not_called()
        self.assertEqual(len(fake.exporters), 1)
        self.assertEqual(len(fake.readable_spans), 1)


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
                self.assertIn("bee.cost_usd_list", posted_keys)
                self.assertNotIn("usage_raw", posted_keys)
                self.assertNotIn("bee.go_allowance.raw", posted_keys)
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
