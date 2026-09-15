import { expect, test } from 'bun:test';
import { knowledgeMarketBlocked, SPACE_CASINO_WORKSPACE as ws } from './lib/knowledge-market-policy.js';

test('excludes the retired markets from metadata, imports and game links', () => {
  for (const metadata of [
    { jurisdiction: 'Brazil' }, { jurisdiction: 'BR' }, { jurisdiction: 'Perú' }, { jurisdiction: 'PER' },
    { language: 'pt-BR' }, { language: 'es-pe' }, { category: 'Games · pt-br' },
    { title: '[es-pe] Withdrawal help' },
    { locator: 'https://www.spacecasino.com/%70t-br/games/test/1' },
    { locator: 'https://www.spacecasino.com./ES-PE/help' },
    { body: 'https://spacecasino.com/es-pe/games/provider/game/1' },
    { body: 'Source URL: https://www.spacecasino.com/pt-br/help\nRetrieved: today\n\nHelp' },
    { body: 'Language / market: es-pe\n\nHelp' },
  ]) {
    expect(knowledgeMarketBlocked(ws, metadata)).toBe(true);
    expect(knowledgeMarketBlocked('another-workspace', metadata)).toBe(false);
  }
});

test('preserves other Spanish and Portuguese content and incidental references', () => {
  for (const metadata of [
    { language: 'es-mx', jurisdiction: 'Mexico' }, { language: 'pt', jurisdiction: 'Portugal' },
    { language: 'pt-PT' }, { title: 'Unsupported markets: Brazil and Peru' },
    { locator: 'https://example.com/pt-br/help', language: 'pt' },
    { body: 'Source URL: https://www.spacecasino.com/en-nz/help\n\nCountry menu: https://www.spacecasino.com/pt-br' },
    { locator: 'https://www.spacecasino.com/en-nz/help?related=es-pe' },
  ]) expect(knowledgeMarketBlocked(ws, metadata)).toBe(false);
});
