#!/usr/bin/env python3
"""Collect real token/usage data for the point-cloud city and write usage.json.

Sources, in order of confidence:

  1. ~/.hermes/state.db               - SQLite SessionDB, per-session token counters. MEASURED.
  2. ~/.hermes/cron/usage_audit.jsonl - one JSON line per cron job fire. MEASURED.
  3. Provider account endpoints       - account/key-level usage. MEASURED where a key exists.

Why provider endpoints work "across any application":
  These are ACCOUNT-scoped questions, not per-app instrumentation. Every app using the same
  account/key shows up in the same number. Nothing has to cooperate, log, or be instrumented.

WHAT IS MEASURED vs APPORTIONED:
  Provider numbers are measured. The split of the Hermes total across districts is
  apportioned from each district's authored share; the legend says so.

Keys are read from the process environment (Hermes loads ~/.hermes/.env). This script never
writes, logs, or transmits a key value - only whether one is present.

Usage:  python3 collect-usage.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
HERMES = HOME / ".hermes"
STATE_DB = HERMES / "state.db"
AUDIT = HERMES / "cron" / "usage_audit.jsonl"
OUT = Path(__file__).resolve().parent / "usage.json"
# One entry per calendar day (local date). Re-running on the same day REPLACES that day's
# entry rather than appending a duplicate, so the growth curve stays honest.
HISTORY = Path(__file__).resolve().parent / "history.json"
HISTORY_DAYS = 400

COUNTERS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
)

TIMEOUT = 20


# --------------------------------------------------------------------------- local


def read_state() -> dict | None:
    """Sum the per-session counters. Read-only so a live gateway can't be disturbed."""
    if not STATE_DB.exists():
        return None
    con = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=5)
    try:
        cur = con.cursor()
        cols = [row[1] for row in cur.execute("PRAGMA table_info(sessions)")]
        present = [c for c in COUNTERS if c in cols]
        if not present:
            return None
        sums = ", ".join(f"COALESCE(SUM({c}), 0)" for c in present)
        row = cur.execute(f"SELECT COUNT(*), {sums} FROM sessions").fetchone()
        counters = {c: 0 for c in COUNTERS}
        for name, value in zip(present, row[1:]):
            counters[name] = int(value or 0)
        return {
            "sessions": int(row[0]),
            "counters": counters,
            "total_tokens": sum(counters.values()),
            "db_size_bytes": STATE_DB.stat().st_size,
        }
    finally:
        con.close()


def read_audit() -> dict | None:
    """Cron fires log their own token counts; folded in as a second measured source."""
    if not AUDIT.exists():
        return None
    fires = 0
    total = 0
    per_model: dict[str, int] = {}
    for line in AUDIT.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        fires += 1
        tokens = int(record.get("total_tokens") or 0)
        total += tokens
        model = record.get("model") or "unknown"
        per_model[model] = per_model.get(model, 0) + tokens
    return {"fires": fires, "total_tokens": total, "per_model": per_model}


# ----------------------------------------------------------------------- providers


def _get_json(url: str, key: str) -> tuple[str, object]:
    """Returns (status, payload-or-message). Never logs or returns the key."""
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "tokenart-usage/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return "ok", json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return f"http_{exc.code}", f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001 - network surface; report, don't crash
        return "error", type(exc).__name__


def _num(value) -> float | None:
    try:
        if value is None or isinstance(value, bool):
            return None
        out = float(value)
        return out if out == out and abs(out) != float("inf") else None
    except (TypeError, ValueError):
        return None


