import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskPii } from './pii.ts';

test('masks emails, phones and secrets', () => {
  const { text, found } = maskPii(
    'Mail anna@example.com or call +7 912 345-67-89. Key: sk-ant-api03-abcdefghijklmnopqrstuvwx',
  );
  assert.equal(text, 'Mail [email hidden] or call [phone hidden]. Key: [secret hidden]');
  assert.deepEqual(found, { email: 1, phone: 1, secret: 1 });
});

test('masks card numbers only when the Luhn check passes', () => {
  assert.deepEqual(maskPii('card 4111 1111 1111 1111').found, { card: 1 });
  assert.deepEqual(maskPii('order 4111 1111 1111 1112').found, {});
});

test('masks Russian documents with valid checksums', () => {
  assert.deepEqual(maskPii('СНИЛС 112-233-445 95').found, { snils: 1 });
  assert.deepEqual(maskPii('ИНН 7707083893').found, { inn: 1 });
  assert.deepEqual(maskPii('ИНН 7707083894').found, {});
  assert.deepEqual(maskPii('паспорт серия 4510 123456').found, { passport: 1 });
});

test('masks IBANs and IPv4 addresses', () => {
  const { text, found } = maskPii('Pay to DE89 3704 0044 0532 0130 00 from 10.0.0.12');
  assert.equal(text, 'Pay to [iban hidden] from [ip hidden]');
  assert.deepEqual(found, { iban: 1, ip: 1 });
});

test('leaves ordinary text alone', () => {
  const input = 'Write three subject lines for the October newsletter, 2026 edition.';
  assert.deepEqual(maskPii(input), { text: input, found: {} });
});
