import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { hostname } from 'node:os';
import { win32 } from 'node:path';
import { licenseStatus } from '../../../shared/license-counts.js';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

export const freeDrawOnlyCommonKeys = ['LIBRARY', 'LOG_SETTING', 'PASSWORD_SETTING', 'TERMINAL_SETTING'];
const hiddenCommonSettings: Array<[string | null, string | null]> = [
  ['CLOUD_SETTING', null],
  [null, 'PASSWORD_ENCRYPTION'],
  ['LIBRARY', 'FILE_LOCATION'],
  ['SYSTEM', 'LICENSE_UPLOADING_IS_ENABLED'],
  ['CSV_DOWNLOAD_SETTING', 'LIMIT_OF_DOWNLOAD_COUNT'],
  ['CONMAS_FUNCTION', 'INPUTREPORT_LABEL_INIT_LOAD'],
  ['CONMAS_FUNCTION', 'INPUTREPORT_LABEL_ALL_DISPLAY'],
  ['CUSTOM_MASTER', 'SYNC_TERMINAL_LIMIT'],
  ['CUSTOM_MASTER', 'SYNC_LIMIT_TIME'],
  ['LOGIN_SETTING', 'ENABLE_MEID'],
];
export function commonSettingVisible(key: string, name: string, freeDrawOnly: boolean): boolean {
  return (
    (!freeDrawOnly || freeDrawOnlyCommonKeys.includes(key)) &&
    !hiddenCommonSettings.some(
      ([hiddenKey, hiddenName]) => (!hiddenKey || hiddenKey === key) && (!hiddenName || hiddenName === name),
    )
  );
}

export function cloudOutputPrefix(value: string): string {
  const match = /[/\\]+settingfiles[/\\]+output[/\\]*/i.exec(value);
  return match ? value.slice(0, match.index + match[0].length) : '';
}
export function displayOutputPath(value: string, prefix: string): string {
  return prefix ? value.split(prefix).join('') : value;
}
export function storedOutputPath(value: string, prefix: string, cloud: boolean): string {
  const relative = cloud ? value.replace(/^[/\\]+/, '') : value;
  const result = win32.isAbsolute(relative) ? relative : win32.join(prefix, relative);
  return result.endsWith('\\') ? result : result + '\\';
}
export function validateCommonSetting(
  record: Record<string, string>,
  mode: 'create' | 'edit',
  freeDrawOnly: boolean,
  cloud: boolean,
): string {
  if (!record.com_key?.trim()) return 'Please enter Common key.';
  if (!record.com_name?.trim()) return 'Please enter Common item name.';
  if (
    !/^[+-]?\d+$/.test(record.com_index?.trim() ?? '') ||
    Number(record.com_index) < -2147483648 ||
    Number(record.com_index) > 2147483647
  )
    return 'Common item index should be an integer value.';
  if (freeDrawOnly && !freeDrawOnlyCommonKeys.includes(record.com_key)) return 'Cannot be set';
  if (mode === 'edit') {
    const values =
      record.com_key === 'IDENTIFICATION_SETTING' && record.com_name === 'ENABLE_IDENTIFICATION'
        ? ['-1', '0', '1']
        : record.com_key === 'REPORT_APPROVE_SETTING' && record.com_name === 'ENABLE_BULK_APPROVAL'
          ? ['0', '1']
          : null;
    if (values && !values.includes(record.com_value))
      return 'Please enter Common item value as one of ' + values.join(',') + '.';
    if (cloud && record.com_key === 'OUTPUT_SETTING' && record.com_name === 'BASE_FOLDER') {
      if (record.com_value.includes(':')) return ': is a character that cannot be used.';
    } else if (!record.com_value) return 'Please enter Common item value.';
  }
  return '';
}

type CommonAction = 'read' | 'create' | 'edit' | 'delete';

