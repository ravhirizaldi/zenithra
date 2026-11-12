import type pg from 'pg';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { licenseDate, readLicenseFields } from '../shared/license-counts.js';
import { root } from '../config/manager.js';
import { configuredPath } from '../controllers/manager/system/files.js';
import { clientError } from '../services/client-xml.js';
import { element, integer, serialize, type XmlNode } from './client-definition-xml.js';

type Database = Pick<pg.Pool, 'query'>;
const text = (row: Record<string, unknown>, key: string) => String(row[key] ?? '');
const fields = (row: Record<string, unknown>, mapping: Record<string, string>) =>
  Object.entries(mapping).map(([name, key]) => element(name, text(row, key)));
async function setting(db: Database, key: string, name: string) {
  return (
    await db.query('SELECT com_value FROM mst_common WHERE com_key=$1 AND com_name=$2 ORDER BY com_index', [key, name])
  ).rows[0]?.com_value;
}
export async function clientLibraryDirectory(db: Database): Promise<string> {
  const configured = await setting(db, 'LIBRARY', 'BASE_FOLDER');
  if (configured) {
    const candidate = configuredPath(configured);
    if ((await stat(candidate).catch(() => undefined))?.isDirectory()) return candidate;
  }
  return join(root, 'SettingFiles', 'xml', 'Library');
}
const role = (table: string) => `(NOT EXISTS (SELECT 1 FROM ${table} r WHERE r.document_id=doc.document_id)
  OR EXISTS (SELECT 1 FROM ${table} r JOIN mst_group_affiation a ON a.group_id=r.group_id WHERE r.document_id=doc.document_id AND a.user_id=$1))`;

