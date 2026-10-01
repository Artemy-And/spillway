export type PiiKind =
  | 'secret'
  | 'email'
  | 'card'
  | 'iban'
  | 'ssn'
  | 'nino'
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
  ssn: 'SSNs',
  nino: 'UK NI numbers',
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

/** International numbers have 8 to 15 digits (E.164). */
const phoneLength = (value: string) => {
  const count = digits(value).length;
  return count >= 8 && count <= 15;
};

/**
 * Order matters: specific formats run first, so an IBAN is never reported as a card and a card
 * never as a phone. Numbers that are only ever valid next to a keyword (passport, INN, a bare
 * SSN) require that keyword: prompts from coding tools are full of 9- and 10-digit numbers such
 * as Unix timestamps, and those must not block a request.
 */
const detectors: Detector[] = [
  {
    kind: 'secret',
    pattern:
      /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}|sw-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})|-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'iban', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, valid: iban },
  // Payment cards start with 2–6 (Mir, Visa, Mastercard, Amex, Discover, JCB, UnionPay).
  { kind: 'card', pattern: /\b[2-6](?:[ -]?\d){12,18}\b/g, valid: luhn },
  // US Social Security numbers: 123-45-6789 anywhere, nine bare digits only after "SSN".
  { kind: 'ssn', pattern: /\b(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}\b/g },
  {
    kind: 'ssn',
    pattern: /(?<=\b(?:SSN|social security(?: number| no\.?)?)\W{0,5})(?!000|666|9)\d{9}\b/gi,
  },
  // UK National Insurance numbers: AB 12 34 56 C.
  {
    kind: 'nino',
    pattern:
      /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
  },
  { kind: 'snils', pattern: /\b\d{3}-\d{3}-\d{3}[ -]\d{2}\b/g, valid: snils },
  {
    kind: 'passport',
    pattern:
      /(?<=(?:паспорт\p{L}*|passport|passeport|pasaporte|reisepass|passaporto|paszport)\P{N}{0,20})(?:\d{2} ?\d{2} ?\d{6}\b|\b(?=[A-Z0-9]*\d)[A-Z0-9]{6,9}\b)/giu,
  },
  {
    kind: 'inn',
    pattern: /(?<=(?<![\p{L}\d])(?:ИНН|инн|INN)\P{N}{0,10})\d{10}(?:\d{2})?\b/gu,
    valid: inn,
  },
  {
    kind: 'phone',
    pattern:
      /(?<![\w+])\+\d[\d ().-]{6,20}\d\b|(?<![\w+])8[ -]?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{2}[ -]?\d{2}\b|(?<![\w+(])\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}\b/g,
    valid: phoneLength,
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
