"""Tests for the bee.usage/v1 rollup and warn-only alert reporter."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from itertools import count
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "usage_report.py"
SERIAL = count(1)


def make_record(
    role="work",
    day="2026-01-06",
    hour=10,
    *,
    usd=1.0,
    allowance_pct=None,
    route="deepseek",
    key=None,
    duration_s=30.0,
    input_tokens=1000,
    cache_read=0,
    cache_write=0,
    output_tokens=500,
    reasoning_tokens=0,
    http_429=0,
    fallback=None,
    card_id="card-1",
    project="orbit",
    model="deepseek-v4",
    served_model=None,
    requested_model=None,
    usage_status="known",
    cost_status=None,
    ts_start=None,
    ts_end=None,
):
    number = next(SERIAL)
    attempt = f"attempt-{number}"
    provider = "opencode" if route == "go" else ("unknown" if route == "unknown" else "deepseek")
    agent = {"work": "bee-work", "verify": "bee-verify", "coordinator": "beekeeper"}.get(
        role, "bee-work"
    )
    if key is None:
        if role == "coordinator":
            key = f"coord:session-{number}:{model}"
        else:
            key = f"attempt:{attempt}"
    served = served_model if served_model is not None else model
    requested = requested_model if requested_model is not None else model
    started = ts_start or f"{day}T{hour:02d}:00:00Z"
    usage_raw = {
        name: value
        for name, value in (
            ("input_tokens", input_tokens),
            ("output_tokens", output_tokens),
            ("cache_read", cache_read),
        )
        if value is not None
    }
    go_allowance = None
    if route == "go":
        go_allowance = {
            "raw": {"allowance_usd": 100.0, "pct_used": allowance_pct},
            "pct_used": allowance_pct,
            "pct_source": "opencode.allowance" if allowance_pct is not None else None,
            "allowance_usd": 100.0,
        }
    if cost_status is None:
        cost_status = "estimated" if usd is not None else "unknown"
    return {
        "schema_version": "bee.usage/v1",
        "key": key,
        "attempt_id": attempt,
        "card_id": card_id,
        "run_id": f"run-{number}",
        "project": project,
        "role": role,
        "join_complete": True,
        "verify_of": None,
        "retry_of": None,
        "ts_start": started,
        "ts_end": ts_end,
        "duration_s": duration_s,
        "queue_s": 1.0,
        "trace_id": f"{number:032x}"[-32:],
        "requested_model": requested,
        "served_model": served,
        "served_model_source": "explicit",
        "provider": provider,
        "route": route,
        "route_source": "explicit" if route == "go" else "inferred",
        "fallback": fallback,
        "fallback_reason": None,
        "http_429_count": http_429,
        "retry_count": 0,
        "error_type": None,
        "stop_reason": "end_turn",
        "tool_calls": 0,
        "usage_status": usage_status,
        "input_tokens": input_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "output_tokens": output_tokens,
        "reasoning_tokens": reasoning_tokens,
        "usage_raw": usage_raw,
        "cost_usd_list": usd,
        "cost_status": cost_status,
        "billing_mode": "subscription_allowance" if route == "go" else "metered",
        "price_table_version": "test",
        "price_period": "off_peak",
        "go_allowance": go_allowance,
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": agent,
        "gen_ai.provider.name": provider,
        "gen_ai.request.model": requested,
        "gen_ai.response.model": served,
        "gen_ai.usage.input_tokens": input_tokens,
        "gen_ai.usage.cache_read.input_tokens": cache_read,
        "gen_ai.usage.cache_write.input_tokens": cache_write,
        "gen_ai.usage.output_tokens": output_tokens,
        "gen_ai.usage.reasoning.output_tokens": reasoning_tokens,
        "launcher": "test",
        "harness": "test",
    }


class UsageReportTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.ledger = Path(self.tempdir.name) / "ledger.jsonl"

    def write(self, records):
        with self.ledger.open("w", encoding="utf-8") as handle:
            for record in records:
                handle.write(json.dumps(record) + "\n")

    def write_raw(self, lines):
        with self.ledger.open("w", encoding="utf-8") as handle:
            for line in lines:
                handle.write(line + "\n")

    def run_cli(self, *args, records=None):
        if records is not None:
            self.write(records)
        command = [
            sys.executable,
            str(SCRIPT),
            "--ledger",
            str(self.ledger),
            "--tz-offset-hours",
            "0",
            *args,
        ]
        env = {k: v for k, v in os.environ.items()
               if k not in ("BEE_USAGE_ALERTS", "BEE_USAGE_DAILY_CAP_USD")}
        return subprocess.run(
            command, capture_output=True, text=True, timeout=30, check=False, env=env
        )

    def report(self, *args, records=None):
        result = self.run_cli(*args, records=records)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_per_day_totals(self):
        records = [
            make_record(role="work", day="2026-01-05", usd=1.0),
            make_record(role="verify", day="2026-01-05", usd=0.5),
            make_record(role="work", day="2026-01-06", usd=2.0),
        ]
        first = self.report("--day", "2026-01-05", records=records)
        second = self.report("--day", "2026-01-06")
        self.assertEqual(first["day"], "2026-01-05")
        self.assertEqual(first["totals"]["records"], 2)
        self.assertAlmostEqual(first["totals"]["usd"], 1.5, places=2)
        self.assertEqual(second["totals"]["records"], 1)
        self.assertAlmostEqual(second["totals"]["usd"], 2.0, places=2)
        full = self.report("--day", "2026-01-06", "--full")
        self.assertEqual({item["day"] for item in full["days"]}, {"2026-01-05", "2026-01-06"})

    def test_grouping_by_every_dimension(self):
        records = [
            make_record(role="work", card_id="card-1", project="orbit", model="m-one"),
            make_record(role="verify", card_id="card-2", project="other", model="m-two"),
            make_record(role="coordinator", card_id="card-3", project="orbit", model="m-one"),
            make_record(
                role="work", card_id="card-1", project="orbit", model="m-one", route="go", usd=2.0
            ),
        ]
        full = self.report("--day", "2026-01-06", "--full", records=records)
        groups = full["groups"]
        self.assertEqual(
            {item["group"] for item in groups["role"]}, {"work", "verify", "coordinator"}
        )
        self.assertEqual(
            {item["group"] for item in groups["card"]}, {"card-1", "card-2", "card-3"}
        )
        self.assertEqual({item["group"] for item in groups["project"]}, {"orbit", "other"})
        self.assertEqual({item["group"] for item in groups["model"]}, {"m-one", "m-two"})
        self.assertEqual({item["group"] for item in groups["route"]}, {"go", "deepseek"})

    def test_cache_hit_percentage(self):
        records = [make_record(input_tokens=100, cache_read=40, output_tokens=10)]
        report = self.report("--day", "2026-01-06", records=records)
        self.assertEqual(report["totals"]["cache_hit_pct"], 40.0)

    def test_cache_hit_pct_is_null_when_tokens_are_unknown(self):
        unknown = make_record(
            usage_status="unknown",
            input_tokens=None,
            cache_read=None,
            cache_write=None,
            output_tokens=None,
            reasoning_tokens=None,
        )
        report = self.report("--day", "2026-01-06", records=[unknown])
        self.assertIsNone(report["totals"]["cache_hit_pct"])

        mixed = self.report(
            "--day",
            "2026-01-06",
            records=[make_record(input_tokens=100, cache_read=40), unknown],
        )
        self.assertIsNone(mixed["totals"]["cache_hit_pct"])

    def test_unknown_usage_counted_in_totals_and_groups(self):
        records = [
            make_record(card_id="card-1"),
            make_record(
                card_id="card-1",
                usage_status="unknown",
                input_tokens=None,
                cache_read=None,
                cache_write=None,
                output_tokens=None,
                reasoning_tokens=None,
                usd=None,
            ),
            make_record(card_id="card-2", usage_status="partial"),
        ]
        full = self.report("--day", "2026-01-06", "--full", "--by", "card", records=records)
        self.assertEqual(full["totals"]["unknown_usage"], 1)
        by_card = {item["group"]: item for item in full["groups"]["card"]}
        self.assertEqual(by_card["card-1"]["unknown_usage"], 1)
        self.assertEqual(by_card["card-1"]["records"], 2)
        self.assertEqual(by_card["card-2"]["unknown_usage"], 0)

        compact = self.report("--day", "2026-01-06", "--by", "card")
        self.assertEqual(compact["totals"]["unknown_usage"], 1)

    def test_flat_v1_fields_drive_metrics(self):
        records = [
            make_record(
                route="go",
                usd=2.5,
                allowance_pct=2.5,
                http_429=2,
                fallback="deepseek",
                served_model="served-a",
            ),
            make_record(route="deepseek", usd=None, served_model="served-b"),
        ]
        full = self.report("--day", "2026-01-06", "--full", records=records)
        totals = full["totals"]
        self.assertAlmostEqual(totals["usd_total"], 2.5, places=2)
        self.assertAlmostEqual(totals["go_usd"], 2.5, places=2)
        self.assertAlmostEqual(totals["go_allowance_pct"], 2.5, places=2)
        self.assertEqual(totals["http_429"], 2)
        self.assertEqual(totals["fallbacks"], 1)
        self.assertEqual(totals["usd_unknown_records"], 1)
        self.assertEqual(
            {item["group"] for item in full["groups"]["model"]}, {"served-a", "served-b"}
        )

    def test_duration_percentiles(self):
        records = [
            make_record(duration_s=10.0, usd=0.1),
            make_record(duration_s=20.0, usd=0.1),
            make_record(duration_s=30.0, usd=0.1),
            make_record(duration_s=40.0, usd=0.1),
        ]
        full = self.report("--day", "2026-01-06", "--full", records=records)
        self.assertEqual(full["totals"]["duration_p50"], 25.0)
        self.assertEqual(full["totals"]["duration_p95"], 38.5)

    def test_daily_cap_boundaries(self):
        cases = ((7.95, None), (8.0, "near"), (10.0, "over"))
        for usd, expected in cases:
            with self.subTest(usd=usd):
                result = self.run_cli(
                    "--day", "2026-01-06", records=[make_record(usd=usd, duration_s=1.0)]
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(result.stdout)
                daily = [a for a in report["alerts"] if a["kind"] == "daily_cap"]
                if expected is None:
                    self.assertEqual(daily, [])
                else:
                    self.assertEqual(len(daily), 1)
                    self.assertEqual(daily[0]["level"], expected)
                    self.assertEqual(daily[0]["action"], "warn")

    def test_go_allowance_windows(self):
        now = "2026-01-06T12:00:00Z"
        cases = (
            ("5h", 16.0, "near"),
            ("5h", 20.0, "over"),
            ("7d", 40.0, "near"),
            ("7d", 50.0, "over"),
            ("month", 80.0, "near"),
            ("month", 100.0, "over"),
        )
        for window, usd, expected in cases:
            with self.subTest(window=window, usd=usd):
                records = [
                    make_record(
                        role="work",
                        hour=10,
                        usd=usd,
                        route="go",
                        allowance_pct=usd,
                        duration_s=1.0,
                    )
                ]
                report = self.report("--day", "2026-01-06", "--now", now, records=records)
                alerts = [
                    a
                    for a in report["alerts"]
                    if a["kind"] == "go_allowance" and a.get("window") == window
                ]
                self.assertEqual(len(alerts), 1)
                self.assertEqual(alerts[0]["level"], expected)
                self.assertEqual(alerts[0]["action"], "warn")
                self.assertAlmostEqual(alerts[0]["pct"], 80.0 if expected == "near" else 100.0, places=2)
                self.assertAlmostEqual(report["totals"]["go_usd"], usd, places=2)
                self.assertAlmostEqual(report["totals"]["go_allowance_pct"], usd, places=2)
                if window == "month":
                    self.assertTrue(alerts[0].get("approximate"))

    def test_rate_limit_alert(self):
        now = "2026-01-06T12:00:00Z"
        records = [
            make_record(hour=11, http_429=1, usd=0.0),
            make_record(hour=11, http_429=1, usd=0.0),
            make_record(hour=11, http_429=1, usd=0.0),
        ]
        report = self.report("--day", "2026-01-06", "--now", now, records=records)
        alerts = [a for a in report["alerts"] if a["kind"] == "rate_limits"]
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["level"], "warn")
        self.assertEqual(alerts[0]["action"], "warn")
        self.assertEqual(alerts[0]["count"], 3)

    def test_coordinator_share_alert(self):
        records = [
            make_record(role="coordinator", usd=9.5),
            make_record(role="work", usd=0.5),
        ]
        report = self.report("--day", "2026-01-06", records=records)
        alerts = [a for a in report["alerts"] if a["kind"] == "coordinator_share"]
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["level"], "info")
        self.assertAlmostEqual(alerts[0]["pct"], 95.0, places=2)

    def test_malformed_lines_are_skipped_and_counted(self):
        self.write_raw(
            [
                json.dumps(make_record()),
                "not json at all",
                "[1, 2, 3]",
                json.dumps({"schema_version": "bee.usage/v0"}),
                "",
                '{"schema_version": "bee.usage/v1", broken',
            ]
        )
        result = self.run_cli("--day", "2026-01-06")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["bad_lines"], 4)
        self.assertEqual(report["totals"]["records"], 1)

    def test_compact_output_under_one_kilobyte(self):
        records = []
        for index in range(12):
            records.append(
                make_record(
                    role=("work", "verify", "coordinator")[index % 3],
                    card_id=f"card-{index}",
                    hour=10,
                    usd=1.25,
                    http_429=2 if index < 3 else 0,
                    duration_s=float(index + 1),
                )
            )
        records.append(
            make_record(role="work", usd=25.0, route="go", allowance_pct=25.0, hour=11)
        )
        result = self.run_cli(
            "--day", "2026-01-06", "--now", "2026-01-06T12:00:00Z", records=records
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        compact = result.stdout.strip()
        self.assertLess(len(compact.encode("utf-8")), 1000)
        parsed = json.loads(compact)
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["by"], "role")
        self.assertLessEqual(len(parsed["top"]), 3)
        self.assertTrue(parsed["alerts"])

    def test_unreadable_ledger_exits_two(self):
        missing = Path(self.tempdir.name) / "missing.jsonl"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--ledger", str(missing)],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 2)




class AlertsFileTests(unittest.TestCase):
    """Thresholds are read from an alert.thresholds/v1 file, not hard-coded."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.ledger = self.dir / "ledger.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def alerts_file(self, thresholds, schema="alert.thresholds/v1"):
        path = self.dir / "alerts.json"
        path.write_text(json.dumps({"schema": schema, "schema_version": "v1",
                                    "thresholds": thresholds}), encoding="utf-8")
        return path

    def go(self, records, *args, env_extra=None):
        self.ledger.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        env = {k: v for k, v in os.environ.items()
               if k not in ("BEE_USAGE_ALERTS", "BEE_USAGE_DAILY_CAP_USD")}
        env.update(env_extra or {})
        res = subprocess.run([sys.executable, str(SCRIPT), "--ledger", str(self.ledger),
                              "--tz-offset-hours", "0", "--day", "2026-01-06", *args],
                             capture_output=True, text=True, timeout=30, check=False, env=env)
        self.assertEqual(res.returncode, 0, res.stderr)
        return json.loads(res.stdout)

    def daily(self, report):
        return [a for a in report["alerts"] if a["kind"] == "daily_cap"]

    def test_daily_spend_from_file(self):
        path = self.alerts_file({"daily_model_spend_above_usd": 20})
        rec = [make_record(usd=10.0, duration_s=1.0)]
        self.assertEqual(self.daily(self.go(rec, "--alerts", str(path))), [])
        rec = [make_record(usd=20.0, duration_s=1.0)]
        self.assertEqual(self.daily(self.go(rec, "--alerts", str(path)))[0]["level"], "over")

    def test_env_alerts_path(self):
        path = self.alerts_file({"daily_model_spend_above_usd": 2})
        rec = [make_record(usd=2.0, duration_s=1.0)]
        got = self.daily(self.go(rec, env_extra={"BEE_USAGE_ALERTS": str(path)}))
        self.assertEqual(got[0]["level"], "over")
        self.assertEqual(got[0]["action"], "warn")

    def test_cli_flag_beats_file(self):
        path = self.alerts_file({"daily_model_spend_above_usd": 2})
        rec = [make_record(usd=2.0, duration_s=1.0)]
        self.assertEqual(self.daily(self.go(rec, "--alerts", str(path), "--daily-cap-usd", "50")), [])

    def test_bad_or_foreign_file_falls_back(self):
        bad = self.dir / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        foreign = self.alerts_file({"daily_model_spend_above_usd": 1}, schema="something/v9")
        rec = [make_record(usd=10.0, duration_s=1.0)]
        for path in (bad, foreign, self.dir / "missing.json"):
            with self.subTest(path=path.name):
                self.assertEqual(self.daily(self.go(rec, "--alerts", str(path)))[0]["level"], "over")

    def test_go_near_pct_from_file(self):
        path = self.alerts_file({"go_allowance_pct_used": 50})
        now = "2026-01-06T12:00:00Z"
        rec = [make_record(usd=11.0, route="go", hour=11)]
        rep = self.go(rec, "--alerts", str(path), "--now", now)
        five = [a for a in rep["alerts"] if a["kind"] == "go_allowance" and a.get("window") == "5h"]
        self.assertEqual(five[0]["level"], "near")
        rep = self.go(rec, "--now", now)
        five = [a for a in rep["alerts"] if a["kind"] == "go_allowance" and a.get("window") == "5h"]
        self.assertEqual(five, [])


if __name__ == "__main__":
    unittest.main()
