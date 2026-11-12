import type pg from 'pg';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../config/manager.js';
import { clientError } from '../services/client-xml.js';
import { decodeImport } from './manager/system/data-import.js';

function decodeClientLog(data: Buffer): string {
  const bom = data.subarray(0, 4).toString('hex');
  if (bom !== 'fffe0000' && bom !== '0000feff') return decodeImport(data, 'text', 'utf-8');
  let text = '';
  for (let offset = 4; offset < data.length; offset += 4) {
    const point =
      offset + 4 > data.length ? 0xfffd : bom === 'fffe0000' ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
    text += String.fromCodePoint(point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? 0xfffd : point);
  }
  return text;
}

export async function putClientLog(
  db: Pick<pg.Pool, 'query'>,
  physicalId: string | undefined,
  params: Record<string, string>,
  upload: string | undefined,
  now = new Date(),
  directory = join(root, 'logs/operationLogs'),
): Promise<string> {
  if (!upload) {
    const terminal = (
      await db.query('SELECT approver FROM mst_terminal WHERE term_type=$1 AND physical_id=$2 AND deleted=0', [
        params.client,
        params.terminalId,
      ])
    ).rows[0];
    return terminal?.approver ? clientError(0) : '<conmas/>';
  }
  const mode = (
    await db.query(
      "SELECT com_value FROM mst_common WHERE com_key='IPAD_SETTING' AND com_name='LOG_OUTPUT_MODE' ORDER BY com_index",
    )
  ).rows[0]?.com_value;
  const enabled = params.intervalLog === '1' || mode === '1';
  if (!enabled) return '<conmas/>';
  if (!physicalId) throw new Error('Missing client log session identity.');
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  // Private Node storage and hashed names avoid installed-file writes and device-ID path traversal/disclosure.
  const filename = createHash('sha256').update(physicalId).digest('hex') + '.' + date + '.log';
  const text = decodeClientLog(await readFile(upload));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(
    join(directory, filename),
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(text + '\r\n', 'utf8');
  } finally {
    await file.close();
  }
  return '<conmas/>';
}
