import type pg from 'pg';
import { copyFile, link, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, join } from 'node:path';
import { clientError } from '../services/client-xml.js';
import { element, integer, serialize } from './client-definition-xml.js';
import { clientLibraryDirectory } from './client-library.js';

type Database = Pick<pg.Pool, 'query'>;
type Parameters = Record<string, string | undefined>;
const modes = ['common', 'report', 'image'] as const;
const labelAccess = (
  mode: string,
  alias: string,
) => `(NOT EXISTS (SELECT 1 FROM ${mode}_document_label_role r WHERE r.mst_label_id=${alias}.mst_label_id)
  OR EXISTS (SELECT 1 FROM ${mode}_document_label_role r JOIN mst_group_affiation a ON a.group_id=r.group_id WHERE r.mst_label_id=${alias}.mst_label_id AND a.user_id=$1))`;
const documentAccess = (
  mode: string,
) => `(doc.document_save_kbn<>2 AND (NOT EXISTS (SELECT 1 FROM mst_${mode}_document_role r WHERE r.document_id=doc.document_id)
  OR EXISTS (SELECT 1 FROM mst_${mode}_document_role r JOIN mst_group_affiation a ON a.group_id=r.group_id WHERE r.document_id=doc.document_id AND a.user_id=$1))
  OR doc.document_save_kbn=2 AND EXISTS (SELECT 1 FROM common_document_irfd_role r JOIN mst_group_affiation a ON a.group_id=r.group_id
    WHERE r.document_id=doc.document_id AND a.user_id=$1 AND (r.role_irfd_read=1 OR r.role_irfd_update=1)))`;

function specified(params: Parameters, key: string, values: readonly string[], errors: string[]) {
  const value = params[key];
  if (value && !values.includes(value))
    errors.push(
      `Invalid value '${value}' specified for '${key}'. It must be ${values.length === 1 ? `'${values[0]}'` : values.length === 2 ? `either '${values[0]}' or '${values[1]}'` : `one of the following: '${values.join("', '")}'`}.`,
    );
}
function numberError(params: Parameters, key: string, errors: string[], positive = false) {
  const value = params[key],
    parsed = integer(value ?? '');
  if (value && (parsed === undefined || (positive && parsed <= 0))) {
    errors.push(
      `Invalid value '${value}' specified for '${key}'. It must be ${positive ? 'a positive integer' : 'an integer'}.`,
    );
    if (!positive) errors.push(`'${key}' must be an integer.`);
  }
}
function date(value: string): Date | undefined {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('/').map(Number),
    parsed = new Date(0);
  parsed.setFullYear(year!, month! - 1, day!);
  parsed.setHours(0, 0, 0, 0);
  return year! > 0 && parsed.getFullYear() === year && parsed.getMonth() === month! - 1 && parsed.getDate() === day
    ? parsed
    : undefined;
}
function parsedInteger(value: string): number {
  const parsed = integer(value);
  if (parsed === undefined) throw new Error('Invalid API integer.');
  return parsed;
}
const xmlFields = (row: Record<string, unknown>, mapping: Record<string, string>) =>
  Object.entries(mapping).map(([name, key]) => element(name, String(row[key] ?? '')));
async function libraryReader(db: Database, userId: string, deletion = false): Promise<boolean> {
  return (
    userId === 'conmasadmin' ||
    (
      await db.query(
        `SELECT 1 FROM mst_group g WHERE ${deletion ? 'g.role_library_delete' : 'g.role_library_read'}=1
    AND EXISTS (SELECT 1 FROM mst_group_affiation a WHERE a.group_id=g.group_id AND a.user_id=$1)`,
        [userId],
      )
    ).rows.length > 0
  );
}

