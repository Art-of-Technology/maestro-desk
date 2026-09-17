export const SUPPORTED_LANGUAGES = [
  'English','Spanish','French','German','Italian','Portuguese','Dutch','Swedish','Norwegian','Danish','Finnish','Polish','Czech','Hungarian','Romanian','Greek','Russian','Ukrainian','Turkish','Arabic','Hebrew','Hindi','Japanese','Mandarin Chinese','Cantonese','Korean','Thai','Vietnamese','Indonesian',
] as const;

export type LanguageDetectionOutcome = {
  outcome: 'success' | 'indeterminate';
  failureCode: null | 'empty_response' | 'unknown_language' | 'unsupported_response';
};

const supported = new Set(SUPPORTED_LANGUAGES.map(language => language.toLowerCase()));

// The browser still owns the customer-facing language choice, but the server
// classifies the raw provider response while it is available so operational
// reporting never needs to retain message text or model output.
export function classifyLanguageDetection(text: string): LanguageDetectionOutcome {
  const value = text.trim().toLowerCase();
  if (!value) return { outcome: 'indeterminate', failureCode: 'empty_response' };
  if (value === 'unknown') return { outcome: 'indeterminate', failureCode: 'unknown_language' };
  if (!supported.has(value)) return { outcome: 'indeterminate', failureCode: 'unsupported_response' };
  return { outcome: 'success', failureCode: null };
}
