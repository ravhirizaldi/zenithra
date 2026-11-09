import { text as pageText } from '../../../config/manager/system/resources.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import type { Express, Response } from 'express';
import { hostname } from 'node:os';
import type pg from 'pg';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

const root = '/ConMasManager/System';
const serverError = 'Server error has been occurred.';
const roleError = 'Role authority is insufficient.';

type PageSize = { value: number; text: string };
type TemplateRow = {
  template_id: number;
  template_name: string;
  document_mobile_save: number | string | null;
  document_life_time: number | string | null;
  use_end_time_display: string | null;
  is_other_app_open: number | string | null;
};
type TemplateForm = {
  TemplateId: number;
  TemplateName: string;
  DocumentMobileSave: string;
  DocumentLifeTimeDay: string;
  DocumentLifeTimeHour: string;
  DocumentLifeTimeMinute: string;
  UseEndTime: string;
  IsOtherAppOpen: string;
};
type FormField = keyof TemplateForm;
type FieldErrors = Partial<Record<FormField, string>>;
type ListPermissions = { read: boolean; create: boolean; edit: boolean; canDelete: boolean };
type ListPage = {
  mode: 'list';
  rows: Array<TemplateRow & { displayName: string; mobileSaveText: string; lifeTimeText: string }>;
  total: number;
  totalPages: number;
  pageIndex: number;
  pageSize: number;
  pageSizes: PageSize[];
  searchName: string;
  error: string;
  permissions: ListPermissions;
};

type EditValidation = {
  valid: boolean;
  errors: FieldErrors;
  documentMobileSave: number;
  documentLifeTime: number;
  useEndTime: string | null;
  isOtherAppOpen: number;
};

function field(source: Record<string, unknown>, name: string, fallback = ''): string {
  const raw = source[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function hasAction(source: Record<string, unknown>, name: string, expected: string): boolean {
  const raw = source[name];
  return raw === expected || (Array.isArray(raw) && raw.includes(expected));
}

function int32(text: string): number | null {
  const value = text.trim();
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 ? parsed : null;
}

function halfWidth(value: string): string {
  return value
    .replace(/[！＃＄％＆（）＊＋，－．／０-９：；＜＝＞？＠Ａ-Ｚ［］＾＿｀ａ-ｚ｛｜｝～]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 65248),
    )
    .replace(/\u3000/g, ' ');
}

function lifeTimeText(value: number | string | null): string {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes <= 0) return '';
  const days = Math.trunc(minutes / 1440);
  const hours = Math.trunc((minutes % 1440) / 60);
  return `${days} day(s) ${hours} hour(s) ${minutes % 60} minute(s)`;
}

function dateValue(text: string): string | null | undefined {
  const value = text.trim();
  if (!value) return null;
  let year: number;
  let month: number;
  let day: number;
  let match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return undefined;
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  }
  if (year < 1 || year > 9999 || month < 1 || month > 12) return undefined;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function validateIrfdTemplate(record: TemplateForm): EditValidation {
  const errors: FieldErrors = {};
  if (!record.TemplateName.trim()) errors.TemplateName = 'Please enter Name of template.';

  const durationFields = [
    ['DocumentLifeTimeDay', 'Day'],
    ['DocumentLifeTimeHour', 'Time'],
    ['DocumentLifeTimeMinute', 'Minutes'],
  ] as const;
  const durationParts: number[] = [];
  for (const [name, label] of durationFields) {
    const raw = record[name].trim();
    if (!raw) {
      durationParts.push(0);
      continue;
    }
    const parsed = int32(raw);
    if (parsed === null || parsed < 0) {
      errors[name] = `${label} should be an integer value.`;
      durationParts.push(0);
    } else {
      durationParts.push(parsed);
    }
  }

  const useEndTime = dateValue(record.UseEndTime);
  if (useEndTime === undefined)
    errors.UseEndTime = `The value '${record.UseEndTime}' is not valid for Term of validity.`;

  const parseDecimal = (text: string, name: 'DocumentMobileSave' | 'IsOtherAppOpen'): number => {
    const raw = text.trim();
    if (!raw) return 0;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
      errors[name] = 'The value is not valid.';
      return 0;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || Math.abs(parsed) > Number('79228162514264337593543950335')) {
      errors[name] = 'The value is not valid.';
      return 0;
    }
    return parsed;
  };
  const documentMobileSave = parseDecimal(record.DocumentMobileSave, 'DocumentMobileSave');
  const isOtherAppOpen = parseDecimal(record.IsOtherAppOpen, 'IsOtherAppOpen');
  const documentLifeTime = (durationParts[0] * 1440 + durationParts[1] * 60 + durationParts[2]) | 0;
  return {
    valid: Object.keys(errors).length === 0,
    errors,
    documentMobileSave,
    documentLifeTime,
    useEndTime: useEndTime ?? null,
    isOtherAppOpen,
  };
}