export function registerCommon(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
) {
  const root = '/ConMasManager/System';
  const titles = {
    list: 'Common master list',
    details: 'Refer common master',
    create: 'Register common master',
    edit: 'Edit common master',
  };
  const settingValue = async (key: string, name: string) =>
    String(
      (
        await db.query('SELECT com_value FROM mst_common WHERE com_key=$1 AND com_name=$2 ORDER BY com_index LIMIT 1', [
          key,
          name,
        ])
      ).rows[0]?.com_value ?? '',
    );
  const outputPrefix = async () =>
    process.env.CONMAS_PLATFORM?.toLowerCase() === 'cloud'
      ? cloudOutputPrefix(await settingValue('OUTPUT_SETTING', 'BASE_FOLDER'))
      : settingValue('CLOUD_SETTING', 'OUTPUT_FIXED_PATH');
  const form = async (
    req: Request,
    res: Response,
    mode: 'create' | 'edit',
    record: Record<string, unknown>,
    error = '',
  ) => {
    const locales = (
      await db.query(
        "SELECT com_value AS value, com_name AS text FROM mst_common WHERE com_key='LOCALE' ORDER BY com_index",
      )
    ).rows;
    return render(res, {
      active: 'System',
      section: 'ComList',
      login: false,
      title: titles[mode],
      userName: res.locals.userName,
      settings: { mode, title: titles[mode], record, error, locales },
    });
  };
  const existing = async (id: number) => {
    const row = (await db.query('SELECT * FROM mst_common WHERE com_id=$1', [id])).rows[0];
    return row && commonSettingVisible(row.com_key, row.com_name ?? '', licenseStatus().freeDrawOnly) ? row : undefined;
  };
  const formGet = async (req: Request, res: Response, mode: 'create' | 'edit') => {
    if (!(await hasSystemPermission(db, req.session?.userId ?? '', 'system', mode))) return res.sendStatus(403);
    if (mode === 'create') return form(req, res, mode, { com_index: 0, com_locale: '' });
    const id = Number(req.query.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.sendStatus(400);
    const row = await existing(id);
    if (!row) return res.sendStatus(404);
    if (row.com_key === 'OUTPUT_SETTING' && row.com_name === 'BASE_FOLDER')
      row.com_value = displayOutputPath(row.com_value ?? '', await outputPrefix());
    return form(req, res, mode, row);
  };
  const save = async (req: Request, res: Response, mode: 'create' | 'edit') => {
    const actor = req.session?.userId ?? '';
    if (!(await hasSystemPermission(db, actor, 'system', mode))) return res.sendStatus(403);
    const body = req.body ?? {};
    const record: Record<string, string> = {};
    for (const key of ['com_id', 'com_key', 'com_index', 'com_name', 'com_value', 'com_locale'])
      record[key] = typeof body['mst_common.' + key] === 'string' ? body['mst_common.' + key] : '';
    const id = Number(record.com_id);
    if (mode === 'edit' && (!Number.isSafeInteger(id) || id <= 0)) return res.sendStatus(400);
    if (mode === 'edit' && !(await existing(id))) return res.sendStatus(404);
    const error = validateCommonSetting(
      record,
      mode,
      licenseStatus().freeDrawOnly,
      process.env.CONMAS_PLATFORM?.toLowerCase() === 'cloud',
    );
    if (error) return form(req, res.status(400), mode, record, error);
    let value = record.com_value;
    if (mode === 'edit' && record.com_key === 'OUTPUT_SETTING' && record.com_name === 'BASE_FOLDER') {
      const prefix = await outputPrefix();
      if (prefix || process.env.CONMAS_PLATFORM?.toLowerCase() === 'cloud')
        value = storedOutputPath(value, prefix, process.env.CONMAS_PLATFORM?.toLowerCase() === 'cloud');
    }
    const values = [
      record.com_key,
      Number(record.com_index),
      record.com_name,
      value,
      record.com_locale === '-1' ? '' : record.com_locale,
      hostname(),
      actor,
    ];
    try {
      if (mode === 'create') {
        const result = await db.query(
          "INSERT INTO mst_common (com_id,com_key,com_index,com_name,com_value,com_locale,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES (nextval('mst_common_com_id_seq'),$1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$6,$7,CURRENT_TIMESTAMP) RETURNING com_id",
          values,
        );
        return res.redirect(root + '/DetailsCom?id=' + result.rows[0].com_id);
      }
      const result = await db.query(
        'UPDATE mst_common SET com_key=$1,com_index=$2,com_name=$3,com_value=$4,com_locale=$5,sys_update_term=$6,sys_update_user=$7,sys_update_time=CURRENT_TIMESTAMP WHERE com_id=$8 AND ($9::boolean=false OR com_key=ANY($10::text[]))',
        [...values, id, licenseStatus().freeDrawOnly, freeDrawOnlyCommonKeys],
      );
      if (!result.rowCount) return res.sendStatus(404);
      return res.redirect(root + '/DetailsCom?id=' + id);
    } catch {
      return form(req, res.status(500), mode, record, 'Server error has been occurred.');
    }
  };

  const read = async (req: Request, res: Response, details: boolean) => {
    const actor = req.session?.userId ?? '';
    if (!(await hasSystemPermission(db, actor, 'system', 'read')))
      return res.status(403).send('Role authority is insufficient.');
    try {
      const freeDrawOnly = licenseStatus().freeDrawOnly;
      const source = req.method === 'POST' ? req.body : req.query;
      const selected = typeof source.com_key === 'string' ? source.com_key : '-1';
      const id = Number(req.query.id);
      if (details && (!Number.isSafeInteger(id) || id <= 0)) return res.sendStatus(400);
      const rows = (
        await db.query('SELECT * FROM mst_common WHERE com_key IS NOT NULL ORDER BY com_key, com_index')
      ).rows.filter((row) => commonSettingVisible(row.com_key, row.com_name ?? '', freeDrawOnly));
      const prefix = await outputPrefix();
      for (const row of rows)
        if (row.com_key === 'OUTPUT_SETTING' && row.com_name === 'BASE_FOLDER')
          row.com_value = displayOutputPath(row.com_value ?? '', prefix);
      const record = details ? rows.find((row) => Number(row.com_id) === id) : undefined;
      if (details && !record) return res.sendStatus(404);
      const [canCreate, canEdit, canDelete] = await Promise.all(
        ['create', 'edit', 'delete'].map((action) => hasSystemPermission(db, actor, 'system', action as CommonAction)),
      );
      return render(res, {
        active: 'System',
        section: 'ComList',
        login: false,
        title: details ? titles.details : titles.list,
        userName: res.locals.userName,
        settings: {
          mode: details ? 'details' : 'list',
          title: details ? titles.details : titles.list,
          rows: rows.filter((row) => selected === '-1' || row.com_key === selected),
          record,
          keys: [...new Set(rows.map((row) => row.com_key))],
          selected,
          canCreate,
          canEdit,
          canDelete,
        },
      });
    } catch {
      return res.status(503).send('Common Master information is unavailable.');
    }
  };
  app.get(`${root}/ComList`, (req, res) => read(req, res, false));
  app.post(`${root}/ComList`, (req, res) => read(req, res, false));
  app.get(`${root}/DetailsCom`, (req, res) => read(req, res, true));
  app.post(`${root}/DetailsCom`, async (req, res) => {
    if (req.body?.act !== 'delete') return res.status(400).send('Unknown action.');
    if (!(await hasSystemPermission(db, req.session?.userId ?? '', 'system', 'delete'))) return res.sendStatus(403);
    const id = Number(req.body['mst_common.com_id']);
    if (!Number.isSafeInteger(id) || id <= 0) return res.sendStatus(400);
    if (!(await existing(id))) return res.sendStatus(404);
    await db.query('DELETE FROM mst_common WHERE com_id=$1 AND ($2::boolean=false OR com_key=ANY($3::text[]))', [
      id,
      licenseStatus().freeDrawOnly,
      freeDrawOnlyCommonKeys,
    ]);
    return res.redirect(root + '/ComList');
  });
  app.get(`${root}/CreateCom`, (req, res) => formGet(req, res, 'create'));
  app.post(`${root}/CreateCom`, (req, res) => save(req, res, 'create'));
  app.get(`${root}/EditCom`, (req, res) => formGet(req, res, 'edit'));
  app.post(`${root}/EditCom`, (req, res) => save(req, res, 'edit'));
}
