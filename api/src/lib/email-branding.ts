// Email branding composition. Wraps an outbound message body with the
// workspace's default header + footer template and, when the email was
// authored by a specific agent, that agent's default signature. Produces a
// plain-text body (always) and an HTML body (when there's anything to brand)
// so sendEmail can send a multipart email whose logo renders in HTML clients
// and degrades to text everywhere else.
//
// The logo is reused from workspaces.logo_url — there is no separate email
// logo. A template only toggles whether to show it (show_logo).
//
// Authoring model: the settings UI captures plain text for the header / footer
// / signature, stored in the *_text columns; we derive safe HTML from it
// (escape → linkify → nl2br). The *_html columns are reserved for a future
// raw-HTML authoring mode; when present they win, but nothing writes them yet,
// so stored content is escaped and cannot inject markup into recipients' mail.

import { getDb } from './db.js';

export interface BrandTemplate {
  id: string;
  name: string;
  header_html: string | null;
  header_text: string | null;
  footer_html: string | null;
  footer_text: string | null;
  show_logo: boolean;
}

export interface EmailSignature {
  id: string;
  name: string;
  body_html: string | null;
  body_text: string | null;
}

export interface ComposeArgs {
  workspaceId: string;
  // When set, the author's default signature (if any) is appended above the
  // footer. Leave null for system/brand emails (CSAT, magic-link, auto-reply).
  authorUserId?: string | null;
  // The core message, plain text — exactly what the caller would have passed
  // as textBody before branding existed.
  bodyText: string;
}

export interface ComposedEmail {
  text: string;
  // null when there's nothing to brand (no default template, no logo, no
  // signature) — the caller then sends plain text exactly as before.
  html: string | null;
}

// ─── Lookups ───────────────────────────────────────────────────────────────

export async function getDefaultBrandTemplate(workspaceId: string): Promise<BrandTemplate | null> {
  const sql = getDb();
  const [row] = await sql<BrandTemplate[]>`
    select id, name, header_html, header_text, footer_html, footer_text, show_logo
    from email_brand_templates
    where workspace_id = ${workspaceId} and is_default = true and deleted_at is null
    limit 1
  `;
  return row ?? null;
}

export async function getDefaultSignature(workspaceId: string, userId: string): Promise<EmailSignature | null> {
  const sql = getDb();
  const [row] = await sql<EmailSignature[]>`
    select id, name, body_html, body_text
    from email_signatures
    where workspace_id = ${workspaceId} and user_id = ${userId}
      and is_default = true and deleted_at is null
    limit 1
  `;
  return row ?? null;
}

// ─── Composition ─────────────────────────────────────────────────────────────

export async function composeEmail(args: ComposeArgs): Promise<ComposedEmail> {
  const { workspaceId, authorUserId, bodyText } = args;
  const sql = getDb();

  const [[ws], template, signature] = await Promise.all([
    sql<{ name: string; logo_url: string | null }[]>`
      select name, logo_url from workspaces where id = ${workspaceId}
    `,
    getDefaultBrandTemplate(workspaceId),
    authorUserId ? getDefaultSignature(workspaceId, authorUserId) : Promise.resolve(null),
  ]);

  const logoUrl = template?.show_logo ? (ws?.logo_url ?? null) : null;
  const headerText = template?.header_text?.trim() || null;
  const footerText = template?.footer_text?.trim() || null;
  const sigText    = signature?.body_text?.trim() || null;

  // Nothing to add → keep the plain-text path identical to pre-branding sends.
  if (!logoUrl && !headerText && !footerText && !sigText
      && !template?.header_html && !template?.footer_html && !signature?.body_html) {
    return { text: bodyText, html: null };
  }

  // ── Plain-text assembly ──
  const textParts: string[] = [];
  if (headerText || (template?.header_html && !headerText)) {
    const ht = headerText ?? stripHtml(template!.header_html!);
    if (ht) textParts.push(ht);
  }
  textParts.push(bodyText);
  if (sigText || (signature?.body_html && !sigText)) {
    const st = sigText ?? stripHtml(signature!.body_html!);
    if (st) textParts.push(st);
  }
  if (footerText || (template?.footer_html && !footerText)) {
    const ft = footerText ?? stripHtml(template!.footer_html!);
    if (ft) textParts.push(ft);
  }
  const text = textParts.join('\n\n');

  // ── HTML assembly ──
  const headerHtml = template?.header_html?.trim() || (headerText ? textToHtml(headerText) : '');
  const footerHtml = template?.footer_html?.trim() || (footerText ? textToHtml(footerText) : '');
  const sigHtml    = signature?.body_html?.trim()  || (sigText ? textToHtml(sigText) : '');
  const bodyHtml   = textToHtml(bodyText);

  const logoBlock = logoUrl
    ? `<img src="${escapeAttr(logoUrl)}" alt="${escapeAttr(ws?.name ?? '')}" style="max-height:48px;max-width:220px;height:auto;border:0;display:block" />`
    : '';

  const headerBlock = (logoBlock || headerHtml)
    ? `<tr><td style="padding:24px 28px 8px">${logoBlock}${headerHtml ? `<div style="margin-top:${logoBlock ? '12px' : '0'}">${headerHtml}</div>` : ''}</td></tr>`
    : '';

  const sigBlock = sigHtml
    ? `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #ececf1;color:#555">${sigHtml}</div>`
    : '';

  const footerBlock = footerHtml
    ? `<tr><td style="padding:16px 28px 24px;border-top:1px solid #ececf1;color:#8a8a93;font-size:12px;line-height:1.5">${footerHtml}</td></tr>`
    : '';

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;-webkit-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
        ${headerBlock}
        <tr><td style="padding:8px 28px 16px;color:#1a1a22;font-size:14px;line-height:1.6">${bodyHtml}${sigBlock}</td></tr>
        ${footerBlock}
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { text, html };
}

// ─── Text/HTML helpers ───────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Attribute-context escape (logo URL, alt text) — quotes must die.
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// Turn admin/agent-authored plain text into safe HTML: escape everything,
// linkify bare http(s) URLs (so "click this link" emails work in HTML), then
// convert newlines to <br>. Operating on already-escaped text means the
// injected <a> tags are the only markup that survives.
export function textToHtml(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    // Trailing punctuation shouldn't be swallowed into the href.
    const m = url.match(/^(.*?)([.,;:!?)]*)$/);
    const href = m ? m[1] : url;
    const tail = m ? m[2] : '';
    return `<a href="${href}" style="color:#5b5bd6;text-decoration:underline">${href}</a>${tail}`;
  });
  return linked.replace(/\r?\n/g, '<br>');
}

// Best-effort HTML → text for the rare case a row only has *_html (no UI writes
// these yet). Strip tags and collapse whitespace; decode the few entities we
// emit. Good enough for a plain-text fallback line.
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
