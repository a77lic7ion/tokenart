#!/usr/bin/env python3
"""Query Hermes session DB by session id or title. Returns JSON."""
import sqlite3, json, sys

DB = '/home/shaun/.hermes/state.db'

def find_session(identifier):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    # Try exact ID match first
    c.execute('SELECT * FROM sessions WHERE id = ?', (identifier,))
    row = c.fetchone()
    if row:
        return dict(row)
    # Try title match (partial, case-insensitive)
    c.execute('SELECT * FROM sessions WHERE title LIKE ? LIMIT 1', (f'%{identifier}%',))
    row = c.fetchone()
    if row:
        return dict(row)
    return None

def session_to_city(session):
    """Convert a session row into a city district structure."""
    provider = session.get('billing_provider') or 'unknown'
    model = session.get('model') or 'unknown'
    input_t = session.get('input_tokens') or 0
    output_t = session.get('output_tokens') or 0
    reasoning_t = session.get('reasoning_tokens') or 0
    total_t = input_t + output_t + reasoning_t
    msgs = session.get('message_count') or 0
    title = session.get('title') or session.get('id', 'unknown')[:20]
    started = session.get('started_at') or 0

    # Per-model breakdown from session_model_usage
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute('SELECT model, billing_provider, api_call_count, input_tokens, output_tokens, reasoning_tokens FROM session_model_usage WHERE session_id = ?', (session.get('id'),))
    model_rows = c.fetchall()
    conn.close()

    models = []
    seen = {}
    for m in model_rows:
        key = m['model']
        mt = (m['input_tokens'] or 0) + (m['output_tokens'] or 0) + (m['reasoning_tokens'] or 0)
        if key in seen:
            seen[key]['calls'] += m['api_call_count'] or 0
            seen[key]['input_tokens'] += m['input_tokens'] or 0
            seen[key]['output_tokens'] += m['output_tokens'] or 0
            seen[key]['reasoning_tokens'] += m['reasoning_tokens'] or 0
            seen[key]['total_tokens'] += mt
        else:
            seen[key] = {
                'model': m['model'],
                'provider': m['billing_provider'] or 'unknown',
                'calls': m['api_call_count'] or 0,
                'input_tokens': m['input_tokens'] or 0,
                'output_tokens': m['output_tokens'] or 0,
                'reasoning_tokens': m['reasoning_tokens'] or 0,
                'total_tokens': mt,
            }
    models = list(seen.values())
    models.sort(key=lambda m: -m['total_tokens'])

    # Map provider to a district-like project entry
    district_id = f"session-{provider}"
    district_name = f"{provider.title()} Session"

    # Size the district based on token volume (log scale to avoid huge cities)
    import math
    log_tokens = math.log10(max(total_t, 1000))
    scale = max(0.3, min(3.0, log_tokens / 3.0))  # 0.3x to 3.0x

    return {
        'id': district_id,
        'name': district_name,
        'title': title,
        'session_id': session.get('id'),
        'provider': provider,
        'model': model,
        'total_tokens': total_t,
        'input_tokens': input_t,
        'output_tokens': output_t,
        'reasoning_tokens': reasoning_t,
        'message_count': msgs,
        'started_at': started,
        'scale': round(scale, 2),
        'models': models,
        'evidence': f"Session '{title}' — {total_t:,} tokens ({msgs} msgs) via {provider}",
        'reference': {
            'metric': 'session_tokens',
            'full': total_t,
            'detail': f"Input: {input_t:,} | Output: {output_t:,} | Reasoning: {reasoning_t:,}"
        }
    }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: query-session.py <session_id_or_title> or --all'}))
        sys.exit(1)

    identifier = sys.argv[1]

    if identifier == '--all':
        # Return all sessions with their model breakdown
        conn = sqlite3.connect(DB)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute('SELECT * FROM sessions ORDER BY started_at DESC')
        all_sessions = c.fetchall()
        conn.close()

        results = []
        for s in all_sessions:
            session = dict(s)
            # Get model breakdown
            conn2 = sqlite3.connect(DB)
            conn2.row_factory = sqlite3.Row
            c2 = conn2.cursor()
            c2.execute('SELECT model, billing_provider, api_call_count, input_tokens, output_tokens, reasoning_tokens FROM session_model_usage WHERE session_id = ?', (session.get('id'),))
            model_rows = c2.fetchall()
            conn2.close()

            models = []
            seen = {}
            for m in model_rows:
                key = m['model']
                mt = (m['input_tokens'] or 0) + (m['output_tokens'] or 0) + (m['reasoning_tokens'] or 0)
                if key in seen:
                    seen[key]['calls'] += m['api_call_count'] or 0
                    seen[key]['input_tokens'] += m['input_tokens'] or 0
                    seen[key]['output_tokens'] += m['output_tokens'] or 0
                    seen[key]['reasoning_tokens'] += m['reasoning_tokens'] or 0
                    seen[key]['total_tokens'] += mt
                else:
                    seen[key] = {
                        'model': m['model'],
                        'provider': m['billing_provider'] or 'unknown',
                        'calls': m['api_call_count'] or 0,
                        'input_tokens': m['input_tokens'] or 0,
                        'output_tokens': m['output_tokens'] or 0,
                        'reasoning_tokens': m['reasoning_tokens'] or 0,
                        'total_tokens': mt,
                    }
            models = list(seen.values())
            models.sort(key=lambda m: -m['total_tokens'])

            input_t = session.get('input_tokens') or 0
            output_t = session.get('output_tokens') or 0
            reasoning_t = session.get('reasoning_tokens') or 0
            total_t = input_t + output_t + reasoning_t
            msgs = session.get('message_count') or 0
            title = session.get('title') or session.get('id', 'unknown')[:20]
            started = session.get('started_at') or 0

            results.append({
                'id': session.get('id'),
                'title': title,
                'provider': session.get('billing_provider') or 'unknown',
                'model': session.get('model') or 'unknown',
                'total_tokens': total_t,
                'input_tokens': input_t,
                'output_tokens': output_t,
                'reasoning_tokens': reasoning_t,
                'message_count': msgs,
                'started_at': started,
                'models': models,
            })

        print(json.dumps(results, indent=2, default=str))
        sys.exit(0)

    session = find_session(identifier)
    if not session:
        print(json.dumps({'error': f'Session not found: {identifier}'}))
        sys.exit(1)

    result = session_to_city(session)
    print(json.dumps(result, indent=2, default=str))