export async function getClientApiDocumentList(
  db: Database,
  userId: string,
  params: Parameters,
  now = new Date(),
): Promise<string> {
  const errors: string[] = [];
  for (const key of ['documentType', 'scopeOfLabel', 'scopeOfExpiration'])
    specified(params, key, ['0', '1', '2'], errors);
  if (params.scopeOfLabel === '2' && !params.labelPath) errors.push("'labelPath' is required.");
  specified(params, 'storageMode', ['0', '1', '2'], errors);
  specified(params, 'mobileSave', ['0', '1'], errors);
  for (const key of ['dateFirstCreatedFrom', 'dateFirstCreatedTo', 'dateLastModifiedFrom', 'dateLastModifiedTo'])
    if (params[key] && !date(params[key]))
      errors.push(`Invalid value '${params[key]}' specified for '${key}'. It must be in format 'yyyy/MM/dd'.`);
  for (const key of ['limitOfList', 'skipOver']) numberError(params, key, errors, true);
  numberError(params, 'documentId', errors);
  if (errors.length) return clientError(2, [...new Set(errors)]);
  if (params.labelPath) {
    const category = modes[parsedInteger(params.documentType ?? '0')];
    if (!category) throw new Error('Invalid document category.');
    if (
      !(await db.query(`SELECT 1 FROM mst_label_${category}_document WHERE label_name_path=$1`, [params.labelPath]))
        .rows.length
    )
      return clientError(8, `'${params.labelPath}' does not exist as label path.`);
  }
  if (!(await libraryReader(db, userId))) return clientError(3, 'Unauthorized to refer documents in library.');
  const type = parsedInteger(params.documentType ?? '0'),
    mode = modes[type];
  if (!mode) throw new Error('Invalid document category.');
  const admin = userId === 'conmasadmin',
    values: unknown[] = [userId],
    conditions = [admin ? '$1::text IS NOT NULL' : documentAccess(mode)];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const scope = parsedInteger(params.scopeOfLabel ?? '0');
  if (scope === 1)
    conditions.push(`NOT EXISTS (SELECT 1 FROM ${mode}_document_label l WHERE l.document_id=doc.document_id)`);
  if (scope === 2)
    conditions.push(`EXISTS (SELECT 1 FROM ${mode}_document_label l JOIN mst_label_${mode}_document ml ON ml.mst_label_id=l.mst_label_id
    WHERE l.document_id=doc.document_id AND ml.label_name_path=${bind(params.labelPath ?? null)}${admin ? '' : ` AND ${labelAccess(mode, 'l')}`})`);
  const expiration = parsedInteger(params.scopeOfExpiration ?? '0');
  if (expiration === 0) conditions.push(`(doc.use_end_time IS NULL OR doc.use_end_time>${bind(now)})`);
  if (expiration === 2) conditions.push(`doc.use_end_time<${bind(now)}`);
  if (params.documentId) conditions.push(`doc.document_id=${bind(parsedInteger(params.documentId))}`);
  const like = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
  for (const [key, column] of [
    ['documentName', 'document_name'],
    ['userFirstCreated', 'sys_regist_user'],
    ['userLastModified', 'sys_update_user'],
  ] as const) {
    if (key === 'documentName' ? !!params[key] : params[key] !== undefined)
      conditions.push(`doc.${column} ILIKE ${bind(like(params[key] ?? ''))}`);
  }
  for (const [key, column] of [
    ['storageMode', 'document_save_kbn'],
    ['mobileSave', 'document_mobile_save'],
  ] as const)
    if (params[key] !== undefined) conditions.push(`doc.${column}=${bind(parsedInteger(params[key]))}`);
  for (const [prefix, column] of [
    ['dateFirstCreated', 'sys_regist_time'],
    ['dateLastModified', 'sys_update_time'],
  ] as const)
    for (const bound of ['From', 'To']) {
      const value = params[prefix + bound];
      if (value === undefined) continue;
      const parsed = date(value);
      if (!parsed) throw new Error('Invalid API date.');
      if (bound === 'To') {
        parsed.setDate(parsed.getDate() + 1);
        if (parsed.getFullYear() > 9999) throw new Error('API date exceeds DateTime range.');
      }
      conditions.push(`doc.${column}${bound === 'From' ? '>=' : '<'}${bind(parsed)}`);
    }
  const limit = bind(params.limitOfList ? parsedInteger(params.limitOfList) : 20),
    offset = bind(params.skipOver ? parsedInteger(params.skipOver) : 0);
  const documents = (
    await db.query(
      `SELECT doc.*,TO_CHAR(use_end_time,'YYYY/MM/DD HH24:MI:SS') AS expire_text,
    TO_CHAR(sys_regist_time,'YYYY/MM/DD HH24:MI:SS') AS created_text,TO_CHAR(sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS updated_text
    FROM mst_${mode}_document doc WHERE ${conditions.join(' AND ')} ORDER BY sys_update_time DESC LIMIT ${limit} OFFSET ${offset}`,
      values,
    )
  ).rows;
  const links =
    documents.length && scope !== 1
      ? (
          await db.query(
            `SELECT l.document_id,l.mst_label_id,ml.label_name_path FROM ${mode}_document_label l
    LEFT JOIN mst_label_${mode}_document ml ON ml.mst_label_id=l.mst_label_id WHERE l.document_id=ANY($2::int[])${admin ? ' AND $1::text IS NOT NULL' : ` AND ${labelAccess(mode, 'l')}`}`,
            [userId, documents.map((row) => row.document_id)],
          )
        ).rows
      : [];
  return serialize(
    element('conmas', [
      element(
        'documents',
        documents.map((row) =>
          element('document', [
            element('documentType', String(type)),
            ...xmlFields(row, {
              documentId: 'document_id',
              documentName: 'document_name',
              iconType: 'document_type',
              storageMode: 'document_save_kbn',
            }),
            element('url', row.document_save_kbn === '1' ? String(row.document_path ?? '') : ''),
            ...xmlFields(row, {
              mobileSave: 'document_mobile_save',
              manualDownload: 'document_manual_download',
              lifeTime: 'document_life_time',
              expire: 'expire_text',
              useInOtherApp: 'is_other_app_open',
              datetimeFirstCreated: 'created_text',
              userFirstCreated: 'sys_regist_user',
              datetimeLastModified: 'updated_text',
              userLastModified: 'sys_update_user',
            }),
            element(
              'labels',
              links
                .filter((link) => link.document_id === row.document_id)
                .map((link) => {
                  if (link.label_name_path === null) throw new Error('Missing library label.');
                  return element('label', xmlFields(link, { labelId: 'mst_label_id', labelPath: 'label_name_path' }));
                }),
            ),
          ]),
        ),
      ),
    ]),
  );
}

