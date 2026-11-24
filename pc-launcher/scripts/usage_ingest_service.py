"""Ingest real launcher receipt pairs and coordinator outbox events into the
merged bee.usage/v1 ledger.

Modes:
  backfill  one full scan over the enabled sources, then exit
  once      a single ingest cycle, then exit
  run       ingest cycles every --interval seconds until stopped

Sources (compose; dedupe by ledger key across sources):
  receipts  --attempts launcher receipt pairs (default when --attempts is given)
  outbox    --outbox coordinator-local rizzstack.bee.landed.v1 event JSON files
            (default ~/.hermes/plugin-data/bundlebees/events/outbox). Events
            are CloudEvents envelopes: the landed facts (attempt_id, backend,
            lease, result, state, task_id, feature_id, job_id, schema,
            source_rev) live under "data", which the reader parses first, with
            a top-level "payload" object kept as a compatibility fallback.
            Hyvv's optional rizzstackusage object is an envelope sibling of
            data. The reader accepts its canonical counts or, for older
            events, a nested receipt-style usage payload. Events without token
            counts are skipped with a counted reason.

Stdlib only, no network: events, receipts, prices.json and the schema are read
from disk paths only. Torn receipt writes (e.g. a half-written .result.json)
and torn outbox files are parse failures that are retried on the next cycle; a
missing source directory is recorded as source missing. prices.json is loaded
once at start, so a pricing snapshot update needs a service restart.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import usage_ledger as ledger

STATUS_SCHEMA = "bee.usage-ingest/v1"
DEFAULT_INTERVAL = 900.0
DEFAULT_PRICES = ledger.DEFAULT_PRICES
OUTBOX_EVENT_TYPE = "rizzstack.bee.landed.v1"
SOURCES = ("receipts", "outbox")
OUTBOX_SKIPPED_REASONS = ("unrelated_type", "no_usage_payload", "missing_attempt_id")


def _default_outbox():
    try:
        home = Path.home()
    except RuntimeError:  # pragma: no cover - exotic passwd setups
        home = Path("/")
    return home / ".hermes" / "plugin-data" / "bundlebees" / "events" / "outbox"


DEFAULT_OUTBOX = _default_outbox()


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _cycle(mode, cycle, args, prices):
    """Run one ingest cycle and return its status record (never raises)."""
    status = {
        "schema": STATUS_SCHEMA,
        "mode": mode,
        "cycle": cycle,
        "ok": True,
        "sources": {},
        "receipt_pairs": 0,
        "parse_errors": [],
        "invalid_records": 0,
        "added": 0,
        "skipped": 0,
        "ledger_records": 0,
        "ts": _now(),
    }
    records = []
    try:
        if "receipts" in args.sources:
            status["attempts_dir"] = str(Path(args.attempts))
            info = ledger.receipt_pairs(args.attempts)
            status["sources"]["launcher_attempts"] = info["status"]
            if info["status"] == "ok":
                for pair in info["pairs"]:
                    try:
                        state, result = ledger.read_receipt_pair(pair)
                        records.append(
                            ledger.record_from_receipt(state, result, pair["attempt_id"], prices)
                        )
                    except ledger.ReceiptParseError:
                        status["parse_errors"].append(
                            {"attempt_id": pair["attempt_id"], "reason": "parse_failure"}
                        )
                status["receipt_pairs"] = len(info["pairs"])
        if "outbox" in args.sources:
            _outbox_cycle(args, prices, status, records)
        schema = ledger._load_schema()
        valid = [record for record in records if ledger.validate_record(record, schema)]
        status["invalid_records"] = len(records) - len(valid)
        status["added"] = ledger.append_new(valid, args.ledger, durable=True)
        status["skipped"] = len(valid) - status["added"]
        status["ledger_records"] = ledger._count_ledger(args.ledger)
    except Exception as error:  # one bad cycle must never take the loop down
        status["ok"] = False
        status["error"] = f"{type(error).__name__}: {error}"
    return status


def _outbox_cycle(args, prices, status, records):
    """Scan the outbox source and append landed-event records to the cycle pool."""
    info = outbox_events(args.outbox)
    status["sources"]["outbox"] = info["status"]
    status["outbox_dir"] = info["outbox_dir"]
    status["outbox_files"] = info["files"]
    status["outbox_events"] = 0
    status["outbox_records"] = 0
    status["outbox_skipped"] = {reason: 0 for reason in OUTBOX_SKIPPED_REASONS}
    status["parse_errors"].extend(info["parse_errors"])
    if info["status"] != "ok":
        return
    for event in info["events"]:
        status["outbox_events"] += 1
        data = event.get("data")
        block = event.get("rizzstackusage")
        counts = (ledger.hyvv_token_counts(block) if event.get("type") == OUTBOX_EVENT_TYPE
                  and isinstance(data, dict) else {})
        if counts:
            attempt_id = ledger._safe_text(data.get("attempt_id"))
            skip = None if attempt_id else "missing_attempt_id"
        else:
            attempt_id, state, result, skip = _outbox_parts(event)
        if skip is not None:
            status["outbox_skipped"][skip] = status["outbox_skipped"].get(skip, 0) + 1
            continue
        try:
            if counts:
                record = ledger.record_from_hyvv(attempt_id, data, event.get("time"), block, counts)
            else:
                record = ledger.record_from_receipt(state, result, attempt_id, prices)
            records.append(record)
        except ledger.ReceiptParseError:
            status["parse_errors"].append({"event": attempt_id or "unknown", "reason": "parse_failure"})
            continue
        except Exception:
            status["parse_errors"].append({"event": attempt_id or "unknown", "reason": "build_failure"})
            continue
        status["outbox_records"] += 1


def outbox_events(outbox_dir):
    """Enumerate outbox event files without interpreting their payloads.

    Returns {"outbox_dir", "status", "files", "events", "parse_errors"} where
    status is "ok" or "missing" (the directory does not exist). Each *.json
    file holds one JSON event object or an array of event objects; unreadable,
    non-JSON or non-object events are parse failures that are retried on the
    next cycle.
    """
    directory = Path(outbox_dir)
    info = {"outbox_dir": str(directory), "status": "missing", "files": 0, "events": [], "parse_errors": []}
    if not directory.is_dir():
        return info
    info["status"] = "ok"
    for path in sorted(directory.iterdir()):
        if path.suffix != ".json" or not path.is_file():
            continue
        info["files"] += 1
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            info["parse_errors"].append({"event": path.stem, "reason": "parse_failure"})
            continue
        if isinstance(data, dict):
            info["events"].append(data)
        elif isinstance(data, list):
            for index, item in enumerate(data):
                if isinstance(item, dict):
                    info["events"].append(item)
                else:
                    info["parse_errors"].append({"event": f"{path.stem}[{index}]", "reason": "parse_failure"})
        else:
            info["parse_errors"].append({"event": path.stem, "reason": "parse_failure"})
    return info


_EVENT_TYPE_KEYS = ("type", "event_type", "schema")
_EVENT_TIME_KEYS = ("landed_at", "ts", "timestamp", "time")


def _first_dict(*candidates):
    for candidate in candidates:
        if isinstance(candidate, dict):
            return dict(candidate)
    return None


def _event_type(event):
    for key in _EVENT_TYPE_KEYS:
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for body_key in ("data", "payload"):
        body = event.get(body_key)
        if isinstance(body, dict):
            for key in ("type", "event_type"):
                value = body.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def _epoch_or_none(value):
    """Epoch seconds from an epoch number or an ISO-8601 string, else None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
            return number if math.isfinite(number) else None
        except ValueError:
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp()
    return None


