// ─── AI client ───────────────────────────────────────────────────────────────
// Single fetch wrapper for the Anthropic Messages API. Owns the API-key /
// model configuration (sourced from localStorage) and the request shape.
// Every AI feature in the app goes through callClaude() — this is the
// chokepoint to swap for a relay later when we need PII redaction or
// server-side key custody.
//
// `anthropic-dangerous-direct-browser-access: true` is the SDK's explicit
// opt-in for direct-from-browser calls. Anthropic warns against this for
// production (the key can leak to any script running on this origin); a
// relay endpoint replaces this header + the localStorage key entirely.

export let AI_API_KEY = localStorage.getItem('ai_api_key') || '';
export let AI_MODEL = localStorage.getItem('ai_model') || 'claude-sonnet-4-6';

export function setAIKey(v) {
  AI_API_KEY = v.trim();
  localStorage.setItem('ai_api_key', AI_API_KEY);
}

export function setAIModel(v) {
  AI_MODEL = v;
  localStorage.setItem('ai_model', AI_MODEL);
}

// Returns { text, error, data }. `text` is the first text block from the
// response (the common case); `error` is the API error message if present;
// `data` is the raw response for callers that need anything else. Network
// errors propagate — callers wrap in try/catch as they did before.
export async function callClaude({ system, messages, maxTokens = 1024, model }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AI_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || AI_MODEL || 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  const data = await res.json();
  const text = data.content?.find(c => c.type === 'text')?.text;
  return { text, error: data.error?.message, data };
}
