import { TRANSLATOR_LANGS } from '../ai/languages.js';

// Suggestions only: unknown and multilingual markets require an agent's choice.
const markets = [
  ['English', 'UK', 'GB', 'GBR', 'United Kingdom', 'IE', 'IRL', 'Ireland', 'US', 'USA', 'United States', 'United States of America', 'AU', 'AUS', 'Australia', 'NZ', 'NZL', 'New Zealand'],
  ['Spanish', 'ES', 'ESP', 'Spain', 'CL', 'CHL', 'Chile', 'MX', 'MEX', 'Mexico', 'AR', 'ARG', 'Argentina', 'CO', 'COL', 'Colombia', 'PE', 'PER', 'Peru', 'UY', 'URY', 'Uruguay', 'EC', 'ECU', 'Ecuador', 'VE', 'VEN', 'Venezuela'],
  ['Portuguese', 'PT', 'PRT', 'Portugal', 'BR', 'BRA', 'Brazil'],
  ['French', 'FR', 'FRA', 'France'],
  ['German', 'DE', 'DEU', 'Germany', 'AT', 'AUT', 'Austria'],
  ['Italian', 'IT', 'ITA', 'Italy'],
  ['Dutch', 'NL', 'NLD', 'Netherlands'],
  ['Swedish', 'SE', 'SWE', 'Sweden'],
  ['Norwegian', 'NO', 'NOR', 'Norway'],
  ['Danish', 'DK', 'DNK', 'Denmark'],
  ['Polish', 'PL', 'POL', 'Poland'],
  ['Czech', 'CZ', 'CZE', 'Czechia', 'Czech Republic'],
  ['Hungarian', 'HU', 'HUN', 'Hungary'],
  ['Romanian', 'RO', 'ROU', 'Romania'],
  ['Greek', 'GR', 'GRC', 'Greece'],
  ['Turkish', 'TR', 'TUR', 'Turkey', 'Türkiye'],
  ['Japanese', 'JP', 'JPN', 'Japan'],
  ['Korean', 'KR', 'KOR', 'South Korea'],
  ['Thai', 'TH', 'THA', 'Thailand'],
  ['Vietnamese', 'VN', 'VNM', 'Vietnam'],
  ['Indonesian', 'ID', 'IDN', 'Indonesia'],
];

const normalize = value => String(value ?? '').trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const languages = new Map(markets.flatMap(([language, ...aliases]) => aliases.map(alias => [normalize(alias), language])));

export function jurisdictionLanguage(jurisdiction) {
  return languages.get(normalize(jurisdiction)) || '';
}

// The language saved on the profile wins; otherwise a recognised single-language market.
export function suggestedCustomerLanguage(customer) {
  if (!customer) return null;
  if (TRANSLATOR_LANGS.includes(customer.preferredLanguage)) return { language: customer.preferredLanguage, source: 'saved customer language' };
  const language = jurisdictionLanguage(customer.jurisdiction);
  return language ? { language, source: `jurisdiction ${String(customer.jurisdiction).trim()}` } : null;
}