export async function getClientLocalReferenceList(
  db: Database,
  userId: string,
  libraryType: string,
  today = new Date(),
): Promise<string> {
  const mode = libraryType === '1' ? 'image' : 'common';
  today = new Date(today);
  today.setHours(0, 0, 0, 0);
  const labels = (
    await db.query(
      `SELECT mst_label_id,upper_label_id,label_name,diplay_number,label_icon_id FROM mst_label_${mode}_document`,
    )
  ).rows;
  const labelRoles = (await db.query(`SELECT mst_label_id,group_id FROM ${mode}_document_label_role`)).rows;
  const links = (await db.query(`SELECT document_id,mst_label_id FROM ${mode}_document_label`)).rows;
  const access =
    userId === 'conmasadmin'
      ? ''
      : mode === 'image'
        ? role('mst_image_document_role')
        : `(doc.document_save_kbn<>2 AND ${role('mst_common_document_role')} OR doc.document_save_kbn=2 AND EXISTS (
      SELECT 1 FROM common_document_irfd_role r JOIN mst_group_affiation a ON a.group_id=r.group_id
      WHERE r.document_id=doc.document_id AND a.user_id=$1 AND (r.role_irfd_read=1 OR r.role_irfd_update=1)))`;
  const documents = (
    await db.query(
      `SELECT doc.*,TO_CHAR(doc.document_update_time,'YYYY/MM/DD HH24:MI:SS') AS update_text,
    TO_CHAR(doc.use_end_time,'YYYY/MM/DD') || ' 23:59:59' AS expire_text FROM mst_${mode}_document doc
    WHERE (doc.use_end_time >= $2 OR doc.use_end_time IS NULL)${access ? ` AND ${access}` : ' AND $1::text IS NOT NULL'}
    ORDER BY doc.document_update_time DESC,doc.document_id DESC`,
      [userId, today],
    )
  ).rows;
  const restriction = await setting(db, 'LIBRARY', 'IREPORTER_LABEL_ROLE_MODE');
  const invisible = new Set<number>();
  if (restriction === '1' || restriction === '2') {
    const groups = (await db.query('SELECT group_id FROM mst_group_affiation WHERE user_id=$1', [userId])).rows.map(
      (row) => row.group_id,
    );
    const hidden = (id: number, visited = new Set<number>()): boolean => {
      if (visited.has(id)) throw new Error('Cyclic library label hierarchy.');
      visited.add(id);
      const entries = labels.filter((row) => row.mst_label_id === id);
      if (entries.length > 1) throw new Error('Duplicate library label.');
      const label = entries[0];
      if (!label) return false;
      const roles = labelRoles.filter((row) => row.mst_label_id === id);
      return (
        (roles.length > 0 && roles.every((row) => !groups.includes(row.group_id))) ||
        hidden(label.upper_label_id, visited)
      );
    };
    for (const label of labels) if (hidden(label.mst_label_id)) invisible.add(label.mst_label_id);
  }
  const files = documents
    .map((row, index) => {
      const labelIds = links.filter((link) => link.document_id === row.document_id).map((link) => link.mst_label_id);
      // Source retains unlabelled documents; a document is hidden only when all its assigned labels are invisible.
      if (labelIds.length && labelIds.every((id) => invisible.has(id))) return undefined;
      const manual = text(row, 'document_manual_download') || '0';
      return element('localFile', [
        ...fields(row, { localFileId: 'document_id', fileName: 'document_name_org', displayName: 'document_name' }),
        element('displayNumber', String(index + 1)),
        element('fileType', text(row, 'document_type')),
        element('url', text(row, 'document_save_kbn') === '1' ? text(row, 'document_path') : ''),
        element(
          'mobilesave',
          ['0', '2'].includes(text(row, 'document_save_kbn')) ? text(row, 'document_mobile_save') : '0',
        ),
        element('updateTime', text(row, 'update_text')),
        element('expire', text(row, 'expire_text')),
        element('labelId', labelIds.join(',')),
        element('lifeTime', manual === '1' ? text(row, 'document_life_time') || '0' : '0'),
        element('downloadType', manual),
        element('isOtherAppOpen', text(row, 'is_other_app_open') || '1'),
      ]);
    })
    .filter((row) => row !== undefined);
  return serialize(
    element('conmas', [
      element(
        'localLabels',
        labels.map((row) =>
          element('localLabel', [
            ...fields(row, {
              labelId: 'mst_label_id',
              iconId: 'label_icon_id',
              name: 'label_name',
              upperLabelId: 'upper_label_id',
              displayNumber: 'diplay_number',
            }),
            element(
              'group',
              labelRoles
                .filter((role) => role.mst_label_id === row.mst_label_id)
                .map((role) => role.group_id)
                .join(','),
            ),
          ]),
        ),
      ),
      element('localFiles', files),
    ]),
  );
}

// DocumentInfoBiz uses DocumentListBiz's native metadata collector, not GeneralProcess Library/DocumentList.
export async function getClientDocumentInfo(
  db: Database,
  userId: string,
  params: Record<string, string>,
  now = new Date(),
): Promise<string> {
  const id = integer(params.documentId ?? '');
  if (!params.documentId) return clientError(2, "'documentId' is required.");
  if (id === undefined)
    return clientError(2, [
      `Invalid value '${params.documentId}' specified for 'documentId'. It must be an integer.`,
      "'documentId' must be an integer.",
    ]);
  if (!params.iconType) return clientError(2, "'iconType' is required.");
  return serialize(element('conmas', [element('localFiles', await documentFiles(db, userId, params, now))]));
}

