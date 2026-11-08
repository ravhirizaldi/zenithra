import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';
import { licenseStatus } from '../../../shared/license-counts.js';

type LockType = 'def' | 'rep';
type LockFilters = {
  defRepType: LockType;
  lockDateFrom: string;
  lockDateTo: string;
  lockUser: string;
  reportName: string;
  reportPublicStatus: string;
};
type LockPage = {
  rows: LockRow[];
  total: number;
  totalPages: number;
};
type LockRow = {
  report_id: number;
  report_name: string;
  report_rev_no: string;
  report_public_status: string;
  lock_date: string;
  lock_user: string;
  lock_user_name: string;
  lock_term: string;
  is_report_current: boolean;
};
type LockQuery = { from: string; where: string; values: unknown[] };
type Render = (res: Response, data: Record<string, unknown>) => unknown;

const root = '/ConMasManager/System';
const fallbackPageSizes = [10, 20, 50, 100];
const pageIndexDefaultSort = 'lok.sys_regist_time';
const statusLabels: Record<string, string> = { '0': 'Non-disclosure', '1': 'Test', '2': 'Published' };
const publicStatusOptions = [
  { value: '-1', text: '- Disclosure Status -' },
  { value: '0', text: 'Non-disclosure' },
  { value: '1', text: 'Test' },
  { value: '2', text: 'Published' },
];
const lockSortExpressions: Record<LockType, Record<string, string>> = {
  def: {
    'lok.sys_regist_time': 'lok.sys_regist_time',
    'top.{0}_top_id': 'top.def_top_id',
    'top.{0}_top_name': 'top.def_top_name',
    'lok.user_id': 'lok.user_id',
    'usr.user_name': 'usr.user_name',
    'trm.term_name': 'trm.term_name',
  },
  rep: {
    'lok.sys_regist_time': 'lok.sys_regist_time',
    'top.{0}_top_id': 'top.rep_top_id',
    'top.{0}_top_name': 'top.rep_top_name',
    'lok.user_id': 'lok.user_id',
    'usr.user_name': 'usr.user_name',
    'trm.term_name': 'trm.term_name',
  },
};

class InvalidLockInput extends Error {}
class LockConfigurationError extends Error {}

function lockType(value: string): LockType {
  if (value === 'def' || value === 'rep') return value;
  throw new InvalidLockInput('Invalid lock target.');
}

function lockDate(value: string): string {
  const dateText = value.trim();
  if (!dateText) return '';
  const yearFirst = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(dateText);
  const monthFirst = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateText);
  const year = Number(yearFirst?.[1] ?? monthFirst?.[3]);
  const month = Number(yearFirst?.[2] ?? monthFirst?.[1]);
  const day = Number(yearFirst?.[3] ?? monthFirst?.[2]);
  if (!yearFirst && !monthFirst) throw new InvalidLockInput('Enter a valid lock date.');
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new InvalidLockInput('Enter a valid lock date.');
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function buildLockQuery(filters: LockFilters, userId: string): LockQuery {
  const type = lockType(filters.defRepType);
  const values: unknown[] = [userId];
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const clauses = [
    `EXISTS (
    SELECT 1 FROM ${type}_role rl
    WHERE rl.group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id = $1)
      AND rl.role_${type}_read > 0
      AND top.${type}_top_id = rl.${type}_top_id
  )`,
  ];
  const fromDate = lockDate(filters.lockDateFrom);
  const toDate = lockDate(filters.lockDateTo);
  if (fromDate) clauses.push(`lok.sys_regist_time >= ${add(fromDate)}::date`);
  if (toDate) clauses.push(`lok.sys_regist_time <= ${add(toDate)}::date + time '23:59:59'`);
  const lockUser = filters.lockUser.trim();
  if (lockUser) {
    const value = add(`%${lockUser}%`);
    clauses.push(`(usr.user_id LIKE ${value} OR usr.user_name LIKE ${value})`);
  }
  const reportName = filters.reportName.trim();
  if (reportName) clauses.push(`top.${type}_top_name LIKE ${add(`%${reportName}%`)}`);
  if (filters.reportPublicStatus && filters.reportPublicStatus !== '-1') {
    clauses.push(`top.public_status = ${add(filters.reportPublicStatus)}`);
  }
  return {
    from: `FROM ${type}_top top INNER JOIN ${type}_lock lok ON top.${type}_top_id = lok.${type}_top_id
      LEFT JOIN ${type}_current cur ON top.${type}_top_id = cur.${type}_top_id
      LEFT JOIN mst_user usr ON lok.user_id = usr.user_id
      LEFT JOIN mst_terminal trm ON lok.sys_regist_term = TEXT(trm.term_id)`,
    where: `WHERE ${clauses.join(' AND ')}`,
    values,
  };
}

