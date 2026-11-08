import type { Express, Response } from 'express';
import type pg from 'pg';
import os from 'node:os';
import { licenseCounts, licenseStatus } from '../../../shared/license-counts.js';

const root = '/ConMasManager/System';
const terminalTypes = [
  { value: 'iPad', label: 'Tablet' },
  { value: 'Manager', label: 'Manager' },
  { value: 'Designer', label: 'Designer' },
  { value: 'i-Repo FreeDraw', label: 'i-Repo FreeDraw' },
] as const;
const listPageSizes = [10, 20, 50, 100];
type Mode = 'list' | 'details' | 'create' | 'edit';
type Filters = {
  term_type: string;
  approver: string;
  deleted: boolean;
  pageIndex: number;
  pageSize: number;
  SearchTermId: string;
  SearchPhysicalId: string;
  SearchTermName: string;
  SearchTermRemarks: string;
  SearchAppricantName: string;
  SearchAppricantDateFrom: string;
  SearchAppricantDateTo: string;
  SearchAppricantComment: string;
  SearchApproverName: string;
  SearchApproverDateFrom: string;
  SearchApproverDateTo: string;
  SearchUseBiometrics: string;
  SearchUseScandit: string;
};
type DeviceRecord = Record<string, unknown>;

const value = (source: Record<string, unknown>, key: string): string => {
  const raw = source[key];
  if (Array.isArray(raw)) return String(raw.at(-1) ?? '');
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
};
const truthy = (text: string): boolean => ['1', 'true', 'on', 'yes'].includes(text.toLowerCase());
const boundedInt = (text: string, fallback: number, max = 10000): number => {
  const result = Number(text);
  return Number.isSafeInteger(result) && result >= 0 ? Math.min(result, max) : fallback;
};
const int32Value = (text: string): number | null => {
  if (!/^\d+$/.test(text)) return null;
  const result = Number(text);
  return Number.isInteger(result) && result <= 2147483647 ? result : null;
};
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&');
const dateFilter = (text: string, end = false): string | null => {
  const match = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return yearText + '-' + monthText + '-' + dayText + ' ' + (end ? '23:59:59' : '00:00:00');
};
const inputDate = (text: string): string | null => {
  const match = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const hour = Number(hourText),
    minute = Number(minuteText),
    second = Number(secondText);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  return yearText + '-' + monthText + '-' + dayText + ' ' + hourText + ':' + minuteText + ':' + secondText;
};
const parseFilters = (source: Record<string, unknown>): Filters => ({
  term_type: value(source, 'term_type') || '-1',
  approver: value(source, 'approver') || '-1',
  deleted: truthy(value(source, 'deleted')),
  pageIndex: boundedInt(value(source, 'pageIndex'), 0),
  pageSize: boundedInt(value(source, 'pageSize'), 0, 1000),
  SearchTermId: value(source, 'SearchTermId').slice(0, 12),
  SearchPhysicalId: value(source, 'SearchPhysicalId').slice(0, 200),
  SearchTermName: value(source, 'SearchTermName').slice(0, 200),
  SearchTermRemarks: value(source, 'SearchTermRemarks').slice(0, 200),
  SearchAppricantName: value(source, 'SearchAppricantName').slice(0, 200),
  SearchAppricantDateFrom: value(source, 'SearchAppricantDateFrom').slice(0, 10),
  SearchAppricantDateTo: value(source, 'SearchAppricantDateTo').slice(0, 10),
  SearchAppricantComment: value(source, 'SearchAppricantComment').slice(0, 200),
  SearchApproverName: value(source, 'SearchApproverName').slice(0, 200),
  SearchApproverDateFrom: value(source, 'SearchApproverDateFrom').slice(0, 10),
  SearchApproverDateTo: value(source, 'SearchApproverDateTo').slice(0, 10),
  SearchUseBiometrics: value(source, 'SearchUseBiometrics'),
  SearchUseScandit: value(source, 'SearchUseScandit'),
});

function termTypeLabel(type: unknown): string {
  const typeValue = String(type ?? '');
  return terminalTypes.find((item) => item.value === typeValue)?.label ?? typeValue;
}