function parseForm(source: Record<string, unknown>): TemplateForm {
  const templateId = int32(field(source, 'TemplateId', '-1')) ?? -1;
  return {
    TemplateId: templateId,
    TemplateName: field(source, 'TemplateName'),
    DocumentMobileSave: field(source, 'DocumentMobileSave'),
    DocumentLifeTimeDay: field(source, 'DocumentLifeTimeDay'),
    DocumentLifeTimeHour: field(source, 'DocumentLifeTimeHour'),
    DocumentLifeTimeMinute: field(source, 'DocumentLifeTimeMinute'),
    UseEndTime: field(source, 'UseEndTime'),
    IsOtherAppOpen: field(source, 'IsOtherAppOpen'),
  };
}

function newTemplate(): TemplateForm {
  return {
    TemplateId: -1,
    TemplateName: '',
    DocumentMobileSave: '1',
    DocumentLifeTimeDay: '',
    DocumentLifeTimeHour: '',
    DocumentLifeTimeMinute: '',
    UseEndTime: '',
    IsOtherAppOpen: '1',
  };
}

async function loadListPermissions(db: pg.Pool, userId: string): Promise<ListPermissions> {
  const [read, create, edit, canDelete] = await Promise.all([
    hasSystemPermission(db, userId, 'group', 'read'),
    hasSystemPermission(db, userId, 'group', 'create'),
    hasSystemPermission(db, userId, 'group', 'edit'),
    hasSystemPermission(db, userId, 'group', 'delete'),
  ]);
  return { read, create, edit, canDelete };
}

async function pageSizeSettings(db: pg.Pool): Promise<{ pageSizes: PageSize[]; defaultPageSize: number }> {
  const [sizesResult, defaultResult] = await Promise.all([
    db.query<{ value: string; text: string }>(
      "SELECT com_value AS value, com_name AS text FROM mst_common WHERE com_key = 'PAGE_SIZE' ORDER BY com_index",
    ),
    db.query<{ com_value: string }>(
      "SELECT com_value FROM mst_common WHERE com_key = 'DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1",
    ),
  ]);
  const pageSizes = sizesResult.rows.flatMap((row) => {
    const value = Number(row.value);
    return Number.isSafeInteger(value) && value > 0 ? [{ value, text: row.text || row.value }] : [];
  });
  const configured = Number(defaultResult.rows[0]?.com_value);
  const defaultPageSize = pageSizes.some((option) => option.value === configured)
    ? configured
    : pageSizes.some((option) => option.value === 20)
      ? 20
      : (pageSizes[0]?.value ?? 20);
  return { pageSizes, defaultPageSize };
}

