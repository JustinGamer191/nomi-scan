import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanSummary } from '../.test-build/scanSummary.js';

const scan = {
  mock: false, age: 'adult', status: 'red', model: 'test', image_count: 2,
  products: [{ brand: 'Product A', confidence: 0.9, keys: ['ingredient'], active_ingredients: [{ name: 'ingredient', strength: '500 mg' }] }],
  flags: [{ id: 'duplicate', kind: 'duplicate', severity: 'red', title: 'Duplicate ingredient', ingredients: ['ingredient'], products: ['Product A', 'Product B'], source: 'Rule reference', explanation: 'Label warning text.', citations: ['FDA label citation'] }],
  labels: { ingredient: { ingredient: 'ingredient', found: true, label_name: 'Label A', set_id: 'abc-123' }, unknown: { ingredient: 'unknown', found: false } },
  hints: ['Image 2: unreadable'], notes: ['Check packaging'],
};

test('exports scan context, warnings, missing labels and verifiable sources', () => {
  const text = buildScanSummary(scan, '2026-11-03T01:00:00.000Z');
  for (const value of ['2026-11-03T01:00:00.000Z', 'Adult (18–64)', 'Product A', '500 mg', '[RED] Duplicate ingredient', 'Product A + Product B', 'Label warning text.', 'Rule reference', 'FDA label citation', 'No label found', 'Image 2: unreadable', 'Check packaging', 'Not medical advice']) assert.ok(text.includes(value), value);
  assert.ok(text.includes(encodeURIComponent('set_id:"abc-123"')));
  assert.ok(!text.includes('DEMO ONLY'));
});

test('marks demo data and does not represent a green scan as proof of safety', () => {
  const text = buildScanSummary({ ...scan, mock: true, status: 'green', flags: [], age: 'child' }, 'time');
  assert.match(text, /DEMO ONLY/);
  assert.match(text, /Kid \(6–11\)/);
  assert.match(text, /does not establish safety/);
  assert.match(text, /does not check every possible interaction/);
  assert.match(text, /Recall checks, chat answers, and dose logs are not included/);
});

test('handles missing strengths and label identifiers without creating broken links', () => {
  const text = buildScanSummary({ ...scan, products: [{ ...scan.products[0], active_ingredients: [{ name: 'ingredient', strength: '' }] }], labels: { ingredient: { ingredient: 'ingredient', found: true } } }, 'time');
  assert.match(text, /Strength not read/);
  assert.match(text, /Label found/);
  assert.ok(!text.includes('https://'));
});

test('marks prescription items and carries no prescription personal info', () => {
  const rxScan = {
    ...scan,
    products: [{ brand: 'Sertraline', rx: true, directions: 'Take 1 tablet by mouth once daily', confidence: 0.95, keys: ['sertraline'], active_ingredients: [{ name: 'Sertraline Hydrochloride', strength: '50 mg' }] }],
    flags: [{ id: 'rx-a-b', kind: 'interaction', severity: 'yellow', rx: true, title: 'Sertraline + Advil: label lists an interaction', ingredients: ['ibuprofen'], products: ['Sertraline', 'Advil'], source: 'openFDA label', evidence: [{ label: 'Sertraline Hydrochloride', section: 'drug interactions', quote: 'Drugs that Interfere with Hemostasis (Non-selective NSAIDs, Aspirin, Warfarin, etc.)' }] }],
  };
  const text = buildScanSummary(rxScan, 'time');
  assert.match(text, /Sertraline \[Rx\]/);
  assert.match(text, /Directions on bottle: Take 1 tablet by mouth once daily/);
  assert.match(text, /Label quote \(Sertraline Hydrochloride, drug interactions\)/);
  assert.match(text, /Do not stop a prescription on your own/);
  assert.ok(!/patient|prescriber:|Rx #|pharmacy phone/i.test(text));
});
