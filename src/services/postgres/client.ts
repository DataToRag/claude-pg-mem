/**
 * Postgres database client using Neon serverless driver + Drizzle ORM.
 *
 * Reads DATABASE_URL from environment. Exports a singleton Drizzle instance
 * and a `getDb()` accessor for lazy initialization.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as schema from './schema.js';

export type Database = NeonHttpDatabase<typeof schema>;

let _db: Database | null = null;

/**
 * Resolve DATABASE_URL from environment or settings file.
 * Priority: DATABASE_URL env > CLAUDE_PG_MEM_DATABASE_URL env > settings.json
 */
function resolveDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.CLAUDE_PG_MEM_DATABASE_URL) return process.env.CLAUDE_PG_MEM_DATABASE_URL;

  // Fall back to settings.json (where the installer stores it)
  const settingsPath = join(
    process.env.CLAUDE_PG_MEM_DATA_DIR || join(homedir(), '.claude-pg-mem'),
    'settings.json',
  );
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      return settings.CLAUDE_PG_MEM_DATABASE_URL || settings.DATABASE_URL;
    } catch {
      // Malformed settings file, ignore
    }
  }
  return undefined;
}

/**
 * Returns the Drizzle database instance, creating it lazily on first call.
 *
 * Reads DATABASE_URL from environment or ~/.claude-pg-mem/settings.json.
 *
 * @throws {Error} if DATABASE_URL is not set.
 */
export function getDb(): Database {
  if (_db) return _db;

  const url = resolveDatabaseUrl();
  if (!url) {
    throw new Error(
      'DATABASE_URL is required. Set it via environment variable or in ~/.claude-pg-mem/settings.json.',
    );
  }

  const client = neon(url);
  _db = drizzle(client, { schema });
  return _db;
}

/**
 * Convenience re-export so callers can do:
 *   import { db } from './client.js'
 *
 * Note: accessing `db` before DATABASE_URL is set will throw.
 * Prefer `getDb()` for explicit control.
 */
export { schema };
