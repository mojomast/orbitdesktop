"""Build canonical bee.usage/v1 records from launcher attempts and Hermes usage.

Stdlib only. The ledger is append-only JSON Lines; records carry token counts,
route metadata and list-price cost estimates without prompt or file contents.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
import sys
from datetime import datetime, time, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from urllib.parse import quote

SCHEMA = "bee.usage/v1"
DEFAULT_PRICES = Path(__file__).resolve().parent.parent / "prices.json"
DEFAULT_SCHEMA = Path(__file__).resolve().parent.parent / "usage-schema.v1.json"
DEEPSEEK_VERSION = "deepseek-pricing-2026-09-10"
DEFAULT_PEAK_WINDOWS = [
    {"days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "start": "01:00", "end": "04:00"},
    {"days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "start": "06:00", "end": "10:00"},
]
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _int_or_none(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return int(value)
    if isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
        if not math.isfinite(number):
            return None
        return int(number)
    return None


def _float_or_none(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def _round6(value):
    return float(Decimal(str(value)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))


def _parse_usage(raw):
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            return {}
    return raw if isinstance(raw, dict) else {}


def _numeric_flat(value):
    """Return only finite numeric top-level entries (schema usage_raw shape)."""
    if isinstance(value, str):
        value = _parse_usage(value)
    if not isinstance(value, dict):
        return {}
    out = {}
    for key, item in value.items():
        if isinstance(item, bool):
            continue
        if isinstance(item, (int, float)) and math.isfinite(float(item)):
            out[key] = item
    return out


def normalize_usage(raw):
    """Return canonical token buckets (input, cache read/write, output, reasoning)."""
    data = _parse_usage(raw)
    empty = {
        "input_tokens": None,
        "cache_read_input_tokens": None,
        "cache_write_input_tokens": None,
        "output_tokens": None,
        "reasoning_output_tokens": None,
    }
    if not data:
        return empty

    deepseek_keys = {"prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"}
    if deepseek_keys.intersection(data):
        prompt = _int_or_none(data.get("prompt_tokens"))
        completion = _int_or_none(data.get("completion_tokens"))
        hit = _int_or_none(data.get("prompt_cache_hit_tokens"))
        miss = _int_or_none(data.get("prompt_cache_miss_tokens"))
        if prompt is None and (hit is not None or miss is not None):
            prompt = (hit or 0) + (miss or 0)
        if hit is None and prompt is not None and miss is not None:
            hit = max(0, prompt - miss)
        cache_write = _int_or_none(data.get("prompt_cache_write_tokens"))
        if cache_write is None and prompt is not None:
            cache_write = 0
        details = data.get("completion_tokens_details")
        reasoning = _int_or_none(details.get("reasoning_tokens")) if isinstance(details, dict) else None
        if reasoning is None:
            reasoning = _int_or_none(data.get("reasoning_tokens"))
        return {
            "input_tokens": prompt,
            "cache_read_input_tokens": hit,
            "cache_write_input_tokens": cache_write,
            "output_tokens": completion,
            "reasoning_output_tokens": reasoning,
        }

    camel_keys = {"inputTokens", "cachedReadTokens", "cacheWriteTokens", "outputTokens", "thoughtTokens", "reasoningTokens", "totalTokens"}
    if camel_keys.intersection(data):
        uncached = _int_or_none(data.get("inputTokens"))
        cache_read = _int_or_none(data.get("cachedReadTokens"))
        cache_write = _int_or_none(data.get("cacheWriteTokens"))
        output_base = _int_or_none(data.get("outputTokens"))
        reasoning = _int_or_none(data.get("thoughtTokens"))
        if reasoning is None:
            reasoning = _int_or_none(data.get("reasoningTokens"))
        if uncached is not None:
            cache_read = 0 if cache_read is None else cache_read
            cache_write = 0 if cache_write is None else cache_write
        if output_base is not None and reasoning is None:
            reasoning = 0
        total_input = uncached + cache_read + cache_write if uncached is not None else None
        total_output = output_base + reasoning if output_base is not None and reasoning is not None else None
        return {
            "input_tokens": total_input,
            "cache_read_input_tokens": cache_read,
            "cache_write_input_tokens": cache_write,
            "output_tokens": total_output,
            "reasoning_output_tokens": reasoning,
        }

    snake_keys = {"input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"}
    if snake_keys.intersection(data):
        total_input = _int_or_none(data.get("input_tokens"))
        cache_read = _int_or_none(data.get("cache_read_tokens"))
        cache_write = _int_or_none(data.get("cache_write_tokens"))
        total_output = _int_or_none(data.get("output_tokens"))
        reasoning = _int_or_none(data.get("reasoning_tokens"))
        if total_input is not None:
            cache_read = 0 if cache_read is None else cache_read
            cache_write = 0 if cache_write is None else cache_write
        if total_output is not None and reasoning is None:
            reasoning = 0
        return {
            "input_tokens": total_input,
            "cache_read_input_tokens": cache_read,
            "cache_write_input_tokens": cache_write,
            "output_tokens": total_output,
            "reasoning_output_tokens": reasoning,
        }

    return empty


def _usage_status(usage):
    core = (usage["input_tokens"], usage["cache_read_input_tokens"], usage["output_tokens"])
    if all(value is not None for value in core):
        return "known"
    if any(value is not None for value in core):
        return "partial"
    return "unknown"


def _version_tuple(value):
    if value is None:
        return None
    parts = str(value).strip().split(".")
    numbers = []
    for part in parts[:3]:
        digits = "".join(ch for ch in part if ch.isdigit())
        if not digits:
            return None
        numbers.append(int(digits))
    while len(numbers) < 3:
        numbers.append(0)
    return tuple(numbers)


def infer_route(model, fallback, brief, launcher):
    """Return (route, route_source) from explicit markers, then launcher version."""
    text = model if isinstance(model, str) else ""
    if text.startswith("go:"):
        return "go", "explicit"
    if text.startswith("deepseek:"):
        return "deepseek", "explicit"
    if isinstance(fallback, str):
        if fallback == "deepseek" or fallback.startswith("deepseek:"):
            return "deepseek", "explicit"
    elif isinstance(fallback, dict):
        target = fallback.get("to") or fallback.get("model")
        if isinstance(target, str) and (target == "deepseek" or target.startswith("deepseek:")):
            return "deepseek", "explicit"
    if isinstance(brief, dict) and brief.get("priority") == "high":
        return "deepseek", "explicit"
    base = text[3:] if text.startswith("go:") else text[8:] if text.startswith("deepseek:") else text
    if base == "deepseek-v4.1-flash":
        version = _version_tuple(launcher)
        if version is not None:
            if (0, 1, 12) <= version <= (0, 1, 14):
                return "deepseek", "inferred"
            if version >= (0, 1, 15):
                return "go", "inferred"
    return "unknown", "inferred"


def _strip_route_prefix(model):
    if not isinstance(model, str):
        return None
    if model.startswith("go:"):
        return model[3:]
    if model.startswith("deepseek:"):
        return model[8:]
    return model


def _provider_for(route):
    if route == "go":
        return "opencode"
    if route == "deepseek":
        return "deepseek"
    return "unknown"


def _agent_for(role):
    if role == "coordinator":
        return "beekeeper"
    if role == "verify":
        return "bee-verify"
    return "bee-work"


def _safe_text(value):
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    lowered = text.lower()
    if "objective" in lowered or "http" in lowered:
        return None
    if "/" in text or "\\" in text:
        return None
    return text


def _join_text(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    return _safe_text(value)


def _first_join(*values):
    for value in values:
        text = _join_text(value)
        if text is not None:
            return text
    return None


def _fallback_target(fallback):
    if isinstance(fallback, str):
        text = fallback.strip()
        if text == "deepseek" or text.startswith("deepseek:"):
            return "deepseek"
    elif isinstance(fallback, dict):
        target = fallback.get("to") or fallback.get("model")
        if isinstance(target, str) and (target == "deepseek" or target.startswith("deepseek:")):
            return "deepseek"
    return None


def _fallback_reason(fallback, history):
    if isinstance(fallback, dict):
        reason = _safe_text(fallback.get("reason"))
        if reason:
            return reason
    if isinstance(history, list):
        for entry in reversed(history):
            if not isinstance(entry, dict):
                continue
            reason = _safe_text(entry.get("after")) or _safe_text(entry.get("reason"))
            if reason:
                return reason
    return None


def _error_type(error):
    if error is None:
        return None
    if isinstance(error, dict):
        for key in ("type", "code", "name"):
            text = _safe_text(error.get(key))
            if text:
                return text
        return "error"
    text = str(error).lower()
    if "429" in text or "rate" in text:
        return "rate_limit"
    if "timeout" in text or "timed out" in text:
        return "timeout"
    if "401" in text or "403" in text or "auth" in text:
        return "auth"
    if "cancel" in text:
        return "cancelled"
    if "exit" in text:
        return "exit"
    return "error"


def _iso_utc(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        value = number
    if not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return datetime.fromtimestamp(number, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _duration(start, end):
    if start is None or end is None:
        return None
    return float(end) - float(start)


def _trace_id(*candidates):
    for candidate in candidates:
        if candidate is None or isinstance(candidate, bool):
            continue
        text = str(candidate)
        if text:
            return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]
    return None


def _usage_fields(usage):
    return {
        "input_tokens": usage["input_tokens"],
        "cache_read_tokens": usage["cache_read_input_tokens"],
        "cache_write_tokens": usage["cache_write_input_tokens"],
        "output_tokens": usage["output_tokens"],
        "reasoning_tokens": usage["reasoning_output_tokens"],
        "gen_ai.usage.input_tokens": usage["input_tokens"],
        "gen_ai.usage.cache_read.input_tokens": usage["cache_read_input_tokens"],
        "gen_ai.usage.cache_write.input_tokens": usage["cache_write_input_tokens"],
        "gen_ai.usage.output_tokens": usage["output_tokens"],
        "gen_ai.usage.reasoning.output_tokens": usage["reasoning_output_tokens"],
    }


def _record_base(*, key, attempt_id, card_id, run_id, project, role, join_complete,
                 verify_of, retry_of, ts_start, ts_end, duration_s, queue_s, trace_id,
                 requested_model, served_model, served_model_source, route, route_source,
                 fallback, fallback_reason, http_429_count, retry_count, error_type,
                 stop_reason, tool_calls, usage, usage_raw, launcher, harness):
    status = _usage_status(usage)
    if status == "unknown":
        usage = {name: None for name in usage}
    provider = _provider_for(route)
    record = {
        "schema_version": SCHEMA,
        "key": key,
        "attempt_id": attempt_id,
        "card_id": card_id,
        "run_id": run_id,
        "project": project,
        "role": role,
        "join_complete": join_complete,
        "verify_of": verify_of,
        "retry_of": retry_of,
        "ts_start": ts_start,
        "ts_end": ts_end,
        "duration_s": duration_s,
        "queue_s": queue_s,
        "trace_id": trace_id,
        "requested_model": requested_model,
        "served_model": served_model,
        "served_model_source": served_model_source,
        "provider": provider,
        "route": route,
        "route_source": route_source,
        "fallback": fallback,
        "fallback_reason": fallback_reason,
        "http_429_count": http_429_count,
        "retry_count": retry_count,
        "error_type": error_type,
        "stop_reason": stop_reason,
        "tool_calls": tool_calls,
        "usage_status": status,
        "usage_raw": usage_raw,
        "cost_usd_list": None,
        "cost_status": "unknown",
        "billing_mode": "unknown",
        "price_table_version": None,
        "price_period": None,
        "go_allowance": None,
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": _agent_for(role),
        "gen_ai.provider.name": provider if provider != "unknown" else None,
        "gen_ai.request.model": requested_model,
        "gen_ai.response.model": served_model,
        "launcher": launcher,
        "harness": harness,
    }
    record.update(_usage_fields(usage))
    return record


def _attempt_record(attempt_id, state, result, prices=None):
    if prices is None:
        prices = _load_prices()
    brief = state.get("brief") if isinstance(state.get("brief"), dict) else {}
    source = result.get("source") if isinstance(result.get("source"), dict) else {}
    observed = result.get("observed") if isinstance(result.get("observed"), dict) else {}

    model = source.get("model") or state.get("model")
    fallback_raw = source.get("fallback", state.get("fallback"))
    fallback = _fallback_target(fallback_raw)
    launcher = source.get("launcher")
    route, route_source = infer_route(model, fallback_raw, brief, launcher)

    created = _float_or_none(state.get("created_at"))
    updated = _float_or_none(state.get("updated_at"))
    started = _float_or_none(state.get("started_at"))
    queue_s = _duration(created, started) if created is not None and started is not None else None

    role = brief.get("role")
    if role not in ("work", "verify", "coordinator"):
        role = "verify" if brief.get("verify_of") else "work"

    card_id = _first_join(
        brief.get("card_id"), brief.get("work_task_id"), brief.get("label"), brief.get("task_id")
    ) or "unknown"
    run_id = _first_join(brief.get("run_id")) or card_id
    project = _first_join(brief.get("project"), source.get("project")) or "unknown"
    attempt_text = _join_text(attempt_id) or "unknown"
    join_complete = all(
        value not in (None, "unknown") for value in (attempt_text, card_id, run_id, project, role)
    )

    trace_raw = brief.get("card_id") or brief.get("work_task_id")
    trace_id = _trace_id(trace_raw)

    usage = normalize_usage(observed.get("usage"))
    history = state.get("model_history")
    rate_limited = _int_or_none(state.get("rate_limited"))
    retry_count = (rate_limited or 0) + (1 if fallback else 0)
    fallback_reason = _fallback_reason(fallback_raw, history) if fallback else None

    served = (
        observed.get("response_model")
        or source.get("response_model")
        or observed.get("served_model")
        or source.get("served_model")
    )
    if isinstance(served, str):
        served_model = served
        served_model_source = "explicit"
    else:
        served_model = model if isinstance(model, str) else None
        served_model_source = "inferred" if served_model is not None else None

    record = _record_base(
        key=f"attempt:{attempt_text}",
        attempt_id=attempt_text,
        card_id=card_id,
        run_id=run_id,
        project=project,
        role=role,
        join_complete=join_complete,
        verify_of=_safe_text(brief.get("verify_of")),
        retry_of=_safe_text(brief.get("retry_of")),
        ts_start=_iso_utc(created),
        ts_end=_iso_utc(updated),
        duration_s=_duration(created, updated),
        queue_s=queue_s,
        trace_id=trace_id,
        requested_model=model if isinstance(model, str) else None,
        served_model=served_model,
        served_model_source=served_model_source,
        route=route,
        route_source=route_source,
        fallback=fallback,
        fallback_reason=fallback_reason,
        http_429_count=rate_limited if rate_limited is not None else 0,
        retry_count=retry_count,
        error_type=_error_type(observed.get("error")),
        stop_reason=_safe_text(observed.get("stop_reason")),
        tool_calls=_int_or_none(observed.get("tool_calls")),
        usage=usage,
        usage_raw=_numeric_flat(observed.get("usage")),
        launcher=str(launcher) if launcher is not None else None,
        harness=source.get("harness") or source.get("kind"),
    )
    allowance_raw = observed.get("allowance")
    if not isinstance(allowance_raw, dict):
        allowance_raw = observed.get("opencode_allowance")
    if not isinstance(allowance_raw, dict):
        allowance_raw = None
    record.update(price(record, prices, allowance_raw=allowance_raw))
    return record


def records_from_attempts(attempts_dir, prices=None):
    """Build records for every attempt that has a matching .result.json sidecar."""
    if prices is None:
        prices = _load_prices()
    directory = Path(attempts_dir)
    records = []
    if not directory.is_dir():
        return records
    for path in sorted(directory.iterdir()):
        if path.suffix != ".json" or path.name.endswith(".result.json"):
            continue
        attempt_id = path.stem
        result_path = directory / f"{attempt_id}.result.json"
        if not result_path.is_file():
            continue
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(state, dict) or not isinstance(result, dict):
            continue
        record = _attempt_record(attempt_id, state, result, prices)
        records.append(record)
    return records


def _hermes_usage(row):
    input_uncached = _int_or_none(row.get("input_tokens"))
    cache_read = _int_or_none(row.get("cache_read_tokens"))
    cache_write = _int_or_none(row.get("cache_write_tokens"))
    output = _int_or_none(row.get("output_tokens"))
    reasoning = _int_or_none(row.get("reasoning_tokens"))
    if input_uncached is not None:
        cache_read = 0 if cache_read is None else cache_read
        cache_write = 0 if cache_write is None else cache_write
        total_input = input_uncached + cache_read
    else:
        total_input = None
    if output is not None and reasoning is None:
        reasoning = 0
    return {
        "input_tokens": total_input,
        "cache_read_input_tokens": cache_read,
        "cache_write_input_tokens": cache_write,
        "output_tokens": output,
        "reasoning_output_tokens": reasoning,
    }


def _hermes_record(row, prices=None):
    if prices is None:
        prices = _load_prices()
    session_id = _join_text(row.get("session_id"))
    model = row.get("model")
    billing_provider = str(row.get("billing_provider") or "").lower()
    if billing_provider == "deepseek":
        route, route_source = "deepseek", "explicit"
    elif billing_provider in ("opencode", "go", "opencode-go"):
        route, route_source = "go", "explicit"
    else:
        route, route_source = "unknown", "inferred"

    first_seen = _float_or_none(row.get("first_seen"))
    last_seen = _float_or_none(row.get("last_seen"))
    usage = _hermes_usage(row)
    usage_raw = _numeric_flat({
        "input_tokens": _int_or_none(row.get("input_tokens")),
        "output_tokens": _int_or_none(row.get("output_tokens")),
        "cache_read_tokens": _int_or_none(row.get("cache_read_tokens")),
        "cache_write_tokens": _int_or_none(row.get("cache_write_tokens")),
        "reasoning_tokens": _int_or_none(row.get("reasoning_tokens")),
        "hermes_estimated_cost_usd": _float_or_none(row.get("estimated_cost_usd")),
    })

    attempt_id = f"coord:{session_id}" if session_id else "unknown"
    card_id = _join_text(row.get("task")) or "coordinator"
    run_id = session_id or "unknown"
    project = "beekeeper"
    role = "coordinator"
    join_complete = all(
        value not in (None, "unknown") for value in (attempt_id, card_id, run_id, project, role)
    )
    requested_model = model if isinstance(model, str) else None

    record = _record_base(
        key=f"coord:{session_id or 'unknown'}:{requested_model}",
        attempt_id=attempt_id,
        card_id=card_id,
        run_id=run_id,
        project=project,
        role=role,
        join_complete=join_complete,
        verify_of=None,
        retry_of=None,
        ts_start=_iso_utc(first_seen),
        ts_end=_iso_utc(last_seen),
        duration_s=_duration(first_seen, last_seen),
        queue_s=None,
        trace_id=None,
        requested_model=requested_model,
        served_model=requested_model,
        served_model_source="explicit" if requested_model is not None else None,
        route=route,
        route_source=route_source,
        fallback=None,
        fallback_reason=None,
        http_429_count=None,
        retry_count=None,
        error_type=None,
        stop_reason=None,
        tool_calls=None,
        usage=usage,
        usage_raw=usage_raw,
        launcher=None,
        harness="hermes",
    )
    record.update(price(record, prices))
    return record


def records_from_hermes(db_path, since_epoch=None, prices=None):
    """Read Hermes session_model_usage rows read-only and build coordinator records."""
    if prices is None:
        prices = _load_prices()
    path = Path(db_path)
    if not path.is_file():
        return []
    uri = "file:" + quote(str(path.resolve())) + "?mode=ro"
    records = []
    try:
        connection = sqlite3.connect(uri, uri=True)
    except sqlite3.Error:
        return records
    try:
        connection.row_factory = sqlite3.Row
        query = (
            "SELECT session_id, model, billing_provider, task, api_call_count, input_tokens, "
            "output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, "
            "estimated_cost_usd, actual_cost_usd, cost_status, first_seen, last_seen "
            "FROM session_model_usage"
        )
        try:
            rows = connection.execute(query).fetchall()
        except sqlite3.Error:
            rows = []
    finally:
        connection.close()
    for row in rows:
        last_seen = _float_or_none(row["last_seen"])
        if since_epoch is not None and last_seen is not None and last_seen < since_epoch:
            continue
        record = _hermes_record(dict(row), prices)
        records.append(record)
    return records


def _versions(prices):
    if not isinstance(prices, dict):
        return {}
    versions = prices.get("versions")
    if isinstance(versions, dict):
        return versions
    if isinstance(versions, list):
        out = {}
        for item in versions:
            if isinstance(item, dict):
                name = item.get("price_version") or item.get("version")
                if isinstance(name, str):
                    out[name] = item
        return out
    if "models" in prices:
        name = prices.get("price_version") or DEEPSEEK_VERSION
        return {name: prices}
    direct = {
        key: value for key, value in prices.items()
        if isinstance(value, dict) and "models" in value
    }
    return direct


def _version_for(prices, route):
    versions = _versions(prices)
    if route == "go":
        preferred = [name for name in versions if name.startswith("opencode-go")]
    else:
        preferred = [name for name in versions if name.startswith("deepseek-pricing")]
    if preferred:
        name = sorted(preferred)[0]
        return name, versions[name]
    if versions:
        name = sorted(versions)[0]
        return name, versions[name]
    return None, None


def _parse_iso(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _moment(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    return _parse_iso(value)


def _period_for(record, version):
    moment = _moment(record.get("ts_start"))
    if moment is None:
        moment = _moment(record.get("ts_end"))
    if moment is None:
        return None
    windows = version.get("peak_windows_utc") if isinstance(version, dict) else None
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


def _allowance_pct(raw, usd, allowance):
    if isinstance(raw, dict):
        for key, factor in (("used_fraction", 100), ("fraction", 100), ("pct", 1), ("percent", 1)):
            if key in raw:
                value = _float_or_none(raw.get(key))
                if value is not None:
                    return _round6(value * factor), "opencode.allowance"
    if usd is not None and allowance:
        return _round6(usd / allowance * 100), "derived_list_price"
    return None, None


def _token_field(record, plain, mirrored):
    value = record.get(mirrored)
    if value is None and plain in record:
        value = record.get(plain)
    return value


def price(record, prices=None, allowance_raw=None):
    """Compute flat list-price cost fields for one canonical record."""
    if prices is None:
        prices = _load_prices()
    route = record.get("route")
    version_name, version = _version_for(prices, route)
    version = version if isinstance(version, dict) else {}
    period = _period_for(record, version)
    model = _strip_route_prefix(record.get("gen_ai.request.model") or record.get("gen_ai.response.model"))

    go = route == "go"
    billing_mode = "subscription_allowance" if go else "metered"
    allowance = version.get("monthly_allowance_usd") if go else None
    if allowance is None and go:
        allowance = 100
    if version.get("billing_mode") == "subscription_allowance" and not go:
        billing_mode = "subscription_allowance"

    models = version.get("models") if isinstance(version.get("models"), dict) else {}
    rates = models.get(model, {}).get(period) if isinstance(model, str) and period else None

    input_tokens = _token_field(record, "input_tokens", "gen_ai.usage.input_tokens")
    cache_read = _token_field(record, "cache_read_tokens", "gen_ai.usage.cache_read.input_tokens")
    output_tokens = _token_field(record, "output_tokens", "gen_ai.usage.output_tokens")
    usd = None
    status = "unknown"
    if isinstance(rates, dict) and all(isinstance(v, int) and not isinstance(v, bool) for v in (input_tokens, cache_read, output_tokens)):
        uncached = max(0, input_tokens - cache_read)
        amount = (
            cache_read * rates.get("cache_hit", 0)
            + uncached * rates.get("cache_miss", 0)
            + output_tokens * rates.get("output", 0)
        ) / 1_000_000.0
        usd = _round6(amount)
        status = "estimated"

    go_allowance = None
    if go:
        raw = allowance_raw if isinstance(allowance_raw, dict) else None
        pct_used, pct_source = _allowance_pct(raw, usd, allowance)
        go_allowance = {
            "raw": raw,
            "pct_used": pct_used,
            "pct_source": pct_source,
            "allowance_usd": allowance,
        }

    return {
        "cost_usd_list": usd,
        "cost_status": status,
        "billing_mode": billing_mode,
        "price_table_version": version_name,
        "price_period": period,
        "go_allowance": go_allowance,
    }


def _load_prices(path=None):
    target = Path(path) if path is not None else DEFAULT_PRICES
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"versions": {}}
    return data if isinstance(data, dict) else {"versions": {}}


def _load_schema(path=None):
    target = Path(path) if path is not None else DEFAULT_SCHEMA
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _type_matches(value, name):
    if name == "null":
        return value is None
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "boolean":
        return isinstance(value, bool)
    return True


def _validate_value(value, spec, path=""):
    errors = []
    if not isinstance(spec, dict):
        return errors
    if "oneOf" in spec:
        alternatives = spec.get("oneOf") or []
        if not any(not _validate_value(value, alternative, path) for alternative in alternatives):
            errors.append(f"{path or '<root>'}: no oneOf alternative matched")
        return errors
    if "const" in spec and value != spec["const"]:
        errors.append(f"{path or '<root>'}: expected const {spec['const']!r}")
    if "enum" in spec and value not in spec["enum"]:
        errors.append(f"{path or '<root>'}: not in enum")
    types = spec.get("type")
    if types is not None:
        if isinstance(types, str):
            types = [types]
        if not any(_type_matches(value, name) for name in types):
            errors.append(f"{path or '<root>'}: wrong type")
            return errors
    if isinstance(value, str) and "pattern" in spec:
        try:
            if re.fullmatch(spec["pattern"], value) is None:
                errors.append(f"{path or '<root>'}: pattern mismatch")
        except re.error:
            pass
    if isinstance(value, dict):
        properties = spec.get("properties") or {}
        for required in spec.get("required", []):
            if required not in value:
                errors.append(f"{path or '<root>'}: missing required key {required!r}")
        additional = spec.get("additionalProperties", True)
        for key, item in value.items():
            child = f"{path}.{key}" if path else key
            if key in properties:
                errors.extend(_validate_value(item, properties[key], child))
            elif additional is False:
                errors.append(f"{path or '<root>'}: extra key {key!r}")
            elif isinstance(additional, dict):
                errors.extend(_validate_value(item, additional, child))
    return errors


def validate_record(record, schema):
    """Return True when a record satisfies the frozen bee.usage/v1 schema."""
    if isinstance(schema, (str, Path)):
        schema = _load_schema(schema)
    if not isinstance(record, dict) or not isinstance(schema, dict) or not schema:
        return False
    return not _validate_value(record, schema)


def _ledger_keys(path):
    keys = set()
    if not path.is_file():
        return keys
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return keys
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict) and isinstance(item.get("key"), str):
            keys.add(item["key"])
    return keys


def append_new(records, ledger_path):
    """Append schema-valid records with unseen keys; return the number written."""
    path = Path(ledger_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    schema = _load_schema()
    seen = _ledger_keys(path)
    added = 0
    with path.open("a", encoding="utf-8") as handle:
        for record in records:
            if not validate_record(record, schema):
                continue
            key = record.get("key")
            if not isinstance(key, str) or key in seen:
                continue
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            seen.add(key)
            added += 1
    return added


def _count_ledger(path):
    return len(_ledger_keys(Path(path)))


def _since_epoch(value):
    if value is None:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        raise SystemExit(f"invalid --since date: {value!r} (expected YYYY-MM-DD)")


def _build(args):
    prices = _load_prices(args.prices)
    records = records_from_attempts(args.attempts, prices=prices)
    if args.hermes_db:
        records.extend(records_from_hermes(args.hermes_db, since_epoch=_since_epoch(args.since), prices=prices))
    schema = _load_schema()
    valid = []
    invalid = 0
    for record in records:
        if validate_record(record, schema):
            valid.append(record)
        else:
            invalid += 1
    added = append_new(valid, args.ledger)
    print(json.dumps({
        "ok": True,
        "added": added,
        "skipped": len(valid) - added,
        "invalid": invalid,
        "ledger_records": _count_ledger(args.ledger),
    }))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build canonical bee.usage/v1 usage ledger records.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="append new usage records to a ledger")
    build.add_argument("--attempts", required=True, help="directory containing <attempt_id>.json and .result.json files")
    build.add_argument("--ledger", required=True, help="append-only JSONL ledger path")
    build.add_argument("--hermes-db", help="optional Hermes state.db (opened read-only)")
    build.add_argument("--prices", default=str(DEFAULT_PRICES), help="prices.json snapshot path")
    build.add_argument("--since", help="Hermes lower bound date (YYYY-MM-DD)")
    args = parser.parse_args(argv)
    if args.command == "build":
        return _build(args)
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
