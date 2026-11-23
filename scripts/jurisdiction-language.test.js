import { expect, test } from 'bun:test';
import { jurisdictionLanguage, suggestedCustomerLanguage } from '../web/js/tickets/jurisdiction-language.js';

test('recognises country codes, names, spacing and accents', () => {
  for (const market of ['CL', 'chl', ' Chile ', 'MX', 'Mexico', 'Perú']) expect(jurisdictionLanguage(market)).toBe('Spanish');
  for (const market of ['UK', 'GB', 'GBR', 'United Kingdom']) expect(jurisdictionLanguage(market)).toBe('English');
  expect(jurisdictionLanguage('DE')).toBe('German');
  expect(jurisdictionLanguage('JP')).toBe('Japanese');
  expect(jurisdictionLanguage('Türkiye')).toBe('Turkish');
  expect(jurisdictionLanguage('BR')).toBe('Portuguese');
});

test('missing, unknown and multilingual jurisdictions require a manual choice', () => {
  for (const market of [undefined, null, '', '  ', 'Unknown', 'CL / BR', 'CA', 'Canada', 'BE', 'Belgium', 'CH', 'Switzerland', 'IN', 'India', 'MT', 'Malta']) {
    expect(jurisdictionLanguage(market)).toBe('');
  }
});

test('the saved customer language wins over the jurisdiction suggestion', () => {
  expect(suggestedCustomerLanguage({ jurisdiction: ' MX ' })).toEqual({ language: 'Spanish', source: 'jurisdiction MX' });
  expect(suggestedCustomerLanguage({ jurisdiction: 'MX', preferredLanguage: 'German' })).toEqual({ language: 'German', source: 'saved customer language' });
  expect(suggestedCustomerLanguage({ jurisdiction: 'MX', preferredLanguage: 'Klingon' }).language).toBe('Spanish');
  for (const customer of [undefined, null, {}, { jurisdiction: 'Canada' }]) expect(suggestedCustomerLanguage(customer)).toBeNull();
});
