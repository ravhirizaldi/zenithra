import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const samples = path.join(root, 'legacy/samples');
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false });

function xmlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory()
        ? xmlFiles(file)
        : entry.isFile() && entry.name.toLowerCase().endsWith('.xml')
          ? [file]
          : [];
    })
    .sort();
}

function setField(xml: string, name: string, value: string): string {
  const match = new RegExp(`(<${name}>)[\\s\\S]*?(</${name}>)`);
  if (!match.test(xml)) throw new Error(`Missing XML field ${name}`);
  const escaped = value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
  );
  return xml.replace(match, (_all, open: string, close: string) => `${open}${escaped}${close}`);
}

export async function importSamples(db: pg.Pool): Promise<{ imported: number; unchanged: number }> {
  const client = await db.connect();
  let imported = 0;
  let unchanged = 0;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS conmas_node_sample_import (
      source_path text PRIMARY KEY, source_sha256 text NOT NULL,
      def_top_id integer NOT NULL REFERENCES def_top(def_top_id),
      rep_top_id integer NOT NULL REFERENCES rep_top(rep_top_id),
      source_xml text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const file of xmlFiles(samples)) {
      const sourcePath = path.relative(samples, file).replaceAll(path.sep, '/');
      const sourceXml = readFileSync(file, 'utf8');
      const hash = createHash('sha256').update(sourceXml).digest('hex');
      const existing = await client.query<{ source_sha256: string }>(
        'SELECT source_sha256 FROM conmas_node_sample_import WHERE source_path = $1',
        [sourcePath],
      );
      if (existing.rowCount) {
        if (existing.rows[0].source_sha256 !== hash) throw new Error(`Changed sample requires review: ${sourcePath}`);
        unchanged++;
        continue;
      }
      const validation = XMLValidator.validate(sourceXml);
      if (validation !== true) throw new Error(`Invalid sample XML: ${sourcePath}`);
      const top = parser.parse(sourceXml)?.conmas?.top;
      if (!top || !top.defTopName || top.repTopId)
        throw new Error(`Expected an unfilled Form definition: ${sourcePath}`);
      const name = String(top.defTopName);
      const rawSheets = top.sheets?.sheet;
      const sheets = rawSheets ? (Array.isArray(rawSheets) ? rawSheets : [rawSheets]) : [];
      if (!sheets.length) throw new Error(`No sheets in sample: ${sourcePath}`);
      const form = await client.query<{ def_top_id: number }>(
        `INSERT INTO def_top
        (def_top_name, rev_no, report_type, def_sheet_count, public_status, deleted,
         xml_data, sys_regist_user, sys_regist_user_name, sys_regist_time,
         sys_update_user, sys_update_user_name, sys_update_time)
        VALUES ($1, 1, $2, $3, 2, 0, $4, 'node-import', 'Sample import', now(), 'node-import', 'Sample import', now())
        RETURNING def_top_id`,
        [name, Number(top.reportType) || 2, sheets.length, sourceXml],
      );
      const defId = form.rows[0].def_top_id;
      const defXml = setField(sourceXml, 'defTopId', String(defId));
      await client.query('UPDATE def_top SET def_top_org = $1, xml_data = $2 WHERE def_top_id = $1', [defId, defXml]);
      const defSheetIds: number[] = [];
      for (const [index, sheet] of sheets.entries()) {
        const row = await client.query<{ def_sheet_id: number }>(
          `INSERT INTO def_sheet
          (def_top_id, def_sheet_no, def_sheet_name, sys_regist_user, sys_regist_time, sys_update_user, sys_update_time)
          VALUES ($1, $2, $3, 'node-import', now(), 'node-import', now()) RETURNING def_sheet_id`,
          [defId, Number(sheet.sheetNo) || index + 1, String(sheet.defSheetName || `Sheet ${index + 1}`)],
        );
        defSheetIds.push(row.rows[0].def_sheet_id);
      }
      const documentName = `Sample - ${name}`;
      const document = await client.query<{ rep_top_id: number }>(
        `INSERT INTO rep_top
        (def_top_id, rep_top_name, rev_no, report_type, rep_sheet_count, public_status, deleted,
         xml_data, sys_regist_user, sys_regist_user_name, sys_regist_time,
         sys_update_user, sys_update_user_name, sys_update_time)
        VALUES ($1, $2, 1, $3, $4, 2, 0, $5, 'node-import', 'Sample import', now(), 'node-import', 'Sample import', now())
        RETURNING rep_top_id`,
        [defId, documentName, Number(top.reportType) || 2, sheets.length, sourceXml],
      );
      const repId = document.rows[0].rep_top_id;
      let repXml = setField(defXml, 'repTopId', String(repId));
      repXml = setField(repXml, 'repTopName', documentName);
      await client.query('UPDATE rep_top SET rep_top_org = $1, xml_data = $2 WHERE rep_top_id = $1', [repId, repXml]);
      for (const [index, sheet] of sheets.entries()) {
        await client.query(
          `INSERT INTO rep_sheet
          (rep_top_id, def_sheet_id, rep_sheet_no, rep_sheet_name, sys_regist_user, sys_regist_time, sys_update_user, sys_update_time)
          VALUES ($1, $2, $3, $4, 'node-import', now(), 'node-import', now())`,
          [
            repId,
            defSheetIds[index],
            Number(sheet.sheetNo) || index + 1,
            String(sheet.repSheetName || sheet.defSheetName || `Sheet ${index + 1}`),
          ],
        );
      }
      await client.query(
        `INSERT INTO conmas_node_sample_import
        (source_path, source_sha256, def_top_id, rep_top_id, source_xml) VALUES ($1, $2, $3, $4, $5)`,
        [sourcePath, hash, defId, repId, sourceXml],
      );
      imported++;
    }
    await client.query('COMMIT');
    return { imported, unchanged };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log(await importSamples(db));
  } finally {
    await db.end();
  }
}
