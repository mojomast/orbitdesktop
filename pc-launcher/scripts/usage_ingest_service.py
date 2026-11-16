"""Ingest real launcher receipt pairs into the merged bee.usage/v1 ledger.

Modes:
  backfill  one full scan over the receipts directory, then exit
  once      a single ingest cycle, then exit
  run       ingest cycles every --interval seconds until stopped

Stdlib only, no network: receipts, prices.json and the schema are read from
disk paths only. Torn receipt writes (e.g. a half-written .result.json) are
parse failures that are retried on the next cycle; a missing receipts
directory is recorded as source missing. prices.json is loaded once at
start, so a pricing snapshot update needs a service restart.
"""

from __future__ import annotations

import argparse
import json
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
        "attempts_dir": str(Path(args.attempts)),
        "receipt_pairs": 0,
        "parse_errors": [],
        "invalid_records": 0,
        "added": 0,
        "skipped": 0,
        "ledger_records": 0,
        "ts": _now(),
    }
    try:
        info = ledger.receipt_pairs(args.attempts)
        status["sources"]["launcher_attempts"] = info["status"]
        if info["status"] == "ok":
            records = []
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
        description="Ingest launcher receipt pairs into the merged bee.usage/v1 ledger."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command, help_text in (
        ("backfill", "scan the receipts directory once and exit"),
        ("once", "run one ingest cycle and exit"),
        ("run", "run ingest cycles every --interval seconds until stopped"),
    ):
        sub = subparsers.add_parser(command, help=help_text)
        sub.add_argument("--attempts", required=True, help="launcher attempts directory (receipt pairs)")
        sub.add_argument("--ledger", required=True, help="append-only JSONL usage ledger path")
        sub.add_argument("--prices", default=str(DEFAULT_PRICES), help="prices.json snapshot path (loaded once at start)")
        sub.add_argument("--state", help="optional path for the last cycle's status JSON")
        if command == "run":
            sub.add_argument("--interval", type=float, default=DEFAULT_INTERVAL,
                             help="seconds between cycles (default: 900)")
            sub.add_argument("--max-cycles", type=int, default=None,
                             help="stop after this many cycles (test helper)")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    if args.command == "run" and (args.interval < 0 or not (args.interval < float("inf"))):
        print("usage_ingest_service: --interval must be a finite number >= 0", file=sys.stderr)
        return 2
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
