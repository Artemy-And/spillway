import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';
import * as schema from './schema.ts';

const MIGRATIONS = join(import.meta.dirname, '../../drizzle');

/**
 * Drizzle on top of Node's built-in SQLite, through the proxy driver:
 * no native modules to compile, one file on disk.
 */
export async function openDb(file: string, migrationsFolder = MIGRATIONS) {
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const db = drizzle(
    async (query, params, method) => {
      const statement = sqlite.prepare(query);
      const values = params as SQLInputValue[];
      if (method === 'run') {
        statement.run(...values);
        return { rows: [] };
      }
      statement.setReturnArrays(true);
      if (method === 'get') return { rows: statement.get(...values) as unknown as unknown[] };
      return { rows: statement.all(...values) as unknown[] };
    },
    { schema },
  );

  await migrate(
    db,
    async (queries) => {
      for (const query of queries) sqlite.exec(query);
    },
    { migrationsFolder },
  );

  return { db, close: () => sqlite.close() };
}

export type Db = Awaited<ReturnType<typeof openDb>>['db'];
