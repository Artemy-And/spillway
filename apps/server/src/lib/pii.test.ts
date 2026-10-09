import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { maskPii } from './pii.ts';

test('masks emails, phones and secrets', () => {
  const { text, found } = maskPii(
    'Mail anna@example.com or call +7 912 345-67-89. Key: sk-ant-api03-abcdefghijklmnopqrstuvwx',
  );
  assert.equal(text, 'Mail [email hidden] or call [phone hidden]. Key: [secret hidden]');
  assert.deepEqual(found, { email: 1, phone: 1, secret: 1 });
});

test('masks US and European phone formats', () => {
  assert.deepEqual(maskPii('Call (415) 555-0132 or 415-555-0199').found, { phone: 2 });
  assert.deepEqual(maskPii('Berlin office +49 30 12345678, Paris +33 1 23 45 67 89').found, {
    phone: 2,
  });
});

test('masks card numbers only when the Luhn check passes', () => {
  assert.deepEqual(maskPii('card 4111 1111 1111 1111').found, { card: 1 });
  assert.deepEqual(maskPii('order 4111 1111 1111 1112').found, {});
});

test('masks US Social Security and UK National Insurance numbers', () => {
  assert.deepEqual(maskPii('SSN 123-45-6789').found, { ssn: 1 });
  assert.deepEqual(maskPii('my social security number: 123456789').found, { ssn: 1 });
  assert.deepEqual(maskPii('invalid 000-12-3456 and 666-12-3456').found, {});
  assert.deepEqual(maskPii('NI number AB 12 34 56 C').found, { nino: 1 });
});

test('masks passport numbers next to the word passport, in several languages', () => {
  assert.deepEqual(maskPii('Passport number: 123456789').found, { passport: 1 });
  assert.deepEqual(maskPii('Reisepass C01X00T47').found, { passport: 1 });
  assert.deepEqual(maskPii('паспорт серия 4510 123456').found, { passport: 1 });
});

test('masks Russian documents with valid checksums', () => {
  assert.deepEqual(maskPii('СНИЛС 112-233-445 95').found, { snils: 1 });
  assert.deepEqual(maskPii('ИНН 7707083893').found, { inn: 1 });
  assert.deepEqual(maskPii('ИНН 7707083894').found, {});
});

test('leaves the numbers coding tools send alone', () => {
  // Unix timestamps, IDs and versions pass checksums by chance; none of them is personal data.
  const input =
    'created: 1790849792, the inn at 7707083893 Main St, id 1234567890123452, build 2026.10.01';
  assert.deepEqual(maskPii(input).found, {});
});

test('masks IBANs and IPv4 addresses', () => {
  const { text, found } = maskPii('Pay to DE89 3704 0044 0532 0130 00 from 10.0.0.12');
  assert.equal(text, 'Pay to [iban hidden] from [ip hidden]');
  assert.deepEqual(found, { iban: 1, ip: 1 });
});

test('scans long runs without spaces in linear time', () => {
  // Minified code or base64 in a tool result; this took seconds and froze the gateway.
  const started = performance.now();
  const { found } = maskPii(`${'x'.repeat(200_000)} ${'x.'.repeat(100_000)} anna@example.com`);
  assert.deepEqual(found, { email: 1 });
  assert.ok(performance.now() - started < 500);
});

test('scans a coding agent prompt of 200 KB quickly', () => {
  // Source files read by tools, as Claude Code and Codex send them; the gateway waits for this.
  const code = ['../gateway/handler.ts', '../gateway/policy.ts', '../admin/routes.ts']
    .map((file) => readFileSync(join(import.meta.dirname, file), 'utf8'))
    .join('\n');
  const prompt = `${code.repeat(Math.ceil(200_000 / code.length))} Passport number: 123456789`;
  const started = performance.now();
  const { found } = maskPii(prompt);
  assert.equal(found.passport, 1);
  assert.ok(performance.now() - started < 150);
});

test('leaves ordinary text alone', () => {
  const input = 'Write three subject lines for the October newsletter, 2026 edition.';
  assert.deepEqual(maskPii(input), { text: input, found: {} });
});
