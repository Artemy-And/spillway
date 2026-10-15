import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectApp } from './apps.ts';

const app = (headers: Record<string, string>) => detectApp(new Headers(headers));

test('Claude Code is told apart by its user agent, wherever it runs', () => {
  // Captured from Claude Code 2.1.300 run from VS Code
  assert.equal(
    app({
      'user-agent': 'claude-cli/2.1.300 (external, claude-vscode, agent-sdk/0.3.296)',
      'x-app': 'cli',
      'x-stainless-lang': 'js',
    }),
    'claude-code',
  );
  assert.equal(app({ 'user-agent': 'claude-cli/2.1.300 (external, cli)' }), 'claude-code');
});

test('Codex is told apart by its originator, in the terminal, VS Code and exec', () => {
  assert.equal(
    app({
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.160.1 (Windows 10.0.26300; x86_64) vscode/1.105.0',
    }),
    'codex',
  );
  assert.equal(app({ originator: 'codex_vscode' }), 'codex');
  assert.equal(app({ 'user-agent': 'codex_exec/0.160.1 (Mac OS 15.5.0; arm64)' }), 'codex');
});

test('n8n is told apart by the header its OpenAI node adds', () => {
  assert.equal(
    app({ 'openai-platform': 'org-qkmJQuJ2WnvoIKMr2UJwIJkZ', 'user-agent': 'OpenAI/JS 5.12.2' }),
    'n8n',
  );
});

test('Open WebUI counts by name only when it says so', () => {
  assert.equal(
    app({ 'user-agent': 'Python/3.11 aiohttp/3.12.15', 'x-openwebui-user-name': 'Tom' }),
    'open-webui',
  );
  assert.equal(app({ 'x-title': 'Open WebUI' }), 'open-webui');
  // With default settings it sends only the library's name, like many scripts do
  assert.equal(app({ 'user-agent': 'Python/3.11 aiohttp/3.12.15' }), 'other');
});

test('everything else is other, with or without a user agent', () => {
  assert.equal(app({ 'user-agent': 'OpenAI/Python 1.99.0' }), 'other');
  assert.equal(app({ 'user-agent': 'curl/8.9.1' }), 'other');
  assert.equal(app({}), 'other');
});