export function registerDevices(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
) {
  const loadLicense = () => licenseCounts();
  const display = (res: Response, mode: Mode, data: Record<string, unknown>) =>
    render(res, {
      active: 'System',
      section: 'TermList',
      login: false,
      title:
        mode === 'list'
          ? 'Devices'
          : mode === 'create'
            ? 'Device registration'
            : mode === 'edit'
              ? 'Edit device information'
              : 'Device reference',
      userName: res.locals.userName,
      devicePage: {
        mode,
        termTypes: terminalTypes,
        ...data,
      },
    });

  const configuredPageSize = async (): Promise<number> => {
    const result = await db.query<{ com_value: string }>(
      "SELECT com_value FROM mst_common WHERE com_key = 'DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1",
    );
    const configured = Number(result.rows[0]?.com_value);
    return listPageSizes.includes(configured) ? configured : 20;
  };

  const loadList = async (filters: Filters) => {
    const license = loadLicense();
    const status = licenseStatus();
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    const add = (clause: string, parameter: string | number) => {
      parameters.push(parameter);
      clauses.push(clause.replace('?', '$' + parameters.length));
    };

    if (filters.term_type && filters.term_type !== '-1') add('t.term_type = ?', filters.term_type);
    if (filters.approver === '0') clauses.push("coalesce(t.approver, '') = ''");
    else if (filters.approver === '1') clauses.push("coalesce(t.approver, '') <> ''");
    if (!filters.deleted) clauses.push('t.deleted = 0');

    const terminalId = int32Value(filters.SearchTermId);
    if (terminalId !== null) add('t.term_id = ?', terminalId);
    for (const [field, column] of [
      ['SearchPhysicalId', 't.physical_id'],
      ['SearchTermName', 't.term_name'],
      ['SearchTermRemarks', 't.term_remarks'],
      ['SearchAppricantComment', 't.applicant_comment'],
    ] as const) {
      const search = filters[field];
      if (search) add(column + ' ILIKE ?', '%' + escapeLike(search) + '%');
    }
    for (const [field, column] of [
      ['SearchAppricantName', '(t.applicant ILIKE ? OR t.applicant_name ILIKE ?)'],
      ['SearchApproverName', '(t.approver ILIKE ? OR t.approver_name ILIKE ?)'],
    ] as const) {
      const search = filters[field];
      if (!search) continue;
      parameters.push('%' + escapeLike(search) + '%');
      const first = parameters.length;
      parameters.push('%' + escapeLike(search) + '%');
      const second = parameters.length;
      clauses.push(column.replace('?', '$' + first).replace('?', '$' + second));
    }
    for (const [field, column, end] of [
      ['SearchAppricantDateFrom', 't.applicant_date', false],
      ['SearchAppricantDateTo', 't.applicant_date', true],
      ['SearchApproverDateFrom', 't.approver_date', false],
      ['SearchApproverDateTo', 't.approver_date', true],
    ] as const) {
      const date = dateFilter(filters[field], end);
      if (date) add(column + (end ? ' <= ?::timestamp' : ' >= ?::timestamp'), date);
    }
    if (filters.SearchUseBiometrics === '0' || filters.SearchUseBiometrics === '1') {
      add('coalesce(t.use_biometrics, 0) = ?', Number(filters.SearchUseBiometrics));
    }
    if (filters.SearchUseScandit === '0' || filters.SearchUseScandit === '1') {
      add('coalesce(t.scandit, 0) = ?', Number(filters.SearchUseScandit));
    }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const total = Number(
      (await db.query<{ total: string }>('SELECT count(*) AS total FROM mst_terminal t ' + where, parameters)).rows[0]
        ?.total ?? 0,
    );
    const defaultSize = await configuredPageSize();
    const pageSize = listPageSizes.includes(filters.pageSize) ? filters.pageSize : defaultSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pageIndex = Math.min(filters.pageIndex, totalPages - 1);
    const listParameters = [...parameters, pageSize, pageIndex * pageSize];
    const rows = await db.query<DeviceRecord>(
      'SELECT t.term_id, t.term_type, ' +
        "CASE t.term_type WHEN 'iPad' THEN 'Tablet' WHEN 'Manager' THEN 'Manager' " +
        "WHEN 'Designer' THEN 'Designer' WHEN 'i-Repo FreeDraw' THEN 'i-Repo FreeDraw' ELSE t.term_type END AS term_type_name, " +
        't.physical_id, t.term_name, t.term_remarks, t.applicant, t.applicant_name, ' +
        "to_char(t.applicant_date, 'YYYY/MM/DD HH24:MI') AS applicant_date_display, " +
        't.applicant_comment, t.approver, t.approver_name, ' +
        "to_char(t.approver_date, 'YYYY/MM/DD HH24:MI') AS approver_date_display, " +
        '(t.deleted <> 0) AS deleted, coalesce(t.use_biometrics, 0)::int AS use_biometrics, ' +
        '(coalesce(t.scandit, 0) <> 0) AS use_scandit ' +
        'FROM mst_terminal t ' +
        where +
        ' ORDER BY t.applicant_date DESC, t.term_id DESC LIMIT $' +
        (parameters.length + 1) +
        ' OFFSET $' +
        (parameters.length + 2),
      listParameters,
    );
    const counts = await db.query<{ ipad_count: string; designer_count: string }>(
      "SELECT count(*) FILTER (WHERE term_type = 'iPad') AS ipad_count, " +
        "count(*) FILTER (WHERE term_type = 'Designer') AS designer_count " +
        "FROM mst_terminal WHERE deleted = 0 AND coalesce(approver, '') <> ''",
    );
    const scanditCount =
      license.Scandit > 0
        ? Number(
            (
              await db.query<{ count: string }>(
                'SELECT count(*) AS count FROM mst_terminal WHERE deleted = 0 AND scandit = 1',
              )
            ).rows[0]?.count ?? 0,
          )
        : 0;

    let heading = 'Devices';
    if (license.Type === 0) {
      heading +=
        '  (iPad:' +
        (counts.rows[0]?.ipad_count ?? 0) +
        '/' +
        license.iPad +
        ' Designer:' +
        (counts.rows[0]?.designer_count ?? 0) +
        '/' +
        license.Designer +
        ')';
    } else {
      heading += '  (iPad:' + (counts.rows[0]?.ipad_count ?? 0) + ' Designer:' + (counts.rows[0]?.designer_count ?? 0);
      if (license.Scandit > 0) heading += ' i-Repo Scan:' + scanditCount + '/' + license.Scandit;
      heading += ')';
    }
    return {
      heading,
      filters: { ...filters, pageIndex, pageSize },
      rows: rows.rows.map((row) => ({ ...row, term_type_name: row.term_type_name ?? termTypeLabel(row.term_type) })),
      total,
      totalPages,
      pageIndex,
      pageSize,
      pageSizes: listPageSizes,
      approveVisible: filters.approver === '0',
      scanditEnable: license.Scandit > 0,
      edgeOcrEnable: status.edgeOCR,
      freeDrawOnly: status.freeDrawOnly,
    };
  };

  const showList = async (res: Response, filters: Filters, error = '') => {
    const data = await loadList(filters);
    return display(res, 'list', { ...data, error });
  };

  const loadTerm = async (termId: number): Promise<DeviceRecord | undefined> => {
    const result = await db.query<DeviceRecord>(
      'SELECT t.term_id, t.term_type, ' +
        "CASE t.term_type WHEN 'iPad' THEN 'Tablet' WHEN 'Manager' THEN 'Manager' " +
        "WHEN 'Designer' THEN 'Designer' WHEN 'i-Repo FreeDraw' THEN 'i-Repo FreeDraw' ELSE t.term_type END AS term_type_name, " +
        't.physical_id, t.term_name, t.term_remarks, t.applicant, t.applicant_name, ' +
        "to_char(t.applicant_date, 'YYYY/MM/DD HH24:MI') AS applicant_date_display, " +
        "to_char(t.applicant_date, 'YYYY/MM/DD HH24:MI') AS applicant_date_input, " +
        't.applicant_comment, t.approver, t.approver_name, ' +
        "to_char(t.approver_date, 'YYYY/MM/DD HH24:MI') AS approver_date_display, " +
        '(t.deleted <> 0) AS deleted, coalesce(t.use_biometrics, 0)::int AS use_biometrics, ' +
        '(coalesce(t.scandit, 0) <> 0) AS "UseScandit" ' +
        'FROM mst_terminal t WHERE t.term_id = $1',
      [termId],
    );
    return result.rows[0];
  };

  const showForm = async (res: Response, mode: Exclude<Mode, 'list'>, record: DeviceRecord, error = '') => {
    const license = loadLicense();
    const status = licenseStatus();
    return display(res, mode, {
      record,
      error,
      scanditEnable: license.Scandit > 0,
      isFreeDrawOnly: status.freeDrawOnly,
      isMobileIron: status.mobileIron,
      searchPageSize: mode === 'create' ? await configuredPageSize() : 20,
      termTypes: terminalTypes,
    });
  };

  const selectedIds = (body: Record<string, unknown>): number[] => {
    const hidden = value(body, 'TermCheckIdList');
    const selected = hidden
      ? hidden.split(',')
      : Array.isArray(body.selectedTermIds)
        ? body.selectedTermIds.map(String)
        : [value(body, 'selectedTermIds')];
    return [
      ...new Set(selected.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0 && id <= 2147483647)),
    ];
  };

  const approveTerms = async (ids: number[], userId: string, userName: string) => {
    if (!ids.length) return false;
    const license = loadLicense();
    if (license.Type === 0) {
      const counts = await db.query<{ ipad_count: string; designer_count: string }>(
        "SELECT count(*) FILTER (WHERE term_type = 'iPad') AS ipad_count, " +
          "count(*) FILTER (WHERE term_type = 'Designer') AS designer_count " +
          "FROM mst_terminal WHERE deleted = 0 AND coalesce(approver, '') <> ''",
      );
      const current = await db.query<{ term_id: number; term_type: string }>(
        'SELECT term_id, term_type FROM mst_terminal WHERE term_id = ANY($1::int[])',
        [ids],
      );
      for (const terminal of current.rows) {
        if (terminal.term_type === 'iPad' && Number(counts.rows[0]?.ipad_count ?? 0) >= license.iPad) return false;
        if (terminal.term_type === 'Designer' && Number(counts.rows[0]?.designer_count ?? 0) >= license.Designer)
          return false;
      }
    }
    const user = (await db.query<{ user_name: string }>('SELECT user_name FROM mst_user WHERE user_id = $1', [userId]))
      .rows[0];
    if (!user) return false;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE mst_terminal SET ' +
          'term_name = physical_id, ' +
          "approver = CASE WHEN coalesce(approver, '') = '' THEN $2 ELSE approver END, " +
          "approver_name = CASE WHEN coalesce(approver, '') = '' THEN $3 ELSE approver_name END, " +
          "approver_date = CASE WHEN coalesce(approver, '') = '' THEN now() ELSE approver_date END, " +
          'sys_update_term = $4, sys_update_user = $2, sys_update_time = now() ' +
          'WHERE term_id = ANY($1::int[])',
        [ids, userId, user.user_name || userName, os.hostname()],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  app.get(root + '/TermList', async (req, res) => showList(res, parseFilters(req.query as Record<string, unknown>)));
  app.post(root + '/TermList', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const filters = parseFilters(body);
    const action = value(body, 'ConMasAction');
    const ids = selectedIds(body);
    if (action === 'ApproveAction') {
      if (!ids.length) return showList(res, filters, 'Select at least one device.');
      const approved = await approveTerms(ids, req.session.userId ?? 'conmasadmin', req.session.userName ?? '');
      if (!approved)
        return showList(res, filters, 'Approval could not be completed because a device license limit was reached.');
    } else if (action === 'DeleteAction') {
      if (!ids.length) return showList(res, filters, 'Select at least one device.');
      await db.query('UPDATE mst_terminal SET deleted = 1 WHERE term_id = ANY($1::int[])', [ids]);
      filters.pageIndex = 0;
    }
    return showList(res, filters);
  });

  app.get(root + '/DetailsTerm', async (req, res) => {
    const termId = int32Value(value(req.query as Record<string, unknown>, 'id')) ?? 0;
    if (!termId) return res.status(400).send('A device ID is required.');
    const record = await loadTerm(termId);
    if (!record) return res.status(404).send('Device not found.');
    return showForm(res, 'details', record);
  });
  app.post(root + '/DetailsTerm', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const termId = int32Value(value(body, 'mst_terminal.term_id')) ?? 0;
    const record = await loadTerm(termId);
    if (!record) return res.status(404).send('Device not found.');
    if (value(body, 'act') === 'delete') {
      await db.query('UPDATE mst_terminal SET deleted = 1 WHERE term_id = $1', [termId]);
      return res.redirect(root + '/TermList');
    }
    return showForm(res, 'details', record);
  });

  app.get(root + '/CreateTerm', async (_req, res) =>
    showForm(res, 'create', {
      term_id: '',
      term_type: 'iPad',
      term_type_name: 'Tablet',
      physical_id: '',
      term_name: '',
      term_remarks: '',
      applicant: '',
      applicant_name: '',
      applicant_date_input: '',
      applicant_date_display: '',
      applicant_comment: '',
      approver: '',
      approver_name: '',
      approver_date_display: '',
      deleted: false,
      use_biometrics: 0,
      UseScandit: false,
    }),
  );
  app.post(root + '/CreateTerm', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const record: DeviceRecord = {
      term_type: value(body, 'mst_terminal.term_type'),
      term_name: value(body, 'mst_terminal.term_name'),
      physical_id: value(body, 'mst_terminal.physical_id'),
      term_remarks: value(body, 'mst_terminal.term_remarks'),
      applicant: value(body, 'mst_terminal.applicant'),
      applicant_name: value(body, 'mst_terminal.applicant_name'),
      applicant_date_input: value(body, 'mst_terminal.applicant_date'),
      applicant_date_display: '',
      applicant_comment: value(body, 'mst_terminal.applicant_comment'),
      UseScandit: truthy(value(body, 'mst_terminal.UseScandit')),
      deleted: truthy(value(body, 'mst_terminal.deleted')),
      use_biometrics: 0,
    };
    const applicant = value(record, 'applicant');
    const applicantName = value(record, 'applicant_name');
    const validDate = inputDate(value(record, 'applicant_date_input'));
    let error = '';
    if (!terminalTypes.some((item) => item.value === value(record, 'term_type'))) error = 'Select a device type.';
    else if (!value(record, 'physical_id').trim()) error = 'Physical ID is required.';
    else if (!value(record, 'term_name').trim()) error = 'Device name is required.';
    else if (!applicant.trim() || !applicantName.trim()) error = 'Applicant ID and name are required.';
    else if (!validDate) error = 'Enter a valid application date.';
    const applicantRow = applicant
      ? (await db.query<{ user_name: string }>('SELECT user_name FROM mst_user WHERE user_id = $1', [applicant]))
          .rows[0]
      : undefined;
    if (!error && !applicantRow) error = 'Select an existing applicant.';
    if (error) return showForm(res.status(400), 'create', record, error);

    const userId = req.session.userId ?? 'conmasadmin';
    const client = await db.connect();
    let termId: number;
    try {
      await client.query('BEGIN');
      const userName =
        (await client.query<{ user_name: string }>('SELECT user_name FROM mst_user WHERE user_id = $1', [userId]))
          .rows[0]?.user_name ??
        req.session.userName ??
        '';
      const approved = truthy(value(body, 'approver'));
      const inserted = await client.query<{ term_id: number }>(
        'INSERT INTO mst_terminal ' +
          '(term_type, physical_id, term_name, term_remarks, applicant, applicant_name, applicant_date, applicant_comment, ' +
          'approver, approver_name, approver_date, deleted, sys_regist_term, sys_regist_user, sys_regist_time, ' +
          'sys_update_term, sys_update_user, sys_update_time) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7::timestamp,$8, CASE WHEN $9 THEN $10 ELSE NULL END, ' +
          'CASE WHEN $9 THEN $11 ELSE NULL END, CASE WHEN $9 THEN now() ELSE NULL END, 0, $12,$10,now(),$12,$10,now()) ' +
          'RETURNING term_id',
        [
          value(record, 'term_type'),
          value(record, 'physical_id'),
          value(record, 'term_name'),
          value(record, 'term_remarks'),
          applicant,
          applicantName,
          validDate,
          value(record, 'applicant_comment'),
          approved,
          userId,
          userName,
          os.hostname(),
        ],
      );
      termId = Number(inserted.rows[0]?.term_id);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      return showForm(res.status(400), 'create', record, 'The device could not be created.');
    } finally {
      client.release();
    }
    return res.redirect(root + '/DetailsTerm?id=' + termId);
  });

  app.get(root + '/EditTerm', async (req, res) => {
    const termId = int32Value(value(req.query as Record<string, unknown>, 'id')) ?? 0;
    if (!termId) return res.status(400).send('A device ID is required.');
    const record = await loadTerm(termId);
    if (!record) return res.status(404).send('Device not found.');
    return showForm(res, 'edit', record);
  });
  app.post(root + '/EditTerm', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const termId = int32Value(value(body, 'mst_terminal.term_id')) ?? 0;
    const existing = await loadTerm(termId);
    if (!existing) return res.status(404).send('Device not found.');
    const record: DeviceRecord = {
      ...existing,
      term_name: value(body, 'mst_terminal.term_name'),
      term_remarks: value(body, 'mst_terminal.term_remarks'),
      UseScandit: truthy(value(body, 'mst_terminal.UseScandit')),
    };
    if (!value(record, 'term_name').trim())
      return showForm(res.status(400), 'edit', record, 'Device name is required.');

    const license = loadLicense();
    const approve = truthy(value(body, 'approver'));
    if (approve && license.Type === 0) {
      const used = Number(
        (
          await db.query<{ count: string }>(
            "SELECT count(*) AS count FROM mst_terminal WHERE deleted = 0 AND coalesce(approver, '') <> '' AND term_type = $1",
            [existing.term_type],
          )
        ).rows[0]?.count ?? 0,
      );
      const limit =
        existing.term_type === 'iPad'
          ? license.iPad
          : existing.term_type === 'Designer'
            ? license.Designer
            : Number.MAX_SAFE_INTEGER;
      if (used >= limit)
        return showForm(
          res.status(400),
          'edit',
          record,
          'Approval could not be completed because a device license limit was reached.',
        );
    }
    if (truthy(value(record, 'UseScandit')) && license.Scandit > 0) {
      const used = Number(
        (
          await db.query<{ count: string }>(
            'SELECT count(*) AS count FROM mst_terminal WHERE deleted = 0 AND scandit = 1 AND term_id <> $1',
            [termId],
          )
        ).rows[0]?.count ?? 0,
      );
      if (used >= license.Scandit)
        return showForm(
          res.status(400),
          'edit',
          record,
          'The Scandit license limit (' + license.Scandit + ') has been reached.',
        );
    }
    const userId = req.session.userId ?? 'conmasadmin';
    const userName =
      (await db.query<{ user_name: string }>('SELECT user_name FROM mst_user WHERE user_id = $1', [userId])).rows[0]
        ?.user_name ??
      req.session.userName ??
      '';
    await db.query(
      'UPDATE mst_terminal SET ' +
        'term_name = $2, term_remarks = $3, ' +
        "approver = CASE WHEN $4 AND coalesce(approver, '') = '' THEN $5 ELSE approver END, " +
        "approver_name = CASE WHEN $4 AND coalesce(approver, '') = '' THEN $6 ELSE approver_name END, " +
        "approver_date = CASE WHEN $4 AND coalesce(approver, '') = '' THEN now() ELSE approver_date END, " +
        'sys_update_term = $7, sys_update_user = $5, sys_update_time = now(), scandit = $8 ' +
        'WHERE term_id = $1',
      [
        termId,
        value(record, 'term_name'),
        value(record, 'term_remarks'),
        approve,
        userId,
        userName,
        os.hostname(),
        truthy(value(record, 'UseScandit')) ? 1 : 0,
      ],
    );
    return res.redirect(root + '/DetailsTerm?id=' + termId);
  });

  const searchUsers = async (source: Record<string, unknown>) => {
    const searchId = value(source, 'searchId').slice(0, 100);
    const searchName = value(source, 'searchName').slice(0, 100);
    const requestedPageSize = boundedInt(value(source, 'pageSize'), 0, 1000);
    const pageSize = listPageSizes.includes(requestedPageSize) ? requestedPageSize : await configuredPageSize();
    const pageIndex = boundedInt(value(source, 'pageIndex'), 0);
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (searchId.trim()) {
      parameters.push(escapeLike(searchId) + '%');
      clauses.push('user_id LIKE $' + parameters.length);
    }
    if (searchName.trim()) {
      parameters.push(escapeLike(searchName) + '%');
      clauses.push('user_name LIKE $' + parameters.length);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const total = Number(
      (await db.query<{ total: string }>('SELECT count(*) AS total FROM mst_user ' + where, parameters)).rows[0]
        ?.total ?? 0,
    );
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(pageIndex, totalPages - 1);
    const rows = await db.query<{ user_id: string; user_name: string }>(
      'SELECT user_id, user_name FROM mst_user ' +
        where +
        ' LIMIT $' +
        (parameters.length + 1) +
        ' OFFSET $' +
        (parameters.length + 2),
      [...parameters, pageSize, currentPage * pageSize],
    );
    return { searchId, searchName, pageIndex: currentPage, pageSize, total, totalPages, rows: rows.rows };
  };
  app.get(root + '/SearchUser', async (req, res) => res.json(await searchUsers(req.query as Record<string, unknown>)));
  app.post(root + '/SearchUser', async (req, res) => res.json(await searchUsers(req.body as Record<string, unknown>)));
  app.get(root + '/SearchUserDirect', async (req, res) => {
    const id = value(req.query as Record<string, unknown>, 'id');
    if (!id) return res.json('');
    const exact = await db.query<{ user_id: string; user_name: string }>(
      'SELECT user_id, user_name FROM mst_user WHERE user_id = $1',
      [id],
    );
    const user = exact.rows[0];
    return res.json(user ? user.user_id + ',' + user.user_name : '');
  });
}