async function resolveDocument(
  db: Database,
  userId: string,
  params: Parameters,
  deletion = false,
): Promise<string | { document: Record<string, unknown>; mode: (typeof modes)[number] }> {
  const errors: string[] = [];
  if (!params.documentType) errors.push("'documentType' is required.");
  specified(params, 'documentType', ['0', '1', '2'], errors);
  if (!params.documentId && !params.documentName)
    errors.push("It is required either of 'documentId' or 'documentName'.");
  if (!deletion && params.downloadType !== undefined) {
    specified(params, 'downloadType', ['0', '1'], errors);
    if (params.downloadType === '1') specified(params, 'documentType', ['0'], errors);
  }
  if (errors.length) return clientError(2, errors);
  const mode = modes[parsedInteger(params.documentType!)];
  if (!mode) throw new Error('Invalid document category.');
  const id = params.documentId ? parsedInteger(params.documentId) : undefined;
  const paths = params.labelPath
    ? params.labelPath.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))
    : [];
  let labels: Record<string, unknown>[] = [];
  const getLabels = async () => {
    if (!paths.length) throw new Error('Missing label path.');
    return (
      await db.query(
        `SELECT ml.mst_label_id,ml.label_name_path,${labelAccess(mode, 'ml')} AS readable FROM mst_label_${mode}_document ml
      WHERE ml.label_name_path=ANY($2::text[])`,
        [userId, paths],
      )
    ).rows;
  };
  if (id === undefined && params.labelPath) {
    labels = await getLabels();
    if (!labels.some((label) => label.label_name_path === params.labelPath))
      return clientError(8, `'${params.labelPath}' does not exist as label path.`);
  }
  const documents = (
    await db.query(
      `SELECT ${deletion ? 'doc.document_id,doc.document_name' : 'doc.*'},${documentAccess(mode)} AS readable FROM mst_${mode}_document doc WHERE ${
        id !== undefined
          ? 'doc.document_id=$2'
          : `doc.document_name=$2 AND ${
              params.labelPath
                ? `EXISTS (SELECT 1 FROM ${mode}_document_label l JOIN mst_label_${mode}_document ml ON ml.mst_label_id=l.mst_label_id
    WHERE l.document_id=doc.document_id AND ml.label_name_path=$3)`
                : `NOT EXISTS (SELECT 1 FROM ${mode}_document_label l WHERE l.document_id=doc.document_id)`
            }`
      }`,
      id !== undefined
        ? [userId, id]
        : params.labelPath
          ? [userId, params.documentName, params.labelPath]
          : [userId, params.documentName],
    )
  ).rows;
  if (!documents.length)
    return clientError(
      8,
      `'${id ?? params.documentName}' does not exist as document ${id !== undefined ? 'id' : 'name'}.`,
    );
  if (id === undefined && new Set(documents.map((row) => row.document_id)).size > 1)
    return clientError(9, 'Document must be unique.');
  const document = documents[0]!;
  if (userId !== 'conmasadmin') {
    const privilege: string[] = [];
    if (!(await libraryReader(db, userId, deletion)))
      privilege.push(
        deletion ? 'Unauthorized to delete documents in library.' : 'Unauthorized to refer documents in library.',
      );
    if (params.labelPath !== undefined) {
      if (!labels.length) labels = await getLabels();
      for (const label of labels)
        if (!label.readable) privilege.push(`Unauthorized to refer the label 'id: ${label.mst_label_id}'.`);
    }
    if (!document.readable) privilege.push(`Unauthorized to refer the document 'id: ${document.document_id}'.`);
    if (privilege.length) return clientError(3, privilege);
  }
  return { document, mode };
}

