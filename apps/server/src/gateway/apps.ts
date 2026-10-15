import type { App } from '../db/schema.ts';

/**
 * The app behind a request, from what the app itself sends; nothing has to be set up on its side.
 * Only names an app gives on its own count, so a label in the log is never a guess:
 * - Claude Code: user agent `claude-cli/<version> (…)`, in the terminal, VS Code and the SDK;
 * - Codex: `originator` header and user agent `codex_cli_rs`, `codex_vscode`, `codex_exec`…;
 * - n8n: its OpenAI chat model node adds an `openai-platform` header to every request;
 * - Open WebUI: `X-OpenWebUI-*` headers, sent when it forwards user info, and `X-Title`.
 * Open WebUI with default settings names only the Python library it uses, like many scripts, so
 * it counts as 'other' with everything else.
 */
export function detectApp(headers: Headers): App {
  const agent = headers.get('user-agent') ?? '';
  if (/^claude-cli\//i.test(agent)) return 'claude-code';
  if (/^codex/i.test(headers.get('originator') ?? '') || /^codex/i.test(agent)) return 'codex';
  if (headers.has('openai-platform')) return 'n8n';
  if (headers.get('x-title') === 'Open WebUI') return 'open-webui';
  for (const name of headers.keys()) {
    if (name.startsWith('x-openwebui-')) return 'open-webui';
  }
  return 'other';
}
