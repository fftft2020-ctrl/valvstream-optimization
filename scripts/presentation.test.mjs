import test from 'node:test';
import assert from 'node:assert/strict';
import {displayNumber as f, numberFormat, auditVisibleText} from './presentation.mjs';

test('same physical quantity has one display policy, without changing raw values', () => {
  const raw = [306.037647, 1306.88751, 29560.548];
  assert.deepEqual(raw.map(x => f(x, 'force')), ['306', '1,307', '29,561']);
  assert.equal(raw[0], 306.037647);
  assert.equal(f(4.7, 'pressure'), '4.7');
  assert.equal(f(400, 'temperature'), '400');
  assert.equal(f(124480, 'flow'), '124,480');
  assert.equal(f(1.93786, 'cv'), '1.94');
  assert.equal(f(83.5689, 'opening'), '83.6');
  assert.equal(f(12.300000000000002, 'pressure'), '12.3');
  assert.equal(numberFormat(1306.88751, 'force'), '#,##0');
  assert.equal(numberFormat(4.7, 'pressure'), '0.0');
  assert.equal(numberFormat(400, 'temperature'), '0');
});

test('small nonzero margins and coefficients survive presentation', () => {
  assert.equal(f(-0.04, 'forceMargin'), '-0.04');
  assert.equal(f(0, 'forceMargin'), '0');
  assert.equal(f(-0, 'forceMargin'), '0');
  assert.notEqual(Number(f(1e-20, 'forceMargin')), 0);
  assert.equal(f(0.7422, 'coefficient'), '0.7422');
  for (const x of [null, '', '88-23', Infinity, NaN]) assert.throws(() => f(x, 'force'));
  assert.throws(() => f(1, 'unknown'));
});

test('checks formula/notes as well as numbers; preserves identifiers and cross-scheme notes', () => {
  const note='同一方案的供气损失尚未明确，不能作为零处理。';
  const entries=[{location:'D21',text:'P2=9.553249999999998 bar(a)'},
    {location:'B29',text:'Cv≈352.500'}, {location:'A1',text:'型号0.123456789',role:'identifier'},
    {location:'D2',text:note,scope:'S1',role:'note'},
    {location:'D3',text:note,scope:'S1',role:'note'},
    {location:'D4',text:note,scope:'S2',role:'note'}];
  const findings=auditVisibleText(entries);
  assert.deepEqual(findings.map(x=>[x.location,x.type]), [['D21','long-decimal'],['B29','trailing-zero-review'],['D3','repeated-note']]);
  assert.equal(entries[0].text,'P2=9.553249999999998 bar(a)');
});