export async function getClientApiDocumentDownload(
  db: Database,
  userId: string,
  params: Parameters,
): Promise<string | { data: Buffer; filename: string; contentType: string }> {
  const resolved = await resolveDocument(db, userId, params);
  if (typeof resolved === 'string') return resolved;
  const { document } = resolved;
  if (document.document_save_kbn === null) throw new Error('Missing library storage mode.');
  if (![0, 2].includes(Number(document.document_save_kbn)))
    return clientError(1000, 'It only works with a document which storaged as a file.');
  const location = (
    await db.query("SELECT com_value FROM mst_common WHERE com_key='LIBRARY' AND com_name='FILE_LOCATION'")
  ).rows[0]?.com_value;
  const storage = location === null || location === undefined ? 0 : parsedInteger(location);
  let data: unknown = document.document_file;
  if (storage === 0) {
    const path = join(await clientLibraryDirectory(db), String(document.document_id));
    if (
      !(
        await stat(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        })
      )?.isFile()
    )
      return clientError(8, 'document file does not exist.');
    data = await readFile(path);
  }
  let filename = document.document_name_org,
    contentType = document.content_type;
  if (params.downloadType === '1') {
    // This API uses the first stored IRFD, with no latest-revision sort, FreeDraw license gate, lock or download log.
    const irfd = (
      await db.query('SELECT irfd_file,irfd_file_name FROM common_document_irfd WHERE document_id=$1', [
        document.document_id,
      ])
    ).rows[0];
    if (!irfd) return clientError(8, 'No data found for the provided document ID.');
    data = irfd.irfd_file;
    filename = irfd.irfd_file_name;
    contentType = 'application/octet-stream';
    if (data === null || filename === null) throw new Error('Null IRFD database field.');
    if (!Buffer.isBuffer(data)) throw new Error('Invalid IRFD binary.');
    if (!data.length) return clientError(8, 'irfdFile not found. The byte array is null or empty.');
    if (!filename) return clientError(8, 'irfdFileName is null or empty.');
  } else if (storage !== 0 && storage !== 1) throw new Error('Unknown library file location.');
  if (!Buffer.isBuffer(data) || filename === null || contentType === null)
    throw new Error('Invalid library file response.');
  return { data, filename: String(filename), contentType: String(contentType) };
}

export async function deleteClientApiDocument(db: pg.Pool, userId: string, params: Parameters): Promise<string> {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    // Serialize resolution/permission checks with deletes and concurrent document changes.
    await connection.query(
      'LOCK TABLE mst_common_document,mst_report_document,mst_image_document IN SHARE ROW EXCLUSIVE MODE',
    );
    const resolved = await resolveDocument(connection, userId, params, true);
    if (typeof resolved === 'string') {
      await connection.query('ROLLBACK');
      return resolved;
    }
    const { document, mode } = resolved,
      id = document.document_id;
    await connection.query(`DELETE FROM ${mode}_document_label WHERE document_id=$1`, [id]);
    if (mode === 'report') {
      await connection.query('DELETE FROM def_report_document WHERE document_id=$1', [id]);
      await connection.query('DELETE FROM rep_report_document WHERE document_id=$1', [id]);
    }
    await connection.query(`DELETE FROM mst_${mode}_document_role WHERE document_id=$1`, [id]);
    await connection.query(`DELETE FROM mst_${mode}_document WHERE document_id=$1`, [id]);
    const directory = await clientLibraryDirectory(connection),
      path = join(directory, String(id));
    if (
      (
        await stat(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        })
      )?.isFile()
    ) {
      const backup = join(directory, '_' + id);
      if (
        (
          await stat(backup).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
          })
        )?.isFile()
      )
        await unlink(backup);
      // Legacy removes files before committing and does not restore them if the later commit fails.
      await unlink(path);
    }
    await connection.query('COMMIT');
    return clientError(0);
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