export function buildUnlockQuery(typeValue: string, reportIds: number[]): { text: string; values: number[][] } {
  const type = lockType(typeValue);
  if (!reportIds.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647)) {
    throw new InvalidLockInput('Invalid report ID.');
  }
  return { text: `DELETE FROM ${type}_lock WHERE ${type}_top_id = ANY($1::integer[])`, values: [reportIds] };
}

function stringValue(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : '';
  }
  return '';
}

function parseFilters(values: Record<string, unknown>, defaultPublicStatus: string): LockFilters {
  const rawType = stringValue(values, 'SerachLockReport.DefRepType');
  return {
    defRepType: rawType ? lockType(rawType) : 'def',
    lockDateFrom: stringValue(values, 'SerachLockReport.LockDateFrom'),
    lockDateTo: stringValue(values, 'SerachLockReport.LockDateTo'),
    lockUser: stringValue(values, 'SerachLockReport.LockUser'),
    reportName: stringValue(values, 'SerachLockReport.ReportName'),
    reportPublicStatus: stringValue(values, 'SerachLockReport.ReportPublicStatus') || defaultPublicStatus,
  };
}

function pageNumber(value: string, fallback: number): number {
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(parsed, 10_000) : fallback;
}

async function pageSettings(db: pg.Pool) {
  const result = await db.query<{ com_key: string; com_value: string }>(
    "SELECT com_key,com_value FROM mst_common WHERE com_key IN ('PAGE_SIZE','DEFAULT_PAGE_SIZE','DEFAULT_PUBLIC_STATUS') ORDER BY com_key,com_index",
  );
  const configuredSizes = result.rows
    .filter((row) => row.com_key === 'PAGE_SIZE')
    .map((row) => Number(row.com_value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const pageSizes = configuredSizes.length ? configuredSizes : fallbackPageSizes;
  const configuredDefault = result.rows.find((row) => row.com_key === 'DEFAULT_PAGE_SIZE')?.com_value;
  const defaultPageSizeValue = Number(configuredDefault ?? 20);
  const defaultPageSize = pageSizes.includes(defaultPageSizeValue)
    ? defaultPageSizeValue
    : pageSizes.includes(20)
      ? 20
      : pageSizes[0];
  const defaultPublicStatus = result.rows.find((row) => row.com_key === 'DEFAULT_PUBLIC_STATUS')?.com_value;
  if (defaultPublicStatus === undefined) throw new LockConfigurationError('DEFAULT_PUBLIC_STATUS is not configured.');
  return { pageSizes, defaultPageSize, defaultPublicStatus };
}

async function loadLockPage(
  db: pg.Pool,
  userId: string,
  filters: LockFilters,
  pageIndex: number,
  pageSize: number,
  sortColumn: string,
  sortDirection: 'ASC' | 'DESC',
): Promise<LockPage> {
  const query = buildLockQuery(filters, userId);
  const total = Number(
    (await db.query<{ total: string }>(`SELECT count(1) AS total ${query.from} ${query.where}`, query.values)).rows[0]
      ?.total ?? 0,
  );
  const sortExpression = lockSortExpressions[filters.defRepType][sortColumn];
  const offset = pageIndex * pageSize;
  const rows = await db.query<{
    report_id: number;
    report_name: string;
    rev_no: string;
    public_status: string;
    lock_date: string | null;
    lock_user: string;
    lock_user_name: string | null;
    lock_term: string | null;
    current_id: number | null;
  }>(
    `SELECT top.${filters.defRepType}_top_id AS report_id,
      top.${filters.defRepType}_top_name AS report_name, top.rev_no, top.public_status,
      to_char(lok.sys_regist_time, 'FMMM/FMDD/YYYY FMHH12:MI:SS AM') AS lock_date,
      lok.user_id AS lock_user, usr.user_name AS lock_user_name, trm.term_name AS lock_term,
      cur.${filters.defRepType}_top_id AS current_id
      ${query.from} ${query.where}
      ORDER BY ${sortExpression} ${sortDirection}, top.${filters.defRepType}_top_id
      OFFSET $${query.values.length + 1} LIMIT $${query.values.length + 2}`,
    [...query.values, offset, pageSize],
  );
  return {
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.rows.map((row) => {
      const status = String(row.public_status ?? '');
      return {
        report_id: row.report_id,
        report_name: row.report_name ?? '',
        report_rev_no: String(row.rev_no ?? ''),
        report_public_status: statusLabels[status] ?? status,
        lock_date: row.lock_date ?? '',
        lock_user: row.lock_user ?? '',
        lock_user_name: row.lock_user_name ?? '',
        lock_term: row.lock_term ?? '',
        is_report_current: row.current_id !== null && row.current_id !== undefined && String(row.current_id) !== '',
      };
    }),
  };
}

async function loadMatchingLockIds(db: pg.Pool, userId: string, filters: LockFilters): Promise<number[]> {
  const query = buildLockQuery(filters, userId);
  const result = await db.query<{ report_id: number }>(
    `SELECT top.${filters.defRepType}_top_id AS report_id ${query.from} ${query.where}`,
    query.values,
  );
  return result.rows
    .map((row) => Number(row.report_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647);
}

function selectedLockIds(values: Record<string, unknown>): number[] {
  const ids: number[] = [];
  for (const key of Object.keys(values)) {
    const match = /^ListLockReport\[(\d+)\]\.IsSelect$/.exec(key);
    if (!match || !['true', '1', 'on'].includes(stringValue(values, key))) continue;
    const idText = stringValue(values, `ListLockReport[${match[1]}].ReportId`);
    const id = Number(idText);
    if (/^\d+$/.test(idText) && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647) ids.push(id);
  }
  return [...new Set(ids)];
}

async function releaseLocks(db: pg.Pool, type: LockType, reportIds: number[]): Promise<void> {
  if (!reportIds.length) return;
  const statement = buildUnlockQuery(type, reportIds);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(statement.text, statement.values);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the original database error. */
    }
    throw error;
  } finally {
    client.release();
  }
}

export function registerSystemLocks(app: Express, db: pg.Pool, render: Render): void {
  const show = (res: Response, systemLocksPage: Record<string, unknown>) =>
    render(res, {
      active: 'System',
      section: 'LockManagement',
      login: false,
      title: 'Batch unlock',
      userName: res.locals.userName,
      systemLocksPage,
    });
  const handler = async (req: Request, res: Response) => {
    try {
      if (licenseStatus().freeDrawOnly) return show(res, { canRead: false, error: '' });
      const userId = req.session.userId ?? '';
      if (!(await hasSystemPermission(db, userId, 'data', 'read'))) {
        return show(res, { canRead: false, error: '' });
      }
      const values = (req.method === 'POST' ? req.body : req.query) as Record<string, unknown>;
      const settings = await pageSettings(db);
      const filters = parseFilters(values, settings.defaultPublicStatus);
      const pageIndex = pageNumber(stringValue(values, 'PageInfo.PageIndex'), 0);
      const rawPageSize = Number(stringValue(values, 'PageInfo.PageSize'));
      const pageSize = settings.pageSizes.includes(rawPageSize) ? rawPageSize : settings.defaultPageSize;
      const sortColumns = lockSortExpressions[filters.defRepType];
      const requestedSort = stringValue(values, 'PageInfo.SortColumn').toLowerCase();
      const sortColumn = Object.hasOwn(sortColumns, requestedSort) ? requestedSort : pageIndexDefaultSort;
      const requestedDirection = stringValue(values, 'PageInfo.SortDirection').toUpperCase();
      const sortDirection = requestedDirection === 'DESC' ? 'DESC' : 'ASC';
      const canEdit = await hasSystemPermission(db, userId, 'data', 'edit');
      const action = req.method === 'POST' ? stringValue(values, 'LockManagementAction') : '';
      if (action === '1' || action === '2') {
        if (!canEdit) return res.status(403).type('text/plain').send('Role authority is insufficient.');
        let ids: number[];
        if (action === '1') {
          const currentPage = await loadLockPage(db, userId, filters, pageIndex, pageSize, sortColumn, sortDirection);
          const visibleIds = new Set(currentPage.rows.map((row) => row.report_id));
          ids = selectedLockIds(values).filter((id) => visibleIds.has(id));
        } else {
          ids = await loadMatchingLockIds(db, userId, filters);
        }
        await releaseLocks(db, filters.defRepType, ids);
      }
      const page = await loadLockPage(db, userId, filters, pageIndex, pageSize, sortColumn, sortDirection);
      return show(res, {
        canRead: true,
        canEdit,
        filters,
        rows: page.rows,
        total: page.total,
        pageIndex,
        pageSize,
        pageSizes: settings.pageSizes,
        totalPages: page.totalPages,
        sortColumn,
        sortDirection,
        publicStatusOptions,
        error: '',
      });
    } catch (error) {
      if (error instanceof InvalidLockInput) return res.status(400).type('text/plain').send(error.message);
      if (error instanceof LockConfigurationError) return res.status(503).type('text/plain').send(error.message);
      return res.status(500).type('text/plain').send('Server error.');
    }
  };
  app.get(`${root}/LockManagement`, handler);
  app.post(`${root}/LockManagement`, handler);
}
