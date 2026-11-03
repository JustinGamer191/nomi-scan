import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage with an optional quota, to test the on-device history store.
let quota = Infinity;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { if (v.length > quota) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
  removeItem: (k) => store.delete(k),
};
const { saveScan, loadHistory, deleteEntry, clearHistory } = await import('../.test-build/history.js');

const scan = (brand, extra = {}) => ({
  mock: true, age: 'adult', model: 'm', status: 'red', image_count: 1, hints: [], notes: [],
  products: [{ brand, confidence: 0.9, keys: ['acetaminophen'], active_ingredients: [{ name: 'Acetaminophen', strength: '500 mg' }], ...extra }],
  labels: { acetaminophen: { ingredient: 'acetaminophen', found: true, label_name: 'L', set_id: 's', warnings: 'long warning text '.repeat(50) } },
  flags: [{ id: 'dup', kind: 'duplicate', severity: 'red', title: 'Duplicate ingredient: acetaminophen', ingredients: ['acetaminophen'], products: [brand, 'B'], source: 'x' }],
});

beforeEach(() => { store.clear(); quota = Infinity; });

test('saves newest first, keeps flags/status/Rx, strips label text', () => {
  saveScan('upload', scan('Tylenol'), '2026-11-02T20:00:00Z');
  saveScan('live', scan('Hydrocodone/APAP', { rx: true, directions: 'Take 1 tablet by mouth every 6 hours', patient: 'JANE DOE', rx_number: '123' }), '2026-11-02T21:00:00Z', 'data:image/jpeg;base64,AAA');
  const list = loadHistory();
  assert.equal(list.length, 2);
  assert.equal(list[0].mode, 'live');
  assert.equal(list[0].result.products[0].rx, true);
  assert.equal(list[0].result.status, 'red');
  assert.equal(list[0].result.flags[0].id, 'dup');
  assert.equal(list[0].result.labels.acetaminophen.warnings, undefined);
  const raw = store.get('nomi-history-v1');
  assert.ok(!raw.includes('JANE DOE') && !raw.includes('rx_number'));
});

test('caps at 50 and supports delete / clear', () => {
  for (let i = 0; i < 55; i++) saveScan('upload', scan(`P${i}`), new Date(Date.UTC(2026, 10, 2, 0, i)).toISOString());
  let list = loadHistory();
  assert.equal(list.length, 50);
  assert.equal(list[0].result.products[0].brand, 'P54');
  list = deleteEntry(list[0].id);
  assert.equal(list.length, 49);
  assert.equal(clearHistory().length, 0);
  assert.equal(loadHistory().length, 0);
});

test('drops thumbnails when storage is tight', () => {
  saveScan('upload', scan('A'), '2026-11-02T20:00:00Z', 'data:image/jpeg;base64,' + 'A'.repeat(5000));
  quota = 4000;
  saveScan('upload', scan('B'), '2026-11-02T20:01:00Z', 'data:image/jpeg;base64,' + 'B'.repeat(5000));
  const list = loadHistory();
  assert.ok(list.length >= 1);
  assert.ok(list.every((e) => !e.thumb));
});
