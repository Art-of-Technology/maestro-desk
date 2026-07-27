// Branded outbound send with a platform-sender safety net.
//
// Every workspace-originated email (agent replies, auto-replies, CSAT
// surveys, mention notifications, portal magic links) wants to send From the
// workspace's own verified domain (support@<domain>, via getOutboundFrom) and
// fall back to the platform default (POSTMARK_OUTBOUND_FROM) when the
// workspace has none. Before this helper each call site duplicated that
// resolution — and none of them survived the failure mode where the branded
// From is REJECTED by Postmark (sender signature missing or lapsed after DNS
// drift): the send failed, the error was swallowed by the caller's
// send_failed path, and customer email silently stopped for the whole
// workspace (2026-07-23 prod outage).
//
// Contract: losing the email over branding is always the wrong trade. When
// Postmark rejects the branded From with a sender-signature error, resend
// once from the platform sender and raise an ops alert (deduped per
// workspace+domain) so the domain gets fixed. Every other error propagates
// unchanged, so callers keep their existing failure handling.

import { env } from './env.js';
import { getOutboundFrom } from './outbound-from.js';
import { sendOpsAlert } from './alert.js';
import {
  sendEmail,
  PostmarkSendError,
  PostmarkNotConfiguredError,
  type SendEmailArgs,
  type SendEmailResult,
} from './postmark-outbound.js';

export interface SendBrandedEmailArgs extends Omit<SendEmailArgs, 'fromEmail' | 'fromName'> {
  workspaceId: string;
  // From display name used when the workspace has no branded domain (the
  // branded path uses the domain row's own display name). Defaults 'Support'.
  fallbackFromName?: string;
}

export interface SendBrandedEmailResult extends SendEmailResult {
  fromEmail: string;
  // True when the branded From was rejected by Postmark and the email was
  // resent from the platform sender.
  usedFallbackFrom: boolean;
}

// Postmark ErrorCodes that mean "this From address is not a usable sender
// signature": 400 = signature not found, 401 = signature not confirmed.
// https://postmarkapp.com/developer/api/overview#error-codes
export function isSenderSignatureError(err: unknown): err is PostmarkSendError {
  return err instanceof PostmarkSendError && (err.code === 400 || err.code === 401);
}

export async function sendBrandedEmail(args: SendBrandedEmailArgs): Promise<SendBrandedEmailResult> {
  const { workspaceId, fallbackFromName, ...mail } = args;

  const workspaceFrom = await getOutboundFrom(workspaceId);
  const platformFrom = env.POSTMARK_OUTBOUND_FROM;
  const fromEmail = workspaceFrom?.fromEmail || platformFrom;
  const fromName = workspaceFrom?.fromName || fallbackFromName || 'Support';
  // Neither a branded domain nor a platform sender — same terminal state
  // sendEmail itself reports for missing outbound config.
  if (!fromEmail) throw new PostmarkNotConfiguredError();

  try {
    const result = await sendEmail({ ...mail, fromEmail, fromName });
    return { ...result, fromEmail, usedFallbackFrom: false };
  } catch (err) {
    if (!isSenderSignatureError(err) || !platformFrom || fromEmail === platformFrom) throw err;

    // Branded From rejected. Alert (fire-and-forget — sendOpsAlert never
    // throws and shouldn't delay the retry), then resend from the platform
    // sender. Detail carries infra identifiers only, no recipient PII.
    const domain = fromEmail.split('@')[1] ?? fromEmail;
    void sendOpsAlert({
      signature: `email-domain-send-rejected:${workspaceId}:${domain}`,
      severity: 'critical',
      title: 'Branded sender rejected by Postmark — fell back to platform From',
      detail:
        `workspace=${workspaceId} domain=${domain} postmarkCode=${err.code} http=${err.httpStatus}. ` +
        `Customer emails are sending from the platform address until the domain is re-verified.`,
    });

    const result = await sendEmail({ ...mail, fromEmail: platformFrom, fromName });
    return { ...result, fromEmail: platformFrom, usedFallbackFrom: true };
  }
}
