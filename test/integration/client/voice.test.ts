import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { readLicenseFields } from '../../../src/shared/license-counts.js';
import { getVoiceCommonGrammar, getVoiceGrammar } from '../../../src/models/client-voice.js';
import { integer } from '../../../src/models/client-definition-xml.js';

const parser = new XMLParser({ parseTagValue: false, ignoreAttributes: false, trimValues: false });
const parse = (xml: string) => parser.parse(xml).conmas;
const enabled = { skip: !process.env.DATABASE_URL || !process.env.CONMAS_LICENSE_KEY };
async function fixture(run: (db: pg.Pool, client: pg.PoolClient) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    client = await pool.connect();
  try {
    for (const table of ['def_grammar', 'rep_grammar', 'common_grammar', 'rep_top', 'rep_sheet', 'mst_user'])
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await run({ query: client.query.bind(client) } as pg.Pool, client);
  } finally {
    client.release(true);
    await pool.end();
  }
}

test(
  'voice dictionary absence/empty storage is error 8; stored XML is preserved with common words',
  enabled,
  async () =>
    fixture(async (db, client) => {
      assert.equal(parse(await getVoiceGrammar(db, 'Designer', '1')).error.code, '8');
      assert.equal(parse(await getVoiceGrammar(db, 'Designer', '')).error.code, '2');
      assert.equal(parse(await getVoiceGrammar(db, 'Designer', '1 OR 1=1')).error.code, '2');
      assert.equal(parse(await getVoiceGrammar(db, 'Designer', '1', '2147483648')).error.code, '2');
      await client.query("INSERT INTO pg_temp.def_grammar (def_top_id,xml_data) VALUES (1,NULL),(2,''),(3,$1)", [
        '<grammar custom="keep"><moveClusterWords/><selectItemWords><cluster><word>say &amp; save</word></cluster></selectItemWords></grammar>',
      ]);
      for (const id of ['1', '2']) assert.equal(parse(await getVoiceGrammar(db, 'Designer', id)).error.code, '8');
      await client.query(`INSERT INTO pg_temp.common_grammar (common_key,voice_value,anwser_back,anwser_back_option)
    VALUES ('retry','one,, two & three,','Try again & listen',1),('ok',NULL,NULL,1)`);
      const voice = parse(await getVoiceGrammar(db, 'Designer', '3')).grammar;
      assert.equal(voice['@_custom'], 'keep');
      assert.equal(voice.selectItemWords.cluster.word, 'say & save');
      assert.equal(voice.common.retry.answerBack, 'Try again & listen');
      assert.equal(voice.common.retry.moveClusterAnswerBack, '1');
      assert.deepEqual(voice.common.retry.addWords.word, ['one', '', ' two & three', '']);
      assert.equal(voice.common.ok.moveClusterAnswerBack, undefined);
      assert.equal(voice.common.ok.addWords.word, '');
      assert.deepEqual(parse(await getVoiceCommonGrammar(db)).grammar.common, voice.common);
      await client.query('UPDATE pg_temp.def_grammar SET xml_data=$1 WHERE def_top_id=3', ['<!DOCTYPE x><grammar/>']);
      await assert.rejects(getVoiceGrammar(db, 'Designer', '3'), /Invalid definition XML/);
    }),
);

test(
  'report movement overrides definition movement; copy sheets duplicate movement without changing stored grammar',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const definition =
        '<grammar><moveClusterWords><cluster><sheetNo>9</sheetNo><clusterId>4</clusterId></cluster></moveClusterWords><selectItemWords><cluster><word>retain</word></cluster></selectItemWords></grammar>';
      const report =
        '<grammar><moveClusterWords><cluster custom="keep"><sheetNo>0</sheetNo><clusterId>1</clusterId></cluster></moveClusterWords></grammar>';
      await client.query('INSERT INTO pg_temp.def_grammar (def_top_id,xml_data) VALUES (1,$1)', [definition]);
      await client.query(
        "INSERT INTO pg_temp.rep_grammar (rep_top_id,xml_data) VALUES (5,$1),(6,'<grammar><moveClusterWords/></grammar>')",
        [report],
      );
      await client.query('INSERT INTO pg_temp.rep_top (rep_top_id) VALUES (5)');
      await client.query(
        'INSERT INTO pg_temp.rep_sheet (rep_sheet_id,rep_top_id,rep_sheet_no,sheet_no_org) VALUES (1,5,0,NULL),(2,5,1,0),(3,5,2,0)',
      );
      const voice = parse(await getVoiceGrammar(db, 'Designer', '1', '5')).grammar;
      assert.deepEqual(
        voice.moveClusterWords.cluster.map((node: { sheetNo: string }) => node.sheetNo),
        ['0', '1', '2'],
      );
      assert.equal(voice.selectItemWords.cluster.word, 'retain');
      assert.equal(voice.moveClusterWords.cluster[2]['@_custom'], 'keep');
      assert.equal(parse(await getVoiceGrammar(db, 'Designer', '99', '5')).grammar.moveClusterWords.cluster.length, 3);
      assert.equal(
        parse(await getVoiceGrammar(db, 'Designer', '1', '6')).grammar.moveClusterWords.cluster.sheetNo,
        '9',
      );
      assert.equal(parse(await getVoiceGrammar(db, 'Designer', '99', '6')).error.code, '8');
      assert.equal(
        (await client.query('SELECT xml_data FROM pg_temp.def_grammar WHERE def_top_id=1')).rows[0].xml_data,
        definition,
      );
      assert.equal(
        (await client.query('SELECT xml_data FROM pg_temp.rep_grammar WHERE rep_top_id=5')).rows[0].xml_data,
        report,
      );
    }),
);

test(
  'voice license gate applies to Tablet but not Designer; common dictionary has no license gate',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const limit = integer(readLicenseFields().get('AmiVoice') ?? '') ?? 0;
      // Force an over-limit count in the read-only query, not by creating license/user data.
      const over = {
        query: async (text: string, params?: unknown[]) =>
          text.includes('COUNT(1)') ? { rows: [{ count: limit + 1 }] } : client.query(text, params),
      } as unknown as pg.Pool;
      assert.equal(parse(await getVoiceGrammar(over, 'iPad', '1')).error.code, '11050');
      assert.equal(parse(await getVoiceGrammar(over, 'Designer', '1')).error.code, '8');
      assert.equal(parse(await getVoiceGrammar(over, null, '1')).error.code, '8');
      assert.equal(parse(await getVoiceCommonGrammar(over)).grammar.common, '');
      assert.equal(parse(await getVoiceGrammar(db, 'iPad', '1')).error.code, limit > 0 ? '8' : '11050');
    }),
);
