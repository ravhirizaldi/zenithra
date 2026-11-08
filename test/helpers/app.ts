import type pg from 'pg';
import { createApp as createRuntimeApp } from '../../src/server.js';

// Unrelated route fixtures must not create authentication audit rows or consume restored sequences.
// operation-log.test.ts exercises the real writers against private tables and a private sequence.
export function createApp(database: pg.Pool | null, enableAuth = true) {
  if (!database) return createRuntimeApp(null, enableAuth);
  const db = {
    query: (sql: string, values?: unknown[]) =>
      /^INSERT INTO conmas_(?:operation_log|user_account_operation_log)\b/.test(sql.trimStart())
        ? Promise.resolve({ rows: [], rowCount: 1 })
        : database.query(sql, values),
    connect: database.connect.bind(database),
  } as unknown as pg.Pool;
  return createRuntimeApp(db, enableAuth);
}
