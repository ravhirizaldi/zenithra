import type pg from 'pg';
import { integer as int32 } from './client-definition-xml.js';
import { clientError } from '../services/client-xml.js';

export async function getClientMessageImage(
  db: pg.Pool,
  messageId: string,
): Promise<string | { data: Buffer; filename: string }> {
  const id = int32(messageId);
  if (id === undefined) return clientError(2);
  const row = (await db.query('SELECT image_file,image_file_name FROM mst_message WHERE message_id=$1', [id])).rows[0];
  if (row?.image_file === null || row?.image_file === undefined) return clientError(8);
  if (!Buffer.isBuffer(row.image_file)) throw new Error('Invalid message image binary.');
  return row.image_file.length ? { data: row.image_file, filename: row.image_file_name ?? '' } : clientError(8);
}

export async function getClientMasterImage(
  db: pg.Pool,
  recordId: string,
  fieldNo: string,
  userId: string,
  termId: number | null,
): Promise<string | { data: Buffer; filename: string }> {
  const id = int32(recordId),
    field = int32(fieldNo);
  if (id === undefined || field === undefined) return clientError(2);
  if (field < 1 || field > 1005 || (field > 100 && field < 1001)) throw new Error('Invalid master image field.');
  if (process.env.CONMAS_PLATFORM?.toLowerCase() === 'cloud' && termId !== null) {
    const mobile = (
      await db.query(
        `SELECT mobile_save FROM mst_custom_table WHERE master_id=(SELECT master_id FROM mst_custom_record WHERE record_id=$1)
      OR master_id=(SELECT master_id FROM mst_custom_default_record WHERE record_id=$1)`,
        [id],
      )
    ).rows[0]?.mobile_save;
    if (Number(mobile) === 1) {
      const error = await syncClientMasterTerminal(db, userId, termId);
      if (error) return error;
    }
  }
  const current = (
    await db.query(
      `SELECT field${String(field).padStart(4, '0')} AS image FROM mst_custom_default_record WHERE record_id=$1`,
      [id],
    )
  ).rows[0];
  // A default-record row suppresses fallback even when its selected field is null or a non-binary value.
  let data: unknown = current?.image;
  if (!current)
    data = (await db.query(`SELECT field${field} AS image FROM mst_custom_record WHERE record_id=$1`, [id])).rows[0]
      ?.image;
  if ((current && !Buffer.isBuffer(data)) || data === null || data === undefined)
    return { data: Buffer.alloc(0), filename: 'empty' };
  if (!Buffer.isBuffer(data)) throw new Error('Invalid legacy master image binary.');
  return { data, filename: `image_${recordId}_${fieldNo}` };
}

