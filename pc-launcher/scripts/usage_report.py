"""Read a bee.usage/v1 JSONL ledger, print rollups and warn-only budget alerts.

The reporter is intentionally read-only: it never dispatches, cancels, or
mutates anything, and budget alerts never change the process exit code.

Stable output shape (consumers depend on it; new fields are additive only):

- Compact output (default): {"ok", "day", "bad_lines", "by", "totals", "top",
  "alerts"} — unchanged by the pricing slice; totals.usd_total still sums only
  the stored cost_usd_list values of the selected day.
- Full output (--full): the same "ok"/"day"/"bad_lines"/"by" header plus
  "totals", "groups", "days", "alerts", "costs", "pricing" and "compact".

Cost rollups (full report, "costs"; they cover every ledger record after the
--card filter, not just the selected day, because jobs span days; a job is a
card, bucketed by card_id with "unknown" for records without one):

- costs.totals: {"cost_usd", "cost_unknown_records", "cost_sources"} where
  cost_usd sums resolved per-attempt costs (stored where present, repriced
  where missing) and cost_sources counts {"ledger", "repriced", "unknown"}.
- costs.attempts: one entry per ledger record, sorted by (ts, attempt):
  {"attempt" (the ledger record key), "attempt_id", "card_id", "job", "ts",
  "cost_usd" (null when unknown — unknown is never coerced to zero),
  "cost_status", "source" ("ledger"|"repriced"|"unknown"),
  "price_table_version", "price_period"}.
- costs.jobs: one entry per job, sorted by cost: {"job", "attempts",
  "cost_usd" (known attempts only), "cost_usd_unknown_attempts",
  "price_table_versions"}.

Versioned pricing snapshots ("pricing"; loaded read-only from --prices, by
default prices.json beside the launcher):

- {"schema", "available", "immutable", "active", "versions"} where versions
  lists snapshot identifiers and active maps route -> live snapshot version.
- Each snapshot is immutable once written and carries an explicit
  price_version identifier matching its key; the file references the live
  snapshot per route under "active".
- Stored costs are history and are never reinterpreted against a newer
  snapshot; missing costs are repriced only against the snapshot recorded on
  the record (price_table_version), or the snapshot live at the attempt
  timestamp for records that predate version recording. A recorded version
  missing from the file, a route/snapshot mismatch, missing rates or missing
  token counts all surface as unknown cost, never as zero.

Out of scope (follow-up): RETURN linkage — the M1 RETURN format is not
decided yet, so no RETURN-related fields are emitted in this slice.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

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
# Versioned pricing snapshots (bee.prices/v1). The reporter only reads them;
# snapshots are immutable once written and are never rewritten or reinterpreted.
DEFAULT_PRICES = Path(__file__).resolve().parent.parent / "prices.json"
ROUTE_SNAPSHOT_PREFIXES = {
    "deepseek": "deepseek-pricing",
    "go": "opencode-go",
    "zoo": "zoo-pricing",
}
# Repricing needs every component of a rate entry as a finite number; a
# partial or non-numeric table is unknown cost, never free usage.
RATE_FIELDS = ("cache_hit", "cache_miss", "output")
DEFAULT_PEAK_WINDOWS = [
    {"days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "start": "01:00", "end": "04:00"},
    {"days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "start": "06:00", "end": "10:00"},
]
DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
EPOCH_FLOOR = datetime(1, 1, 1, tzinfo=timezone.utc)
EMPTY_PRICING = {"schema": None, "available": False, "active": {}, "versions": {}}


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
        "usd_unknown_records": totals["usd_unknown_records"],
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


def round6(value):
    return float(Decimal(str(value)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))


def token_field(record, plain, mirrored):
    value = record.get(mirrored)
    if value is None and plain in record:
        value = record.get(plain)
    return value


def strip_route_prefix(model):
    if not isinstance(model, str):
        return None
    for prefix in ("go:", "deepseek:", "zoo:", "zoo/"):
        if model.startswith(prefix):
            return model[len(prefix):]
    return model


def moment_of(record):
    for field in ("ts_start", "ts_end"):
        value = record.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            try:
                return datetime.fromtimestamp(float(value), tz=timezone.utc)
            except (OverflowError, OSError, ValueError):
                continue
        moment = parse_timestamp(value)
        if moment is not None:
            return moment
    return None


def period_for(record, snapshot):
    moment = moment_of(record)
    if moment is None:
        return None
    windows = snapshot.get("peak_windows_utc") if isinstance(snapshot, dict) else None
    if not isinstance(windows, list) or not windows:
        windows = DEFAULT_PEAK_WINDOWS
    day = DAY_NAMES[moment.weekday()]
    current = moment.time()
    for window in windows:
        days = window.get("days") or []
        if day not in days:
            continue
        try:
            start = time.fromisoformat(window.get("start"))
            end = time.fromisoformat(window.get("end"))
        except (TypeError, ValueError):
            continue
        if start <= current < end:
            return "peak"
    return "off_peak"


def load_price_snapshots(path):
    """Load versioned pricing snapshots read-only; never mutate file or data.

    Snapshots are immutable once written and must carry an explicit
    price_version identifier that matches their key. Accepts a "versions"
    object/array container or the flat historical layout with one snapshot per
    top-level key. A missing or unreadable file is not fatal: repricing
    degrades to unknown and stored costs still roll up.
    """
    if not path:
        return dict(EMPTY_PRICING)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, UnicodeError, ValueError):
        print(
            "usage_report: cannot read prices file; costs without stored values stay unknown",
            file=sys.stderr,
        )
        return dict(EMPTY_PRICING)
    if not isinstance(data, dict):
        return dict(EMPTY_PRICING)
    raw_versions = data.get("versions")
    if isinstance(raw_versions, dict):
        candidates = list(raw_versions.items())
    elif isinstance(raw_versions, list):
        candidates = [
            (item.get("price_version") or item.get("version"), item)
            for item in raw_versions
            if isinstance(item, dict)
        ]
    elif "models" in data:
        candidates = [(data.get("price_version") or data.get("version"), data)]
    else:
        candidates = [
            (name, value)
            for name, value in data.items()
            if isinstance(value, dict) and "models" in value
        ]
    versions = {}
    for name, snapshot in candidates:
        if not isinstance(name, str) or not isinstance(snapshot, dict):
            continue
        declared = snapshot.get("price_version") or snapshot.get("version")
        if declared != name:
            continue
        versions[name] = snapshot
    active = {}
    raw_active = data.get("active")
    if isinstance(raw_active, dict):
        for route, name in raw_active.items():
            if isinstance(route, str) and isinstance(name, str) and name in versions:
                active[route] = name
    schema = data.get("schema")
    return {
        "schema": schema if isinstance(schema, str) else None,
        "available": True,
        "active": active,
        "versions": versions,
    }


def snapshot_routes(snapshot, name):
    routes = snapshot.get("routes")
    if isinstance(routes, list) and routes:
        return {route for route in routes if isinstance(route, str)}
    for route, prefix in ROUTE_SNAPSHOT_PREFIXES.items():
        if name.startswith(prefix):
            return {route}
    return set()


def snapshot_effective_from(snapshot):
    return parse_timestamp(snapshot.get("effective_from_utc"))


def live_snapshot_name(record, route, pricing):
    """Return the snapshot version live for this route at the attempt timestamp."""
    versions = pricing["versions"]
    names = sorted(
        name
        for name, snapshot in versions.items()
        if route in snapshot_routes(snapshot, name)
    )
    if not names:
        return None
    moment = moment_of(record)
    if moment is not None:
        eligible = []
        for name in names:
            effective = snapshot_effective_from(versions[name]) or EPOCH_FLOOR
            if effective <= moment:
                eligible.append((effective, name))
        if eligible:
            return max(eligible)[1]
        return None
    reference = pricing["active"].get(route)
    if reference in names:
        return reference
    return names[0] if len(names) == 1 else None


def reprice_attempt(record, pricing):
    """Resolve one record's list price without ever reinterpreting history.

    Returns (cost_usd, price_table_version, price_period, source). A stored
    cost_usd_list is returned untouched under source "ledger"; repricing uses
    only the snapshot recorded on the record, or the snapshot live at the
    attempt timestamp when the record predates version recording. A rate
    table must carry cache_hit, cache_miss and output as finite numbers;
    anything unresolvable stays unknown (cost_usd None), never zero.
    """
    route = record.get("route")
    route = route if isinstance(route, str) else None
    recorded = record.get("price_table_version")
    recorded = recorded if isinstance(recorded, str) and recorded else None
    stored = number(record.get("cost_usd_list"))
    if stored is not None:
        return stored, recorded, record.get("price_period"), "ledger"
    versions = pricing["versions"]
    chosen = None
    if recorded is not None:
        snapshot = versions.get(recorded)
        if snapshot is not None and route is not None and route in snapshot_routes(snapshot, recorded):
            chosen = recorded
    elif route is not None:
        chosen = live_snapshot_name(record, route, pricing)
    if chosen is None:
        return None, recorded, None, "unknown"
    snapshot = versions[chosen]
    period = period_for(record, snapshot)
    model = strip_route_prefix(
        record.get("gen_ai.request.model") or record.get("gen_ai.response.model")
    )
    models = snapshot.get("models")
    rates = None
    if isinstance(models, dict) and isinstance(model, str) and period is not None:
        entry = models.get(model)
        if isinstance(entry, dict):
            rates = entry.get(period)
    input_tokens = token_field(record, "input_tokens", "gen_ai.usage.input_tokens")
    cache_read = token_field(record, "cache_read_tokens", "gen_ai.usage.cache_read.input_tokens")
    output_tokens = token_field(record, "output_tokens", "gen_ai.usage.output_tokens")
    if (
        not isinstance(rates, dict)
        or any(number(rates.get(name)) is None for name in RATE_FIELDS)
        or not all(
            isinstance(value, int) and not isinstance(value, bool)
            for value in (input_tokens, cache_read, output_tokens)
        )
    ):
        return None, chosen, period, "unknown"
    uncached = max(0, input_tokens - cache_read)
    amount = (
        cache_read * rates["cache_hit"]
        + uncached * rates["cache_miss"]
        + output_tokens * rates["output"]
    ) / 1_000_000.0
    return round6(amount), chosen, period, "repriced"


def build_cost_entry(record, pricing):
    cost_usd, version, period, source = reprice_attempt(record, pricing)
    card_id = record.get("card_id")
    card_id = card_id if isinstance(card_id, str) and card_id else None
    status = record.get("cost_status")
    if status not in ("estimated", "actual", "unknown"):
        status = "unknown"
    if source == "repriced":
        status = "estimated"
    moment = moment_of(record)
    record_name = record.get("key")
    attempt_id = record.get("attempt_id")
    return {
        "attempt": record_name if isinstance(record_name, str) else None,
        "attempt_id": attempt_id if isinstance(attempt_id, str) else None,
        "card_id": card_id,
        "job": card_id or "unknown",
        "ts": moment.isoformat() if moment is not None else None,
        "cost_usd": cost_usd,
        "cost_status": status,
        "source": source,
        "price_table_version": version,
        "price_period": period if period in ("peak", "off_peak") else None,
    }


def build_costs(records, pricing):
    entries = [build_cost_entry(record, pricing) for record in records]
    entries.sort(
        key=lambda entry: (entry["ts"] or "", entry["attempt"] or "", entry["attempt_id"] or "")
    )
    sources = {"ledger": 0, "repriced": 0, "unknown": 0}
    for entry in entries:
        sources[entry["source"]] += 1
    total = round6(sum(entry["cost_usd"] for entry in entries if entry["cost_usd"] is not None))
    buckets = {}
    for entry in entries:
        bucket = buckets.setdefault(
            entry["job"], {"attempts": 0, "amount": 0.0, "unknown": 0, "versions": set()}
        )
        bucket["attempts"] += 1
        if entry["cost_usd"] is None:
            bucket["unknown"] += 1
        else:
            bucket["amount"] += entry["cost_usd"]
        if entry["price_table_version"]:
            bucket["versions"].add(entry["price_table_version"])
    jobs = [
        {
            "job": name,
            "attempts": bucket["attempts"],
            "cost_usd": round6(bucket["amount"]),
            "cost_usd_unknown_attempts": bucket["unknown"],
            "price_table_versions": sorted(bucket["versions"]),
        }
        for name, bucket in buckets.items()
    ]
    jobs.sort(key=lambda item: (-item["cost_usd"], -item["attempts"], item["job"]))
    return {
        "totals": {
            "cost_usd": total,
            "cost_unknown_records": sources["unknown"],
            "cost_sources": sources,
        },
        "attempts": entries,
        "jobs": jobs,
    }


def pricing_block(pricing):
    return {
        "schema": pricing["schema"],
        "available": pricing["available"],
        "immutable": True,
        "active": {route: pricing["active"][route] for route in sorted(pricing["active"])},
        "versions": sorted(pricing["versions"]),
    }


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
    pricing=None,
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
    for day_key in sorted(by_day):
        day_totals, day_groups = summarize_day(by_day[day_key])
        days.append({"day": day_key.isoformat(), "totals": day_totals, "groups": day_groups})

    top = groups[by][:3]
    compact_top = [
        {"group": item["group"], "usd": compact_usd(item["usd_total"]), "records": item["records"]}
        for item in top
    ]

    costs = build_costs(records, pricing or EMPTY_PRICING)

    return {
        "ok": True,
        "day": selected_day.isoformat(),
        "bad_lines": bad_lines,
        "by": by,
        "totals": totals,
        "groups": groups,
        "days": days,
        "alerts": alerts,
        "costs": costs,
        "pricing": pricing_block(pricing or EMPTY_PRICING),
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
    parser.add_argument(
        "--prices",
        default=str(DEFAULT_PRICES),
        help=(
            "versioned pricing snapshots file, read-only "
            "(default: prices.json beside the launcher)"
        ),
    )
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
    pricing = load_price_snapshots(args.prices)

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
        pricing=pricing,
    )

    output = report if args.full else report["compact"]
    print(json.dumps(output, separators=(",", ":"), sort_keys=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
