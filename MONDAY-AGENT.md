# Monday Agent Decision Mechanism

## Overview

The Monday agent decides whether TokenArt's city has earned ONE new district
each Monday. It follows the "earned, never guessed" rule from TARGET.md.

## How it works

### Input
- `city.json` — current district definitions
- `usage.json` — provider measurement data
- `~/.hermes/.env` — active API keys

### Decision process
1. Scan `.env` for real (non-placeholder) API keys
2. Check `usage.json` for which providers report data
3. For providers with keys but no district → candidate for addition
4. For existing districts with `no_key` status → candidate for enabling
5. Pick the candidate with the strongest evidence
6. Update `city.json` with evidence field
7. Regenerate `procedural-city-data.js`
8. Report decision on issue thread (or do nothing)

### Priority ranking
- Priority 3: Provider has key AND usage data confirms activity
- Priority 2: Provider has key but no usage data yet
- Priority 1: Provider has key but sparse rendering only (Gemini OAuth)
- Priority 0: No key — blocked

## Script

`monday-expand.py` in the TokenArt repo root.

Usage:
```
python3 monday-expand.py          # dry run — prints decision
python3 monday-expand.py --apply  # actually updates city.json
```

## Current Monday decision (2026-09-28)

### Finding
- 6 districts exist in city.json
- 3 providers have keys but no districts: mistral, groq, anthropic, kimi
- 2 providers have districts but no keys: zai, opencode
- 1 provider has key but no usage API: gemini

### Decision
- Added: Mistral Tower (mistral) — MISTRAL_API_KEY present in .env, no district existed
- Evidence: "Mistral API key present in .env — paid tier provider"
- Growth trigger: size_up at 100M tokens

### Blocked (need keys in .env)
- zai: ZAI_API_KEY not in .env (key exists in Keys.txt)
- opencode: OPENCODE_GO_API_KEY not in .env (key exists in Keys.txt)
- nous: NOUS_API_KEY not in .env
- minimax: MINIMAX_API_KEY not in .env

### Next Monday candidates (in priority order)
1. Groq Speed (groq) — GROQ_API_KEY in .env
2. Anthropic Wing (anthropic) — ANTHROPIC_API_KEY in .env
3. Kimi Quarter (kimi) — MOONSHOT_API_KEY in .env
4. Enable Z.ai Quarter — needs ZAI_API_KEY added to .env
5. Enable OpenCode Yard — needs OPENCODE_GO_API_KEY added to .env