def _outbox_parts(event):
    """Split a legacy receipt-style event into (attempt_id, state, result).

    Canonical landed events are CloudEvents envelopes whose facts live under
    "data" (attempt_id, backend, lease, result, state, task_id, feature_id,
    job_id, schema, source_rev); the "data" object is parsed first, with a
    top-level "payload" object kept as a compatibility fallback and the whole
    event as the last resort. "data.state" is a plain string ("landed"/
    "failed") and is mapped as a string, never as a receipt state dict.

    Returns (attempt_id, state, result, None) on success or
    (None, None, None, skip_reason) when the event must not become a record:
    unrelated_type (not a rizzstack.bee.landed.v1 event), no_usage_payload
    (no token counts to ingest) or missing_attempt_id (usage without an
    attempt identity to key it by). Nothing is fabricated.
    """
    if not isinstance(event, dict):
        return None, None, None, "unrelated_type"
    if _event_type(event) != OUTBOX_EVENT_TYPE:
        return None, None, None, "unrelated_type"
    body = _first_dict(event.get("data"), event.get("payload")) or event
    result_raw = body.get("result") if isinstance(body.get("result"), dict) else {}

    observed = _first_dict(result_raw.get("observed"), body.get("observed"), event.get("observed"))
    usage_map = None
    if observed is not None and observed.get("usage") is not None:
        usage_map = observed.get("usage")
    if usage_map is None:
        for candidate in (result_raw, body, event):
            if isinstance(candidate, dict) and candidate.get("usage") is not None:
                usage_map = candidate.get("usage")
                break
    if usage_map is None or not isinstance(usage_map, (dict, str)):
        return None, None, None, "no_usage_payload"
    if all(value is None for value in ledger.normalize_usage(usage_map).values()):
        return None, None, None, "no_usage_payload"
    if observed is None:
        observed = {}
    if observed.get("usage") is None:
        observed["usage"] = usage_map

    attempt_id = ledger._join_text(body.get("attempt_id"))
    if attempt_id is None:
        attempt_id = ledger._join_text(result_raw.get("attempt_id"))
    if attempt_id is None:
        attempt_id = ledger._join_text(event.get("attempt_id"))
    if attempt_id is None:
        return None, None, None, "missing_attempt_id"

    state_raw = body.get("state")
    state = dict(state_raw) if isinstance(state_raw, dict) else {}
    if isinstance(state_raw, str) and state_raw.strip():
        # Canonical data.state ("landed"/"failed") stays a plain string.
        state["state"] = state_raw.strip()
    brief = state.get("brief") if isinstance(state.get("brief"), dict) else body.get("brief")
    brief = dict(brief) if isinstance(brief, dict) else {}
    if brief.get("run_id") is None and body.get("run_id") is not None:
        brief["run_id"] = body.get("run_id")
    for brief_key, body_key in (("task_id", "task_id"), ("project", "feature_id"),
                                ("run_id", "job_id")):
        if brief.get(brief_key) is None and body.get(body_key) is not None:
            brief[brief_key] = body[body_key]
    if brief:
        state["brief"] = brief
    event_time = None
    for source_dict in (body, event):
        for key in _EVENT_TIME_KEYS:
            if source_dict.get(key) is not None:
                event_time = source_dict.get(key)
                break
        if event_time is not None:
            break
    created = _epoch_or_none(state.get("created_at"))
    if created is None:
        created = _epoch_or_none(body.get("created_at"))
    if created is None:
        created = _epoch_or_none(event_time)
    if created is not None:
        state["created_at"] = created
    updated = _epoch_or_none(state.get("updated_at"))
    if updated is None:
        updated = _epoch_or_none(body.get("updated_at"))
    if updated is not None:
        state["updated_at"] = updated

    source = _first_dict(result_raw.get("source"), body.get("source"), event.get("source")) or {}
    backend = body.get("backend") if isinstance(body.get("backend"), dict) else {}
    for from_dict in (backend, body):
        for key in ("model", "fallback", "launcher", "project", "response_model", "served_model", "harness", "kind"):
            if source.get(key) is None and from_dict.get(key) is not None:
                source[key] = from_dict.get(key)

    return attempt_id, state, {"source": source, "observed": observed}, None


