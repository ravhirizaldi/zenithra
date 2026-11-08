import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { legacyPassword } from '../../../src/shared/legacy-auth.js';

test(
  'legacy password encryption matches the imported local administrator record',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_LEGACY_KEY || !process.env.CONMAS_TEST_PASSWORD },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const encrypted = legacyPassword(
        'conmasadmin',
        process.env.CONMAS_TEST_PASSWORD!,
        process.env.CONMAS_LEGACY_KEY!,
      );
      const result = await pool.query(
        'SELECT EXISTS(SELECT 1 FROM mst_user WHERE user_id = $1 AND password = $2) AS matches',
        ['conmasadmin', encrypted],
      );
      assert.equal(result.rows[0].matches, true);
    } finally {
      await pool.end();
    }
  },
);
