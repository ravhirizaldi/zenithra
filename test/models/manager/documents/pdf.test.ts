import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { documentPdfOptions, documentPdfView } from '../../../../src/models/manager/documents/pdf.js';

test('PDF options preserve source defaults and reject non-boolean or repeated values', () => {
  assert.deepEqual(documentPdfOptions({}), {
    isLayer: false,
    isInitJudgeDisplay: false,
    isForciblyFontSize: false,
    isClusterLine: false,
  });
  assert.equal(documentPdfOptions({ isLayer: 'TRUE' }).isLayer, true);
  for (const name of ['isLayer', 'isInitJudgeDisplay', 'isForciblyFontSize', 'isClusterLine']) {
    for (const value of ['1', 'on', ['true', 'false'], true, null, { value: 'true' }])
      assert.throws(() => documentPdfOptions({ [name]: value }), /Invalid PDF preview options/);
  }
});

test('PDF report/form identity, selected sparse sheet and integer validation precede binary access', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let accessible = true,
    found = true;
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('FROM rep_top t'))
        return { rows: accessible ? [{ def_top_id: 100 }] : [], rowCount: accessible ? 1 : 0 };
      assert.equal(sql, 'SELECT 1 FROM rep_sheet WHERE rep_top_id=$1 AND rep_sheet_no=$2');
      return { rows: found ? [{}] : [], rowCount: found ? 1 : 0 };
    },
  } as unknown as Pick<pg.Pool, 'query'>;
  const input = { repTopId: '1', defTopId: '100' };
  assert.deepEqual(await documentPdfView(db, input, 'fixture'), {
    repTopId: 1,
    defTopId: 100,
    sheetNo: -1,
    clusterId: -1,
    ...documentPdfOptions({}),
  });
  assert.equal((await documentPdfView(db, { ...input, sheetNo: '3', clusterId: '0' }, 'fixture')).sheetNo, 3);
  assert.deepEqual(calls.at(-1)?.values, [1, 3]);
  for (const [name, value] of [
    ['repTopId', '0'],
    ['defTopId', '2147483648'],
    ['sheetNo', '-2'],
    ['clusterId', '-2'],
    ['sheetNo', '1.5'],
    ['repTopId', ['1', '2']],
    ['sheetNo', { no: '3' }],
    ['isLayer', '1'],
  ] as const) {
    const count = calls.length;
    await assert.rejects(documentPdfView(db, { ...input, [name]: value }, 'fixture'));
    assert.equal(calls.length, count);
  }
  for (const allowed of [true, false]) {
    accessible = allowed;
    const count = calls.length;
    await assert.rejects(documentPdfView(db, { ...input, defTopId: '101', sheetNo: '3' }, 'fixture'), /authority/);
    assert.equal(calls.length, count + 1);
  }
  accessible = true;
  found = false;
  await assert.rejects(documentPdfView(db, { ...input, sheetNo: '2' }, 'fixture'), /page index/);
  assert(calls.every(({ sql }) => !/background_image_file|UPDATE|DELETE|INSERT/.test(sql)));
});
