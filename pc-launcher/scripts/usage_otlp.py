#!/usr/bin/env python3
"""Opt-in OTLP/HTTP exporter for canonical ``bee.usage/v1`` JSONL ledgers.

The exporter is deliberately narrow: records are turned into OpenTelemetry
GenAI spans and only a fixed whitelist of numeric/identifier attributes is
emitted. Prompt text, completions, tool arguments and file contents never leave
the ledger.

    python3 usage_otlp.py export --ledger usage.jsonl --endpoint URL

Export does nothing unless --endpoint or BEE_USAGE_OTLP_ENDPOINT is set.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

SCHEMA = "bee.usage/v1"
BATCH_SIZE = 100
TIMEOUT_S = 10.0
STATE_VERSION = 1
SERVICE_NAME = "orbit-bees"
PROJECT_NAME = "bees"
SCOPE_NAME = "orbit-bees.usage_otlp"
_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}

_FLAT_ATTRIBUTES = {
    "bee.schema_version": "schema_version",
    "bee.route": "route",
    "bee.role": "role",
    "bee.project": "project",
    "bee.card_id": "card_id",
    "bee.run_id": "run_id",
    "bee.attempt_id": "attempt_id",
    "bee.verify_of": "verify_of",
    "bee.requested_model": "requested_model",
    "bee.served_model": "served_model",
    "bee.usage_status": "usage_status",
    "bee.cost_usd_list": "cost_usd_list",
    "bee.cost_status": "cost_status",
    "bee.billing_mode": "billing_mode",
    "bee.price_table_version": "price_table_version",
    "bee.http_429_count": "http_429_count",
    "bee.retry_count": "retry_count",
    "bee.fallback": "fallback",
    "bee.fallback_reason": "fallback_reason",
    "bee.launcher": "launcher",
}

_SDK_MODULES = (
    "opentelemetry.sdk.resources",
    "opentelemetry.sdk.trace",
    "opentelemetry.sdk.trace.export",
    "opentelemetry.exporter.otlp.proto.http.trace_exporter",
    "opentelemetry.trace",
)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _parse_ts(value) -> int | None:
    """Return UNIX nanoseconds for an ISO-8601 UTC timestamp, else None."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    delta = dt - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1_000_000_000 + delta.microseconds * 1000


def record_to_span(record: dict) -> dict | None:
    """Project one canonical flat ``bee.usage/v1`` record to a span dictionary.

    Returns None when the record has no usable key or no timestamp at all.
    Only whitelisted attributes are copied; ``usage_raw``, ``go_allowance.raw``
    and arbitrary record keys are intentionally ignored.
    """
    if not isinstance(record, dict):
        return None
    key = record.get("key")
    if not isinstance(key, str) or not key:
        return None

    start_ns = _parse_ts(record.get("ts_start"))
    end_ns = _parse_ts(record.get("ts_end"))
    if start_ns is None and end_ns is None:
        return None
    if start_ns is None:
        start_ns = end_ns
    if end_ns is None:
        end_ns = start_ns

    supplied_trace = record.get("trace_id")
    if isinstance(supplied_trace, str) and _HEX32.match(supplied_trace.lower()):
        trace_id = supplied_trace.lower()
    else:
        trace_id = _sha256(key)[:32]

    attributes: dict[str, object] = {}
    for name, value in record.items():
        if name.startswith("gen_ai.") and value is not None:
            attributes[name] = value

    for attribute, field in _FLAT_ATTRIBUTES.items():
        value = record.get(field)
        if value is not None:
            attributes[attribute] = value

    go_allowance = record.get("go_allowance")
    if isinstance(go_allowance, dict):
        pct_used = go_allowance.get("pct_used")
        if pct_used is not None:
            attributes["bee.go_allowance.pct_used"] = pct_used

    error_type = record.get("error_type")
    status_code = "ERROR" if error_type is not None else "UNSET"

    agent_name = record.get("gen_ai.agent.name") or ""
    return {
        "name": "invoke_agent " + str(agent_name),
        "trace_id": trace_id,
        "span_id": _sha256(key)[:16],
        "parent": None,
        "start_ns": start_ns,
        "end_ns": end_ns,
        "status": {"code": status_code},
        "attributes": attributes,
    }


