import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameProduct } from '../.test-build/productMatch.js';

const ibu = (brand, strength = '200 mg') => ({ brand, active_ingredients: [{ name: 'Ibuprofen', strength }], confidence: 0.9 });

test('form words in the brand name do not split one product', () => {
  assert.equal(sameProduct(ibu('Equate Ibuprofen'), ibu('Equate Ibuprofen Tablets')), true);
  assert.equal(sameProduct(ibu('Advil Liquid-Gels'), ibu('Advil')), true);
});

test('different strengths or brands stay separate', () => {
  assert.equal(sameProduct(ibu('Equate Ibuprofen'), ibu('Equate Ibuprofen', '400 mg')), false);
  assert.equal(sameProduct(ibu('Advil'), ibu('Motrin IB')), false);
});
