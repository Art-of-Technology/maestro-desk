import type { ComposedEmail } from './email-branding.js';

export type SentEmail = {
  subject: string;
  text: string;
  html: string | null;
  logo_url: string | null;
};

export function sentEmailContent(email: ComposedEmail, subject: string): SentEmail {
  return { subject, text: email.text, html: email.html, logo_url: email.logoUrl || null };
}
