type TextLike = { type: string; text?: string };

export function textOf(content: string | readonly TextLike[] | null | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
