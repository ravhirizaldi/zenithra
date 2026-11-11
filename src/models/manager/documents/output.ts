import type pg from 'pg';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import { reportNameDate } from '../../client-report-name.js';
import { r } from '../../../config/manager/documents/resources.js';
import { documentAdministratorId, documentDetail } from './details.js';
import { documentClusterPermissionQuery } from './clusters.js';
import { LabelValidationError } from '../labels/index.js';
import { outputCsvText } from '../data-output/index.js';
import { encodeExport } from '../system/data-export.js';
import { configuredPath, zipBuffer } from '../../../controllers/manager/system/files.js';
import { ReportUnsupported } from '../../client-reports.js';
import { clientSettingsDirectory } from '../../../shared/license-counts.js';
import { child, optionalField, root } from '../../client-definition-xml.js';
import { text as pageText } from '../../../config/manager/documents/resources.js';

const docuWorksSettings = (id: number) => {
  const settings = clientSettingsDirectory();
  return settings ? join(settings, 'interface', 'report', 'DW', 'report', String(id) + '.xml') : undefined;
};

export async function documentDocuWorksAvailable(id: number, enabled: string) {
  const path = docuWorksSettings(id);
  return (
    enabled.toLowerCase() === 'true' &&
    !!path &&
    (await stat(path).then(
      (file) => file.isFile(),
      (error) => {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
        throw error;
      },
    ))
  );
}

// DownLoadAction(xdw) serves a previously generated artifact; it never runs a converter or creates output folders.
export async function documentDownloadDocuWorks(db: Pick<pg.Pool, 'query'>, id: number, user: string, locale: string) {
  if (!(await documentDetail(db, id, user)))
    throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
  const unavailable = () => new LabelValidationError('xdw', pageText['The DocuWorks output file is unavailable.']);
  const settings = docuWorksSettings(id);
  if (!settings) throw unavailable();
  let data: Buffer;
  try {
    const xml = root(await readFile(settings, 'utf8')),
      variables = child(xml, 'variables');
    const file = variables ? optionalField(variables, 'pdfpath').replaceAll('.pdf', '.xdw') : '';
    if (!file.toLowerCase().endsWith('.xdw') || (!isAbsolute(file) && !win32.isAbsolute(file))) throw unavailable();
    data = await readFile(configuredPath(file));
  } catch (error) {
    if (error instanceof LabelValidationError) throw error;
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw unavailable();
    throw error;
  }
  return { data, name: (await documentDownloadName(db, id, locale)) + '.xdw' };
}

