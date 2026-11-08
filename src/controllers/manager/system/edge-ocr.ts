import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { edgeOcrLicense, licenseStatus } from '../../../shared/license-counts.js';
import { edgeOcrLabels as labels } from '../../../config/manager/system/legacy-edge-ocr-labels.js';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

type Render = (res: Response, data: Record<string, unknown>) => unknown;
export type EdgeCredential = {
  edgeocr_token_id: string;
  edgeocr_certificate: string;
  terminals: Array<{ terminal_id: string; physical_id: string }>;
};
type License = ReturnType<typeof edgeOcrLicense>;
declare module 'express-session' {
  interface SessionData {
    edgeOcrSelected?: number[];
    edgeOcrFilters?: Record<string, string>;
  }
}
const root = '/ConMasManager/System';
export function updateEdgeSelection(previous: number[], value: string): number[] {
  const selected = new Set(previous);
  for (const item of value.split(',')) {
    const match = /^([+-]?\d+):(.*)$/.exec(item);
    if (!match) continue;
    const id = Number(match[1]);
    if (!Number.isInteger(id) || id < -2147483648 || id > 2147483647) throw new Error('Invalid terminal ID.');
    selected.delete(id);
    if (match[2].toUpperCase() === 'TRUE') selected.add(id);
  }
  return [...selected];
}
export function validateEdgeCredential(
  value: unknown,
  license: License,
  eligible: Map<number, string>,
): EdgeCredential | null {
  if (!value || typeof value !== 'object') return null;
  const model = value as Partial<EdgeCredential>;
  if (
    typeof model.edgeocr_token_id !== 'string' ||
    !model.edgeocr_token_id ||
    model.edgeocr_token_id !== license.token ||
    typeof model.edgeocr_certificate !== 'string' ||
    !model.edgeocr_certificate ||
    !Array.isArray(model.terminals) ||
    !model.terminals.length ||
    license.limit === null ||
    model.terminals.length > license.limit
  )
    return null;
  const terminals: EdgeCredential['terminals'] = [];
  for (const terminal of model.terminals) {
    if (
      !terminal ||
      typeof terminal.terminal_id !== 'string' ||
      !/^[+-]?\d+$/.test(terminal.terminal_id.trim()) ||
      Number(terminal.terminal_id) < -2147483648 ||
      Number(terminal.terminal_id) > 2147483647 ||
      typeof terminal.physical_id !== 'string' ||
      !terminal.physical_id ||
      !eligible.has(Number(terminal.terminal_id))
    )
      return null;
    terminals.push({ terminal_id: terminal.terminal_id, physical_id: eligible.get(Number(terminal.terminal_id))! });
  }
  return { edgeocr_token_id: model.edgeocr_token_id, edgeocr_certificate: model.edgeocr_certificate, terminals };
}
export async function saveEdgeCredential(db: pg.Pool, model: EdgeCredential, actor: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO edgeocr_info (edgeocr_info_id,edgeocr_certificate,sys_regist_user,sys_regist_time) VALUES (1,$1,$2,CURRENT_TIMESTAMP) ON CONFLICT (edgeocr_info_id) DO UPDATE SET edgeocr_certificate=EXCLUDED.edgeocr_certificate,sys_regist_user=EXCLUDED.sys_regist_user,sys_regist_time=EXCLUDED.sys_regist_time',
      [model.edgeocr_certificate, actor],
    );
    await client.query('DELETE FROM edgeocr_use_terminals');
    for (const terminal of model.terminals)
      await client.query(
        'INSERT INTO edgeocr_use_terminals (term_id,physical_id,sys_regist_user,sys_regist_time) VALUES ($1,$2,$3,CURRENT_TIMESTAMP)',
        [Number(terminal.terminal_id), terminal.physical_id, actor],
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export function registerEdgeOcr(app: Express, db: pg.Pool, render: Render): void {
  const show = (res: Response, page: Record<string, unknown>) =>
    render(res, {
      active: 'System',
      section: 'EdgeOCRCredentialSetting',
      login: false,
      title: labels.EdgeOCRLinkageSetting,
      userName: res.locals.userName,
      edgeOcrPage: { labels, ...page },
    });
  const gate = async (req: Request, res: Response, action: 'read' | 'edit', filter = true) => {
    try {
      if (
        (filter && licenseStatus().freeDrawOnly) ||
        !(await hasSystemPermission(db, req.session?.userId ?? '', 'terminal', action))
      ) {
        show(res.status(403), { mode: 'denied' });
        return false;
      }
      return true;
    } catch {
      show(res.status(503), { mode: 'error', errors: [labels.serverError] });
      return false;
    }
  };
  const saveSelection = (req: Request, source: Record<string, unknown>) => {
    req.session.edgeOcrSelected = updateEdgeSelection(
      req.session.edgeOcrSelected ?? [],
      typeof source.ChkStatusTermIdList === 'string' ? source.ChkStatusTermIdList : '',
    );
  };
  const selectedRows = async (ids: number[]) =>
    (
      await db.query(
        'SELECT t.*, EXISTS(SELECT 1 FROM edgeocr_use_terminals e WHERE e.term_id=t.term_id) AS use_edgeocr FROM mst_terminal t WHERE t.term_id=ANY($1::int[])',
        [ids],
      )
    ).rows;
  const page = async (req: Request, res: Response, source: Record<string, unknown>, errors: string[] = []) => {
    const license = edgeOcrLicense();
    if (!license.enabled) errors.unshift(labels.EdgeOCRErrorMessageNoLicense);
    const settings = (
      await db.query('SELECT com_key,com_value FROM mst_common WHERE com_key=ANY($1::text[]) ORDER BY com_index', [
        ['PAGE_SIZE', 'DEFAULT_PAGE_SIZE'],
      ])
    ).rows;
    const sizes = settings
      .filter((r) => r.com_key === 'PAGE_SIZE')
      .map((r) => Number(r.com_value))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!sizes.length) sizes.push(10, 20, 50, 100);
    const defaultSize = Number(settings.find((r) => r.com_key === 'DEFAULT_PAGE_SIZE')?.com_value) || 20;
    const pageSize = sizes.includes(Number(source.pageSize)) ? Number(source.pageSize) : defaultSize;
    const filters: Record<string, string> = {};
    for (const key of [
      'SearchTermId',
      'SearchPhysicalId',
      'SearchTermName',
      'SearchTermRemarks',
      'SearchAppricantName',
      'SearchAppricantComment',
      'SearchUseEdgeOCR',
    ])
      filters[key] = typeof source[key] === 'string' ? source[key] : '';
    const values: unknown[] = [];
    const clauses = ["t.term_type='iPad'", 't.approver IS NOT NULL', 't.deleted=0'];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replaceAll('?', '$' + values.length));
    };
    if (filters.SearchTermId && /^\d+$/.test(filters.SearchTermId) && Number(filters.SearchTermId) <= 2147483647)
      add('t.term_id=?', Number(filters.SearchTermId));
    for (const [key, column] of [
      ['SearchPhysicalId', 'physical_id'],
      ['SearchTermName', 'term_name'],
      ['SearchTermRemarks', 'term_remarks'],
      ['SearchAppricantComment', 'applicant_comment'],
    ])
      if (filters[key]) add('t.' + column + ' ILIKE ?', '%' + filters[key] + '%');
    if (filters.SearchAppricantName)
      add('(t.applicant ILIKE ? OR t.applicant_name ILIKE ?)', '%' + filters.SearchAppricantName + '%');
    if (['0', '1'].includes(filters.SearchUseEdgeOCR))
      clauses.push(
        (filters.SearchUseEdgeOCR === '0' ? 'NOT ' : '') +
          'EXISTS(SELECT 1 FROM edgeocr_use_terminals e WHERE e.term_id=t.term_id)',
      );
    const where = clauses.join(' AND '),
      total = Number((await db.query('SELECT count(*) FROM mst_terminal t WHERE ' + where, values)).rows[0].count);
    const pages = Math.max(1, Math.ceil(total / pageSize)),
      index = Math.min(
        pages - 1,
        Math.max(0, Number.isInteger(Number(source.pageIndex)) ? Number(source.pageIndex) : 0),
      );
    const rows = (
      await db.query(
        'SELECT t.*, EXISTS(SELECT 1 FROM edgeocr_use_terminals e WHERE e.term_id=t.term_id) AS use_edgeocr FROM mst_terminal t WHERE ' +
          where +
          ' ORDER BY t.applicant_date DESC, t.term_id DESC LIMIT $' +
          (values.length + 1) +
          ' OFFSET $' +
          (values.length + 2),
        [...values, pageSize, index * pageSize],
      )
    ).rows;
    const used = Number((await db.query('SELECT count(*) FROM edgeocr_use_terminals')).rows[0].count);
    const info = license.enabled
      ? (
          await db.query(
            "SELECT sys_regist_user,to_char(sys_regist_time,'YYYY/MM/DD') AS uploaded_at FROM edgeocr_info WHERE edgeocr_info_id=1",
          )
        ).rows[0]
      : undefined;
    req.session.edgeOcrFilters = { ...filters, pageSize: String(pageSize), pageIndex: String(index) };
    return show(res, {
      mode: 'list',
      errors,
      license: {
        enabled: license.enabled,
        limit: license.limit,
        expires: license.expires,
        token: license.token.length > 7 ? license.token.slice(0, 7) + '...' : license.token,
      },
      info,
      used,
      rows,
      selected: req.session.edgeOcrSelected ?? [],
      filters,
      pageSize,
      sizes,
      index,
      pages,
      total,
    });
  };
  app.get(`${root}/EdgeOCRCredentialSetting`, async (req, res) => {
    if (!(await gate(req, res, 'read'))) return;
    try {
      const back = String(req.query.act ?? '').toUpperCase() === 'BACK' || Boolean(req.query.errorAct);
      if (!back) {
        req.session.edgeOcrFilters = undefined;
        req.session.edgeOcrSelected = (
          await db.query(
            "SELECT t.term_id FROM mst_terminal t JOIN edgeocr_use_terminals e ON e.term_id=t.term_id WHERE t.term_type='iPad' AND t.approver IS NOT NULL AND t.deleted=0",
          )
        ).rows.map((r) => Number(r.term_id));
      }
      const errors =
        req.query.errorAct === 'OVER_LIMIT'
          ? [labels.EdgeOCRErrorMessageOverLimitOfTerminals]
          : req.query.errorAct === 'NONE_SELECT'
            ? [labels.EdgeOCRErrorMessageNoTerminalSelected]
            : [];
      return page(req, res, back ? (req.session.edgeOcrFilters ?? {}) : req.query, errors);
    } catch {
      return show(res.status(500), { mode: 'error', errors: [labels.serverError] });
    }
  });
  app.post(`${root}/EdgeOCRCredentialSetting`, async (req, res) => {
    const act = String(req.body?.act ?? '').toUpperCase();
    if (!(await gate(req, res, 'read')) || (act === 'IMPORT' && !(await gate(req, res, 'edit')))) return;
    if (!edgeOcrLicense().enabled) return res.redirect(root + '/EdgeOCRCredentialSetting');
    try {
      if (['SEARCH', 'PAGE', 'FILTER', 'IMPORT', 'EXPORT'].includes(act)) saveSelection(req, req.body);
      else req.session.edgeOcrSelected = [];
      if (act === 'EXPORT') {
        req.session.edgeOcrFilters = { ...req.session.edgeOcrFilters, ...req.body };
        return res.redirect(root + '/ConfirmEdgeOCRCredentialSetting');
      }
      const errors: string[] = [];
      if (act === 'IMPORT') {
        if (!req.file) errors.push(labels.DataInputNoFileMessage);
        else {
          let model: unknown;
          try {
            model = JSON.parse(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''));
          } catch {
            errors.push(labels.EdgeOCRErrorMessageInvalidFileFormat);
          }
          if (!errors.length) {
            const eligible = (
              await db.query(
                "SELECT term_id,physical_id FROM mst_terminal WHERE term_type='iPad' AND approver IS NOT NULL AND deleted=0",
              )
            ).rows;
            const validated = validateEdgeCredential(
              model,
              edgeOcrLicense(),
              new Map(eligible.map((r) => [Number(r.term_id), String(r.physical_id ?? '')])),
            );
            if (!validated) errors.push(labels.EdgeOCRErrorMessageInvalidLicenseInfomation);
            else await saveEdgeCredential(db, validated, req.session.userId ?? '');
          }
        }
      }
      return page(req, res, req.body, errors);
    } catch {
      return show(res.status(500), { mode: 'error', errors: [labels.serverError] });
    }
  });
  app.get(`${root}/ConfirmEdgeOCRCredentialSetting`, async (req, res) => {
    if (!(await gate(req, res, 'edit', false))) return;
    const license = edgeOcrLicense();
    if (!license.enabled) return res.redirect(root + '/EdgeOCRCredentialSetting');
    try {
      saveSelection(req, req.query);
      const ids = req.session.edgeOcrSelected ?? [];
      const error = ids.length > (license.limit ?? 0) ? 'OVER_LIMIT' : !ids.length ? 'NONE_SELECT' : '';
      if (error) return res.redirect(root + '/EdgeOCRCredentialSetting?errorAct=' + error);
      return show(res, { mode: 'confirm', rows: await selectedRows(ids) });
    } catch {
      return show(res.status(500), { mode: 'error', errors: [labels.serverError] });
    }
  });
  app.get(`${root}/ExportEdgeOCRCertificateFile`, async (req, res) => {
    if (!(await gate(req, res, 'edit'))) return;
    const license = edgeOcrLicense();
    if (!license.enabled) return res.redirect(root + '/EdgeOCRCredentialSetting');
    const ids = req.session.edgeOcrSelected ?? [];
    if (!ids.length) return res.status(400).send(labels.serverError);
    const terminals = (await selectedRows(ids)).map((row) => ({
      terminal_id: String(row.term_id),
      physical_id: String(row.physical_id ?? ''),
    }));
    const now = new Date();
    const stamp =
      String(now.getFullYear()) +
      [now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((value) => String(value).padStart(2, '0'))
        .join('');
    return res
      .attachment('EdgeOCR_terms_' + stamp + '.json')
      .type('application/json')
      .send(JSON.stringify({ edgeocr_token_id: license.token, terminals }));
  });
}