export async function syncClientMasterTerminal(
  db: pg.Pool,
  userId: string,
  termId: number,
): Promise<string | undefined> {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    // Serialize capacity checks so concurrent clients cannot exceed the source's configured limit.
    await connection.query('LOCK TABLE custom_master_synching_terminal IN EXCLUSIVE MODE');
    const settings = (
      await connection.query(
        "SELECT com_name,com_value FROM mst_common WHERE com_key='CUSTOM_MASTER' ORDER BY com_index",
      )
    ).rows;
    const setting = (name: string, fallback: number) =>
      int32(settings.find((row) => row.com_name === name)?.com_value ?? '') ?? fallback;
    await connection.query(
      "DELETE FROM custom_master_synching_terminal WHERE sys_update_time<clock_timestamp()-$1*interval '1 second'",
      [setting('SYNC_LIMIT_TIME', 60)],
    );
    const existing = (
      await connection.query('SELECT term_id FROM custom_master_synching_terminal WHERE term_id=$1', [termId])
    ).rowCount;
    if (existing)
      await connection.query(
        'UPDATE custom_master_synching_terminal SET sys_update_user=$1,sys_update_time=clock_timestamp() WHERE term_id=$2',
        [userId, termId],
      );
    else {
      const limit = setting('SYNC_TERMINAL_LIMIT', 5);
      if (
        Number((await connection.query('SELECT count(*) FROM custom_master_synching_terminal')).rows[0].count) >= limit
      ) {
        await connection.query('ROLLBACK');
        return clientError(17009, String(limit));
      }
      await connection.query(
        'INSERT INTO custom_master_synching_terminal (term_id,sys_regist_user,sys_regist_time,sys_update_user,sys_update_time) VALUES ($1,$2,clock_timestamp(),$2,clock_timestamp())',
        [termId, userId],
      );
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

function integer(text: string): number {
  if (!/^[+-]?\d+$/.test(text.trim()) || Number(text) < -2147483648 || Number(text) > 2147483647)
    throw new Error('Invalid binary request integer.');
  return Number(text);
}

// ReportBiz.GetBackgroundExcel: a non-null byte[] stops fallback even when empty (.NET byte[].ToString()).
export async function getClientExcel(
  db: pg.Pool,
  topId: string,
  repTopId: string,
): Promise<{ data: Buffer; filename: string }> {
  const report = integer(repTopId || '-1');
  const definition = report === -1 ? integer(topId || '-1') : -1;
  const tables =
    report !== -1 ? ['def_top', 'rep_top', 'def_top_backup'] : definition !== -1 ? ['def_top', 'def_top_backup'] : [];
  for (const table of tables) {
    const condition =
      report !== -1
        ? table === 'rep_top'
          ? 'rep_top_id=$1'
          : 'def_top_id=(SELECT def_top_id FROM rep_top WHERE rep_top_id=$1)'
        : 'def_top_id=$1';
    const row = (
      await db.query(`SELECT def_file,def_file_type FROM ${table} WHERE ${condition}`, [
        report !== -1 ? report : definition,
      ])
    ).rows[0];
    if (row?.def_file !== null && row?.def_file !== undefined) {
      if (!Buffer.isBuffer(row.def_file)) throw new Error('Invalid Excel binary.');
      return { data: row.def_file, filename: row.def_file.length ? `excel.${row.def_file_type ?? ''}` : 'empty' };
    }
  }
  return { data: Buffer.alloc(0), filename: 'empty' };
}

// ReportBiz.GetBackgroundPdf: report -> associated definition -> associated backup, then explicit topId only for null.
export async function getClientBackgroundPdf(db: pg.Pool, topId: string, repTopId: string): Promise<Buffer> {
  const report = integer(repTopId || '-1');
  let data: Buffer | null = null;
  if (report !== -1) {
    for (const table of ['rep_top', 'def_top', 'def_top_backup']) {
      const condition =
        table === 'rep_top' ? 'rep_top_id=$1' : 'def_top_id=(SELECT def_top_id FROM rep_top WHERE rep_top_id=$1)';
      const row = (await db.query(`SELECT background_image_file FROM ${table} WHERE ${condition}`, [report])).rows[0];
      if (row?.background_image_file !== null && row?.background_image_file !== undefined) {
        if (!Buffer.isBuffer(row.background_image_file)) throw new Error('Invalid PDF binary.');
        data = row.background_image_file;
      }
      if (data?.length) break;
    }
  }
  // Legacy parses topId after report lookup, even if a report binary was found.
  const definition = integer(topId || '-1');
  if (definition !== -1 && data === null) {
    const row = (await db.query('SELECT background_image_file FROM def_top WHERE def_top_id=$1', [definition])).rows[0];
    if (row?.background_image_file !== null && row?.background_image_file !== undefined) {
      if (!Buffer.isBuffer(row.background_image_file)) throw new Error('Invalid PDF binary.');
      data = row.background_image_file;
    }
  }
  if (data === null) throw new Error('Missing PDF binary.');
  return data;
}

export async function getClientSheetBackground(db: pg.Pool, topId: string, sheetNo: string): Promise<Buffer> {
  const row = (
    await db.query('SELECT background_image_file FROM def_sheet WHERE def_top_id=$1 AND def_sheet_no=$2', [
      integer(topId),
      integer(sheetNo),
    ])
  ).rows[0];
  if (!Buffer.isBuffer(row?.background_image_file)) throw new Error('Missing sheet binary.');
  return row.background_image_file;
}