def probe_openrouter(key: str) -> dict:
    """Account-level credits. THE endpoint that sees other apps' spend. Verified working."""
    status, payload = _get_json("https://openrouter.ai/api/v1/credits", key)
    if status != "ok":
        return {"status": status, "detail": str(payload)[:200]}
    data = (payload or {}).get("data") or {}
    used = _num(data.get("total_usage"))
    purchased = _num(data.get("total_credits"))
    limit = purchased if (purchased or 0) > 0 else None
    if used is None:
        return {"status": "unrecognized", "detail": "no total_usage field in response"}
    detail = f"account lifetime ${used:.4f}"
    if limit is not None:
        detail += f" of ${limit:.2f} purchased"
    else:
        detail += " (nothing purchased -> no allowance to measure against)"
    return {
        "status": "ok",
        "metric": "usd",
        "used": used,
        "limit": limit,
        "remaining": (limit - used) if limit is not None else None,
        "detail": detail,
    }


def probe_zai(key: str) -> dict:
    """Z.ai / Zhipu quota. Written from the documented shape - UNVERIFIED (no ZAI key here)."""
    status, payload = _get_json("https://api.z.ai/api/monitor/usage/quota/limit", key)
    if status != "ok":
        return {"status": status, "detail": str(payload)[:200]}
    data = (payload or {}).get("data") or payload or {}
    limits = data.get("limits") if isinstance(data, dict) else None
    if not isinstance(limits, list) or not limits:
        return {"status": "unrecognized", "detail": "response had no limits[] array"}
    percent = None
    for item in limits:
        if isinstance(item, dict):
            for field in ("percentage", "usagePercent", "percent", "used_percent"):
                value = _num(item.get(field))
                if value is not None:
                    percent = value * 100 if value <= 1 else value
                    break
        if percent is not None:
            break
    if percent is None:
        return {"status": "unrecognized", "detail": "limits[] carried no recognisable percent field"}
    return {
        "status": "ok", "metric": "percent", "used": percent, "limit": 100,
        "detail": f"{percent:.1f}% of quota used", "unverified": True,
    }


def probe_opencode(key: str) -> dict:
    """OpenCode Go/Zen windows. UNVERIFIED (no OPENCODE_GO_API_KEY here)."""
    status, payload = _get_json("https://opencode.ai/zen/go/v1/usage", key)
    if status != "ok":
        return {"status": status, "detail": str(payload)[:200]}
    data = (payload or {}).get("data") or payload or {}
    windows = data.get("windows") if isinstance(data, dict) else None
    if not isinstance(windows, list) or not windows:
        return {"status": "unrecognized", "detail": "response had no windows[] array"}
    tightest = None
    for item in windows:
        if isinstance(item, dict):
            value = _num(item.get("percent"))
            if value is not None:
                tightest = value if tightest is None else max(tightest, value)
    if tightest is None:
        return {"status": "unrecognized", "detail": "windows[] carried no percent field"}
    return {
        "status": "ok", "metric": "percent", "used": tightest, "limit": 100,
        "detail": f"{tightest:.1f}% of tightest window used", "unverified": True,
    }


PROVIDERS = (
    ("openrouter", ("OPENROUTER_API_KEY",), probe_openrouter, "usd"),
    ("zai", ("ZAI_API_KEY", "Z_AI_API_KEY"), probe_zai, "percent"),
    ("opencode", ("OPENCODE_GO_API_KEY",), probe_opencode, "percent"),
)

STATUS_MARK = {
    "ok": "OK  ", "no_key": "----", "no_api": "n/a ",
    "unrecognized": "??  ", "unavailable": "----",
}


def collect_providers() -> list[dict]:
    out: list[dict] = []
    for pid, env_names, probe, metric in PROVIDERS:
        key = next((os.environ[n] for n in env_names if os.environ.get(n)), None)
        if not key:
            out.append({
                "id": pid, "metric": metric, "status": "no_key",
                "detail": f"set {env_names[0]} in ~/.hermes/.env to enable",
            })
            continue
        result = probe(key)
        result.setdefault("metric", metric)
        result["id"] = pid
        out.append(result)

    # A declared blind spot, not a fabricated bar.
    out.append({
        "id": "gemini", "metric": None, "status": "no_api",
        "detail": "No key-based usage endpoint. Gemini Code Assist quota needs OAuth/browser "
                  "cookies, so it is not attempted. Renders sparse on purpose.",
    })
    return out


