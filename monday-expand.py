#!/usr/bin/env python3
"""Monday city expansion decision mechanism.

Runs on Mondays (or on demand). Reads city.json + usage.json + .env,
decides whether the city has earned ONE new district, and updates city.json
with evidence. Or does nothing.

Decision rules (from TARGET.md):
  - "Earned, never guessed": no invented significance, no fabricated totals.
  - A district needs real evidence to exist: a working provider key + usage data,
    or a documented real-world thing it maps to (like plugin-foundry).
  - One district per Monday. Not a flood.
  - Blind spots stay visible: a provider with no key renders sparse, not fake.

How it decides:
  1. Scan .env for real (non-placeholder) API keys.
  2. Check usage.json for which providers report data.
  3. For providers with keys but no district: candidate for addition.
  4. For existing districts with no_key: candidate for enabling (key missing).
  5. Pick the candidate with the strongest evidence.
  6. Update city.json + regenerate procedural-city-data.js.
  7. Report the decision on the issue thread (or do nothing if no candidate).

Usage:  python3 monday-expand.py            # dry run, prints decision
        python3 monday-expand.py --apply    # actually updates city.json
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CITY = ROOT / "city.json"
USAGE = ROOT / "usage.json"
ENV = Path.home() / ".hermes" / ".env"

# Provider metadata: what key env var to look for, style, accent, default size
PROVIDER_META = {
    "zai": {
        "key_var": "ZAI_API_KEY",
        "name": "Z.ai Quarter",
        "style": "industrial",
        "accent": "amber",
        "size": {"width": 8.0, "depth": 6.7},
        "metric": "percent",
        "reference": {"metric": "percent", "full": 100},
        "evidence": "Z.ai API key present in .env — quota-based usage tracking",
    },
    "opencode": {
        "key_var": "OPENCODE_GO_API_KEY",
        "name": "OpenCode Yard",
        "style": "residential",
        "accent": "ink",
        "size": {"width": 8.8, "depth": 7.2},
        "metric": "percent",
        "reference": {"metric": "percent", "full": 100},
        "evidence": "OpenCode Go API key present in .env — quota-based usage tracking",
    },
    "nous": {
        "key_var": "NOUS_API_KEY",
        "name": "Nous Hub",
        "style": "laboratory",
        "accent": "teal",
        "size": {"width": 8.0, "depth": 6.7},
        "metric": "tokens",
        "reference": {"metric": "tokens", "full": 1000000000},
        "evidence": "Nous API key present in .env — free tier provider",
    },
    "mistral": {
        "key_var": "MISTRAL_API_KEY",
        "name": "Mistral Tower",
        "style": "laboratory",
        "accent": "amber",
        "size": {"width": 8.0, "depth": 6.7},
        "metric": "tokens",
        "reference": {"metric": "tokens", "full": 1000000000},
        "evidence": "Mistral API key present in .env — paid tier provider",
    },
    "groq": {
        "key_var": "GROQ_API_KEY",
        "name": "Groq Speed",
        "style": "laboratory",
        "accent": "teal",
        "size": {"width": 8.0, "depth": 6.7},
        "metric": "tokens",
        "reference": {"metric": "tokens", "full": 1000000000},
        "evidence": "Groq API key present in .env — fast inference provider",
    },
    "anthropic": {
        "key_var": "ANTHROPIC_API_KEY",
        "name": "Anthropic Wing",
        "style": "laboratory",
        "accent": "ink",
        "size": {"width": 8.0, "depth": 6.7},
        "metric": "tokens",
        "reference": {"metric": "tokens", "full": 1000000000},
        "evidence": "Anthropic API key present in .env — Claude provider",
    },
    "kimi": {
        "key_var": "MOONSHOT_API_KEY",
        "name": "Kimi Quarter",
        "style": "residential",
        "accent": "amber",
        "size": {"width": 8.0, "depth": 6.7},
        "metric": "tokens",
        "reference": {"metric": "tokens", "full": 1000000000},
        "evidence": "Kimi/Moonshot API key present in .env",
    },
    "minimax": {
        "key_var": "MINIMAX_API_KEY",
        "name": "Minimax Lab",
        "style": "laboratory",
        "accent": "teal",
        "size": {"width": 8.0, "depth": 6.7},
        "metric": "tokens",
        "reference": {"metric": "tokens", "full": 1000000000},
        "evidence": "Minimax API key present in .env",
    },
}

PLACEHOLDER_RE = re.compile(r'^\*+$|^x+$|^your_|^placeholder|^xxx', re.IGNORECASE)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


def load_env_key(path: Path, var: str) -> str | None:
    """Read a key value from .env file. Returns None if missing or placeholder."""
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == var:
            v = v.strip().strip('"').strip("'")
            # Treat placeholder/empty values as no key
            if not v or PLACEHOLDER_RE.match(v) or v == "*" * len(v):
                return None
            return v
    return None


def env_has_key(var: str) -> bool:
    """Check if a key exists in environment (for runtime checks)."""
    val = os.environ.get(var, "")
    return bool(val) and not PLACEHOLDER_RE.match(val) and val != "*" * len(val)


def get_existing_ids(city: dict) -> set[str]:
    return {p["id"] for p in city.get("projects", [])}


def assess_providers(city: dict, usage: dict, env: Path) -> list[dict]:
    """Assess all providers and return candidates for expansion."""
    existing = get_existing_ids(city)
    providers = usage.get("providers", [])
    candidates = []

    # 1. Existing districts with no_key status — can we enable them?
    for p in providers:
        pid = p.get("id")
        if pid not in PROVIDER_META:
            continue
        if pid in existing and p.get("status") == "no_key":
            meta = PROVIDER_META[pid]
            key_val = load_env_key(env, meta["key_var"])
            if key_val:
                candidates.append({
                    "type": "enable",
                    "id": pid,
                    "name": meta["name"],
                    "evidence": f"Key found in .env for {pid} — district already exists, can enable",
                    "priority": 2,  # Lower priority than new districts with usage
                    "key_var": meta["key_var"],
                })
            else:
                candidates.append({
                    "type": "enable",
                    "id": pid,
                    "name": meta["name"],
                    "evidence": f"No real key in .env for {pid} — needs key before enabling",
                    "priority": 1,
                    "key_var": meta["key_var"],
                    "blocked": True,
                })

    # 2. Providers with keys but no district — new district candidates
    for pid, meta in PROVIDER_META.items():
        if pid in existing:
            continue
        key_val = load_env_key(env, meta["key_var"])
        if key_val:
            # Check if usage data exists for this provider
            provider_usage = next((p for p in providers if p.get("id") == pid), None)
            has_usage = provider_usage and provider_usage.get("status") == "ok"
            candidates.append({
                "type": "new",
                "id": pid,
                "name": meta["name"],
                "evidence": meta["evidence"],
                "priority": 3 if has_usage else 2,  # Higher if usage data confirms activity
                "key_var": meta["key_var"],
                "meta": meta,
            })
        else:
            candidates.append({
                "type": "new",
                "id": pid,
                "name": meta["name"],
                "evidence": f"No {meta['key_var']} in .env — key needed",
                "priority": 0,  # Blocked — no key
                "key_var": meta["key_var"],
                "blocked": True,
            })

    # 3. Gemini special case — has key in .env but no key-based usage API
    if "gemini" not in existing:
        key_val = load_env_key(env, "GEMINI_API_KEY")
        if key_val:
            candidates.append({
                "type": "new",
                "id": "gemini",
                "name": "Antigravity Spire",
                "evidence": "Gemini API key present but no key-based usage endpoint — OAuth only, renders sparse",
                "priority": 1,  # Low — sparse rendering by design
                "key_var": "GEMINI_API_KEY",
                "sparse_only": True,
            })

    # Sort by priority descending, then by type (new before enable for same priority)
    candidates.sort(key=lambda c: (-c["priority"], 0 if c["type"] == "new" else 1))
    return candidates


def make_decision(city: dict, usage: dict, env_path: Path) -> dict:
    """Make the Monday expansion decision. Returns decision dict."""
    candidates = assess_providers(city, usage, env_path)
    existing = get_existing_ids(city)

    # Find the best non-blocked candidate
    actionable = [c for c in candidates if not c.get("blocked")]

    if not actionable:
        return {
            "decision": "none",
            "reason": "No provider has a real key in .env. All candidates are blocked.",
            "candidates": candidates,
        }

    # Pick the top candidate
    pick = actionable[0]

    # Check if it would be a duplicate
    if pick["id"] in existing and pick["type"] == "new":
        # Already has a district, skip
        pick = None
        for c in actionable[1:]:
            if c["id"] not in existing:
                pick = c
                break
        if not pick:
            return {
                "decision": "none",
                "reason": "All providers with keys already have districts.",
                "candidates": candidates,
            }

    if not pick:
        return {
            "decision": "none",
            "reason": "No new districts to add — all keyed providers already have districts.",
            "candidates": candidates,
        }

    decision = {
        "decision": "add" if pick["type"] == "new" else "enable",
        "id": pick["id"],
        "name": pick["name"],
        "evidence": pick["evidence"],
        "key_var": pick["key_var"],
        "candidates": candidates,
    }

    # If enabling an existing district, note what to do
    if pick["type"] == "enable":
        decision["action"] = f"Add {pick['key_var']} to .env to enable {pick['name']}"

    return decision


def add_district(city: dict, decision: dict) -> dict:
    """Add a new district to city.json based on the decision."""
    meta = PROVIDER_META.get(decision["id"])
    if not meta:
        print(f"  ERROR: No metadata for {decision['id']}")
        return city

    # Find a free origin position (near existing districts but not overlapping)
    existing_projects = city.get("projects", [])
    origins = [(p["origin"]["x"], p["origin"]["z"]) for p in existing_projects]

    # Place new district at a position that extends the city perimeter
    # Try positions around the existing city boundary
    import math
    max_reach = 0
    for ox, oz in origins:
        reach = math.sqrt(ox**2 + oz**2)
        max_reach = max(max_reach, reach)

    # Place at 45-degree angle from center, at the edge
    angle = len(origins) * math.pi / 4  # Spread districts around
    distance = max_reach + 10
    new_x = round(distance * math.cos(angle), 1)
    new_z = round(distance * math.sin(angle), 1)

    new_district = {
        "id": decision["id"],
        "name": meta["name"],
        "source": decision["id"],
        "tokenShare": 0.3,  # Default fallback
        "origin": {"x": new_x, "z": new_z},
        "size": dict(meta["size"]),
        "style": meta["style"],
        "accent": meta["accent"],
        "evidence": decision["evidence"],
    }

    city.setdefault("projects", []).append(new_district)

    # Add growth trigger for the new district
    growth = city.setdefault("growth", {})
    triggers = growth.setdefault("triggers", [])
    metric = meta.get("metric", "tokens")
    threshold = 50 if metric == "percent" else (100000000 if metric == "tokens" else 5)
    triggers.append({
        "district": decision["id"],
        "metric": metric,
        "threshold": threshold,
        "action": "size_up",
        "factor": 1.25,
        "evidence": f"{meta['name']} reaches {threshold} {metric} — district grows",
    })

    return city


def main():
    apply = "--apply" in sys.argv
    dry_run = not apply

    city = load_json(CITY)
    usage = load_json(USAGE)

    print("=" * 60)
    print("MONDAY CITY EXPANSION DECISION MECHANISM")
    print("=" * 60)
    print(f"  Dry run: {dry_run}")
    print(f"  City: {CITY}")
    print(f"  Usage: {USAGE}")
    print(f"  Env: {ENV}")
    print()

    # Current state
    existing = get_existing_ids(city)
    print(f"Current districts ({len(existing)}):")
    for p in city.get("projects", []):
        pid = p["id"]
        source = p.get("source", "none")
        print(f"  - {pid} ({p.get('name', '')}) source={source}")
    print()

    # Provider key status
    print("Provider key status:")
    for pid, meta in PROVIDER_META.items():
        key_val = load_env_key(ENV, meta["key_var"])
        status = "KEY FOUND" if key_val else "NO KEY"
        in_city = "IN CITY" if pid in existing else "NOT IN CITY"
        print(f"  {pid:<12} {status:<10} {in_city}")
    print()

    # Make decision
    decision = make_decision(city, usage, ENV)

    print("DECISION:")
    print(f"  Action: {decision['decision']}")
    print(f"  Reason: {decision.get('reason', '(actionable — see below)')}")
    print()

    if decision["decision"] in ("add", "enable"):
        print(f"  District: {decision['name']} ({decision['id']})")
        print(f"  Evidence: {decision['evidence']}")
        print(f"  Key var:  {decision['key_var']}")
        print()

        if apply:
            city = add_district(city, decision)
            CITY.write_text(json.dumps(city, indent=2) + "\n")
            print(f"  Updated city.json with {decision['id']} district")

            # Regenerate procedural-city-data.js
            import subprocess
            result = subprocess.run(
                [sys.executable, str(ROOT / "generate-city-data.py")],
                capture_output=True, text=True, cwd=str(ROOT),
            )
            if result.returncode == 0:
                print(f"  Regenerated procedural-city-data.js")
            else:
                print(f"  WARNING: generate-city-data.py failed: {result.stderr}")
        else:
            print("  (dry run — not applying)")
    else:
        print("  No expansion this Monday.")
        print("  Candidates:")
        for c in decision.get("candidates", []):
            status = "BLOCKED" if c.get("blocked") else "ACTIONABLE"
            print(f"    [{status}] {c['id']}: {c['evidence']}")

    print()
    print("=" * 60)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())