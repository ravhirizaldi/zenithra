import type pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { clientSettingsDirectory } from '../shared/license-counts.js';
import { exportStatement, serializeExportRows } from './manager/system/data-export.js';
import { clientError } from '../services/client-xml.js';
import { legacyDecrypt, legacyEncrypt } from '../shared/legacy-auth.js';
import { element, field, integer, must, root, serialize } from './client-definition-xml.js';

type Database = Pick<pg.Pool, 'query'>;

export async function identifyClientApprover(db: Database, userId: string, code: string): Promise<string> {
  if (!code) return clientError(2);
  const row = (await db.query('SELECT identification_code FROM mst_user WHERE user_id=$1', [userId])).rows[0];
  if (row?.identification_code === null || row?.identification_code === undefined) return clientError(2);
  const encrypted =
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='PASSWORD_ENCRYPTION' AND com_name='PASSWORD_ENCRYPTION' ORDER BY com_index",
      )
    ).rows[0]?.com_value === '1';
  let stored = String(row.identification_code);
  if (encrypted) {
    const key = process.env.CONMAS_LEGACY_KEY;
    if (!key) throw new Error('Client encryption key is unavailable.');
    stored = legacyDecrypt(stored, legacyEncrypt(`#*${userId}*#`, key));
  }
  return clientError(stored === code ? 0 : 2);
}

// GetCalendarListBiz: keep the source endpoint-overlap rule, not a broader interval-overlap rule.
export async function getClientCalendar(
  db: Database,
  userId: string,
  yearText: string,
  monthText: string,
  statusText: string,
): Promise<string> {
  const year = integer(yearText),
    month = integer(monthText),
    status = integer(statusText);
  if (year === undefined || month === undefined || status === undefined) return clientError(2);
  if (year < 1 || year > 9999 || month < 1 || month > 12) throw new Error('Invalid calendar month.');
  const start = new Date(0);
  start.setFullYear(year, month - 1, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(month, 0);
  end.setHours(23, 59, 59, 0);
  const directory = clientSettingsDirectory();
  if (!directory) throw new Error('Client settings directory is unavailable.');
  const queries = must(root(readFileSync(join(directory, 'CalendarListBiz.xml'), 'utf8')), 'baseQuery');
  const filter =
    ' AND (sch.start_date BETWEEN :fromDate AND :toDate OR sch.end_date BETWEEN :fromDate AND :toDate)' +
    (status > -1 ? ' AND top.public_status = :public_status' : '');
  const list = field(queries, 'list')
    .replace('{0}', filter)
    .replace(/:user_id\b/g, '$1')
    .replace(/:fromDate\b/g, '$2')
    .replace(/:toDate\b/g, '$3')
    .replace(/:public_status\b/g, '$4');
  const tasks = (await db.query(list, status > -1 ? [userId, start, end, status] : [userId, start, end])).rows.map(
    (row) => {
      const text = (key: string) => String(row[key] ?? '');
      const fields = {
        taskId: text('task_id'),
        taskName: text('task_name'),
        taskRemark: text('task_remark'),
        orderComment: text('order_comment'),
        workComment: text('work_comment'),
        startDate: text('start_date') + ' ' + (text('start_time') ? text('start_time') + ':00' : '00:00:00'),
        finishDate: text('end_date')
          ? text('end_date') + ' ' + (text('end_time') ? text('end_time') + ':00' : '00:00:00')
          : '',
        finishStatus: text('finish_status'),
        type: text('report_type'),
        itemId: text('rep_top_id'),
        name: text('rep_top_name'),
        icon_id: '0',
        editStatus: text('edit_refer_status'),
        registTime: text('sys_regist_time'),
        updateTime: text('sys_update_time'),
        detailInfo: '',
        mobileSave: text('mobile_save'),
        mobileReportSave: text('mobile_report_save'),
        dispRemarks: text('dispRemarks'),
      };
      return element(
        'task',
        Object.entries(fields).map(([name, value]) => element(name, value)),
      );
    },
  );
  const holidayQuery = field(queries, 'holidayList')
    .replace(/:fromDate\b/g, '$1')
    .replace(/:toDate\b/g, '$2');
  const holidays = (await db.query(holidayQuery, [start, end])).rows.map((row) =>
    element('holiday', [
      element('holidayFrom', row.holiday_from),
      element('holidayTo', row.holiday_to),
      element('holidayName', row.holiday_name ?? ''),
    ]),
  );
  return serialize(element('conmas', [element('tasks', tasks), element('holidays', holidays)]));
}

const appRequire = createRequire(import.meta.url);
const expressRequire = createRequire(appRequire.resolve('express'));
const iconv = createRequire(expressRequire.resolve('body-parser'))('iconv-lite') as {
  encode(text: string, encoding: string): Buffer;
  encodingExists(encoding: string): boolean;
};
function codePage(text: string): string | undefined {
  const number = integer(text);
  if (number === undefined || number <= 0) return;
  const name =
    (
      { 65001: 'utf-8', 932: 'shift_jis', 1200: 'utf-16le', 1201: 'utf-16be', 20127: 'ascii' } as Record<number, string>
    )[number] ?? `cp${number}`;
  return iconv.encodingExists(name) ? name : undefined;
}

// GetUser shares the same UserBiz templates as System OutputUser; it never selects passwords.
export async function getClientUsers(
  db: Database,
  options: {
    type: string;
    withAdmin: string;
    withImprint: string;
    userId: string;
    encoding: string;
    cultureName: string;
  },
): Promise<{ data: string | Buffer; encoding?: string }> {
  if (!['xml', 'csv'].includes(options.type)) return { data: clientError(2) };
  const statement = exportStatement(0, options.type, {
    ...options,
    withAdmin: options.withAdmin.trim(),
    withImprint: options.withImprint.trim(),
  });
  const rows = (await db.query(statement.text, statement.values)).rows;
  if (options.type === 'xml') return { data: serializeExportRows(0, 'xml', 'user', rows) };
  let encoding = codePage(options.encoding);
  if (!encoding) {
    const configured = (
      await db.query("SELECT com_value FROM mst_common WHERE com_key='ENCODING' AND com_locale=$1", [
        options.cultureName,
      ])
    ).rows[0]?.com_value;
    encoding = configured === undefined ? undefined : codePage(configured);
  }
  if (!encoding) throw new Error('Invalid client CSV encoding setting.');
  return { data: iconv.encode(serializeExportRows(0, 'csv', 'user', rows), encoding), encoding };
}
