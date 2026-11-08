import 'dotenv/config';
import pg from 'pg';

// The shipped base dump predates fields/tables used by the installed business layer.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await db.query('ALTER TABLE mst_user ADD COLUMN IF NOT EXISTS meid_upn text, ADD COLUMN IF NOT EXISTS meid_oid text');
  await db.query('ALTER TABLE def_top ADD COLUMN IF NOT EXISTS cooperation_table numeric');
  await db.query('ALTER TABLE def_external_output_folder ADD COLUMN IF NOT EXISTS optional_setting text');
  await db.query(`CREATE TABLE IF NOT EXISTS edgeocr_info (
    edgeocr_info_id integer PRIMARY KEY, edgeocr_certificate text,
    sys_regist_user text, sys_regist_time timestamp without time zone);
    CREATE TABLE IF NOT EXISTS edgeocr_use_terminals (
    term_id integer PRIMARY KEY, physical_id text,
    sys_regist_user text, sys_regist_time timestamp without time zone)`);
  console.log('User, definition and EdgeOCR compatibility schema is ready.');
} finally {
  await db.end();
}