def _otlp_value(value):
    """Convert a whitelisted scalar to an OTLP AnyValue, or None if unsupported."""
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": value}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    return None


def _otlp_attributes(attributes: dict) -> list:
    values = []
    for key in sorted(attributes):
        value = _otlp_value(attributes[key])
        if value is not None:
            values.append({"key": key, "value": value})
    return values


def _otlp_status_code(code) -> str:
    return {
        "ERROR": "STATUS_CODE_ERROR",
        "OK": "STATUS_CODE_OK",
    }.get(str(code).upper(), "STATUS_CODE_UNSET")


def build_otlp_json(spans) -> dict:
    """Build an OTLP/HTTP JSON export request for internal span dictionaries."""
    otlp_spans = []
    for span in spans:
        item = {
            "traceId": span["trace_id"],
            "spanId": span["span_id"],
            "name": span["name"],
            "startTimeUnixNano": str(span["start_ns"]),
            "endTimeUnixNano": str(span["end_ns"]),
            "attributes": _otlp_attributes(span.get("attributes", {})),
        }
        parent = span.get("parent")
        if parent:
            item["parentSpanId"] = parent
        status = span.get("status")
        if status:
            item["status"] = {"code": _otlp_status_code(status.get("code"))}
        otlp_spans.append(item)

    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": SERVICE_NAME}},
                        {
                            "key": "openinference.project.name",
                            "value": {"stringValue": PROJECT_NAME},
                        },
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": SCOPE_NAME},
                        "spans": otlp_spans,
                    }
                ],
            }
        ]
    }


def _normalize_endpoint(endpoint: str) -> str:
    endpoint = endpoint.strip()
    if "://" not in endpoint:
        endpoint = "http://" + endpoint
    return endpoint


def _is_loopback_endpoint(endpoint: str) -> bool:
    try:
        host = urlsplit(_normalize_endpoint(endpoint)).hostname
    except ValueError:
        return False
    if not host:
        return False
    return host.lower().rstrip(".") in _LOOPBACK_HOSTS


