import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glossaryAnswer, isDoseQuestion } from '../.test-build/glossary.js';
import { singleProductFlags, isInjectable } from '../.test-build/rx.js';
import { singleProductHeadline } from '../.test-build/statusText.js';

// Regression: Live scan of a Fentanyl Citrate 50 mcg/mL vial with the "Baby (under 2)" profile showed GREEN.
const fentanyl = { brand: 'Fentanyl Citrate Injection', rx: true, confidence: 0.9, keys: ['fentanyl'], active_ingredients: [{ name: 'Fentanyl Citrate', strength: '50 mcg/mL' }] };
const sections = [{
  brand: fentanyl.brand, label_name: 'Fentanyl Citrate', rx: true, red: [], yellow: [], routes: ['INTRAMUSCULAR', 'INTRAVENOUS'],
  boxed: 'WARNING: SERIOUS AND LIFE-THREATENING RISKS FROM USE OF FENTANYL CITRATE INJECTION Addiction, Abuse, and Misuse Because the use of Fentanyl Citrate Injection exposes patients to the risks of opioid addiction, abuse and misuse, which can lead to overdose and death.',
  pediatric: '8.4 Pediatric Use The safety and efficacy of Fentanyl Citrate Injection in pediatric patients under two years of age has not been established.',
  controlled: '9.1 Controlled Substance Fentanyl Citrate Injection contains fentanyl, a Schedule II controlled drug substance.',
}];
const baby = { min: 0, max: 2, label: 'Baby (under 2)' };
const adult = { min: 18, max: 65, label: 'Adult (18–64)' };

test('single opioid product with a baby profile is red, never green', () => {
  const flags = singleProductFlags([fentanyl], sections, baby);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'red');
  assert.equal(flags[0].kind, 'boxed');
  assert.ok(flags[0].evidence.some((e) => e.section === 'boxed warning' && /opioid addiction/.test(e.quote)));
  assert.ok(flags[0].evidence.some((e) => e.section === 'pediatric use' && /under two years/.test(e.quote)));
  assert.match(flags[0].explanation, /controlled medication\. Only take it as prescribed to you/);
  assert.match(flags[0].explanation, /given by a healthcare provider/);
  assert.match(singleProductHeadline(flags).title, /Serious warning on 1 product/);
});

test('boxed warning alone is at least yellow for adults', () => {
  const flags = singleProductFlags([fentanyl], sections, adult);
  assert.equal(flags[0].severity, 'yellow');
});

test('injectable detection', () => {
  assert.ok(isInjectable(fentanyl));
  assert.ok(!isInjectable({ brand: 'Sertraline', active_ingredients: [{ name: 'Sertraline', strength: '50 mg' }], confidence: 1 }));
});

test('units and abbreviations get a direct answer', () => {
  assert.match(glossaryAnswer("how much fentanyl citrate can I take... what's MCG in micro?"), /micrograms.*1\/1000 of a milligram/);
  assert.match(glossaryAnswer('what does q6h mean?'), /every 6 hours/);
  assert.match(glossaryAnswer('what is mL'), /milliliters/);
  assert.equal(glossaryAnswer('Tylenol 500 mg'), null);
  assert.ok(isDoseQuestion('how much fentanyl citrate can I take'));
});
