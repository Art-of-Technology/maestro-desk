import { env } from './env.ts';

// ─── Postmark Email API ──────────────────────────────────────────────────
//
// POST https://api.postmarkapp.com/email
//   X-Postmark-Server-Token: <token>
//   Body: { From, To, Subject, TextBody, MessageStream, Headers? }
//
// Returns 200 with { MessageID, SubmittedAt, To, ErrorCode, Message }.
// ErrorCode 0 = success. Non-zero codes (e.g. 405 SignatureNotConfirmed,
// 406 InactiveRecipient) come back as 200 with the failure encoded in the
// JSON body — non-2xx HTTP is reserved for malformed requests / auth.
// See https://postmarkapp.com/developer/api/email-api for the full list.

const ENDPOINT = 'https://api.postmarkapp.com/email';
const STREAM = 'outbound';   // default transactional stream

export interface SendEmailArgs {
  to: string;
  subject: string;
  textBody: string;
  fromEmail: string;
  fromName: string;
  // RFC Message-ID of the email we're replying to. When present, sent as
  // In-Reply-To + References headers so the customer's mail client threads
  // our reply under the original.
  inReplyTo?: string | null;
}

export interface SendEmailResult {
  messageId: string;     // Postmark's MessageID for the sent email
  submittedAt: string;
}

export class PostmarkSendError extends Error {
  constructor(
    message: string,
    public code: number,
    public httpStatus: number,
  ) {
    super(message);
  }
}

export class PostmarkNotConfiguredError extends Error {
  constructor() {
    super('Postmark outbound is not configured (missing POSTMARK_SERVER_TOKEN or POSTMARK_OUTBOUND_FROM)');
  }
}

export function isPostmarkConfigured(): boolean {
  return Boolean(env.POSTMARK_SERVER_TOKEN && env.POSTMARK_OUTBOUND_FROM);
}

/**
 * Send a plain-text email via Postmark. Throws PostmarkNotConfiguredError if
 * env vars are unset, PostmarkSendError if Postmark refuses the send.
 */
export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  if (!isPostmarkConfigured()) {
    throw new PostmarkNotConfiguredError();
  }

  const headers: Array<{ Name: string; Value: string }> = [];
  if (args.inReplyTo) {
    // RFC 5322 Message-IDs are angle-bracket-wrapped on the wire. Some
    // inbound providers strip the brackets; re-add them defensively so
    // threading works regardless of how the original was stored.
    const msgId = args.inReplyTo.startsWith('<') ? args.inReplyTo : `<${args.inReplyTo}>`;
    headers.push({ Name: 'In-Reply-To', Value: msgId });
    headers.push({ Name: 'References', Value: msgId });
  }

  const body = {
    From: formatFrom(args.fromName, args.fromEmail),
    To: args.to,
    Subject: args.subject,
    TextBody: args.textBody,
    MessageStream: STREAM,
    ...(headers.length > 0 ? { Headers: headers } : {}),
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // Non-2xx → auth / malformed / server error. Body is still JSON with a
  // human-readable Message.
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({ Message: res.statusText }))) as {
      Message?: string;
      ErrorCode?: number;
    };
    throw new PostmarkSendError(
      `Postmark refused send (HTTP ${res.status}): ${errBody.Message ?? 'unknown'}`,
      errBody.ErrorCode ?? -1,
      res.status,
    );
  }

  const data = (await res.json()) as {
    MessageID: string;
    SubmittedAt: string;
    To: string;
    ErrorCode: number;
    Message: string;
  };

  // Postmark returns 200 even for some logical failures (e.g. inactive
  // recipient, unconfirmed sender signature). ErrorCode 0 is the success
  // marker.
  if (data.ErrorCode !== 0) {
    throw new PostmarkSendError(
      `Postmark send failed: ${data.Message}`,
      data.ErrorCode,
      res.status,
    );
  }

  return { messageId: data.MessageID, submittedAt: data.SubmittedAt };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build an RFC 5322 From header value: `"Name" <email>` if name present,
 * else just `email`. Quote-escape any double-quotes in the name.
 */
function formatFrom(name: string, email: string): string {
  const trimmed = name.trim();
  if (!trimmed) return email;
  const escaped = trimmed.replace(/"/g, '\\"');
  return `"${escaped}" <${email}>`;
}

/**
 * Prefix a subject with "Re: " if it isn't already a reply. Match standard
 * "re:", "re :", "RE:", "Re[2]:" etc. case-insensitively at the start.
 */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re\s*(\[\d+\])?\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}
