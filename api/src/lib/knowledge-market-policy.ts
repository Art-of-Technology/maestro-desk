// Stable workspace identity already used by the Space Casino connection migration.
export const SPACE_CASINO_WORKSPACE = '69a587ed-4487-427a-a06c-610d98d83149';
export const UNSUPPORTED_KNOWLEDGE_MARKET = 'Brazil and Peru are no longer supported by Space Casino. Choose a supported jurisdiction.';
export class UnsupportedKnowledgeMarket extends Error {
  constructor() { super(UNSUPPORTED_KNOWLEDGE_MARKET); }
}
type Metadata = { title?: string; category?: string; language?: string; jurisdiction?: string; locator?: string; body?: string };
const normalize = (value = '') => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replaceAll('_', '-');
const excluded = (value?: string) => ['br', 'bra', 'brazil', 'brasil', 'pt-br', 'pe', 'per', 'peru', 'es-pe'].includes(normalize(value));

function excludedUrl(value = '') {
  try {
    const url = new URL(value.trim());
    if (!['spacecasino.com', 'www.spacecasino.com'].includes(url.hostname.toLowerCase().replace(/\.$/, ''))) return false;
    const path = decodeURIComponent(url.pathname).replaceAll('\\', '/');
    return ['pt-br', 'es-pe'].includes(normalize(path.split('/').filter(Boolean)[0]));
  } catch { return false; }
}

export function knowledgeMarketBlocked(workspaceId: string | undefined, metadata: Metadata): boolean {
  if (workspaceId !== SPACE_CASINO_WORKSPACE) return false;
  if (excluded(metadata.jurisdiction) || ['pt-br', 'es-pe'].includes(normalize(metadata.language))) return true;
  if (excluded(metadata.category?.split('·').at(-1)) || excluded(metadata.title?.match(/^\s*\[([^\]]+)\]/)?.[1])) return true;
  if (excludedUrl(metadata.locator)) return true;
  const body = metadata.body?.trim() || '';
  if (excludedUrl(body)) return true;
  // Import provenance only. Ordinary references to countries or navigation links
  // in supported-market documents must not exclude the entire document.
  const header = body.split(/\r?\n\s*\r?\n/, 1)[0];
  for (const line of header.split(/\r?\n/)) {
    const url = line.match(/^(?:Source URL|Requested URL|URL):\s*(\S+)/i)?.[1];
    const market = line.match(/^(?:Language\s*\/\s*market|Language|Jurisdiction):\s*(.+)$/i)?.[1];
    if ((url && excludedUrl(url)) || (market && excluded(market))) return true;
  }
  return false;
}

export function assertKnowledgeMarket(workspaceId: string | undefined, metadata: Metadata) {
  if (knowledgeMarketBlocked(workspaceId, metadata)) throw new UnsupportedKnowledgeMarket();
}
