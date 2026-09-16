// These are prompts for an agent to check, never claims that a reply is incorrect.
export function replyWarnings({ text, customerName, replyLanguage, customerLanguage, review }) {
  const warnings = [];
  const normalise = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
  const greeting = String(text || '').match(/^\s*(?:hi|hello|dear|hola|bonjour|hallo|ciao|olá)\s+([\p{L}\p{M}'’-]+)(?:[,.!:\s]|$)/iu);
  if (greeting && customerName && !['there', 'team', 'all', 'customer', 'sir', 'madam', 'mr', 'mrs', 'ms', 'miss', 'dr', 'prof'].includes(normalise(greeting[1]))
      && normalise(greeting[1]) !== normalise(customerName.trim().split(/\s+/)[0])) {
    warnings.push(`The greeting may use a different name. This customer's first name is ${customerName}.`);
  }
  if (customerLanguage && replyLanguage && normalise(customerLanguage) !== normalise(replyLanguage)) {
    warnings.push(`The reply appears to be in ${replyLanguage}; the customer language is ${customerLanguage}.`);
  }
  if (customerLanguage && !replyLanguage && String(text || '').trim()) {
    warnings.push(`The reply language could not be checked. Confirm it matches the customer's ${customerLanguage}.`);
  }
  const claims = /\b(?:guarantee(?:d)?|refund(?:ed)?|approved|eligible|eligibility|\d+\s+(?:business\s+)?(?:days?|hours?)|reembolso|garantizado|aprobado|\d+\s+(?:días?|horas?))\b/iu;
  if (claims.test(text || '')) {
    warnings.push('Check any policy, payment or timing claims against current guidance. This check cannot verify that they are correct.');
  } else if (review && !(review.references || []).some(ref => ref.kind === 'article' || (!ref.kind && ref.url))) {
    warnings.push('No knowledge source accompanies this suggestion. Check any claims before sending.');
  }
  return warnings;
}
