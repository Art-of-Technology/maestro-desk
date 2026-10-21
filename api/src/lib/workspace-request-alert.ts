import { env } from './env.js';

export async function notifyWorkspaceRequest(brandName: string, organizationName: string): Promise<boolean> {
  const webhook = env.EMAIL_USAGE_SLACK_WEBHOOK_URL || env.SLACK_ALERT_WEBHOOK_URL;
  if (!webhook) return false;
  const heading = '🟠 ACTION REQUIRED: Respovia workspace approval';
  const label = (value: string) => Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, 300).join('').trim() || 'Not provided';
  try {
    const reviewUrl = new URL('/#/god', env.APP_BASE_URL).href;
    const response = await fetch(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        text: `${heading}\nA new Maestro brand needs your approval. No workspace has been created.\nOpen approval requests: ${reviewUrl}`,
        unfurl_links: false, unfurl_media: false,
        // Keep the action outside the secondary card so collapsing details cannot hide it.
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: heading, emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: `*<${reviewUrl}|Open approval requests>*\nReview this request in Respovia before a workspace is created.` } },
        ],
        attachments: [{ color: '#d97706', blocks: [
          { type: 'section', fields: [
            { type: 'plain_text', text: `Brand\n${label(brandName)}` },
            { type: 'plain_text', text: `Organisation\n${label(organizationName)}` },
          ] },
          { type: 'context', elements: [{ type: 'plain_text', text: 'Approval required. Only Respovia platform administrators can approve this request.' }] },
        ] }],
      }),
    });
    if (!response.ok) throw new Error('Slack rejected workspace request alert');
    return true;
  } catch {
    // shortcut: delivery is best-effort; add durable retries if guaranteed alerts are required.
    console.warn('[workspace-request] Slack alert could not be delivered; the request remains pending.');
    return false;
  }
}
