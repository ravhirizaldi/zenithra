import { text as pageText } from '../../../config/manager/library/resources.js';
import type pg from 'pg';
import { copyFile, link, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { clientLibraryDirectory } from '../../client-library.js';
import {
  labelChecked,
  labelInteger,
  labelMode,
  labelRows,
  labelString,
  LabelValidationError,
} from '../labels/index.js';
import { readLicenseFields } from '../../../shared/license-counts.js';
import { irfdAttachments, irfdImageLocation } from '../../../shared/irfd.js';

type Database = Pick<pg.Pool, 'query'>;
export type LibraryMode = 'ComLIb' | 'RepLIb' | 'ImageLib';
export const libraryModes = { ComLIb: 'common', RepLIb: 'report', ImageLib: 'image' } as const;
export type LibraryDocument = Record<string, unknown> & {
  document_id: number;
  document_name: string;
  document_save_kbn: string | number;
};
export type LibraryFile = { token: string; path: string; name: string; type: string; size: number };
export type LibraryRoles = Record<string, { read: boolean; edit: boolean }>;
export class LibraryError extends LabelValidationError {}
export class LibraryPendingError extends LibraryError {}
export const libraryText = labelString;
export function libraryMode(value: unknown): LibraryMode {
  const mode = labelMode(value ?? 'ComLIb');
  if (mode !== 'ComLIb' && mode !== 'RepLIb' && mode !== 'ImageLib')
    throw new LibraryError('mode', pageText['Invalid library mode.']);
  return mode;
}
export function libraryIds(value: unknown): number[] {
  const parts = Array.isArray(value) ? value : libraryText(value).split(',');
  return [
    ...new Set(
      parts
        .filter((part) => part !== '')
        .map((part) => {
          const id = labelInteger(part);
          if (id <= 0) throw new LibraryError('', pageText['Invalid selection.']);
          return id;
        }),
    ),
  ];
}
export async function managerLibraryPermissions(db: Database, userId: string) {
  const row =
    (
      await db.query(
        `SELECT MAX(g.role_library_read) AS read,MAX(g.role_library_create) AS create,
    MAX(g.role_library_update) AS edit,MAX(g.role_library_delete) AS delete,MAX(g.role_data_output) AS output
    FROM mst_group g JOIN mst_group_affiation a USING(group_id) WHERE a.user_id=$1`,
        [userId],
      )
    ).rows[0] ?? {};
  const permissions = {
    read: Number(row.read) === 1,
    create: Number(row.create) === 1,
    edit: Number(row.edit) === 1,
    delete: Number(row.delete) === 1,
    output: Number(row.output) === 1,
  };
  return { ...permissions, refer: permissions.read || permissions.create || permissions.edit || permissions.delete };
}
export function managerTabAllowed(tab: 'Library' | 'DataOutput', fields = readLicenseFields()): boolean {
  return fields.get('Tab') !== '1' || (fields.get('TabOption') ?? '').split(',').includes(tab);
}
export async function librarySetting(db: Database, name: string): Promise<string> {
  return String(
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='LIBRARY' AND com_name=$1 ORDER BY com_index LIMIT 1",
        [name],
      )
    ).rows[0]?.com_value ?? '',
  );
}
function documentAccess(category: string, edit = false) {
  return `(COALESCE(d.document_save_kbn,0)<>2 AND
    (EXISTS (SELECT 1 FROM mst_${category}_document_role r JOIN mst_group_affiation a USING(group_id) WHERE r.document_id=d.document_id AND a.user_id=$1)
      OR NOT EXISTS (SELECT 1 FROM mst_${category}_document_role r WHERE r.document_id=d.document_id))
    OR COALESCE(d.document_save_kbn,0)=2 AND EXISTS (SELECT 1 FROM common_document_irfd_role r JOIN mst_group_affiation a USING(group_id)
      WHERE r.document_id=d.document_id AND a.user_id=$1 AND (${edit ? 'r.role_irfd_update=1' : 'r.role_irfd_read=1 OR r.role_irfd_update=1'})))`;
}
export async function libraryDocument(
  db: Database,
  mode: LibraryMode,
  id: number,
  userId: string,
  edit = false,
): Promise<LibraryDocument | undefined> {
  const category = libraryModes[mode];
  const categories = Object.values(libraryModes);
  const matchingRole = categories
    .map(
      (kind) =>
        `EXISTS (SELECT 1 FROM mst_${kind}_document_role r WHERE r.document_id=d.document_id AND r.group_id=a.group_id)`,
    )
    .join(' OR ');
  const noRoles = categories
    .map((kind) => `NOT EXISTS (SELECT 1 FROM mst_${kind}_document_role r WHERE r.document_id=d.document_id)`)
    .join(' AND ');
  // HasLibraryRole checks Common FreeDraw first, then roles across all three categories; lists differ.
  return (
    await db.query<LibraryDocument>(
      `SELECT d.* FROM mst_${category}_document d WHERE document_id=$2
    AND ($1='conmasadmin' OR CASE WHEN EXISTS (SELECT 1 FROM mst_common_document c WHERE c.document_id=d.document_id AND c.document_save_kbn=2)
      THEN EXISTS (SELECT 1 FROM common_document_irfd_role r JOIN mst_group_affiation a USING(group_id)
        WHERE r.document_id=d.document_id AND a.user_id=$1 AND (${edit ? 'r.role_irfd_update=1' : 'r.role_irfd_read=1 OR r.role_irfd_update=1'}))
      ELSE EXISTS (SELECT 1 FROM mst_group_affiation a WHERE a.user_id=$1 AND ((${matchingRole}) OR (${noRoles}))) END)`,
      [userId, id],
    )
  ).rows[0];
}
function day(value: unknown): string | undefined {
  const text = libraryText(value);
  if (!text) return;
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(text);
  if (!match) throw new LibraryError('', pageText['Invalid date.']);
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== `${match[1]}-${match[2]}-${match[3]}` ||
    Number(match[1]) === 0
  )
    throw new LibraryError('', pageText['Invalid date.']);
  return date.toISOString().slice(0, 10);
}
export async function libraryList(db: Database, mode: LibraryMode, userId: string, input: Record<string, unknown>) {
  const category = libraryModes[mode],
    values: unknown[] = [userId];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const where = [`($1='conmasadmin' OR ${documentAccess(category)})`];
  const label = libraryText(input.LabelID);
  if (label === 'NoLabel')
    where.push(`NOT EXISTS (SELECT 1 FROM ${category}_document_label l WHERE l.document_id=d.document_id)`);
  else if (label && label !== 'All')
    where.push(
      `EXISTS (SELECT 1 FROM ${category}_document_label l WHERE l.document_id=d.document_id AND l.mst_label_id=${bind(labelInteger(label))})`,
    );
  if (['0', '2'].includes(libraryText(input.UseEndDate)))
    where.push(
      input.UseEndDate === '2'
        ? 'd.use_end_time<CURRENT_DATE'
        : '(d.use_end_time IS NULL OR d.use_end_time>=CURRENT_DATE)',
    );
  for (const [key, column] of [
    ['SearchDocumentName', 'document_name'],
    ['SearchRemarks', 'remarks'],
    ['SearchIrfdText', 'irfd_text'],
  ] as const) {
    const value = libraryText(input[key]).trim();
    if (!value || (key === 'SearchIrfdText' && mode !== 'ComLIb')) continue;
    where.push(`d.${column} ${key === 'SearchDocumentName' ? 'LIKE' : 'ILIKE'} ${bind('%' + value + '%')}`);
  }
  for (const [key, column] of [
    ['SearchMobileSave', 'document_mobile_save'],
    ['SearchSaveKbn', 'document_save_kbn'],
  ] as const)
    if (libraryText(input[key])) where.push(`d.${column}=${bind(labelInteger(input[key]))}`);
  for (const [prefix, column, alias] of [
    ['SearchRegist', 'sys_regist', 'u'],
    ['SearchUpdate', 'sys_update', 'v'],
  ] as const) {
    const user = libraryText(input[prefix + 'User']).trim();
    if (user)
      where.push(`(d.${column}_user LIKE ${bind('%' + user + '%')} OR ${alias}.user_name LIKE $${values.length})`);
    const from = day(input[prefix + 'TimeFrom']),
      to = day(input[prefix + 'TimeTo']);
    if (from && to && from > to) throw new LibraryError('', pageText['The start date must not follow the end date.']);
    if (from) where.push(`d.${column}_time>=${bind(from)}::date`);
    if (to) where.push(`d.${column}_time<${bind(to)}::date+interval '1 day'`);
  }
  if (mode === 'RepLIb') {
    for (const kind of ['Def', 'Rep'] as const) {
      const lower = kind.toLowerCase(),
        id = libraryText(input[`Search${kind}TopId`]),
        name = libraryText(input[`Search${kind}TopName`]);
      if (id)
        where.push(
          `EXISTS (SELECT 1 FROM ${lower}_report_document l WHERE l.document_id=d.document_id AND l.${lower}_top_id=${bind(labelInteger(id))})`,
        );
      if (name)
        where.push(
          `EXISTS (SELECT 1 FROM ${lower}_report_document l JOIN ${lower}_top t USING(${lower}_top_id) WHERE l.document_id=d.document_id AND t.${lower}_top_name ILIKE ${bind('%' + name + '%')})`,
        );
    }
    where.push(`(EXISTS (SELECT 1 FROM def_report_document l JOIN def_role r USING(def_top_id) JOIN mst_group_affiation a USING(group_id) WHERE l.document_id=d.document_id AND a.user_id=$1)
      OR EXISTS (SELECT 1 FROM rep_report_document l JOIN rep_role r USING(rep_top_id) JOIN mst_group_affiation a USING(group_id) WHERE l.document_id=d.document_id AND a.user_id=$1)
      OR NOT EXISTS (SELECT 1 FROM def_report_document l WHERE l.document_id=d.document_id) AND NOT EXISTS (SELECT 1 FROM rep_report_document l WHERE l.document_id=d.document_id))`);
  }
  if (userId !== 'conmasadmin' && (await librarySetting(db, 'IREPORTER_LABEL_ROLE_MODE')) === '1') {
    const visible = (await labelRows(db, mode, userId)).map((row) => row.mst_label_id);
    where.push(`(NOT EXISTS (SELECT 1 FROM ${category}_document_label l WHERE l.document_id=d.document_id) OR EXISTS
      (SELECT 1 FROM ${category}_document_label l WHERE l.document_id=d.document_id AND l.mst_label_id=ANY(${bind(visible)}::int[])))`);
  }
  const from = `FROM mst_${category}_document d LEFT JOIN mst_user u ON u.user_id=d.sys_regist_user LEFT JOIN mst_user v ON v.user_id=d.sys_update_user WHERE ${where.join(' AND ')}`;
  const total = Number((await db.query(`SELECT COUNT(*) AS count ${from}`, values)).rows[0].count);
  const defaultSize =
    Number(
      (await db.query("SELECT com_value FROM mst_common WHERE com_key='DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1"))
        .rows[0]?.com_value,
    ) || 20;
  const size = Math.max(1, Math.min(1000, labelInteger(input.PageSize, defaultSize))),
    pages = Math.max(1, Math.ceil(total / size));
  const index = Math.max(0, Math.min(pages - 1, labelInteger(input.PageIndex, 0)));
  const column = libraryText(input.SortColumn).toLowerCase(),
    allowed = [
      'document_id',
      'document_name',
      'document_save_kbn',
      'document_mobile_save',
      'sys_regist_time',
      'sys_update_time',
      'sys_regist_user',
      'sys_update_user',
    ];
  const order = allowed.includes(column) ? column : 'sys_update_time',
    direction = input.SortDirection === 'ASC' ? 'ASC' : 'DESC';
  const rows = (
    await db.query(
      `SELECT d.document_id,d.document_name,d.document_type,d.document_save_kbn,d.document_path,d.document_mobile_save,d.use_end_time,d.sys_regist_time,d.sys_update_time,
    COALESCE(u.user_name,d.sys_regist_user) AS created_by,COALESCE(v.user_name,d.sys_update_user) AS updated_by,
    ARRAY(SELECT l.mst_label_id FROM ${category}_document_label l WHERE l.document_id=d.document_id ORDER BY l.mst_label_id) AS label_ids,
    EXISTS(SELECT 1 FROM document_lock l WHERE l.document_id=d.document_id) AS locked ${from} ORDER BY d.${order} ${direction},d.document_id LIMIT ${bind(size)} OFFSET ${bind(index * size)}`,
      values,
    )
  ).rows;
  return { rows, total, size, index, pages, order, direction };
}
const referenceTypes = [
  'URL',
  'PDF',
  'EXCEL',
  'PowerPoint',
  'Word',
  'XVL',
  'MOVIE',
  'PHOTO',
  'SOUND',
  'OTHERS',
  'AIModel',
];
export { referenceTypes as libraryReferenceTypes };
function fileType(name: string, mode: LibraryMode) {
  const extension = extname(name).toLowerCase();
  for (const [type, extensions] of Object.entries({
    PDF: ['.pdf'],
    EXCEL: ['.xls', '.xlsx', '.xlsm'],
    PowerPoint: ['.ppt', '.pptx', '.pptm'],
    Word: ['.doc', '.docx', '.docm'],
    PHOTO: ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.pict', '.tif', '.tiff'],
    MOVIE: ['.wmv', '.avi', '.mpeg', '.vob', '.mpg', '.ogm', '.mov', '.divx', '.mp4'],
    SOUND: ['.wav', '.wma', '.mp3', '.ogg', '.m4a', '.cda'],
    XVL: ['.xvl', '.xv2', '.xv3'],
  }))
    if (extensions.includes(extension)) return type;
  return extension === '.mlmodel' && mode === 'RepLIb' ? 'AIModel' : 'OTHERS';
}
export function libraryInput(input: Record<string, unknown>) {
  const get = (key: string) => input['Document.' + key];
  const components = ['day', 'hour', 'minuite'].map((unit) => labelInteger(get('document_life_time_' + unit), 0));
  if (components.some((value) => value < 0)) throw new LibraryError('', pageText['Invalid document lifetime.']);
  const lifetime = components[0] * 1440 + components[1] * 60 + components[2];
  if (lifetime < 0 || lifetime > 2147483647) throw new LibraryError('', pageText['Invalid document lifetime.']);
  const storage = labelInteger(get('document_save_kbn'), 0);
  if (![0, 1, 2].includes(storage)) throw new LibraryError('', pageText['Invalid storage mode.']);
  return {
    document_id: labelInteger(get('document_id'), 0),
    document_name: libraryText(get('document_name')),
    document_save_kbn: storage,
    document_type:
      libraryText(get(storage === 1 ? 'document_type_url' : 'document_type')) || (storage === 1 ? 'URL' : 'OTHERS'),
    document_path: libraryText(get('document_path')),
    document_mobile_save: labelInteger(get('document_mobile_save'), 1),
    document_manual_download: labelChecked(get('document_manual_download')) ? 1 : 0,
    document_life_time: lifetime,
    use_end_time: day(get('use_end_time')) ?? null,
    is_other_app_open: labelInteger(get('IsOtherAppOpen'), 1),
    remarks: libraryText(get('Remarks')),
  };
}
async function auditInsert(
  db: Database,
  table: string,
  fields: Record<string, unknown>,
  user: string,
  now = new Date(),
) {
  const data = {
    ...fields,
    sys_regist_term: hostname(),
    sys_regist_user: user,
    sys_regist_time: now,
    sys_update_term: hostname(),
    sys_update_user: user,
    sys_update_time: now,
  };
  const columns = Object.keys(data);
  await db.query(
    `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
    Object.values(data),
  );
}
export async function libraryGroups(db: Database, mode: LibraryMode, id: number, fd = false) {
  const category = libraryModes[mode];
  return (
    await db.query(
      `SELECT g.group_id,g.group_name_path,${fd ? 'COALESCE(r.role_irfd_read,0)=1' : 'r.group_id IS NOT NULL'} AS read,
    ${fd ? 'COALESCE(r.role_irfd_update,0)=1' : 'false'} AS edit FROM mst_group g LEFT JOIN ${fd ? 'common_document_irfd_role' : `mst_${category}_document_role`} r ON r.group_id=g.group_id AND r.document_id=$1
    WHERE g.group_id<>-999 ORDER BY g.group_name_path,g.group_id`,
      [id],
    )
  ).rows;
}
async function writeRoles(
  db: Database,
  mode: LibraryMode,
  id: number,
  user: string,
  roles: LibraryRoles,
  noRoles: boolean,
  fd = false,
) {
  const table = fd ? 'common_document_irfd_role' : `mst_${libraryModes[mode]}_document_role`;
  const groups = await libraryGroups(db, mode, id, fd),
    allowed = new Set(groups.map((group) => String(group.group_id)));
  if (Object.keys(roles).some((id) => !allowed.has(id)))
    throw new LibraryError('', pageText['Invalid group selection.']);
  await db.query(`DELETE FROM ${table} WHERE document_id=$1`, [id]);
  for (const group of groups) {
    const role = roles[group.group_id];
    if (!role || (fd ? !role.read && !role.edit : noRoles || !role.read)) continue;
    await auditInsert(
      db,
      table,
      {
        document_id: id,
        group_id: group.group_id,
        ...(fd ? { role_irfd_read: role.read ? 1 : 0, role_irfd_update: role.edit ? 1 : 0 } : {}),
      },
      user,
    );
  }
}
// Keep the old bytes until COMMIT, unlike the source's pre-commit backup deletion.
async function stageFile(target: string, file?: LibraryFile) {
  const backup = target + '.node-' + randomUUID(),
    pending = backup + '.new';
  let old = false,
    written = false;
  try {
    try {
      await link(target, backup);
      old = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (file) {
      await copyFile(file.path, pending, constants.COPYFILE_EXCL);
      await rename(pending, target);
      written = true;
    } else if (old) {
      await unlink(target);
      written = true;
    }
  } catch (error) {
    await unlink(pending).catch(() => {});
    await unlink(backup).catch(() => {});
    throw error;
  }
  return {
    commit: async () => {
      if (old) await unlink(backup).catch(() => {});
    },
    rollback: async () => {
      if (old) await rename(backup, target);
      else if (written) await unlink(target);
    },
  };
}
export async function saveLibraryDocument(
  db: pg.Pool,
  mode: LibraryMode,
  input: Record<string, unknown>,
  files: LibraryFile[],
  user: string,
  options: { create: boolean; labels: number[]; roles: LibraryRoles; noRoles: boolean },
) {
  const item = libraryInput(input),
    category = libraryModes[mode];
  if (item.document_save_kbn === 2)
    throw new LibraryPendingError(
      '',
      pageText['FreeDraw PDF/IRFD registration is not implemented yet. No changes were saved.'],
    );
  if (mode === 'ImageLib' && item.document_save_kbn !== 0)
    throw new LibraryError('', pageText['Image library requires an image file.']);
  if (
    (!options.create && !item.document_name) ||
    (item.document_save_kbn === 1 && (!item.document_name || !item.document_path))
  )
    throw new LibraryError('', pageText['Document name and URL are required.']);
  if (item.document_save_kbn === 1 && !/^(https?:\/\/|file:\/\/)/i.test(item.document_path))
    throw new LibraryError('', pageText['Invalid document URL.']);
  if (
    !referenceTypes.includes(item.document_type) ||
    (mode !== 'RepLIb' && item.document_type === 'AIModel') ||
    ![0, 1].includes(item.document_mobile_save) ||
    ![0, 1].includes(item.is_other_app_open)
  )
    throw new LibraryError('', pageText['Invalid document options.']);
  if (options.create && item.document_save_kbn === 0 && !files.length)
    throw new LibraryError('', pageText['File upload is required.']);
  if (files.length > 10 || (!options.create && files.length > 1))
    throw new LibraryError('', pageText['Too many uploaded files.']);
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.irfd'))
      throw new LibraryError('', pageText['IRFD files require FreeDraw storage mode.']);
    if (mode === 'ImageLib') {
      const format = (
        await sharp(file.path)
          .metadata()
          .catch(() => ({}) as Metadata)
      ).format;
      if (!format || !['png', 'jpeg', 'tiff'].includes(format))
        throw new LibraryError('', pageText['Only PNG, JPEG and TIFF images are accepted.']);
    }
  }
  const connection = await db.connect(),
    changes: Awaited<ReturnType<typeof stageFile>>[] = [],
    ids: number[] = [];
  try {
    await connection.query('BEGIN');
    await connection.query(
      'LOCK TABLE mst_common_document,mst_report_document,mst_image_document IN SHARE ROW EXCLUSIVE MODE',
    );
    const permissions = await managerLibraryPermissions(connection, user);
    if (!permissions[options.create ? 'create' : 'edit'])
      throw new LibraryError('', pageText['Role authority is insufficient.']);
    const old = options.create ? undefined : await libraryDocument(connection, mode, item.document_id, user, true);
    if (!options.create && !old) throw new LibraryError('', pageText['Document is not accessible.']);
    if (old && Number(old.document_save_kbn) === 2)
      throw new LibraryPendingError(
        '',
        pageText['FreeDraw registration is not implemented yet. No changes were saved.'],
      );
    const location = await librarySetting(connection, 'FILE_LOCATION');
    if (location && !['0', '1'].includes(location))
      throw new LibraryError('', pageText['Unsupported library file location.']);
    const visible = new Set((await labelRows(connection, mode, user)).map((row) => row.mst_label_id));
    if (options.labels.some((id) => !visible.has(id))) throw new LibraryError('', pageText['Label is not accessible.']);
    const batch = item.document_save_kbn === 1 || !files.length ? [undefined] : files;
    for (const file of batch) {
      {
        const limit = readLicenseFields().get('Document');
        const count = Number(
          (
            await connection.query(
              'SELECT (SELECT count(*) FROM mst_common_document)+(SELECT count(*) FROM mst_report_document) AS count',
            )
          ).rows[0].count,
        );
        if (limit !== undefined && /^\d+$/.test(limit) && count >= Number(limit))
          throw new LibraryError('', pageText['The document license limit has been reached.']);
      }
      const id =
        old?.document_id ??
        Number((await connection.query("SELECT nextval('mst_document_document_id_seq') AS id")).rows[0].id);
      const now = new Date(),
        data: Record<string, unknown> = {
          ...item,
          document_id: id,
          document_name: options.create && file ? file.name : item.document_name,
          document_type: options.create && file ? fileType(file.name, mode) : item.document_type,
          sys_update_user: user,
          sys_update_term: hostname(),
          sys_update_time: now,
        };
      if (mode === 'ComLIb')
        data.sys_update_user_name =
          (await connection.query('SELECT user_name FROM mst_user WHERE user_id=$1', [user])).rows[0]?.user_name ??
          user;
      if (file)
        Object.assign(data, { document_name_org: file.name, content_type: file.type, document_update_time: now });
      if (file && location === '1') data.document_file = await readFile(file.path);
      if (options.create) {
        await auditInsert(
          connection,
          `mst_${category}_document`,
          { ...data, ...(mode === 'ComLIb' ? { sys_regist_user_name: data.sys_update_user_name } : {}) },
          user,
          now,
        );
      } else {
        delete data.document_id;
        const columns = Object.keys(data);
        await connection.query(
          `UPDATE mst_${category}_document SET ${columns.map((column, i) => `${column}=$${i + 1}`).join(',')} WHERE document_id=$${columns.length + 1}`,
          [...Object.values(data), id],
        );
      }
      // Invisible existing label assignments survive an edit rather than being silently erased.
      await connection.query(
        `DELETE FROM ${category}_document_label WHERE document_id=$1 AND mst_label_id=ANY($2::int[])`,
        [id, [...visible]],
      );
      for (const label of options.labels)
        await auditInsert(
          connection,
          `${category}_document_label`,
          { document_id: id, mst_label_id: label },
          user,
          now,
        );
      if (options.create) await writeRoles(connection, mode, id, user, options.roles, options.noRoles);
      if (file && location !== '1') {
        const directory = await clientLibraryDirectory(connection);
        await mkdir(directory, { recursive: true });
        if (
          !old &&
          (await stat(join(directory, String(id))).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
          }))
        )
          throw new LibraryError('', pageText['A library file already exists for this ID.']);
        changes.push(await stageFile(join(directory, String(id)), file));
      }
      ids.push(id);
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').finally(() => Promise.all(changes.reverse().map((change) => change.rollback())));
    throw error;
  } finally {
    connection.release();
  }
  for (const change of changes) await change.commit();
  return ids;
}
export async function changeLibraryDocuments(
  db: pg.Pool,
  mode: LibraryMode,
  ids: number[],
  user: string,
  action: 'delete' | 'labels' | 'roles',
  options: { labels?: number[]; remove?: boolean; roles?: LibraryRoles; noRoles?: boolean } = {},
) {
  if (!ids.length) throw new LibraryError('', pageText['Select a document.']);
  const connection = await db.connect(),
    changes: Awaited<ReturnType<typeof stageFile>>[] = [],
    category = libraryModes[mode];
  try {
    await connection.query('BEGIN');
    await connection.query(
      'LOCK TABLE mst_common_document,mst_report_document,mst_image_document,document_lock IN SHARE ROW EXCLUSIVE MODE',
    );
    const permissions = await managerLibraryPermissions(connection, user);
    if (!permissions[action === 'delete' ? 'delete' : 'edit'])
      throw new LibraryError('', pageText['Role authority is insufficient.']);
    const visible = new Set((await labelRows(connection, mode, user)).map((row) => row.mst_label_id));
    if (options.labels?.some((id) => !visible.has(id)))
      throw new LibraryError('', pageText['Label is not accessible.']);
    for (const id of ids) {
      const item = await libraryDocument(connection, mode, id, user, true);
      if (!item) throw new LibraryError('', pageText['Document is not accessible.']);
      const fd = Number(item.document_save_kbn) === 2;
      if (
        fd &&
        action === 'delete' &&
        (await connection.query('SELECT 1 FROM document_lock WHERE document_id=$1', [id])).rowCount
      )
        throw new LibraryError('', pageText['A selected document is locked.']);
      if (action === 'roles') await writeRoles(connection, mode, id, user, options.roles ?? {}, !!options.noRoles, fd);
      else if (action === 'labels')
        for (const label of options.labels ?? []) {
          await connection.query(`DELETE FROM ${category}_document_label WHERE document_id=$1 AND mst_label_id=$2`, [
            id,
            label,
          ]);
          if (!options.remove)
            await auditInsert(connection, `${category}_document_label`, { document_id: id, mst_label_id: label }, user);
        }
      else {
        await connection.query(`DELETE FROM ${category}_document_label WHERE document_id=$1`, [id]);
        await connection.query(`DELETE FROM mst_${category}_document_role WHERE document_id=$1`, [id]);
        if (mode === 'RepLIb')
          for (const table of ['def_report_document', 'rep_report_document'])
            await connection.query(`DELETE FROM ${table} WHERE document_id=$1`, [id]);
        if (mode === 'ComLIb')
          for (const table of ['common_document_irfd_role', 'common_document_irfd'])
            await connection.query(`DELETE FROM ${table} WHERE document_id=$1`, [id]);
        await connection.query(`DELETE FROM mst_${category}_document WHERE document_id=$1`, [id]);
        changes.push(await stageFile(join(await clientLibraryDirectory(connection), String(id))));
      }
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').finally(() => Promise.all(changes.reverse().map((change) => change.rollback())));
    throw error;
  } finally {
    connection.release();
  }
  for (const change of changes) await change.commit();
}
export async function libraryBinary(db: Database, document: LibraryDocument) {
  if (Number(document.document_save_kbn) === 1)
    throw new LibraryError('', pageText['This document is a URL, not a file.']);
  const location = await librarySetting(db, 'FILE_LOCATION');
  const data =
    location === '1'
      ? document.document_file
      : await readFile(join(await clientLibraryDirectory(db), String(document.document_id))).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        });
  if (!Buffer.isBuffer(data)) throw new LibraryError('', pageText['Document file was not found.']);
  return {
    data,
    name: String(document.document_name_org ?? document.document_name),
    type: String(document.content_type || 'application/octet-stream'),
  };
}
export async function libraryIrfdContent(db: Database, id: number, revision?: number) {
  const history = (
    await db.query(
      `SELECT r.rev_no,r.sys_regist_time,r.sys_update_time,
    COALESCE(u.user_name,r.sys_regist_user) AS created_by,COALESCE(v.user_name,r.sys_update_user) AS updated_by
    FROM common_document_irfd r LEFT JOIN mst_user u ON u.user_id=r.sys_regist_user LEFT JOIN mst_user v ON v.user_id=r.sys_update_user
    WHERE r.document_id=$1 ORDER BY r.rev_no`,
      [id],
    )
  ).rows;
  const selectedRevision = revision ?? (history.length ? Number(history[history.length - 1].rev_no) : undefined);
  if (selectedRevision === undefined) return;
  const row = (
    await db.query(
      `SELECT document_name,pdf_file_name,irfd_file_name,irfd_file FROM common_document_irfd
    WHERE document_id=$1 AND rev_no=$2`,
      [id, selectedRevision],
    )
  ).rows[0];
  if (!row) return;
  const attachments = Buffer.isBuffer(row.irfd_file) ? irfdAttachments(row.irfd_file) : [];
  const images = [];
  for (const attachment of attachments.filter((item) => item.format === 'jpeg' || item.format === 'png')) {
    images.push({
      name: attachment.name,
      format: attachment.format,
      pageNumber: attachment.pageNumber,
      location: await irfdImageLocation(attachment.data),
    });
  }
  const texts = attachments
    .filter((item) => item.format === 'text')
    .map((item) => ({ pageNumber: item.pageNumber, text: item.data.toString('utf8') }));
  return {
    documentName: row.document_name,
    pdfName: row.pdf_file_name,
    irfdName: row.irfd_file_name,
    selectedRevision,
    history,
    images,
    texts,
    useHistory: (await librarySetting(db, 'FD_USE_HISTORY')) === '1',
  };
}
