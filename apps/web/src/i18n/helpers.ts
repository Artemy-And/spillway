/** Plural forms a language may need; English uses one/other, Russian adds few/many. */
export interface Forms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** Picks the plural form for `count` and puts the formatted number in place of `#`. */
export function plural(locale: string) {
  const rules = new Intl.PluralRules(locale);
  const number = new Intl.NumberFormat(locale);
  return (count: number, forms: Forms) =>
    (forms[rules.select(count)] ?? forms.other).replaceAll('#', number.format(count));
}

/** Joins "a, b and c" the way the language does. */
export function list(locale: string) {
  const format = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  return (items: string[]) => format.format(items);
}

/** Parameters of a request-log trace step, as the server records them. */
export interface TraceParams {
  profile?: string;
  reason?: string;
  model?: string;
  name?: string;
  team?: string | null;
  rule?: number | null;
  rpm?: number;
  key?: string;
  limit?: number;
  spent?: number;
  percent?: number;
  budget?: number;
  from?: string;
  to?: string;
  keySpent?: number | null;
  keyLimit?: number | null;
  teamPercent?: number | null;
  teamBudget?: number | null;
  pii?: Record<string, number>;
  local?: boolean;
  provider?: string;
  message?: string;
  count?: number;
  saved?: number;
  /** promptCut: tokens sent, about, and tokens Ollama kept */
  sent?: number;
  kept?: number;
}

/** "card numbers ×2, emails ×1" with the language's own labels. */
export function describePii(
  found: Record<string, number> | undefined,
  labels: Record<string, string>,
) {
  return Object.entries(found ?? {})
    .map(([kind, count]) => `${labels[kind] ?? kind} ×${count}`)
    .join(', ');
}
