// Shared helpers for the two invite flows — the platform-admin owner-invite
// (routes/god.ts) and the workspace agent-invite (routes/agents.ts). Both mint
// a Better Auth user for a fresh email and derive a display name/initials.

// Derive a reasonable display name + initials from an email local-part, e.g.
// "jane.doe@x.com" → { name: "Jane Doe", initials: "JD" }.
export function deriveNameFromEmail(email: string): { name: string; initials: string } {
  const local = email.split('@')[0] || 'user';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : '');
  const first = cap(parts[0]) || 'User';
  const last = cap(parts[1] ?? '');
  return {
    name: [first, last].filter(Boolean).join(' '),
    initials: ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || first.slice(0, 2).toUpperCase(),
  };
}

// Initials from a provided full name, e.g. "Jane Q Doe" → "JQD" (max 3).
export function initialsFromName(name: string): string {
  const ini = name.trim().split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  return ini || name.slice(0, 2).toUpperCase();
}

// Throwaway password for a freshly-created account — the invitee never learns
// it and sets their own via the emailed reset link. Long + random so it
// satisfies any password policy and can't be guessed in the meantime.
export function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 'Aa1!' + Buffer.from(bytes).toString('base64url');
}