def _write_status(path, status):
    """Persist the status record atomically (write + fsync + rename)."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(status, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, target)


def _sleep(seconds, stop):
    """Sleep in small chunks so a stop signal ends the wait promptly."""
    deadline = time.monotonic() + seconds
    while not stop["flag"]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(0.5, remaining))


def _run_loop(mode, args, prices, stop):
    cycle = 0
    last = None
    while not stop["flag"]:
        cycle += 1
        last = _cycle(mode, cycle, args, prices)
        _report(last, args.state)
        if args.max_cycles is not None and cycle >= args.max_cycles:
            break
        _sleep(args.interval, stop)
    return last


def _report(status, state_path):
    print(json.dumps(status, ensure_ascii=False, separators=(",", ":")), flush=True)
    if state_path:
        _write_status(state_path, status)


def _install_signals(stop):
    def handler(signum, frame):
        stop["flag"] = True

    for name in ("SIGINT", "SIGTERM"):
        number = getattr(signal, name, None)
        if number is not None:
            signal.signal(number, handler)


def _parser():
    parser = argparse.ArgumentParser(
        description="Ingest launcher receipt pairs and coordinator outbox events into the merged bee.usage/v1 ledger."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command, help_text in (
        ("backfill", "scan the enabled sources once and exit"),
        ("once", "run one ingest cycle and exit"),
        ("run", "run ingest cycles every --interval seconds until stopped"),
    ):
        sub = subparsers.add_parser(command, help=help_text)
        sub.add_argument("--attempts", help="launcher attempts directory (receipt pairs; enables the receipts source)")
        sub.add_argument("--ledger", required=True, help="append-only JSONL usage ledger path")
        sub.add_argument("--prices", default=str(DEFAULT_PRICES), help="prices.json snapshot path (loaded once at start)")
        sub.add_argument("--state", help="optional path for the last cycle's status JSON")
        sub.add_argument("--source", action="append", default=None,
                         help="ingest source to enable: 'receipts', 'outbox'; repeatable or comma-separated "
                              "(default: receipts; --attempts and --outbox also enable their source)")
        sub.add_argument("--outbox", default=None,
                         help="coordinator outbox directory with rizzstack.bee.landed.v1 event JSON files "
                              f"(default: {DEFAULT_OUTBOX})")
        if command == "run":
            sub.add_argument("--interval", type=float, default=DEFAULT_INTERVAL,
                             help="seconds between cycles (default: 900)")
            sub.add_argument("--max-cycles", type=int, default=None,
                             help="stop after this many cycles (test helper)")
    return parser


def _resolve_sources(args):
    """Return (sources, error); sources is the frozenset of enabled sources."""
    selected = set()
    for raw in args.source or ():
        for name in str(raw).split(","):
            name = name.strip().lower()
            if not name:
                continue
            if name not in SOURCES:
                return None, f"unknown --source {name!r} (expected one of {', '.join(SOURCES)})"
            selected.add(name)
    if args.attempts:
        selected.add("receipts")
    if args.outbox:
        selected.add("outbox")
    if not selected:
        return None, "no ingest source selected (pass --attempts or --source receipts|outbox)"
    if "receipts" in selected and not args.attempts:
        return None, "--source receipts requires --attempts"
    return frozenset(selected), None


def main(argv=None):
    args = _parser().parse_args(argv)
    if args.command == "run" and (args.interval < 0 or not (args.interval < float("inf"))):
        print("usage_ingest_service: --interval must be a finite number >= 0", file=sys.stderr)
        return 2
    sources, error = _resolve_sources(args)
    if error:
        print(f"usage_ingest_service: {error}", file=sys.stderr)
        return 2
    args.sources = sources
    if "outbox" in sources and not args.outbox:
        args.outbox = str(DEFAULT_OUTBOX)
    prices = ledger._load_prices(args.prices)
    if args.command == "run":
        stop = {"flag": False}
        _install_signals(stop)
        last = _run_loop(args.command, args, prices, stop)
    else:
        last = _cycle(args.command, 1, args, prices)
        _report(last, args.state)
    return 0 if last is None or last["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