export async function getClientDocumentList(
  db: Database,
  userId: string,
  params: Record<string, string>,
  now = new Date(),
): Promise<string> {
  const errors: string[] = [];
  const specified = (key: string, choices: string[], values = [params[key]]) => {
    if (!params[key]) return;
    for (const value of values)
      if (!choices.includes(value))
        errors.push(
          `Invalid value '${value}' specified for '${key}'. It must be ${choices.length === 2 ? `either '${choices[0]}' or '${choices[1]}'` : `one of the following: '${choices.join("', '")}'`}.`,
        );
  };
  specified('libraryType', ['0', '1']);
  if (params.labelId)
    for (const value of params.labelId.split(','))
      if (integer(value) === undefined)
        errors.push(`Invalid value '${value}' specified for 'labelId'. It must be an integer.`);
  specified('editStatus', ['1', '4']);
  specified(
    'iconType',
    ['URL', 'PDF', 'EXCEL', 'PowerPoint', 'Word', 'XVL', 'MOVIE', 'PHOTO', 'SOUND', 'OTHERS', 'FD'],
    params.iconType?.split(','),
  );
  specified('wordTargetName', ['true', 'false']);
  if (errors.length) return clientError(2, [...new Set(errors)]);
  const mode = params.libraryType === '1' ? 'image' : 'common';
  if (params.labelId) {
    const id = integer(params.labelId);
    if (id === undefined) throw new Error('Invalid document label integer.');
    if (!(await db.query(`SELECT 1 FROM mst_label_${mode}_document WHERE mst_label_id=$1`, [id])).rowCount)
      return clientError(8, `'${id}' does not exist as labelId.`);
  }
  const labels: XmlNode[] = [];
  if (!params.word || params.wordTargetLabelName === 'true') {
    const values: unknown[] = params.labelId ? [integer(params.labelId)] : [];
    const start = params.labelId ? 'mst_label_id=$1' : 'upper_label_id IS NULL';
    if (params.word) values.push(documentSearchWord(params.word));
    const sql = params.word
      ? `WITH RECURSIVE labels AS (
        SELECT l.*, '000_' || lpad(diplay_number::text,10,'0') AS sort_key, 0 AS level, ARRAY[mst_label_id] AS visited FROM mst_label_${mode}_document l WHERE ${start}
        UNION ALL SELECT l.*, p.sort_key || '_' || lpad((p.level+1)::text,3,'0') || '_' || lpad(l.diplay_number::text,10,'0'), p.level+1, p.visited || l.mst_label_id
        FROM mst_label_${mode}_document l JOIN labels p ON p.mst_label_id=l.upper_label_id WHERE NOT l.mst_label_id=ANY(p.visited))
        SELECT * FROM labels WHERE convert_full2half(label_name) ILIKE $${values.length} ORDER BY sort_key,mst_label_id`
      : `SELECT * FROM mst_label_${mode}_document WHERE ${params.labelId ? 'upper_label_id=$1' : 'upper_label_id IS NULL'} ORDER BY diplay_number,mst_label_id`;
    const rows = (await db.query(sql, values)).rows;
    for (const row of rows) {
      const groups = (
        await db.query(`SELECT group_id FROM ${mode}_document_label_role WHERE mst_label_id=$1`, [row.mst_label_id])
      ).rows;
      labels.push(
        element('localLabel', [
          ...fields(row, {
            labelId: 'mst_label_id',
            iconId: 'label_icon_id',
            name: params.word ? 'label_name_path' : 'label_name',
            upperLabelId: 'upper_label_id',
            displayNumber: 'diplay_number',
          }),
          element('group', groups.map((group) => group.group_id).join(',')),
        ]),
      );
    }
  }
  return serialize(
    element('conmas', [
      element('localLabels', labels),
      element('localFiles', await documentFiles(db, userId, params, now)),
    ]),
  );
}

function documentSearchWord(word: string): string {
  return (
    '%' +
    word
      .replace(/[！＃＄％＆（）＊＋，－．／０-９：；＜＝＞？＠Ａ-Ｚ［］＾＿｀ａ-ｚ｛｜｝～]/g, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 65248),
      )
      .replaceAll('　', ' ') +
    '%'
  );
}