def load_state(path) -> set[str]:
    """Read the exported-key state file; tolerate missing/corrupt files."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    if isinstance(data, list):
        return {str(item) for item in data}
    if isinstance(data, dict):
        keys = data.get("exported", data.get("keys", data.get("exported_keys", [])))
        if isinstance(keys, list):
            return {str(item) for item in keys}
    return set()


def save_state(path, keys) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": STATE_VERSION, "exported": sorted(keys)}
    temporary = destination.with_name(destination.name + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, destination)


def read_ledger(path) -> list[dict]:
    records = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict):
                continue
            schema = record.get("schema_version")
            if schema is not None and schema != SCHEMA:
                continue
            records.append(record)
    return records


def _sdk_available() -> bool:
    """True when the OpenTelemetry SDK and protobuf OTLP exporter import."""
    try:
        for name in _SDK_MODULES:
            importlib.import_module(name)
    except (ImportError, AttributeError, ValueError):
        return False
    return True


def _send_sdk(spans, endpoint: str, timeout: float) -> None:
    """Send via the OpenTelemetry SDK/protobuf exporter (not used in tests)."""
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import ReadableSpan
    from opentelemetry.sdk.trace.export import SpanExportResult
    from opentelemetry.trace import SpanContext, SpanKind, Status, StatusCode, TraceFlags

    resource = Resource.create(
        {
            "service.name": SERVICE_NAME,
            "openinference.project.name": PROJECT_NAME,
        }
    )
    readable = []
    for span in spans:
        context = SpanContext(
            trace_id=int(span["trace_id"], 16),
            span_id=int(span["span_id"], 16),
            is_remote=False,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        )
        is_error = (span.get("status") or {}).get("code") == "ERROR"
        readable.append(
            ReadableSpan(
                name=span["name"],
                context=context,
                parent=None,
                resource=resource,
                attributes=dict(span.get("attributes", {})),
                events=[],
                links=[],
                kind=SpanKind.INTERNAL,
                status=Status(StatusCode.ERROR if is_error else StatusCode.UNSET),
                start_time=span["start_ns"],
                end_time=span["end_ns"],
            )
        )

    exporter = OTLPSpanExporter(endpoint=endpoint, timeout=timeout)
    try:
        result = exporter.export(readable)
        if result != SpanExportResult.SUCCESS:
            raise RuntimeError("OTLP span export failed")
    finally:
        exporter.shutdown()


def _post_json(endpoint: str, body: bytes, timeout: float) -> None:
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        response.read()


def export(
    ledger,
    endpoint: str | None = None,
    state=None,
    all: bool = False,
    dry_run: bool = False,
    allow_remote: bool = False,
    timeout: float = TIMEOUT_S,
) -> dict:
    """Export new ledger records and return a small JSON-serialisable result."""
    endpoint = (endpoint or os.environ.get("BEE_USAGE_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        return {"ok": True, "exported": 0, "reason": "disabled"}

    endpoint = _normalize_endpoint(endpoint)
    if not allow_remote and not _is_loopback_endpoint(endpoint):
        return {
            "ok": False,
            "exported": 0,
            "error": "NonLoopbackEndpoint",
            "reason": "endpoint must be loopback; use --allow-remote",
        }

    ledger_path = Path(ledger)
    state_path = Path(state) if state else Path(str(ledger_path) + ".otlp-state.json")

    try:
        records = read_ledger(ledger_path)
    except OSError as exc:
        return {"ok": False, "exported": 0, "error": type(exc).__name__}

    exported_keys = load_state(state_path)
    pending: list[tuple[str, dict]] = []
    seen: set[str] = set()
    for record in records:
        key = record.get("key")
        if not isinstance(key, str) or not key or key in seen:
            continue
        if not all and key in exported_keys:
            continue
        span = record_to_span(record)
        if span is None:
            continue
        seen.add(key)
        pending.append((key, span))

    if dry_run:
        span_count = 0
        body_bytes = 0
        for offset in range(0, len(pending), BATCH_SIZE):
            batch = pending[offset : offset + BATCH_SIZE]
            body = build_otlp_json([span for _, span in batch])
            span_count += len(batch)
            body_bytes += len(
                json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            )
        return {
            "ok": True,
            "dry_run": True,
            "spans": span_count,
            "bytes": body_bytes,
            "exported": 0,
        }

    exported = 0
    next_state = set(exported_keys)
    for offset in range(0, len(pending), BATCH_SIZE):
        batch = pending[offset : offset + BATCH_SIZE]
        spans = [span for _, span in batch]
        try:
            if _sdk_available():
                _send_sdk(spans, endpoint, timeout)
            else:
                body = json.dumps(
                    build_otlp_json(spans), separators=(",", ":"), ensure_ascii=False
                ).encode("utf-8")
                _post_json(endpoint, body, timeout)
        except Exception as exc:  # network failures must never escape
            return {"ok": False, "exported": exported, "error": type(exc).__name__}
        exported += len(batch)
        next_state.update(key for key, _ in batch)
        try:
            save_state(state_path, next_state)
        except OSError as exc:
            return {"ok": False, "exported": exported, "error": type(exc).__name__}

    return {"ok": True, "exported": exported}


export_ledger = export


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("export", help="export new records from a usage ledger")
    command.add_argument("--ledger", required=True, help="JSONL usage ledger")
    command.add_argument(
        "--endpoint",
        help="OTLP/HTTP traces URL (or set BEE_USAGE_OTLP_ENDPOINT)",
    )
    command.add_argument("--state", help="state file (default: <ledger>.otlp-state.json)")
    command.add_argument("--all", action="store_true", help="re-export every record")
    command.add_argument("--dry-run", action="store_true", help="report size without sending")
    command.add_argument(
        "--allow-remote",
        action="store_true",
        help="allow a non-loopback endpoint",
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    result = export(
        args.ledger,
        endpoint=args.endpoint,
        state=args.state,
        all=args.all,
        dry_run=args.dry_run,
        allow_remote=args.allow_remote,
    )
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
