import test from 'node:test';
import assert from 'node:assert/strict';
import { missingIntradayRange } from '../lib/intraday-coverage.ts';
test('partial historical months remain reusable without time-based expiry', () => {
  assert.equal(missingIntradayRange('2026-09-01','2026-09-21',{fromDate:'2026-09-01',toDate:'2026-09-21'}),null);
});
test('new dates only are fetched when the requested end advances', () => {
  assert.deepEqual(missingIntradayRange('2026-09-01','2026-09-22',{fromDate:'2026-09-01',toDate:'2026-09-21'}),{from:'2026-09-22',to:'2026-09-22'});
});
test('earlier dates extend coverage without redownloading the suffix', () => {
  assert.deepEqual(missingIntradayRange('2026-09-01','2026-09-21',{fromDate:'2026-09-10',toDate:'2026-09-21'}),{from:'2026-09-01',to:'2026-09-09'});
});
test('disjoint requests fill the gap before coverage is merged', () => {
  assert.deepEqual(missingIntradayRange('2026-09-20','2026-09-21',{fromDate:'2026-09-01',toDate:'2026-09-10'}),{from:'2026-09-01',to:'2026-09-21'});
});
test('no cache fetches the requested range', () => {
  assert.deepEqual(missingIntradayRange('2026-09-01','2026-09-21'),{from:'2026-09-01',to:'2026-09-21'});
});
