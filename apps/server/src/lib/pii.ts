export type PiiKind =
  | 'secret'
  | 'email'
  | 'card'
  | 'iban'
  | 'snils'
  | 'passport'
  | 'inn'
  | 'phone'
  | 'ip';

export type PiiCounts = Partial<Record<PiiKind, number>>;

export const PII_LABELS: Record<PiiKind, string> = {
  secret: 'API keys',
  email: 'emails',
  card: 'card numbers',
  iban: 'IBANs',
  snils: 'SNILS numbers',
  passport: 'passport numbers',
  inn: 'INNs',
  phone: 'phone numbers',
  ip: 'IP addresses',
};

interface Detector {
  kind: PiiKind;
  pattern: RegExp;
  valid?: (match: string) => boolean;
}

const digits = (value: string) => value.replace(/\D/g, '');

function luhn(value: string): boolean {
  const d = digits(value);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function iban(value: string): boolean {
  const compact = value.replace(/\s/g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function snils(value: string): boolean {
  const d = digits(value);
  if (d.length !== 11) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (9 - i);
  const check = sum < 100 ? sum : sum % 101 === 100 ? 0 : sum % 101;
  return check === Number(d.slice(9));
}

function innChecksum(d: string, weights: number[]): number {
  return (weights.reduce((sum, w, i) => sum + w * Number(d[i]), 0) % 11) % 10;
}

function inn(value: string): boolean {
  const d = digits(value);
  if (d.length === 10) return innChecksum(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[9]);
  if (d.length === 12) {
    return (
      innChecksum(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[10]) &&
      innChecksum(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[11])
    );
  }
  return false;
}

// Order matters: specific formats first, so a card number is never reported as a phone.
const detectors: Detector[] = [
  {
    kind: 'secret',
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|sw-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/g,
  },
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'card', pattern: /\b(?:\d[ -]?){12,18}\d\b/g, valid: luhn },
  { kind: 'iban', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, valid: iban },
  { kind: 'snils', pattern: /\b\d{3}-\d{3}-\d{3}[ -]\d{2}\b/g, valid: snils },
  { kind: 'passport', pattern: /(?<=паспорт\D{0,20})\d{2} ?\d{2} ?\d{6}\b/giu },
  { kind: 'inn', pattern: /\b\d{10}(?:\d{2})?\b/g, valid: inn },
  {
    kind: 'phone',
    pattern:
      /(?<![\w+])(?:\+\d{1,3}|8)[ -]?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{2}[ -]?\d{2}\b|(?<![\w+])\+1[ -]?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/g,
  },
  {
    kind: 'ip',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
];

/** Replaces personal data and secrets with `[kind hidden]` and counts what was found. */
export function maskPii(text: string): { text: string; found: PiiCounts } {
  const found: PiiCounts = {};
  let masked = text;
  for (const { kind, pattern, valid } of detectors) {
    masked = masked.replace(pattern, (match) => {
      if (valid && !valid(match)) return match;
      found[kind] = (found[kind] ?? 0) + 1;
      return `[${kind} hidden]`;
    });
  }
  return { text: masked, found };
}

export function describePii(found: PiiCounts): string {
  return Object.entries(found)
    .map(([kind, count]) => `${PII_LABELS[kind as PiiKind]} ×${count}`)
    .join(', ');
}
