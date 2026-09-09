// Authenticated AI transport. The provider key stays on the Respovia server.
import { apiGet, apiPost, getJwt, getWorkspaceId } from '../core/api-client.js';

export const AI_MODELS = [
  { v: 'claude-sonnet-4-6', l: 'Claude Sonnet 4.6' },
  { v: 'claude-haiku-4-5', l: 'Claude Haiku 4.5' },
  { v: 'claude-opus-4-7', l: 'Claude Opus 4.7' },
];
export let AI_MODEL = localStorage.getItem('ai_model') || 'claude-sonnet-4-6';
if (!AI_MODELS.some(m => m.v === AI_MODEL)) AI_MODEL = 'claude-sonnet-4-6';
// Retire the old browser credential; never send it to the backend.
localStorage.removeItem('ai_api_key');

export function setAIModel(value) {
  if (!AI_MODELS.some(m => m.v === value)) return;
  AI_MODEL = value;
  localStorage.setItem('ai_model', value);
}

export const getAIStatus = () => apiGet('/api/v1/ai/status');
export const checkAIConnection = () => apiPost('/api/v1/ai/check', { model: AI_MODEL });

export async function callClaude({ system, messages, maxTokens = 1024, model, action = 'draft', sources = [] }) {
  const workspace = getWorkspaceId();
  const jwt = getJwt();
  if (!workspace || !jwt) throw new Error('Sign in and select a workspace to use AI.');
  const data = await apiPost('/api/v1/ai/messages', {
    system, messages, maxTokens, model: model || AI_MODEL, action, sources,
  });
  // An in-flight result must never be applied after an account/brand switch.
  if (workspace !== getWorkspaceId() || jwt !== getJwt()) throw new Error('Workspace changed. Please try again.');
  return { text: data.text, data };
}
