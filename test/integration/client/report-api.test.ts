import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { readFileSync } from 'node:fs';
import {
  clientReportTopItems,
  getClientReportTopDetail,
  unlockClientReport,
} from '../../../src/models/client-report-api.js';

const enabled = { skip: !process.env.DATABASE_URL },
  parser = new XMLParser({ parseTagValue: false });
async function fixture(run: (db: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    client = await pool.connect();
  try {
    for (const table of ['rep_top', 'rep_role', 'mst_group_affiation', 'rep_lock'])
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await client.query(`INSERT INTO pg_temp.rep_top (rep_top_id,rep_top_name,deleted,xml_data,use_init_input_judge_parameters,sys_regist_time,use_end_date,def_file) VALUES
      (1,'Report & name',1,'<conmas><sheet id="1"/></conmas>','<useInitInputJudgeParameters>ignored<judge>yes</judge></useInitInputJudgeParameters>','2026-11-07 12:34:56','2026-11-08 01:02:03','binary'),
      (2,'Null',0,NULL,NULL,NULL,NULL,NULL);
      INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read) VALUES (1,1,1),(2,1,1);
      INSERT INTO pg_temp.mst_group_affiation (user_id,group_id) VALUES ('reader',1)`);
    await run({
      query: client.query.bind(client),
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as pg.Pool);
  } finally {
    client.release(true);
    await pool.end();
  }
}

test('report top inquiry allowlist matches every installed source property in order', () => {
  const source = readFileSync(
    'legacy/decompiled/conmas-manager-decompiled/Cimtops.ConMasBiz/Cimtops/ConMasBiz/API/Data/RepTop.cs',
    'utf8',
  );
  const names = [...source.matchAll(/public [\w?[\]]+ (\w+) \{ get;/g)].map(
    (match) => match[1]![0]!.toLowerCase() + match[1]!.slice(1),
  );
  assert.deepEqual(clientReportTopItems, names);
});

test(
  'report top inquiry validates items before IDs, preserves selected ordering, repeated items and existence-before-read-permission',
  enabled,
  async () =>
    fixture(async (db) => {
      const inquiry = (id: string, items: string, user = 'reader') => getClientReportTopDetail(db, user, id, items);
      assert.match(await inquiry('', ''), /<code>2<\/code>/);
      assert.match(await inquiry('bad', 'repTopId,notAField,notAField'), /<code>2<\/code>/);
      assert.match(await inquiry('1', 'repTopName, repTopId'), /Invalid value &apos; repTopId&apos;/);
      await assert.rejects(inquiry('2147483648', 'repTopName'), /Invalid report ID/);
      await assert.rejects(inquiry('1', 'repTopId'), /Empty report detail selection/);
      assert.match(await inquiry('99', 'repTopName', 'denied'), /<code>8<\/code>/);
      assert.match(await inquiry('1', 'repTopName', 'denied'), /<code>3<\/code>/);
      const result = await inquiry(' +1 ', 'repTopName,repTopId,repTopName');
      assert(result.indexOf('<repTopName>') < result.indexOf('<repTopId>'));
      assert.deepEqual(parser.parse(result).conmas.top, {
        repTopName: ['Report & name', 'Report & name'],
        repTopId: '1',
      });
      assert.equal(parser.parse(await inquiry('1', 'deleted', 'conmasadmin')).conmas.top.deleted, '1');
      assert.equal(parser.parse(await inquiry('2', 'defFile,sysRegistTime')).conmas.top.defFile, '');
    }),
);

test(
  'report unlocking releases matching user or numeric terminal locks only, keeps unrelated locks and rolls back both deletes on failure',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(
        "INSERT INTO pg_temp.rep_lock (rep_top_id,user_id,sys_regist_term) VALUES (1,'reader','20'),(2,'other','10'),(3,'other','30'),(4,'reader','10')",
      );
      const unlock = (id: string) => unlockClientReport(db, 'reader', 10, id);
      for (const id of ['', '1,2', '2147483648', '1 OR 1=1']) await assert.rejects(unlock(id), /Invalid report ID/);
      const failingDb = {
        connect: async () => {
          const connection = await db.connect();
          return {
            release: connection.release,
            query: async (sql: string, values?: unknown[]) => {
              if (sql.includes('sys_regist_term=$2')) throw new Error('fixture unlock error');
              return connection.query(sql, values);
            },
          };
        },
      } as unknown as pg.Pool;
      await assert.rejects(unlockClientReport(failingDb, 'reader', 10, '1'), /fixture unlock error/);
      assert.equal((await db.query('SELECT * FROM pg_temp.rep_lock')).rowCount, 4);
      assert.match(await unlock(' +1 '), /<code>0<\/code>/);
      assert.match(await unlock('2'), /<code>0<\/code>/);
      assert.deepEqual(
        (await db.query('SELECT rep_top_id,user_id,sys_regist_term FROM pg_temp.rep_lock ORDER BY rep_top_id')).rows,
        [
          { rep_top_id: 3, user_id: 'other', sys_regist_term: '30' },
          { rep_top_id: 4, user_id: 'reader', sys_regist_term: '10' },
        ],
      );
      assert.match(await unlock('99'), /<code>0<\/code>/);
      assert.match(await unlock('-1'), /<code>0<\/code>/);
    }),
);

test(
  'report top inquiry supports all fields and source date/base64/nested-XML formats, rejecting corrupt stored XML',
  enabled,
  async () =>
    fixture(async (db) => {
      const inquiry = (items: string) => getClientReportTopDetail(db, 'reader', '1', items);
      const top = parser.parse(await inquiry(clientReportTopItems.join(','))).conmas.top;
      assert.equal(Object.keys(top).length, clientReportTopItems.length);
      assert.equal(top.sysRegistTime, '2026/11/07 12:34:56');
      assert.equal(top.useEndDate, '2026/11/08 01:02');
      assert.equal(top.defFile, Buffer.from('binary').toString('base64'));
      assert.deepEqual(top.xmlData, { conmas: { sheet: '' } });
      assert.deepEqual(top.useInitInputJudgeParameters, { judge: 'yes' });
      await db.query(
        "UPDATE pg_temp.rep_top SET use_init_input_judge_parameters='<other><judge/></other>' WHERE rep_top_id=1",
      );
      assert.deepEqual(
        parser.parse(await inquiry('useInitInputJudgeParameters')).conmas.top.useInitInputJudgeParameters,
        { other: { judge: '' } },
      );
      await db.query("UPDATE pg_temp.rep_top SET xml_data='<!DOCTYPE x><conmas/>' WHERE rep_top_id=1");
      await assert.rejects(inquiry('xmlData'), /Invalid definition XML/);
      await assert.rejects(getClientReportTopDetail(db, 'reader', '2', 'xmlData'), /Null report XML/);
    }),
);