const safe = (value: unknown) => String(value ?? '').replace(/\r\n|[\\/:*?<>|"\r\n\t]/g, '_');

// ReportWriter.SetBaseSetting: downloads use the configured filename, never create its server-side folder.
export function documentOutputName(
  settings: Record<string, string>,
  report: Record<string, unknown>,
  now: Date,
  locale: string,
) {
  let name = settings.BASE_FILE ?? '';
  if (settings.BASE_FOLDER) {
    const values: Record<string, string> = {
      date: reportNameDate(now, settings.DATE_FORMAT, locale),
      dateTime: reportNameDate(now, settings.DATETIME_FORMAT, locale),
      time: reportNameDate(now, settings.TIME_FORMAT, locale),
      defTopId: safe(report.def_top_id),
      defTopName: safe(report.def_top_name),
      repTopId: safe(report.rep_top_id),
      repTopName: safe(report.rep_top_name),
      repTopOrg: safe(report.rep_top_org),
      repRevNo: safe(report.rev_no),
      defTopOrg: safe(report.def_top_org),
      defRevNo: safe(report.def_rev_no),
      publicStatus: safe([r.NonDisclosure, r.Test, r.Published][Number(report.public_status)]),
      editStatus: safe(
        [r.BeforeEditing, r.InEditing, r.WaitingForApproval, r.Rejected, r['BizDataOutputResource-Completed']][
          Number(report.edit_refer_status)
        ],
      ),
    };
    for (let index = 1; index <= 10; index++) values['remarks' + index] = safe(report['top_remarks' + index]);
    for (const [key, value] of Object.entries(values)) name = name.replaceAll('{' + key + '}', value);
  }
  if (settings.DOBLE_ESCAPE_EEQUENCE_STRING_RENAME === '1') name = name.replace(/[＋+]/g, '_');
  return safe(name).replace(/\p{Cc}/gu, '_');
}

export async function documentDownloadName(db: Pick<pg.Pool, 'query'>, id: number, locale: string) {
  const report = (
    await db.query(
      `SELECT t.*,d.def_top_name,d.def_top_org,d.rev_no AS def_rev_no FROM rep_top t LEFT JOIN def_top d USING(def_top_id) WHERE t.rep_top_id=$1`,
      [id],
    )
  ).rows[0];
  const settings = Object.fromEntries(
    (
      await db.query("SELECT com_name,com_value FROM mst_common WHERE com_key='OUTPUT_SETTING' ORDER BY com_index")
    ).rows.map((row) => [row.com_name, String(row.com_value ?? '')]),
  );
  return documentOutputName(settings, report, new Date(), locale);
}

export function documentCsvLines(
  report: Record<string, unknown>,
  rows: Record<string, unknown>[],
  mode: string,
  locale: string,
  images: boolean,
) {
  const entries: Array<{ name: string; data: Buffer }> = [];
  let csv = '';
  for (const row of rows) {
    const type = String(row.cluster_type),
      parameter = String(row.input_parameter ?? '');
    const media = ['FixedText', 'FreeText', 'Image', 'DrawingImage', 'FreeDraw', 'AudioRecording'].includes(type);
    const binary = type === 'AudioRecording' ? row.recording_file : row.image_file;
    const hasFile = Buffer.isBuffer(binary) && binary.length > 0;
    const extension = type === 'AudioRecording' ? String(row.recording_file_extension || 'm4a') : 'png';
    if (hasFile && media && !/^[a-zA-Z0-9]+$/.test(extension))
      throw new ReportUnsupported('Report media format has not been migrated.', 'report_csv_media');
    const filename = hasFile && media ? `${row.rep_sheet_no}_cluster_${row.cluster_id}.${extension}` : '';
    const raw = mode === '3' ? row.display_value : ((type === 'FixedText' ? row.display_value : row.input_value) ?? '');
    let value: unknown = media ? filename : raw;
    const audit = ['Registration', 'RegistrationDate', 'LatestUpdate', 'LatestUpdateDate'].includes(type);
    const omitted =
      String(row.verified) === '1' && (raw === '' || (type === 'Check' && String(raw).toUpperCase() === 'FALSE'));
    if (audit) {
      const prefix = type.startsWith('Registration') ? 'regist' : 'update';
      value = '';
      if (type.endsWith('Date')) {
        const date = report['sys_' + prefix + '_time'];
        if (report.sys_regist_time && report.sys_update_time) {
          if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
            throw new Error('Invalid report audit date.');
          const format = parameter
            .split(';')
            .find((part) => part.includes('DateFormat='))
            ?.split('=')[1];
          if (format === undefined)
            throw new ReportUnsupported('Report audit date format has not been migrated.', 'report_csv_date');
          value = reportNameDate(date, format.replaceAll('(ccc)', '(ddd)'), locale);
        }
      } else {
        const id = String(report['sys_' + prefix + '_user'] ?? ''),
          name = String(report['current_' + prefix + '_name'] ?? '');
        value = parameter.includes('DisplayUserName=UserIDandName')
          ? id + ':' + name
          : parameter.includes('DisplayUserName=UserID') && !parameter.includes('DisplayUserName=UserName')
            ? id
            : name;
      }
    } else if (omitted) value = report.no_need_to_fill_string ?? '';
    const line = (value: unknown) =>
      outputCsvText([
        Number(report.rep_sheet_count) === 1
          ? [row.cluster_id, row.cluster_name, value]
          : [row.rep_sheet_no, row.cluster_id, row.cluster_name, value],
      ]);
    // Source SQL concatenation yields an empty line for null display values in mode 3.
    csv += !audit && !omitted && (row.cluster_name == null || (!media && value == null)) ? '\r\n' : line(value);
    if (images && media) {
      if (hasFile) entries.push({ name: filename, data: binary as Buffer });
      else if (String(row.verified) === '1') csv += line(report.no_need_to_fill_string ?? '');
    }
  }
  return { csv, entries };
}

export async function documentDownloadCsv(db: pg.Pool, id: number, user: string, locale: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (!(await documentDetail(client, id, user)))
      throw new LabelValidationError('access', 'Role authority is insufficient.');
    const report = (
      await client.query(
        `SELECT t.*,d.def_top_name,d.def_top_org,d.rev_no AS def_rev_no,u.user_name AS current_regist_name,v.user_name AS current_update_name
      FROM rep_top t LEFT JOIN def_top d USING(def_top_id) LEFT JOIN mst_user u ON u.user_id=t.sys_regist_user LEFT JOIN mst_user v ON v.user_id=t.sys_update_user WHERE t.rep_top_id=$1`,
        [id],
      )
    ).rows[0];
    const settings = Object.fromEntries(
      (
        await client.query(
          "SELECT com_name,com_value FROM mst_common WHERE com_key='OUTPUT_SETTING' ORDER BY com_index",
        )
      ).rows.map((row) => [row.com_name, String(row.com_value ?? '')]),
    );
    const mode = settings.CSV_MODE ?? '',
      encoding = settings.CSV_ENCODING || '65001';
    if (['1', '2'].includes(mode) || !['65001', '932'].includes(encoding))
      throw new ReportUnsupported('This report CSV mode or encoding has not been migrated.', 'report_csv_settings');
    const administrator = await documentAdministratorId();
    const rows = (
      await client.query(
        `SELECT c.*,s.rep_sheet_no FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id)
      CROSS JOIN LATERAL(${documentClusterPermissionQuery.replaceAll('$1', '$2')}) roles
      WHERE s.rep_top_id=$1 AND ($2=$3 OR NOT (NOT roles.refer AND (roles.none OR NOT roles.edit))) ORDER BY s.rep_sheet_no,c.cluster_id`,
        [id, user, administrator],
      )
    ).rows;
    const result = documentCsvLines(report, rows, mode, locale, settings.CSV_IMAGE_OUTPUT === 'true');
    const now = new Date(),
      name = documentOutputName(settings, report, now, locale);
    const csv = encodeExport((encoding === '65001' ? '\ufeff' : '') + result.csv, 'csv', encoding);
    // DownLoadAction uses binaryMode: media are archived regardless of the server-file CSV_ZIP setting.
    const entries = result.entries;
    const data = entries.length
      ? zipBuffer([
          ...entries.map((entry) => ({ name: name + '_' + entry.name, data: entry.data, date: now })),
          { name: name + '.csv', data: csv, date: now },
        ])
      : csv;
    await client.query('COMMIT');
    return {
      name: name + (entries.length ? '.zip' : '.csv'),
      type: entries.length ? 'application/zip' : 'text/csv',
      data,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