const referenceTypes = ['URL', 'PDF', 'EXCEL', 'PowerPoint', 'Word', 'XVL', 'MOVIE', 'PHOTO', 'SOUND', 'OTHERS'];
function fileReferenceType(filename: string, mode: string): string {
  const extension = extname(filename).toLowerCase();
  for (const [type, extensions] of Object.entries({
    PDF: ['.pdf'],
    EXCEL: ['.xlsx', '.xls', '.xlsm'],
    PowerPoint: ['.ppt', '.pptx', '.pptm'],
    Word: ['.doc', '.docx', '.docm'],
    PHOTO: ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.pict', '.tiff', '.tif'],
    MOVIE: ['.wmv', '.avi', '.mpeg', '.vob', '.mpg', '.ogm', '.mov', '.divx', '.mp4'],
    SOUND: ['.wav', '.wma', '.mp3', '.ogg', '.m4a', '.cda'],
    XVL: ['.xvl', '.xv2', '.xv3'],
  }))
    if (extensions.includes(extension)) return type;
  return extension === '.mlmodel' && mode === 'report' ? 'AIModel' : 'OTHERS';
}
function registrationDate(value: string): Date | undefined {
  const match = /^(\d{4}\/\d{2}\/\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const result = date(match[1]!),
    hour = Number(match[2]),
    minute = Number(match[3]),
    second = Number(match[4]);
  if (!result || hour > 23 || minute > 59 || second > 59) return undefined;
  result.setHours(hour, minute, second);
  return result;
}
type LibraryUpload = Pick<Express.Multer.File, 'path' | 'originalname' | 'mimetype' | 'size'>;

export async function registerClientApiDocument(
  db: pg.Pool,
  userId: string,
  params: Parameters,
  file?: LibraryUpload,
  host = '',
  now = new Date(),
): Promise<string> {
  const errors: string[] = [];
  if (!params.documentType) errors.push("'documentType' is required.");
  specified(params, 'documentType', ['0', '1', '2'], errors);
  if (errors.length) return clientError(2, errors);
  const mode = modes[parsedInteger(params.documentType!)]!;
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    // Like deletion, serialize resolution with mutations; legacy starts its transaction after validation.
    await connection.query(
      'LOCK TABLE mst_common_document,mst_report_document,mst_image_document IN SHARE ROW EXCLUSIVE MODE',
    );
    await connection.query(`LOCK TABLE mst_label_${mode}_document IN SHARE ROW EXCLUSIVE MODE`);
    const fail = async (code: number) => {
      await connection.query('ROLLBACK');
      return clientError(code, [...new Set(errors)]);
    };
    const defaultName = () => {
      const requested = params.storageMode ? parsedInteger(params.storageMode) : 0;
      return requested === 0 ? (file?.originalname ?? '') : requested === 1 ? (params.documentUrl ?? '') : '';
    };
    const name = params.documentName ?? defaultName();
    const documents = name
      ? (
          await connection.query(
            `SELECT doc.*,${documentAccess(mode)} AS readable FROM mst_${mode}_document doc WHERE doc.document_name=$2 AND
      ${params.labelPath ? 'EXISTS' : 'NOT EXISTS'} (SELECT 1 FROM ${mode}_document_label l JOIN mst_label_${mode}_document ml ON ml.mst_label_id=l.mst_label_id
        WHERE l.document_id=doc.document_id${params.labelPath ? ' AND ml.label_name_path=$3' : ''})`,
            params.labelPath ? [userId, name, params.labelPath] : [userId, name],
          )
        ).rows
      : [];
    if (new Set(documents.map((row) => row.document_id)).size > 1) {
      errors.push('Document must be unique.');
      return await fail(9);
    }
    const old = documents[0] as Record<string, unknown> | undefined,
      creating = !old;
    const paths = params.labelPath
      ? [...new Set(params.labelPath.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')))]
      : [];
    const labels = paths.length
      ? (
          await connection.query(
            `SELECT ml.*,${labelAccess(mode, 'ml')} AS readable FROM mst_label_${mode}_document ml WHERE label_name_path=ANY($2::text[])`,
            [userId, paths],
          )
        ).rows
      : [];
    const missingPaths = paths.filter((path) => !labels.some((label) => label.label_name_path === path));
    const oldStorage = old?.document_save_kbn === null ? undefined : Number(old?.document_save_kbn);
    if (creating) {
      if (params.labelIcon) {
        if (!params.labelPath) errors.push("'labelPath' is required.");
        if (missingPaths.length)
          specified(
            params,
            'labelIcon',
            Array.from({ length: 10 }, (_, index) => String(index + 1)),
            errors,
          );
      }
      specified(params, 'storageMode', ['0', '1'], errors);
      if (!params.storageMode || params.storageMode === '0') {
        if (!file?.size) errors.push('File upload is required.');
        specified(params, 'mobileSave', ['0', '1'], errors);
      } else if (params.storageMode === '1' && !params.documentUrl) errors.push("'documentUrl' is required.");
    } else {
      specified(params, 'storageMode', ['0', '1'], errors);
      if (params.storageMode === '0' || (!params.storageMode && oldStorage === 0))
        specified(params, 'mobileSave', ['0', '1'], errors);
    }
    if (mode === 'common') {
      specified(params, 'manualDownload', ['0', '1'], errors);
      if (
        params.manualDownload === '1' ||
        (!creating && !params.manualDownload && Number(old!.document_manual_download) === 1)
      ) {
        const lifetime = params.lifeTime ? integer(params.lifeTime) : undefined;
        if (params.lifeTime && (lifetime === undefined || lifetime < 0))
          errors.push(
            `Invalid value '${params.lifeTime}' specified for 'lifeTime'. It must be a non-negative integer.`,
          );
      }
    }
    if (params.expire && !registrationDate(params.expire))
      errors.push(
        `Invalid value '${params.expire}' specified for 'expire'. It must be in format 'yyyy/MM/dd HH:mm:ss'.`,
      );
    specified(params, 'useInOtherApp', ['0', '1'], errors);
    if (mode === 'report' && creating && !params.definitionId && !params.reportId)
      errors.push("It is required either of 'definitionId' or 'reportId'.");
    for (const key of mode === 'report' ? ['definitionId', 'reportId', 'groupId'] : ['groupId']) {
      if (params[key])
        for (const value of params[key].split(','))
          if (integer(value) === undefined)
            errors.push(`Invalid value '${value}' specified for '${key}'. It must be an integer.`);
    }
    if (errors.length) return await fail(2);
    const ids = (key: string) =>
      params[key]
        ? [
            ...new Set(
              params[key]
                .split(',')
                .filter((value) => value.trim())
                .map(parsedInteger),
            ),
          ]
        : undefined;
    const definitions = mode === 'report' ? ids('definitionId') : undefined,
      reports = mode === 'report' ? ids('reportId') : undefined,
      groups = ids('groupId');
    for (const [requested, table, column, title] of [
      [definitions, 'def_top', 'def_top_id', 'definition'],
      [reports, 'rep_top', 'rep_top_id', 'report'],
      [groups, 'mst_group', 'group_id', 'group'],
    ] as const) {
      if (!requested) continue;
      const found = (
        await connection.query(`SELECT ${column} FROM ${table} WHERE ${column}=ANY($1::int[])`, [requested])
      ).rows;
      for (const id of requested)
        if (!found.some((row) => row[column] === id)) errors.push(`'${id}' does not exist as ${title} id.`);
    }
    if (errors.length) return await fail(8);
    const closest = labels.filter(
      (label) => label.label_name_path.length === Math.max(...labels.map((label) => label.label_name_path.length)),
    );
    if (new Set(closest.map((label) => label.mst_label_id)).size > 1) {
      errors.push('Label must be unique.');
      return await fail(9);
    }
    if (userId !== 'conmasadmin') {
      const roles = (
        await connection.query(
          'SELECT g.* FROM mst_group g JOIN mst_group_affiation a ON a.group_id=g.group_id WHERE a.user_id=$1',
          [userId],
        )
      ).rows;
      if (!roles.some((row) => Number(row[creating ? 'role_library_create' : 'role_library_update']) === 1))
        errors.push(`Unauthorized to ${creating ? 'create' : 'update'} documents in library.`);
      if (old && !old.readable) errors.push(`Unauthorized to refer the document 'id: ${old.document_id}'.`);
      for (const label of labels)
        if (!label.readable) errors.push(`Unauthorized to refer the label 'id: ${label.mst_label_id}'.`);
      if (missingPaths.length && !roles.some((row) => Number(row.role_label_create_manager) === 1))
        errors.push('Unauthorized to create labels.');
      for (const [requested, table, column, title, role] of [
        [definitions, 'def_role', 'def_top_id', 'definition', 'role_def_read'],
        [reports, 'rep_role', 'rep_top_id', 'report', 'role_rep_read'],
      ] as const) {
        if (!requested?.length) continue;
        const readable = (
          await connection.query(
            `SELECT r.${column} FROM ${table} r JOIN mst_group_affiation a ON a.group_id=r.group_id WHERE a.user_id=$1 AND r.${role}=1 AND r.${column}=ANY($2::int[])`,
            [userId, requested],
          )
        ).rows;
        for (const id of requested)
          if (!readable.some((row) => row[column] === id))
            errors.push(`Unauthorized to refer the ${title} 'id: ${id}'.`);
      }
      if (errors.length) return await fail(3);
    }
    if (file?.originalname.toLowerCase().endsWith('.irfd')) {
      errors.push('irfd file is not allowed to upload.');
      return await fail(2);
    }
    const storage = params.storageMode ? parsedInteger(params.storageMode) : creating ? 0 : oldStorage;
    if (storage === undefined) throw new Error('Missing library storage mode.');
    specified(
      params,
      'iconType',
      [...referenceTypes.filter((type) => storage !== 0 || type !== 'URL'), ...(mode === 'report' ? ['AIModel'] : [])],
      errors,
    );
    if (errors.length) return await fail(2);
    if (![0, 1].includes(storage)) throw new Error('Unsupported library document storage mode.');
    const fileLocationValue = (
      await connection.query("SELECT com_value FROM mst_common WHERE com_key='LIBRARY' AND com_name='FILE_LOCATION'")
    ).rows[0]?.com_value;
    const fileLocation = fileLocationValue == null ? 0 : parsedInteger(fileLocationValue);
    const optionalInteger = (key: string) => (params[key] ? parsedInteger(params[key]) : undefined);
    const manual = optionalInteger('manualDownload'),
      lifetime = optionalInteger('lifeTime');
    if (old && (manual !== undefined ? ![0, 1].includes(manual) : ![0, 1].includes(oldStorage!)))
      throw new Error('Unsupported library lifetime mode.');
    const replacesFile = storage === 0 && !!file;
    const values: Record<string, unknown> = {
      document_name: creating ? params.documentName || defaultName() : old.document_name,
      document_name_org: replacesFile ? file.originalname : (old?.document_name_org ?? null),
      document_type:
        params.iconType ??
        (old ? old.document_type : storage === 1 ? 'URL' : fileReferenceType(file!.originalname, mode)),
      document_save_kbn: storage,
      document_path: storage === 1 ? params.documentUrl || (old?.document_path ?? null) : (old?.document_path ?? null),
      document_mobile_save:
        storage === 0
          ? (optionalInteger('mobileSave') ?? (old ? old.document_mobile_save : 0))
          : old
            ? old.document_mobile_save
            : 0,
      document_manual_download: manual ?? (old ? old.document_manual_download : 0),
      document_life_time: creating
        ? (lifetime ?? 0)
        : manual === 1 || (manual === undefined && oldStorage === 1)
          ? (lifetime ?? old.document_life_time)
          : old.document_life_time,
      document_update_time: creating || replacesFile ? now : old.document_update_time,
      use_end_time: params.expire ? registrationDate(params.expire) : (old?.use_end_time ?? null),
      content_type: replacesFile ? file.mimetype : (old?.content_type ?? null),
      is_other_app_open: optionalInteger('useInOtherApp') ?? (old ? old.is_other_app_open : 0),
      document_file: replacesFile && fileLocation === 1 ? await readFile(file.path) : (old?.document_file ?? null),
      sys_update_term: host,
      sys_update_user: userId,
      sys_update_time: now,
    };
    const id = old
      ? old.document_id
      : parsedInteger(
          String((await connection.query("SELECT nextval('mst_document_document_id_seq') AS id")).rows[0].id),
        );
    if (creating)
      Object.assign(values, { document_id: id, sys_regist_term: host, sys_regist_user: userId, sys_regist_time: now });
    const columns = Object.keys(values),
      parameters = Object.values(values);
    const written = await connection.query(
      creating
        ? `INSERT INTO mst_${mode}_document (${columns.join(',')}) VALUES (${columns.map((_, index) => '$' + (index + 1)).join(',')})`
        : `UPDATE mst_${mode}_document SET ${columns.map((column, index) => `${column}=$${index + 1}`).join(',')} WHERE document_id=$${parameters.push(id)}`,
      parameters,
    );
    if (!written.rowCount) throw new Error('Failed to write library document.');
    if (creating && paths.length) {
      let parent = closest[0];
      const siblings = missingPaths.length
        ? (
            await connection.query(
              `SELECT mst_label_id FROM mst_label_${mode}_document WHERE upper_label_id IS NOT DISTINCT FROM $1`,
              [parent?.mst_label_id ?? null],
            )
          ).rows
        : [];
      if (siblings.length)
        await connection.query(
          `UPDATE mst_label_${mode}_document SET diplay_number=diplay_number+1 WHERE mst_label_id=ANY($1::int[])`,
          [siblings.map((row) => row.mst_label_id)],
        );
      for (const path of missingPaths.sort((a, b) => a.length - b.length)) {
        const parts = path.split('/'),
          labelName = parts.at(-1)!;
        if (parts.length !== 1 && path !== `${parent?.label_name_path ?? ''}/${labelName}`)
          throw new Error('Inconsistent library label hierarchy.');
        const sequence =
          mode === 'image' ? 'mst_label_def_mst_label_id_seq' : `mst_label_${mode}_document_mst_label_id_seq`;
        const labelId = parsedInteger(
          String((await connection.query(`SELECT nextval('${sequence}') AS id`)).rows[0].id),
        );
        const idPath = parts.length === 1 ? String(labelId) : `${parent?.label_id_path ?? ''}/${labelId}`;
        await connection.query(
          `INSERT INTO mst_label_${mode}_document (mst_label_id,upper_label_id,label_name,label_id_path,label_name_path,label_icon_id,diplay_number,auto_delete,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
          VALUES ($1,$2,$3,$4,$5,$6,0,0,$7,$8,$9,$7,$8,$9)`,
          [
            labelId,
            parent?.mst_label_id ?? null,
            labelName,
            idPath,
            path,
            params.labelIcon === undefined ? 6 : parsedInteger(params.labelIcon),
            host,
            userId,
            now,
          ],
        );
        parent = { mst_label_id: labelId, label_id_path: idPath, label_name_path: path };
      }
      const labelId = missingPaths.length
        ? parent?.mst_label_id
        : labels.find((label) => label.label_name_path === params.labelPath)?.mst_label_id;
      if (labelId === undefined) throw new Error('Missing library label.');
      await connection.query(
        `INSERT INTO ${mode}_document_label (document_id,mst_label_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$4,$5,$3,$4,$5)`,
        [id, labelId, host, userId, now],
      );
    }
    for (const [requested, table, column, addRep] of [
      [definitions, 'def_report_document', 'def_top_id', null],
      [reports, 'rep_report_document', 'rep_top_id', 1],
      [groups, `mst_${mode}_document_role`, 'group_id', undefined],
    ] as const) {
      if (!requested) continue;
      const existing = (await connection.query(`SELECT ${column} FROM ${table} WHERE document_id=$1`, [id])).rows.map(
        (row) => row[column],
      );
      await connection.query(`DELETE FROM ${table} WHERE document_id=$1 AND NOT (${column}=ANY($2::int[]))`, [
        id,
        requested,
      ]);
      for (const target of requested.filter((value) => !existing.includes(value)))
        await connection.query(
          `INSERT INTO ${table} (document_id,${column},sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time${addRep === undefined ? '' : ',add_rep'})
        VALUES ($1,$2,$3,$4,$5,$3,$4,$5${addRep === undefined ? '' : ',$6'})`,
          addRep === undefined ? [id, target, host, userId, now] : [id, target, host, userId, now, addRep],
        );
    }
    if (replacesFile && fileLocation !== 1) {
      const directory = await clientLibraryDirectory(connection),
        target = join(directory, String(id)),
        backup = join(directory, '_' + id);
      const exists = async (path: string) =>
        (
          await stat(path).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
          })
        )?.isFile();
      if (old) {
        try {
          if (await exists(target)) {
            await link(target, backup);
            await unlink(target);
          }
          await mkdir(directory, { recursive: true });
          await copyFile(file.path, target, constants.COPYFILE_EXCL);
        } catch (error) {
          if (await exists(backup)) {
            if (await exists(target)) await unlink(target);
            await rename(backup, target);
          }
          throw error;
        }
        if (await exists(backup)) await unlink(backup);
      } else {
        try {
          await mkdir(directory, { recursive: true });
          await copyFile(file.path, target);
        } catch (error) {
          if (await exists(target)) await unlink(target);
          throw error;
        }
      }
      // Legacy discards the old backup before commit; a later commit failure cannot restore it.
    }
    await connection.query('COMMIT');
    return clientError(0);
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
