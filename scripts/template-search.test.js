import { expect, test } from 'bun:test';
import { filterTemplates, templateCategories } from '../web/js/tickets/template-search.js';

const templates = [
  { id: '1', name: 'Refund update', category: ' Payments ', text: 'Your refund is processing.' },
  { id: '2', name: 'Verification', category: 'Account', text: 'Upload your documents.' },
  { id: '3', name: 'Welcome', category: null, text: 'Hello {name}' },
  { id: '4', name: 'Unassigned', category: '  ' },
];

test('search matches name, category and body, ignoring case and extra spaces', () => {
  expect(filterTemplates(templates, '  PAYMENTS   refund ')).toEqual([templates[0]]);
  expect(filterTemplates(templates, 'documents')).toEqual([templates[1]]);
  expect(filterTemplates(templates, 'verification')).toEqual([templates[1]]);
  expect(filterTemplates(templates, 'missing')).toEqual([]);
  expect(filterTemplates(templates, ' ')).toEqual(templates);
});

test('category and search combine without changing source order or identity', () => {
  expect(filterTemplates(templates, 'refund', 'Account')).toEqual([]);
  expect(filterTemplates(templates, '', 'Payments')[0]).toBe(templates[0]);
  expect(filterTemplates(templates, '', 'Uncategorised')).toEqual(templates.slice(2));
  expect(templateCategories(templates)).toEqual(['Account', 'Payments', 'Uncategorised']);
  expect(templates[0].category).toBe(' Payments ');
  expect(filterTemplates([])).toEqual([]);
  expect(filterTemplates([{ name: 'Example', category: 'all' }], '', 'all')).toHaveLength(1);
});

test('new-conversation templates search subject and body with the same rules', () => {
  const starters = [
    { id: 'a', name: 'Follow-up', category: ' Payments ', subject: 'Withdrawal status', body: 'Your bank transfer is pending.' },
    { id: 'b', name: 'Account help', category: '', subject: 'Verification', body: 'Please upload proof of address.' },
  ];
  expect(filterTemplates(starters, 'WITHDRAWAL transfer', 'Payments')).toEqual([starters[0]]);
  expect(filterTemplates(starters, 'proof address')).toEqual([starters[1]]);
  expect(filterTemplates(starters, 'proof', 'Payments')).toEqual([]);
});