async function documentFiles(
  db: Database,
  userId: string,
  params: Record<string, string>,
  now: Date,
): Promise<XmlNode[]> {
  const mode = params.libraryType === '1' ? 'image' : 'common',
    admin = userId === 'conmasadmin';
  const parsed = (value: string) => {
    const result = integer(value);
    if (result === undefined) throw new Error('Invalid document filter integer.');
    return result;
  };
  const labelId = params.labelId ? parsed(params.labelId) : undefined;
  if (
    !admin &&
    labelId !== undefined &&
    ['1', '2'].includes(String(await setting(db, 'LIBRARY', 'IREPORTER_LABEL_ROLE_MODE')))
  ) {
    // Source deliberately checks common-label ancestors even when libraryType selects images.
    const path = (
      await db.query('SELECT label_id_path FROM mst_label_common_document WHERE mst_label_id=$1', [labelId])
    ).rows[0]?.label_id_path;
    const ancestors = String(path ?? '')
      .split('/')
      .map(integer)
      .filter((value) => value !== undefined);
    for (const ancestor of ancestors) {
      if (
        !(
          await db.query(
            `SELECT 1 FROM mst_label_common_document l WHERE mst_label_id=$2 AND
        (NOT EXISTS (SELECT 1 FROM common_document_label_role r WHERE r.mst_label_id=l.mst_label_id) OR EXISTS
        (SELECT 1 FROM common_document_label_role r JOIN mst_group_affiation a ON a.group_id=r.group_id WHERE r.mst_label_id=l.mst_label_id AND a.user_id=$1))`,
            [userId, ancestor],
          )
        ).rows.length
      )
        return [];
    }
  }
  if (params.word && params.wordTargetName !== 'true' && params.wordTargetRemarks !== 'true') return [];
  const icons = params.iconType ? params.iconType.split(',').filter((value) => value.trim()) : undefined;
  if (icons && !icons.length) throw new Error('Empty document icon filter.');
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const values: unknown[] = [userId, today],
    conditions = ['(doc.use_end_time IS NULL OR doc.use_end_time>=$2)'];
  const bind = (value: unknown) => {
    values.push(value);
    return '$' + values.length;
  };
  if (params.documentId) conditions.push('doc.document_id=' + bind(parsed(params.documentId)));
  if (icons) conditions.push('doc.document_type=ANY(' + bind(icons) + '::text[])');
  if (!admin)
    conditions.push(`(doc.document_save_kbn<>2 AND ${role('mst_' + mode + '_document_role')} OR doc.document_save_kbn=2 AND EXISTS
    (SELECT 1 FROM common_document_irfd_role r JOIN mst_group_affiation a ON a.group_id=r.group_id WHERE r.document_id=doc.document_id AND a.user_id=$1 AND (r.role_irfd_read=1 OR r.role_irfd_update=1)))`);
  else conditions.push('$1::text IS NOT NULL');
  if (!params.word && !params.documentId) {
    conditions.push(
      `${labelId === undefined ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${mode}_document_label d WHERE d.document_id=doc.document_id${labelId === undefined ? '' : ' AND d.mst_label_id=' + bind(labelId)})`,
    );
  } else if (labelId !== undefined)
    conditions.push(`EXISTS (WITH RECURSIVE labels AS
    (SELECT mst_label_id FROM mst_label_${mode}_document WHERE mst_label_id=${bind(labelId)} UNION
    SELECT l.mst_label_id FROM mst_label_${mode}_document l JOIN labels p ON p.mst_label_id=l.upper_label_id)
    SELECT 1 FROM ${mode}_document_label d JOIN labels l ON l.mst_label_id=d.mst_label_id WHERE d.document_id=doc.document_id)`);
  if (mode === 'common' && params.editStatus) conditions.push('doc.edit_status=' + bind(parsed(params.editStatus)));
  if (params.word) {
    const word = documentSearchWord(params.word),
      searches: string[] = [];
    if (params.wordTargetName === 'true') searches.push('convert_full2half(doc.document_name) ILIKE ' + bind(word));
    if (params.wordTargetRemarks === 'true') searches.push('convert_full2half(doc.remarks) ILIKE ' + bind(word));
    conditions.push('(' + searches.join(' OR ') + ')');
  }
  const rows = (
    await db.query(
      `SELECT doc.document_id,doc.document_name,doc.document_name_org,doc.document_type,doc.document_save_kbn,
    doc.document_path,doc.document_mobile_save,doc.document_manual_download,doc.document_life_time,doc.is_other_app_open,
    doc.sys_regist_user,doc.sys_update_user,${mode === 'common' ? 'doc.sys_regist_user_name,doc.sys_update_user_name,doc.edit_status,doc.lock_mode,doc.remarks' : 'NULL::text AS sys_regist_user_name,NULL::text AS sys_update_user_name,NULL::numeric AS edit_status,NULL::numeric AS lock_mode,doc.remarks'},
    TO_CHAR(doc.sys_regist_time,'YYYY/MM/DD HH24:MI:SS') AS created_text,TO_CHAR(doc.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS updated_text,
    TO_CHAR(doc.use_end_time,'YYYY/MM/DD 23:59:59') AS expire_text FROM mst_${mode}_document doc WHERE ${conditions.join(' AND ')}
    ORDER BY doc.document_update_time DESC,doc.document_id DESC`,
      values,
    )
  ).rows;
  const strict = (await setting(db, 'LOCK_SETTING', 'REPORT_STRICT_LOCK')) === '1',
    output = [];
  for (const row of rows) {
    if (row.document_save_kbn === null || !row.created_text || !row.updated_text)
      throw new Error('Missing document metadata.');
    const documentId = row.document_id,
      freeDraw = String(row.document_save_kbn) === '2';
    const links = (await db.query(`SELECT mst_label_id FROM ${mode}_document_label WHERE document_id=$1`, [documentId]))
      .rows;
    const lock = (await db.query('SELECT user_id FROM document_lock WHERE document_id=$1', [documentId])).rows.find(
      (lock) => strict || lock.user_id !== userId,
    );
    const editable =
      !freeDraw ||
      admin ||
      (
        await db.query(
          `SELECT 1 FROM common_document_irfd_role r JOIN mst_group_affiation a ON a.group_id=r.group_id WHERE r.document_id=$1 AND a.user_id=$2 AND r.role_irfd_update=1`,
          [documentId, userId],
        )
      ).rows.length > 0;
    const filename =
      freeDraw && icons?.includes('FD')
        ? (
            await db.query(
              'SELECT irfd_file_name FROM common_document_irfd WHERE document_id=$1 ORDER BY rev_no DESC LIMIT 1',
              [documentId],
            )
          ).rows[0]?.irfd_file_name
        : row.document_name_org;
    const manual = text(row, 'document_manual_download') || '0';
    output.push(
      element('localFile', [
        element('localFileId', String(documentId)),
        element('fileName', String(filename ?? '')),
        element('displayName', text(row, 'document_name')),
        element('displayNumber', '1'),
        element('fileType', text(row, 'document_type')),
        element('url', String(row.document_save_kbn) === '1' ? text(row, 'document_path') : ''),
        element('mobilesave', String(row.document_save_kbn) === '1' ? '0' : text(row, 'document_mobile_save')),
        element('labelId', links.map((link) => link.mst_label_id).join(',')),
        element('registUser', text(row, 'sys_regist_user_name') || text(row, 'sys_regist_user')),
        element('registTime', text(row, 'created_text')),
        element('updateUser', text(row, 'sys_update_user_name') || text(row, 'sys_update_user')),
        element('updateTime', text(row, 'updated_text')),
        element('expire', text(row, 'expire_text')),
        element('lifeTime', manual === '1' && row.document_life_time !== null ? text(row, 'document_life_time') : '0'),
        element('downloadType', manual),
        element('isOtherAppOpen', text(row, 'is_other_app_open') || '1'),
        element('editStatus', text(row, 'edit_status')),
        element('locked', lock || !editable ? '1' : '0'),
        element(
          'lockUserName',
          lock
            ? String(
                (await db.query('SELECT user_name FROM mst_user WHERE user_id=$1', [lock.user_id])).rows[0]
                  ?.user_name ?? '',
              )
            : '',
        ),
        element('remarks', text(row, 'remarks')),
        element('lockMode', freeDraw && mode === 'common' ? text(row, 'lock_mode') : ''),
      ]),
    );
  }
  return output;
}

