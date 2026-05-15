// ─── Categorical color maps ──────────────────────────────────────────────────
// Shared color tokens for status / priority categorical charts (status pies,
// priority bars, breakdown widgets). Centralised here so every consumer
// (tags, dashboard, reports) renders identical colors for identical keys.
//
// Values are CSS custom-property references defined in index.html's <style>
// block; the var() level of indirection means a theme swap re-tints every
// chart without touching this file.

export const STATUS_COLORS   = { open:'var(--cyan)', pending:'var(--amber)', escalated:'var(--purple)', gdpr:'var(--red)', resolved:'var(--green)' };
export const PRIORITY_COLORS = { urgent:'var(--red)', high:'var(--amber)', normal:'var(--cyan)', low:'var(--ink4)' };
