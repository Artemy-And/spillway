import { readFile } from 'node:fs/promises';
import { runCI } from '../apps/server/src/comparison/ci.ts';

try {
  const configPath = process.argv[2];
  if (!configPath || !process.env.SPILLWAY_URL) throw new Error('Usage: node scripts/evaluate.mjs config.json (set SPILLWAY_URL and SPILLWAY_ADMIN_COOKIE)');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const result = await runCI(process.env.SPILLWAY_URL, process.env.SPILLWAY_ADMIN_COOKIE ?? '', config);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CI evaluation failed');
  process.exitCode = 2;
}