async function listPageData(
  db: pg.Pool,
  source: Record<string, unknown>,
  permissions: ListPermissions,
  error = '',
): Promise<ListPage> {
  const { pageSizes, defaultPageSize } = await pageSizeSettings(db);
  const requestedSize = int32(field(source, 'pageSize'));
  const pageSize =
    requestedSize !== null && pageSizes.some((option) => option.value === requestedSize)
      ? requestedSize
      : defaultPageSize;
  const requestedIndex = int32(field(source, 'pageIndex'));
  const pageIndex = requestedIndex !== null && requestedIndex >= 0 ? Math.min(requestedIndex, 10000) : 0;
  const searchName = field(source, 'SearchName');
  const pattern = searchName ? `%${halfWidth(searchName)}%` : null;
  const where = pattern ? ' WHERE convert_full2half(template_name) ILIKE $1' : '';
  const parameters: unknown[] = pattern ? [pattern] : [];
  const countResult = await db.query<{ total: string }>(
    `SELECT count(*) AS total FROM mst_irfd_template${where}`,
    parameters,
  );
  const total = Number(countResult.rows[0]?.total ?? 0);
  const offsetPosition = parameters.length + 1;
  const limitPosition = offsetPosition + 1;
  const result = await db.query<TemplateRow>(
    `SELECT template_id, template_name, document_mobile_save, document_life_time,
      to_char(use_end_time, 'YYYY/MM/DD') AS use_end_time_display, is_other_app_open
     FROM mst_irfd_template${where}
     ORDER BY template_id ASC LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
    [...parameters, pageIndex * pageSize, pageSize],
  );
  const rows = result.rows.map((row) => ({
    ...row,
    displayName: row.template_id === 1 && row.template_name === 'Default2' ? 'Default' : row.template_name,
    mobileSaveText: Number(row.document_mobile_save) === 1 ? 'Yes' : 'No',
    lifeTimeText: lifeTimeText(row.document_life_time),
  }));
  return {
    mode: 'list',
    rows,
    total,
    totalPages: Math.ceil(total / pageSize),
    pageIndex,
    pageSize,
    pageSizes,
    searchName,
    error,
    permissions,
  };
}

async function loadTemplate(db: pg.Pool, templateId: number): Promise<TemplateForm | null> {
  const result = await db.query<{
    template_id: number;
    template_name: string;
    document_mobile_save: number | string | null;
    document_life_time: number | string | null;
    use_end_time: string | null;
    is_other_app_open: number | string | null;
  }>(
    `SELECT template_id, template_name, document_mobile_save, document_life_time,
      to_char(use_end_time, 'YYYY/MM/DD') AS use_end_time, is_other_app_open
     FROM mst_irfd_template WHERE template_id = $1`,
    [templateId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const lifeTime = Number(row.document_life_time ?? 0);
  return {
    TemplateId: row.template_id,
    TemplateName: row.template_name ?? '',
    DocumentMobileSave: String(row.document_mobile_save ?? 0),
    DocumentLifeTimeDay: lifeTime > 0 ? String(Math.trunc(lifeTime / 1440)) : '',
    DocumentLifeTimeHour: lifeTime > 0 ? String(Math.trunc((lifeTime % 1440) / 60)) : '',
    DocumentLifeTimeMinute: lifeTime > 0 ? String(lifeTime % 60) : '',
    UseEndTime: row.use_end_time ?? '',
    IsOtherAppOpen: String(row.is_other_app_open ?? 0),
  };
}

export function registerIrfd(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  irfdLicensed?: boolean,
): void {
  const show = (res: Response, title: string, irfdPage: Record<string, unknown>, status = 200) =>
    render(res.status(status), {
      active: 'System',
      section: 'IrfdTemplateList',
      login: false,
      title,
      userName: res.locals.userName,
      irfdPage,
    });
  const licenseAllowed = (res: Response, title: string) => {
    try {
      if (irfdLicensed ?? licenseStatus().hasFreeDrawLicense) return true;
      show(res, title, { mode: 'denied', error: pageText['i-Repo FreeDraw license is required.'] }, 403);
    } catch {
      show(res, title, { mode: 'denied', error: pageText['License information is unavailable.'] }, 503);
    }
    return false;
  };
  const deny = (res: Response, title: string) => show(res.status(403), title, { mode: 'denied', error: roleError });
  const listTitle = 'i-Repo FreeDraw setting template';
  const emergencyList = (permissions: ListPermissions, error = serverError): ListPage => ({
    mode: 'list',
    rows: [],
    total: 0,
    totalPages: 0,
    pageIndex: 0,
    pageSize: 20,
    pageSizes: [],
    searchName: '',
    error,
    permissions,
  });
  const showForm = (
    res: Response,
    record: TemplateForm,
    options: { error?: string; errors?: FieldErrors; canDelete?: boolean } = {},
  ) =>
    show(
      res,
      record.TemplateId === -1
        ? 'i-Repo FreeDraw setting template creation'
        : 'i-Repo FreeDraw setting template editing',
      {
        mode: 'edit',
        record,
        error: options.error ?? '',
        errors: options.errors ?? {},
        canDelete: options.canDelete ?? false,
      },
    );

  app.get(`${root}/IrfdTemplateList`, async (req, res) => {
    let permissions: ListPermissions = { read: false, create: false, edit: false, canDelete: false };
    try {
      permissions = await loadListPermissions(db, req.session?.userId ?? '');
      if (!permissions.read) return deny(res, listTitle);
      if (!licenseAllowed(res, listTitle)) return;
      const data = await listPageData(db, req.query as Record<string, unknown>, permissions);
      return show(res, listTitle, data);
    } catch {
      return show(res, listTitle, emergencyList(permissions), 500);
    }
  });

  app.post(`${root}/IrfdTemplateList`, async (req, res) => {
    let permissions: ListPermissions = { read: false, create: false, edit: false, canDelete: false };
    try {
      permissions = await loadListPermissions(db, req.session?.userId ?? '');
      const body = req.body as Record<string, unknown>;
      const deleteSelected = hasAction(body, 'act', 'delete') || hasAction(body, 'deleteAction', 'delete');
      if (deleteSelected && !permissions.canDelete) return deny(res, listTitle);
      if (!deleteSelected && !permissions.read) return deny(res, listTitle);
      if (!licenseAllowed(res, listTitle)) return;
      let error = '';
      if (deleteSelected) {
        const checked = body.chk;
        const selection =
          field(body, 'ChkIds') ||
          (Array.isArray(checked) ? checked.join(',') : typeof checked === 'string' ? checked : '');
        const ids = selection ? selection.split(',') : [];
        if (ids.length === 0) {
          error = 'Please select Template';
        } else {
          const parsedIds = ids.map((id) => int32(id));
          if (parsedIds.some((id) => id === null || id < 1)) {
            return show(res, listTitle, emergencyList(permissions, serverError), 400);
          }
          const failed: number[] = [];
          for (const id of parsedIds as number[]) {
            if (id === 1) continue;
            try {
              await db.query('DELETE FROM mst_irfd_template WHERE template_id = $1', [id]);
            } catch {
              failed.push(id);
            }
          }
          if (failed.length) error = `Template has not been deleted. (ID:${failed.join(',')})`;
        }
      }
      if (deleteSelected && !permissions.read) return deny(res, listTitle);
      const data = await listPageData(db, { ...body, act: '' }, permissions, error);
      return show(res, listTitle, data);
    } catch {
      return show(res, listTitle, emergencyList(permissions), 500);
    }
  });

  app.get(`${root}/EditIrfdTemplate`, async (req, res) => {
    const parsedId = int32(field(req.query as Record<string, unknown>, 'id'));
    if (parsedId === null || (parsedId !== -1 && parsedId < 1))
      return res.status(400).send(pageText['Invalid template ID.']);
    const isCreate = parsedId === -1;
    const title = isCreate ? 'i-Repo FreeDraw setting template creation' : 'i-Repo FreeDraw setting template editing';
    try {
      const allowed = await hasSystemPermission(db, req.session?.userId ?? '', 'system', isCreate ? 'create' : 'edit');
      if (!allowed) return deny(res, title);
      if (!licenseAllowed(res, title)) return;
      const record = isCreate ? newTemplate() : await loadTemplate(db, parsedId);
      if (!record) return res.status(404).send(pageText['Template not found.']);
      const canDelete =
        record.TemplateId > 1 && (await hasSystemPermission(db, req.session?.userId ?? '', 'system', 'delete'));
      return showForm(res, record, { canDelete });
    } catch {
      return show(
        res,
        title,
        {
          mode: 'edit',
          record: isCreate ? newTemplate() : { ...newTemplate(), TemplateId: parsedId },
          error: serverError,
          errors: {},
          canDelete: false,
        },
        500,
      );
    }
  });

  app.post(`${root}/EditIrfdTemplate`, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const record = parseForm(body);
    const parsedId = int32(field(body, 'TemplateId', '-1'));
    if (parsedId === null || (parsedId !== -1 && parsedId < 1))
      return res.status(400).send(pageText['Invalid template ID.']);
    record.TemplateId = parsedId;
    const title =
      record.TemplateId === -1
        ? 'i-Repo FreeDraw setting template creation'
        : 'i-Repo FreeDraw setting template editing';
    const deleteAction = hasAction(body, 'act', 'delete') || hasAction(body, 'deleteAction', 'delete');
    try {
      if (deleteAction) {
        const allowed = await hasSystemPermission(db, req.session?.userId ?? '', 'system', 'delete');
        if (!allowed) return deny(res, title);
        if (!licenseAllowed(res, title)) return;
        if (record.TemplateId !== 1) {
          try {
            await db.query('DELETE FROM mst_irfd_template WHERE template_id = $1', [record.TemplateId]);
          } catch {
            return showForm(res, record, {
              error: pageText['Template has not been deleted.'],
              canDelete: record.TemplateId > 1,
            });
          }
        }
        return res.redirect(`${root}/IrfdTemplateList`);
      }

      const isCreate = record.TemplateId === -1;
      const allowed = await hasSystemPermission(db, req.session?.userId ?? '', 'system', isCreate ? 'create' : 'edit');
      if (!allowed) return deny(res, title);
      if (!licenseAllowed(res, title)) return;
      const validation = validateIrfdTemplate(record);
      const canDelete =
        record.TemplateId > 1 && (await hasSystemPermission(db, req.session?.userId ?? '', 'system', 'delete'));
      if (!validation.valid) return showForm(res, record, { errors: validation.errors, canDelete });

      const userId = req.session?.userId ?? '';
      const term = hostname();
      const now = new Date();
      if (isCreate) {
        await db.query(
          `INSERT INTO mst_irfd_template (
             template_id, template_name, document_mobile_save, document_life_time, use_end_time,
             is_other_app_open, sys_regist_term, sys_regist_user, sys_regist_time,
             sys_update_term, sys_update_user, sys_update_time
           ) VALUES (
             nextval('mst_irfd_template_template_id_seq'), $1, $2, $3, $4, $5, $6, $7, $8, $6, $7, $8
           )`,
          [
            record.TemplateName,
            validation.documentMobileSave,
            validation.documentLifeTime,
            validation.useEndTime,
            validation.isOtherAppOpen,
            term,
            userId,
            now,
          ],
        );
      } else {
        const result =
          record.TemplateId === 1
            ? await db.query(
                `UPDATE mst_irfd_template SET document_mobile_save = $1, document_life_time = $2,
              use_end_time = $3, is_other_app_open = $4, sys_update_term = $5,
              sys_update_user = $6, sys_update_time = $7 WHERE template_id = $8`,
                [
                  validation.documentMobileSave,
                  validation.documentLifeTime,
                  validation.useEndTime,
                  validation.isOtherAppOpen,
                  term,
                  userId,
                  now,
                  record.TemplateId,
                ],
              )
            : await db.query(
                `UPDATE mst_irfd_template SET template_name = $1, document_mobile_save = $2,
              document_life_time = $3, use_end_time = $4, is_other_app_open = $5,
              sys_update_term = $6, sys_update_user = $7, sys_update_time = $8 WHERE template_id = $9`,
                [
                  record.TemplateName,
                  validation.documentMobileSave,
                  validation.documentLifeTime,
                  validation.useEndTime,
                  validation.isOtherAppOpen,
                  term,
                  userId,
                  now,
                  record.TemplateId,
                ],
              );
        if (!result.rowCount) return res.status(404).send(pageText['Template not found.']);
      }
      return res.redirect(`${root}/IrfdTemplateList`);
    } catch {
      let canDelete: boolean;
      try {
        canDelete =
          record.TemplateId > 1 && (await hasSystemPermission(db, req.session?.userId ?? '', 'system', 'delete'));
      } catch {
        canDelete = false;
      }
      return showForm(res, record, { error: serverError, canDelete });
    }
  });
}
