"""Read a bee.usage/v1 JSONL ledger, print rollups and warn-only budget alerts.

The reporter is intentionally read-only: it never dispatches, cancels, or
mutates anything, and budget alerts never change the process exit code.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import date, datetime, timedelta, timezone

SCHEMA = "bee.usage/v1"
ROLES = ("work", "verify", "coordinator")
DIMENSIONS = {
    "role": ("role", True),
    "card": ("card_id", False),
    "project": ("project", False),
    "model": ("served_model", False),
    "route": ("route", False),
}
MODEL_FALLBACKS = ("requested_model", "gen_ai.request.model")
# Alert thresholds come from the workflow repo's observability/alerts.defaults.json
# (schema alert.thresholds/v1), passed with --alerts or env BEE_USAGE_ALERTS.
# The constants below are only the fallback when no thresholds file is given.
ALERTS_SCHEMAS = ("alert.thresholds/v1", "alert.thresholds.override/v1")
DAILY_SPEND_KEY = "daily_model_spend_above_usd"
GO_PCT_KEY = "go_allowance_pct_used"
DEFAULT_DAILY_CAP = 10.0
DEFAULT_GO_NEAR_PCT = 80.0
DEFAULT_GO_ALLOWANCE = 100.0
GO_WINDOWS = (
    ("5h", timedelta(hours=5), 0.2, False),
    ("7d", timedelta(days=7), 0.5, False),
    ("month", None, 1.0, True),
)


def parse_timestamp(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def number(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    return None


def integer(value):
    parsed = number(value)
    return int(parsed) if parsed is not None else None


def toggle(value):
    return 1 if value not in (None, "") else 0


def record_time(record):
    return parse_timestamp(record.get("ts_start")) or parse_timestamp(record.get("ts_end"))


def record_usd(record):
    return number(record.get("cost_usd_list"))


def record_allowance_pct(record):
    allowance = record.get("go_allowance")
    if not isinstance(allowance, dict):
        return None
    return number(allowance.get("pct_used"))


def token_totals(records, field):
    total = 0
    unknown = 0
    for record in records:
        value = integer(record.get(field))
        if value is None:
            unknown += 1
        else:
            total += value
    return total, unknown


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 6)
    position = (len(ordered) - 1) * fraction
    low = int(math.floor(position))
    high = int(math.ceil(position))
    if low == high:
        return round(ordered[low], 6)
    blended = ordered[low] + (ordered[high] - ordered[low]) * (position - low)
    return round(blended, 6)


def stats_for(records):
    records = list(records)
    input_tokens, input_unknown = token_totals(records, "input_tokens")
    cache_read, cache_read_unknown = token_totals(records, "cache_read_tokens")
    cache_write, _ = token_totals(records, "cache_write_tokens")
    output_tokens, _ = token_totals(records, "output_tokens")
    reasoning, _ = token_totals(records, "reasoning_tokens")
    known_usd = [value for value in (record_usd(r) for r in records) if value is not None]
    go_records = [r for r in records if r.get("route") == "go"]
    go_usd = sum(value for value in (record_usd(r) for r in go_records) if value is not None)
    go_pct = sum(
        value for value in (record_allowance_pct(r) for r in go_records) if value is not None
    )
    durations = [
        value for value in (number(r.get("duration_s")) for r in records) if value is not None
    ]
    http_429 = sum(integer(r.get("http_429_count")) or 0 for r in records)
    fallbacks = sum(toggle(r.get("fallback")) for r in records)
    unknown_usage = sum(1 for r in records if r.get("usage_status") == "unknown")
    usd_total = sum(known_usd)
    if input_unknown or cache_read_unknown:
        cache_hit = None
    elif input_tokens:
        cache_hit = cache_read / input_tokens * 100.0
    else:
        cache_hit = 0.0
    return {
        "records": len(records),
        "input": input_tokens,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "output": output_tokens,
        "reasoning": reasoning,
        "usd_total": round(usd_total, 6),
        "usd_unknown_records": len(records) - len(known_usd),
        "unknown_usage": unknown_usage,
        "cache_hit_pct": round(cache_hit, 2) if cache_hit is not None else None,
        "http_429": http_429,
        "fallbacks": fallbacks,
        "duration_p50": percentile(durations, 0.50),
        "duration_p95": percentile(durations, 0.95),
        "go_usd": round(go_usd, 6),
        "go_allowance_pct": round(go_pct, 2),
    }


def dimension_value(record, dimension):
    key, _ = DIMENSIONS[dimension]
    value = record.get(key)
    if dimension == "model" and (not isinstance(value, str) or not value):
        for fallback in MODEL_FALLBACKS:
            candidate = record.get(fallback)
            if isinstance(candidate, str) and candidate:
                value = candidate
                break
    if not isinstance(value, str) or not value:
        return "unknown"
    return value


def group_stats(records, dimension):
    buckets = {}
    for record in records:
        label = dimension_value(record, dimension)
        buckets.setdefault(label, []).append(record)
    groups = []
    for label, bucket in buckets.items():
        item = {"group": label}
        item.update(stats_for(bucket))
        groups.append(item)
    groups.sort(key=lambda item: (-item["usd_total"], -item["records"], item["group"]))
    return groups


def local_date(record, tzinfo):
    moment = record_time(record)
    if moment is None:
        return None
    return moment.astimezone(tzinfo).date()


def compact_usd(value):
    return round(value, 2) if value is not None else None


def compact_alert(alert):
    item = {
        "kind": alert["kind"],
        "level": alert["level"],
        "pct": round(alert["pct"], 2) if alert.get("pct") is not None else None,
        "action": "warn",
    }
    if alert.get("window"):
        item["window"] = alert["window"]
    if alert.get("count") is not None:
        item["count"] = alert["count"]
    if alert.get("approximate"):
        item["approximate"] = True
    return item


def alert_level(pct, near_pct=80.0):
    if pct >= 100.0:
        return "over"
    if pct >= near_pct:
        return "near"
    return None


def build_alerts(
    day_records, all_records, now, tzinfo, daily_cap, go_allowance, go_near_pct=DEFAULT_GO_NEAR_PCT
):
    alerts = []
    day_totals = stats_for(day_records)
    day_usd = day_totals["usd_total"]

    if daily_cap > 0:
        cap_pct = day_usd / daily_cap * 100.0
        level = alert_level(cap_pct)
        if level:
            alerts.append(
                {
                    "kind": "daily_cap",
                    "level": level,
                    "pct": cap_pct,
                    "action": "warn",
                    "usd": day_usd,
                    "budget_usd": daily_cap,
                }
            )

    go_records = [r for r in all_records if r.get("route") == "go"]
    month_start_local = now.astimezone(tzinfo).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    for label, span, share, approximate in GO_WINDOWS:
        if span is None:
            start = month_start_local.astimezone(timezone.utc)
        else:
            start = now - span
        window_usd = 0.0
        for record in go_records:
            moment = record_time(record)
            if moment is None or moment < start or moment > now:
                continue
            value = record_usd(record)
            if value is not None:
                window_usd += value
        budget = go_allowance * share
        if budget <= 0:
            continue
        pct = window_usd / budget * 100.0
        level = alert_level(pct, go_near_pct)
        if level:
            alert = {
                "kind": "go_allowance",
                "window": label,
                "level": level,
                "pct": pct,
                "action": "warn",
                "usd": round(window_usd, 6),
                "budget_usd": round(budget, 2),
            }
            if approximate:
                alert["approximate"] = True
            alerts.append(alert)

    hour_start = now - timedelta(hours=1)
    recent_429 = 0
    for record in all_records:
        moment = record_time(record)
        if moment is None or moment < hour_start or moment > now:
            continue
        recent_429 += integer(record.get("http_429_count")) or 0
    if recent_429 >= 3:
        alerts.append(
            {
                "kind": "rate_limits",
                "level": "warn",
                "pct": None,
                "action": "warn",
                "count": recent_429,
            }
        )

    if day_usd > 0:
        coordinator_usd = sum(
            value
            for value in (record_usd(r) for r in day_records if r.get("role") == "coordinator")
            if value is not None
        )
        share_pct = coordinator_usd / day_usd * 100.0
        if share_pct > 90.0:
            alerts.append(
                {
                    "kind": "coordinator_share",
                    "level": "info",
                    "pct": share_pct,
                    "action": "warn",
                    "usd": round(coordinator_usd, 6),
                }
            )

    return alerts


def compact_totals(totals):
    return {
        "records": totals["records"],
        "usd": compact_usd(totals["usd_total"]),
        "go_usd": compact_usd(totals["go_usd"]),
        "go_allowance_pct": compact_usd(totals["go_allowance_pct"]),
        "coordinator_usd": compact_usd(totals["coordinator_usd"]),
        "bee_usd": compact_usd(totals["bee_usd"]),
        "unknown_usage": totals["unknown_usage"],
        "cache_hit_pct": totals["cache_hit_pct"],
        "http_429": totals["http_429"],
    }


def load_ledger(path):
    records = []
    bad_lines = 0
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            try:
                record = json.loads(text)
            except (ValueError, TypeError):
                bad_lines += 1
                continue
            if not isinstance(record, dict) or record.get("schema_version") != SCHEMA:
                bad_lines += 1
                continue
            records.append(record)
    return records, bad_lines


def parse_offset(value):
    return timezone(timedelta(hours=value))


def summarize_day(day_records):
    totals = stats_for(day_records)
    role_usd = {}
    for record in day_records:
        value = record_usd(record)
        if value is None:
            continue
        role = record.get("role")
        role_usd[role] = role_usd.get(role, 0.0) + value
    totals["coordinator_usd"] = round(role_usd.get("coordinator", 0.0), 6)
    totals["bee_usd"] = round(role_usd.get("work", 0.0) + role_usd.get("verify", 0.0), 6)
    groups = {dimension: group_stats(day_records, dimension) for dimension in DIMENSIONS}
    return totals, groups


def build_report(
    records,
    bad_lines,
    selected_day,
    now,
    tzinfo,
    by,
    daily_cap,
    go_allowance,
    go_near_pct=DEFAULT_GO_NEAR_PCT,
):
    by_day = {}
    for record in records:
        key = local_date(record, tzinfo)
        if key is not None:
            by_day.setdefault(key, []).append(record)

    day_records = by_day.get(selected_day, [])
    totals, groups = summarize_day(day_records)
    alerts = build_alerts(
        day_records, records, now, tzinfo, daily_cap, go_allowance, go_near_pct
    )

    days = []
    for key in sorted(by_day):
        day_totals, day_groups = summarize_day(by_day[key])
        days.append({"day": key.isoformat(), "totals": day_totals, "groups": day_groups})

    top = groups[by][:3]
    compact_top = [
        {"group": item["group"], "usd": compact_usd(item["usd_total"]), "records": item["records"]}
        for item in top
    ]

    return {
        "ok": True,
        "day": selected_day.isoformat(),
        "bad_lines": bad_lines,
        "by": by,
        "totals": totals,
        "groups": groups,
        "days": days,
        "alerts": alerts,
        "compact": {
            "ok": True,
            "day": selected_day.isoformat(),
            "bad_lines": bad_lines,
            "by": by,
            "totals": compact_totals(totals),
            "top": compact_top,
            "alerts": [compact_alert(alert) for alert in alerts],
        },
    }


def positive_float(text):
    try:
        value = float(text)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("must be a number")
    if value <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return value


def build_parser():
    parser = argparse.ArgumentParser(
        description="Summarize a bee.usage/v1 JSONL ledger and emit warn-only budget alerts."
    )
    parser.add_argument("--ledger", required=True, help="path to the JSONL usage ledger")
    day_group = parser.add_mutually_exclusive_group()
    day_group.add_argument("--day", help="local calendar day to report (YYYY-MM-DD)")
    day_group.add_argument("--today", action="store_true", help="report the local current day")
    parser.add_argument(
        "--by",
        choices=sorted(DIMENSIONS),
        default="role",
        help="group dimension used for the top-3 list (default: role)",
    )
    parser.add_argument("--card", help="only include records for this card_id")
    parser.add_argument("--full", action="store_true", help="print the full rollup JSON")
    parser.add_argument(
        "--daily-cap-usd",
        type=positive_float,
        default=None,
        help=(
            "daily spend warn level in USD (default: env BEE_USAGE_DAILY_CAP_USD, then "
            "thresholds.daily_model_spend_above_usd from --alerts, then the built-in fallback)"
        ),
    )
    parser.add_argument(
        "--go-allowance-usd",
        type=positive_float,
        default=DEFAULT_GO_ALLOWANCE,
        help="monthly Go allowance in USD (default: 100)",
    )
    parser.add_argument(
        "--alerts",
        default=None,
        help=(
            "alert.thresholds/v1 JSON (workflow observability/alerts.defaults.json or an "
            "override); default: env BEE_USAGE_ALERTS"
        ),
    )
    parser.add_argument("--now", help="reference time for windows (ISO-8601)")
    parser.add_argument(
        "--tz-offset-hours",
        type=float,
        default=None,
        help="fixed UTC offset for local-day grouping (default: machine local timezone)",
    )
    return parser


def load_thresholds(path):
    """Return the thresholds object from an alert.thresholds/v1 file, or {}.

    A missing, unreadable or foreign file falls back to the built-in defaults;
    alerts are warn-only, so a bad thresholds file never fails the report.
    """
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, UnicodeError, ValueError):
        print("usage_report: cannot read alerts file; using fallback thresholds", file=sys.stderr)
        return {}
    if not isinstance(data, dict) or data.get("schema") not in ALERTS_SCHEMAS:
        print("usage_report: alerts file is not alert.thresholds/v1; using fallback", file=sys.stderr)
        return {}
    thresholds = data.get("thresholds")
    return thresholds if isinstance(thresholds, dict) else {}


def _positive(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and value > 0 else None


def resolve_daily_cap(parser, value, thresholds=None):
    if value is not None:
        return value
    env_value = os.environ.get("BEE_USAGE_DAILY_CAP_USD")
    if env_value:
        try:
            parsed = float(env_value)
        except ValueError:
            parsed = None
        if parsed is not None and math.isfinite(parsed) and parsed > 0:
            return parsed
    from_file = _positive((thresholds or {}).get(DAILY_SPEND_KEY))
    if from_file is not None:
        return from_file
    return DEFAULT_DAILY_CAP


def resolve_go_near_pct(thresholds=None):
    value = _positive((thresholds or {}).get(GO_PCT_KEY))
    if value is not None and value <= 100.0:
        return value
    return DEFAULT_GO_NEAR_PCT


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.tz_offset_hours is not None and not (-24 < args.tz_offset_hours < 24):
        parser.error("--tz-offset-hours must be between -24 and 24")
    tzinfo = parse_offset(args.tz_offset_hours) if args.tz_offset_hours is not None else None

    if args.now:
        now = parse_timestamp(args.now)
        if now is None:
            parser.error("--now must be an ISO-8601 timestamp")
    else:
        now = datetime.now(timezone.utc)

    if args.day:
        try:
            selected_day = date.fromisoformat(args.day)
        except ValueError:
            parser.error("--day must be YYYY-MM-DD")
    else:
        selected_day = now.astimezone(tzinfo).date()

    thresholds = load_thresholds(args.alerts or os.environ.get("BEE_USAGE_ALERTS"))
    daily_cap = resolve_daily_cap(parser, args.daily_cap_usd, thresholds)
    go_near_pct = resolve_go_near_pct(thresholds)

    try:
        records, bad_lines = load_ledger(args.ledger)
    except (OSError, UnicodeError):
        print("usage_report: cannot read ledger", file=sys.stderr)
        return 2

    if args.card:
        records = [r for r in records if r.get("card_id") == args.card]

    report = build_report(
        records,
        bad_lines,
        selected_day,
        now,
        tzinfo,
        args.by,
        daily_cap,
        args.go_allowance_usd,
        go_near_pct,
    )

    output = report if args.full else report["compact"]
    print(json.dumps(output, separators=(",", ":"), sort_keys=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
