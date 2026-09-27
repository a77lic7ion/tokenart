#!/usr/bin/env python3
"""Monday city expansion decision.

Checks usage.json against city.json growth triggers. When a threshold is crossed,
applies the growth action (size_up / tier_up) to the district and logs the decision.

Usage:  python3 monday-decision.py
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CITY = ROOT / "city.json"
USAGE = ROOT / "usage.json"
DECISIONS_LOG = ROOT / "expansion-decisions.jsonl"


def load() -> tuple[dict, dict]:
    city = json.loads(CITY.read_text())
    usage = json.loads(USAGE.read_text()) if USAGE.exists() else {}
    return city, usage


def check_trigger(proj: dict, trig: dict, providers: list[dict]) -> dict | None:
    """Return a growth decision dict if the trigger is crossed, else None."""
    source = proj.get("source")
    if not source:
        return None

    # Find the matching provider entry in usage.json
    provider_data = next((p for p in providers if p.get("id") == source), {})
    if provider_data.get("status") != "ok":
        return None  # no data for this provider — can't make a decision

    used = provider_data.get("used")
    if used is None:
        return None

    metric = trig.get("metric")
    threshold = trig.get("threshold")
    action = trig["action"]

    # Key/evidence triggers (no metric/threshold) — handled separately
    if metric is None or threshold is None:
        return None

    crossed = (
        (metric == "tokens" and used >= threshold)
        or (metric == "usd" and used >= threshold)
        or (metric == "percent" and isinstance(used, (int, float)) and used >= threshold)
    )
    if not crossed:
        return None

    return {
        "district": proj["id"],
        "trigger": trig.get("evidence", f"{action}: {metric}>={threshold}"),
        "action": action,
        "metric": metric,
        "used": used,
        "threshold": threshold,
        "factor": trig.get("factor", 1.25),
    }


def apply_growth(city: dict, usage: dict) -> list[dict]:
    """Apply growth rules. Returns list of decisions made."""
    projects = city.get("projects", [])
    growth = city.get("growth", {})
    triggers = growth.get("triggers", [])
    providers = usage.get("providers", [])

    decisions = []
    for proj in projects:
        for trig in triggers:
            if trig.get("district") != proj.get("id"):
                continue
            decision = check_trigger(proj, trig, providers)
            if decision is None:
                continue

            action = decision["action"]
            if action == "size_up":
                factor = decision.get("factor", growth.get("expansionRate", 1.25))
                old_w = proj["size"]["width"]
                old_d = proj["size"]["depth"]
                proj["size"]["width"] = round(old_w * factor, 2)
                proj["size"]["depth"] = round(old_d * factor, 2)
                proj["_growth"] = decision["trigger"]
                decision["old_size"] = {"width": old_w, "depth": old_d}
                decision["new_size"] = proj["size"].copy()

            elif action == "tier_up":
                old_tier = proj.get("tier", 0)
                proj["tier"] = old_tier + 1
                proj["_growth"] = decision["trigger"]
                decision["old_tier"] = old_tier
                decision["new_tier"] = proj["tier"]

            decisions.append(decision)

    return decisions


def main() -> int:
    city, usage = load()
    providers = usage.get("providers", [])

    if not providers:
        print("No usage data available — cannot make expansion decisions.")
        return 1

    decisions = apply_growth(city, usage)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    entry = {
        "run_at": now,
        "decisions": decisions,
        "district_count": len(city.get("projects", [])),
    }

    # Append to decisions log
    DECISIONS_LOG.write_text(
        json.dumps(entry, indent=2) + "\n", encoding="utf-8"
    )

    # Write updated city.json
    CITY.write_text(json.dumps(city, indent=2) + "\n", encoding="utf-8")

    if decisions:
        print(f"Monday decision: {len(decisions)} expansion(s) applied")
        for d in decisions:
            if d["action"] == "size_up":
                print(f"  {d['district']}: size_up ×{d['factor']} "
                      f"({d['old_size']['width']}→{d['new_size']['width']}, "
                      f"{d['old_size']['depth']}→{d['new_size']['depth']})")
            elif d["action"] == "tier_up":
                print(f"  {d['district']}: tier_up {d['old_tier']}→{d['new_tier']}")
    else:
        print("Monday decision: no growth triggers crossed — city unchanged")

    print(f"Wrote: {CITY}")
    print(f"Log:   {DECISIONS_LOG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())