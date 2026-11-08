import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import type pg from 'pg';
import { directIsLinked } from '../../../../src/controllers/manager/system/direct.js';

const fixtureKey = 'fixture-direct-key';
let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env.CONMAS_DIRECT_KEY;
  process.env.CONMAS_DIRECT_KEY = fixtureKey;
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.CONMAS_DIRECT_KEY;
  else process.env.CONMAS_DIRECT_KEY = previousKey;
});

function encryptSetting(xml: string): string {
  const key = Buffer.alloc(8);
  for (const [index, byte] of Buffer.from(fixtureKey, 'utf8').entries()) key[index % 8] ^= byte;
  const cipher = createCipheriv('des-ede3-cbc', Buffer.concat([key, key, key]), key);
  return Buffer.concat([cipher.update(xml, 'utf8'), cipher.final()]).toString('base64');
}

test('Direct linkage checks stored refresh token without external requests', async () => {
  const queries: string[] = [];
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error('Direct linkage must not call fetch.');
  };
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{ xml_data: encryptSetting('<direct><refreshToken>refresh-token</refreshToken></direct>') }] };
    },
  } as unknown as pg.Pool;

  try {
    assert.equal(await directIsLinked(db), true);
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /SELECT xml_data FROM mst_direct WHERE key=\$1/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Direct linkage fails closed for missing, empty, or malformed settings', async () => {
  const missing = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
  const emptyToken = {
    query: async () => ({ rows: [{ xml_data: encryptSetting('<direct><refreshToken></refreshToken></direct>') }] }),
  } as unknown as pg.Pool;
  const malformed = { query: async () => ({ rows: [{ xml_data: 'not encrypted XML' }] }) } as unknown as pg.Pool;

  assert.equal(await directIsLinked(missing), false);
  assert.equal(await directIsLinked(emptyToken), false);
  assert.equal(await directIsLinked(malformed), false);
});

test('Direct linkage fails closed when its private compatibility key is missing', async () => {
  delete process.env.CONMAS_DIRECT_KEY;
  const db = {
    query: async () => ({
      rows: [{ xml_data: encryptSetting('<direct><refreshToken>fixture</refreshToken></direct>') }],
    }),
  } as unknown as pg.Pool;
  assert.equal(await directIsLinked(db), false);
});
