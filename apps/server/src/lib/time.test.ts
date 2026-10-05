import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendar, isTimeZone } from './time.ts';

const at = (iso: string) => new Date(iso);

test('days and months start at midnight in the chosen zone', () => {
  const ny = calendar('America/New_York');
  // 23:00 on Oct 31 in New York is already November in UTC.
  const now = at('2026-11-01T03:00:00Z');
  assert.equal(ny.dayKey(now), '2026-10-31');
  assert.equal(ny.startOfDay(now).toISOString(), '2026-10-31T04:00:00.000Z');
  assert.equal(ny.startOfMonth(now).toISOString(), '2026-10-01T04:00:00.000Z');
  // Clocks go back on Nov 1, so November starts at UTC−4 and December at UTC−5.
  assert.equal(ny.startOfNextMonth(now).toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(
    ny.startOfNextMonth(at('2026-11-15T12:00:00Z')).toISOString(),
    '2026-12-01T05:00:00.000Z',
  );
});

test('counting days back crosses a clock change by the calendar, not by 24 hours', () => {
  const berlin = calendar('Europe/Berlin');
  // Summer time ends on Oct 25, 2026: that day has 25 hours.
  const now = at('2026-10-27T10:00:00Z');
  assert.equal(berlin.daysAgo(3, now).toISOString(), '2026-10-23T22:00:00.000Z');
  assert.equal(berlin.dayKey(berlin.daysAgo(3, now)), '2026-10-24');
});

test('half-hour zones and UTC work the same way', () => {
  const india = calendar('Asia/Kolkata');
  assert.equal(india.dayKey(at('2026-10-04T18:45:00Z')), '2026-10-05');
  assert.equal(
    india.startOfDay(at('2026-10-04T18:45:00Z')).toISOString(),
    '2026-10-04T18:30:00.000Z',
  );
  assert.equal(
    calendar('UTC').startOfMonth(at('2026-10-05T10:00:00Z')).toISOString(),
    '2026-10-01T00:00:00.000Z',
  );
});

test('working hours are checked on the zone’s clock, also across midnight', () => {
  const tokyo = calendar('Asia/Tokyo');
  assert.equal(tokyo.isWithin('09:00', '18:00', at('2026-10-05T02:00:00Z')), true, '11:00');
  assert.equal(tokyo.isWithin('09:00', '18:00', at('2026-10-05T12:00:00Z')), false, '21:00');
  assert.equal(tokyo.isWithin('22:00', '06:00', at('2026-10-05T14:30:00Z')), true, '23:30');
  assert.equal(tokyo.isWithin('22:00', '06:00', at('2026-10-05T03:00:00Z')), false, '12:00');
});

test('unknown zones are refused', () => {
  assert.equal(isTimeZone('Europe/Berlin'), true);
  assert.equal(isTimeZone('Mars/Olympus_Mons'), false);
});