# ------------------------------------------------------------------------- history


def append_history(payload: dict, providers: list[dict]) -> tuple[dict, int, dict | None]:
    """Record today's snapshot. Returns (today_entry, days_tracked, previous_day_entry).

    The whole file is rewritten because today's entry must be replaced, not appended - running
    the collector five times in one day must not look like five days of growth.
    """
    today = datetime.now().astimezone().date().isoformat()
    entry = {
        "date": today,
        "generated_at": payload["generated_at"],
        "measured_total_tokens": payload["measured_total_tokens"],
        "providers": {p["id"]: (p.get("used") if p.get("status") == "ok" else None) for p in providers},
    }

    rows: list[dict] = []
    if HISTORY.exists():
        try:
            existing = json.loads(HISTORY.read_text())
        except (json.JSONDecodeError, OSError):
            existing = []
        if isinstance(existing, list):
            rows = [r for r in existing
                    if isinstance(r, dict) and r.get("date") and r["date"] != today]

    previous = rows[-1] if rows else None
    rows.append(entry)
    rows.sort(key=lambda r: r["date"])
    rows = rows[-HISTORY_DAYS:]
    HISTORY.write_text(json.dumps(rows, indent=2) + "\n")
    return entry, len(rows), previous


# ---------------------------------------------------------------------------- main


def main() -> int:
    state = read_state()
    audit = read_audit()
    providers = collect_providers()

    hermes_tokens = (state or {}).get("total_tokens", 0)
    providers.insert(0, {
        "id": "hermes",
        "metric": "tokens",
        "status": "ok" if state else "unavailable",
        "used": hermes_tokens,
        "limit": None,
        "detail": (f"{hermes_tokens:,} tokens across {state['sessions']} sessions"
                   if state else "state.db unavailable"),
    })

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {
            "session_db": str(STATE_DB.relative_to(HOME)),
            "cron_audit": str(AUDIT.relative_to(HOME)),
        },
        "state": state,
        "cron": audit,
        "measured_total_tokens": hermes_tokens + (audit or {}).get("total_tokens", 0),
        "providers": providers,
        "note": (
            "Provider numbers are measured and account-scoped, so they include usage from ANY "
            "app on that account. The split of the Hermes total across districts is apportioned "
            "from each district's authored share, not measured per district."
        ),
    }

    OUT.write_text(json.dumps(payload, indent=2) + "\n")

    entry, days, previous = append_history(payload, providers)
    payload["history"] = {
        "days_tracked": days,
        "today": entry["date"],
        "previous_day": (previous or {}).get("date"),
        "delta_tokens_since_previous_day": (
            entry["measured_total_tokens"] - int((previous or {}).get("measured_total_tokens") or 0)
            if previous else None
        ),
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n")

    if state:
        c = state["counters"]
        print(f"Hermes      : {state['sessions']} sessions")
        print(f"  input     : {c['input_tokens']:,}")
        print(f"  output    : {c['output_tokens']:,}")
        print(f"  cache read: {c['cache_read_tokens']:,}")
        print(f"  reasoning : {c['reasoning_tokens']:,}")
    else:
        print("Hermes      : state.db unavailable")
    if audit:
        print(f"cron        : {audit['fires']} fires / {audit['total_tokens']:,} tokens")
    print("providers   :")
    for p in providers:
        mark = STATUS_MARK.get(p["status"], "ERR ")
        print(f"  {mark} {p['id']:<11} {p.get('detail', '')}")
        if p.get("unverified"):
            print("       ^ parser UNVERIFIED - no key has been exercised on this machine")
    print(f"MEASURED    : {payload['measured_total_tokens']:,} tokens (Hermes side)")
    print(f"HISTORY     : {days} day(s) tracked · today {entry['date']} (replaced in place)")
    print(f"wrote       : {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())