/**
 * Integration tests for database operations.
 *
 * Requires TEST_DATABASE_URL env var pointing to a Neon Postgres instance.
 * Run: TEST_DATABASE_URL="postgresql://..." pnpm test tests/integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../src/services/postgres/schema.js';
import type { Database } from '../../src/services/postgres/client.js';
import {
  storeObservation,
  getObservation,
  getObservationsByIds,
  computeObservationContentHash,
  findDuplicateObservation,
} from '../../src/services/postgres/Observations.js';
import {
  createSdkSession,
  getSdkSession,
  completeSdkSession,
  storeUserPrompt,
  getPromptCount,
} from '../../src/services/postgres/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Skip all tests if no test DB URL
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

let db: Database;
const TEST_PROJECT = `test-${Date.now()}`;
const TEST_SESSION_ID = `test-session-${Date.now()}`;
const TEST_MEMORY_SESSION_ID = `test-mem-${Date.now()}`;

describeWithDb('Database Integration', () => {
  beforeAll(async () => {
    const client = neon(TEST_DB_URL!);
    db = drizzle(client, { schema });

    // Ensure schema exists (tables should already be pushed)
    // Create a test SDK session for observation FK
    await db.insert(schema.sdkSessions).values({
      content_session_id: TEST_SESSION_ID,
      memory_session_id: TEST_MEMORY_SESSION_ID,
      project: TEST_PROJECT,
      user_prompt: 'test prompt',
      started_at: new Date().toISOString(),
      started_at_epoch: Date.now(),
      status: 'active',
    });
  });

  afterAll(async () => {
    // Clean up test data
    await db.delete(schema.observations).where(eq(schema.observations.project, TEST_PROJECT));
    await db.delete(schema.userPrompts).where(eq(schema.userPrompts.content_session_id, TEST_SESSION_ID));
    await db.delete(schema.sdkSessions).where(eq(schema.sdkSessions.content_session_id, TEST_SESSION_ID));
  });

  // -----------------------------------------------------------------------
  // SDK Sessions
  // -----------------------------------------------------------------------
  describe('SDK Sessions', () => {
    const SESSION_2 = `test-session2-${Date.now()}`;

    afterAll(async () => {
      await db.delete(schema.sdkSessions).where(eq(schema.sdkSessions.content_session_id, SESSION_2));
    });

    it('createSdkSession is idempotent', async () => {
      const id1 = await createSdkSession(db, SESSION_2, TEST_PROJECT, 'prompt 1');
      const id2 = await createSdkSession(db, SESSION_2, TEST_PROJECT, 'prompt 2');
      expect(id1).toBe(id2);
    });

    it('getSdkSession returns the session', async () => {
      const session = await getSdkSession(db, TEST_SESSION_ID);
      expect(session).not.toBeNull();
      expect(session!.project).toBe(TEST_PROJECT);
      expect(session!.status).toBe('active');
    });

    it('completeSdkSession marks session as completed', async () => {
      await completeSdkSession(db, SESSION_2);
      const session = await getSdkSession(db, SESSION_2);
      expect(session!.status).toBe('completed');
      expect(session!.completed_at).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // User Prompts
  // -----------------------------------------------------------------------
  describe('User Prompts', () => {
    it('stores and counts prompts', async () => {
      const before = await getPromptCount(db, TEST_SESSION_ID);

      await storeUserPrompt(db, {
        content_session_id: TEST_SESSION_ID,
        prompt_number: (before as number) + 1,
        prompt_text: 'hello world',
        created_at: new Date().toISOString(),
      });

      const after = await getPromptCount(db, TEST_SESSION_ID);
      expect(Number(after)).toBe(Number(before) + 1);
    });
  });

  // -----------------------------------------------------------------------
  // Observations
  // -----------------------------------------------------------------------
  describe('Observations', () => {
    let storedId: number;

    it('stores an observation', async () => {
      const result = await storeObservation(db, {
        memory_session_id: TEST_MEMORY_SESSION_ID,
        project: TEST_PROJECT,
        type: 'discovery',
        title: 'Found the config file',
        narrative: 'The config was in /etc/app.conf',
        facts: JSON.stringify(['Config is YAML', 'Located at /etc/app.conf']),
        concepts: JSON.stringify(['configuration', 'yaml']),
        files_read: JSON.stringify(['/etc/app.conf']),
        created_at: new Date().toISOString(),
      });

      expect(result.id).toBeGreaterThan(0);
      storedId = result.id;
    });

    it('retrieves the stored observation', async () => {
      const obs = await getObservation(db, storedId);
      expect(obs).not.toBeNull();
      expect(obs!.title).toBe('Found the config file');
      expect(obs!.type).toBe('discovery');
      expect(obs!.project).toBe(TEST_PROJECT);
    });

    it('getObservationsByIds preserves order', async () => {
      // Store a second observation
      const result2 = await storeObservation(db, {
        memory_session_id: TEST_MEMORY_SESSION_ID,
        project: TEST_PROJECT,
        type: 'change',
        title: 'Updated config',
        narrative: 'Changed the port number',
        created_at: new Date().toISOString(),
      });

      // Request in reverse order
      const obs = await getObservationsByIds(db, [result2.id, storedId]);
      expect(obs).toHaveLength(2);
      expect(obs[0].id).toBe(result2.id);
      expect(obs[1].id).toBe(storedId);
    });

    it('deduplicates within 30s window', async () => {
      const hash = computeObservationContentHash(TEST_MEMORY_SESSION_ID, 'Dupe title', 'Dupe narrative');

      const first = await storeObservation(db, {
        memory_session_id: TEST_MEMORY_SESSION_ID,
        project: TEST_PROJECT,
        type: 'discovery',
        title: 'Dupe title',
        narrative: 'Dupe narrative',
        content_hash: hash,
        created_at: new Date().toISOString(),
      });

      const second = await storeObservation(db, {
        memory_session_id: TEST_MEMORY_SESSION_ID,
        project: TEST_PROJECT,
        type: 'discovery',
        title: 'Dupe title',
        narrative: 'Dupe narrative',
        content_hash: hash,
        created_at: new Date().toISOString(),
      });

      // Should return the same ID (deduped)
      expect(second.id).toBe(first.id);
    });
  });

  // -----------------------------------------------------------------------
  // Full-text search
  // -----------------------------------------------------------------------
  describe('Full-text search', () => {
    it('search_vector is populated on insert', async () => {
      const result = await storeObservation(db, {
        memory_session_id: TEST_MEMORY_SESSION_ID,
        project: TEST_PROJECT,
        type: 'feature',
        title: 'Implemented authentication',
        narrative: 'Added JWT-based login flow',
        created_at: new Date().toISOString(),
      });

      // Query using tsvector
      const rows = await db
        .select({ id: schema.observations.id })
        .from(schema.observations)
        .where(
          sql`${schema.observations.search_vector} @@ plainto_tsquery('english', 'authentication login')`
        );

      const ids = rows.map((r) => r.id);
      expect(ids).toContain(result.id);
    });
  });
});