export async function hasClientFreeDrawLicense(
  db: Database,
  userId: string,
  license = readLicenseFields(),
  today = new Date(),
): Promise<boolean> {
  const todayCode = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const valid = (field: string) => {
    const expiry = licenseDate(license.get(field));
    return !expiry || expiry >= todayCode;
  };
  if (integer(license.get('FreeDrawOnly') ?? '') === 1 && valid('FreeDrawOnlyExpire')) return true;
  if ((integer(license.get('FreeDraw') ?? '') ?? 0) <= 0 || !valid('FreeDrawExprie')) return false;
  return (
    userId === 'conmasadmin' ||
    Number((await db.query('SELECT irfd_enable FROM mst_user WHERE user_id=$1', [userId])).rows[0]?.irfd_enable) === 1
  );
}

export async function editClientLibraryDocument(
  db: Database,
  userId: string,
  termId: number,
  id: number,
  lockMode: string,
  now = new Date(),
): Promise<string | undefined> {
  const edit =
    userId === 'conmasadmin' ||
    (
      await db.query(
        `SELECT 1 FROM common_document_irfd_role r JOIN mst_group_affiation a ON a.group_id=r.group_id
    WHERE r.document_id=$1 AND a.user_id=$2 AND r.role_irfd_update=1`,
        [id, userId],
      )
    ).rowCount;
  if (!edit) return clientError(3, 'Unauthorized to editor the document.');
  if (lockMode !== '0') return;
  try {
    await db.query('BEGIN');
    await db.query('LOCK TABLE document_lock IN EXCLUSIVE MODE');
    const strict = (await setting(db, 'LOCK_SETTING', 'REPORT_STRICT_LOCK')) === '1';
    const locks = (await db.query('SELECT user_id FROM document_lock WHERE document_id=$1', [id])).rows;
    if (locks.some((lock) => strict || lock.user_id !== userId)) {
      await db.query('ROLLBACK');
      return clientError(-1, 'Exclusive Error');
    }
    await db.query('DELETE FROM document_lock WHERE document_id=$1', [id]);
    await db.query(
      `INSERT INTO document_lock (document_id,user_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      VALUES ($1,$2,$3,$2,$4,$3,$2,$4)`,
      [id, userId, String(termId), now],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function getClientLocalReference(
  db: pg.Pool,
  userId: string,
  termId: number,
  localFileId: string,
  fileType: string,
  previewMode: string,
): Promise<string | { data: Buffer; filename: string; contentType: string }> {
  const empty = { data: Buffer.alloc(0), filename: 'empty', contentType: 'application' };
  const id = integer(localFileId);
  if (id === undefined) return empty;
  const now = new Date(),
    midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const rows = (
    await db.query(
      ['report', 'common', 'image']
        .map(
          (
            mode,
          ) => `SELECT doc.document_id,doc.document_name,doc.document_name_org,doc.document_save_kbn,doc.content_type,
    ${mode === 'common' ? 'doc.lock_mode' : 'NULL::numeric AS lock_mode'}, '${mode === 'report' ? 1 : 0}' AS document_kbn
    FROM mst_${mode}_document doc WHERE doc.document_id=$2 AND (doc.use_end_time >= $3 OR doc.use_end_time IS NULL)
    AND ($1='conmasadmin' OR ${role(`mst_${mode}_document_role`)})`,
        )
        .join(' UNION ALL '),
      [userId, id, midnight],
    )
  ).rows;
  const row = rows[0];
  if (!row) return empty;
  let data: unknown;
  if (Number(await setting(db, 'LIBRARY', 'FILE_LOCATION')) === 1) {
    // Binary lookup is common -> report -> image, unlike metadata's report -> common -> image order.
    data = (
      await db.query(
        ['common', 'report', 'image']
          .map((mode) => `SELECT document_file FROM mst_${mode}_document WHERE document_id=$1`)
          .join(' UNION ALL '),
        [id],
      )
    ).rows[0]?.document_file;
  } else {
    const directory = await clientLibraryDirectory(db);
    try {
      data = await readFile(join(directory, String(id)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (Number(row.document_save_kbn ?? 0) === 2 && fileType === '1') {
    const irfd = (
      await db.query(
        'SELECT irfd_file,irfd_file_name FROM common_document_irfd WHERE document_id=$1 ORDER BY rev_no DESC LIMIT 1',
        [id],
      )
    ).rows[0];
    data = irfd?.irfd_file;
    row.document_name_org = irfd?.irfd_file_name;
    row.content_type = 'application/octet-stream';
  }
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    // Legacy swallows log insert failures. A savepoint keeps PostgreSQL's transaction usable afterward.
    await connection.query('SAVEPOINT library_log');
    try {
      await connection.query(
        `INSERT INTO log_library_download (document_id,document_name,document_kbn,document_top_id,log_date,log_user,log_user_name,log_term,log_term_name,
        log_gps_lat,log_gps_lon,log_gps_alt,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
        VALUES ($1,$2,$3,NULL,$4,$5,(SELECT user_name FROM mst_user WHERE user_id=$5),$6,(SELECT term_name FROM mst_terminal WHERE term_id=$7),'','','',$6,$5,$8,$6,$5,$8)`,
        [id, row.document_name, row.document_kbn, now, userId, String(termId), termId, midnight],
      );
    } catch {
      await connection.query('ROLLBACK TO SAVEPOINT library_log');
    }
    await connection.query('COMMIT');
    if (Number(row.document_save_kbn ?? 0) === 2 && fileType === '1') {
      if (!(await hasClientFreeDrawLicense(connection, userId)))
        return clientError(11050, 'i-Repo FreeDraw Licence Error');
      if (previewMode !== '1') {
        const error = await editClientLibraryDocument(connection, userId, termId, id, text(row, 'lock_mode'), now);
        if (error) return error;
      }
    }
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  if (data !== null && data !== undefined && !Buffer.isBuffer(data))
    throw new Error('Invalid library document binary.');
  return {
    data: data ?? Buffer.alloc(0),
    filename: row.document_name_org || 'unknown',
    contentType: row.content_type || 'application',
  };
}

export async function unlockClientDocuments(db: Database, documentIds: string): Promise<string> {
  const tokens = documentIds.split(','),
    ids = tokens.map(integer);
  if (ids.filter((id) => id !== undefined).length > 10) return clientError(2, 'number of documentId is over 10.');
  const errors = documentIds
    ? [
        ...new Set(
          tokens
            .filter((_, index) => ids[index] === undefined)
            .map((token) => `Invalid value '${token}' specified for 'documentId'. It must be an integer.`),
        ),
      ]
    : ["'documentId' is required."];
  if (errors.length) return clientError(2, errors);
  const results = [];
  // Legacy releases each ID independently, even locks owned by another user/terminal; there is no extra role check.
  for (const id of ids)
    if ((await db.query('DELETE FROM document_lock WHERE document_id=$1', [id])).rowCount === 1)
      results.push(element('result', [element('documentId', String(id)), element('remarks')]));
  return clientError(0).replace('</conmas>', serialize(element('results', results)) + '</conmas>');
}
