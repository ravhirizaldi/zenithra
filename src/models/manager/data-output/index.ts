import type pg from 'pg';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { clientSettingsDirectory } from '../../../shared/license-counts.js';
import { encodeExport } from '../system/data-export.js';
import { zipBuffer } from '../../../controllers/manager/system/files.js';
import { labelChecked, labelInteger, labelString } from '../labels/index.js';
import { LibraryError, LibraryPendingError, managerLibraryPermissions } from '../library/index.js';

type Database = Pick<pg.Pool, 'query'>;
export type OutputKind = 'def' | 'rep';
export type OutputLayout = {
  org: number;
  name: string;
  xml: string;
  fields: string[];
  sheets: OutputSheet[];
  clusterDetails: boolean;
};
type OutputSheet = {
  org: number;
  fields: string[];
  clusters: { id: number; name: string; selected: boolean; display: boolean }[];
};
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const builder = new XMLBuilder({ ignoreAttributes: false, suppressEmptyNode: true });
type LayoutFields = { field?: string | string[] };
type LayoutCluster = { '#text'?: string | number; '@_name'?: string; '@_isOutput'?: string; '@_outputType'?: string };
type LayoutSheet = {
  sheetOrg?: string | number;
  sheetId?: string | number;
  fields?: LayoutFields;
  clusters?: { cluster?: LayoutCluster | LayoutCluster[] };
};
type LayoutTop = Record<string, unknown> & { fields?: LayoutFields; sheets?: { sheet?: LayoutSheet | LayoutSheet[] } };
type Node = { conmas?: { top: LayoutTop }; conams?: { top: LayoutTop } };
const unsafeFileName = new RegExp(`[\\\\/:*?"<>|${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, 'g');
const array = <T>(value: T | T[] | undefined | null): T[] =>
  value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
export const outputFieldLabels: Record<string, string> = {
  Top_rep_top_id: 'Document ID',
  Top_rep_top_name: 'Form name',
  Top_def_top_id: 'Form ID',
  Top_def_top_name: 'Form name',
  Top_rep_top_org: 'Original document ID',
  Top_rep_top_org_name: 'Original document name',
  Top_rev_no: 'Revision No.',
  Top_report_type: 'Document type',
  Top_report_type_name: 'Name of document type',
  Top_rep_sheet_count: 'Number of sheets',
  Top_auto_gen: 'Automatic document creation',
  Top_auto_gen_name: 'Automatic document creation',
  Top_public_status: 'Disclosure status',
  Top_public_status_name: 'Disclosure status',
  Top_edit_refer_status: 'Status',
  Top_edit_refer_status_name: 'Status',
  Top_auto_select_gen: 'Auto. data acquisition for the items of choices',
  Top_auto_select_gen_name: 'Auto. data acquisition for the items of choices',
  Top_mobile_save: 'Save on iPad',
  Top_mobile_save_name: 'Save on iPad',
  Top_remarks_edit: 'Mobile editable for Remarks',
  Top_remarks_edit_name: 'Name for mobile editable for Remarks',
};
for (let i = 1; i <= 10; i++) outputFieldLabels['Top_top_remarks_name' + i] = 'Remarks name ' + i;
for (let i = 1; i <= 10; i++) outputFieldLabels['Top_top_remarks' + i] = 'Remarks information ' + i;
Object.assign(outputFieldLabels, {
  Top_deleted: 'Delete flag',
  Top_sys_regist_term: 'Device registration',
  Top_sys_regist_user: 'Registrant',
  Top_sys_regist_user_name: 'Registrant name',
  Top_sys_regist_time: 'Registration date and time',
  Top_sys_update_term: 'Last update device',
  Top_sys_update_user: 'Last updated by',
  Top_sys_update_user_name: 'Last update person',
  Top_sys_update_time: 'Last update date and time',
  Sheet_rep_sheet_name: 'Name of Sheet',
  Sheet_rep_sheet_no: 'Sheet No.',
});
for (let i = 1; i <= 10; i++) outputFieldLabels['Sheet_sheet_remarks_name' + i] = 'Name of Sheet remarks ' + i;
for (let i = 1; i <= 10; i++) outputFieldLabels['Sheet_sheet_remarks' + i] = 'Sheet remarks ' + i;
outputFieldLabels.Sheet_layer_input_value = 'Layer input text';
const topFields = Object.keys(outputFieldLabels).filter((key) => key.startsWith('Top_'));
const sheetFields = Object.keys(outputFieldLabels).filter((key) => key.startsWith('Sheet_'));
export { topFields as outputTopFields, sheetFields as outputSheetFields };
export function outputSelection(selected: number[], delta: unknown): number[] {
  const next = new Set(selected);
  for (const item of labelString(delta).split(',').filter(Boolean)) {
    const match = /^(\d+):(true|false)$/i.exec(item);
    if (!match) throw new LibraryError('', 'Invalid selection state.');
    const id = labelInteger(match[1]);
    if (id <= 0) throw new LibraryError('', 'Invalid selection state.');
    if (match[2].toLowerCase() === 'true') next.add(id);
    else next.delete(id);
  }
  return [...next];
}
export async function outputAuthorize(db: Database, kind: OutputKind, ids: number[], user: string) {
  if (!ids.length) throw new LibraryError('', 'Select at least one item.');
  const found = (
    await db.query(
      `SELECT t.${kind}_top_id FROM ${kind}_top t WHERE t.${kind}_top_id=ANY($2::int[]) AND COALESCE(t.deleted,0)=0
    AND EXISTS (SELECT 1 FROM ${kind}_role r JOIN mst_group_affiation a USING(group_id) WHERE r.${kind}_top_id=t.${kind}_top_id AND a.user_id=$1 AND (r.role_${kind}_read=1 OR r.role_${kind}_update=1))`,
      [user, ids],
    )
  ).rows;
  if (found.length !== new Set(ids).size)
    throw new LibraryError('', 'Role authority is insufficient or a selected item no longer exists.');
}
export async function outputList(
  db: Database,
  kind: OutputKind,
  user: string,
  input: Record<string, unknown>,
  definitions: number[],
  selected: number[],
  all = false,
) {
  const values: unknown[] = [user],
    bind = (value: unknown) => {
      values.push(value);
      return '$' + values.length;
    };
  const where = [
    `COALESCE(t.deleted,0)=0`,
    `EXISTS (SELECT 1 FROM ${kind}_role r JOIN mst_group_affiation a USING(group_id) WHERE r.${kind}_top_id=t.${kind}_top_id AND a.user_id=$1 AND r.role_${kind}_read=1)`,
  ];
  if (!labelChecked(input.IsAllRevision))
    where.push(`EXISTS (SELECT 1 FROM ${kind}_current c WHERE c.${kind}_top_id=t.${kind}_top_id)`);
  if (kind === 'rep') where.push(`t.def_top_id=ANY(${bind(definitions)}::int[])`);
  const label = labelString(input.LabelID);
  if (label === 'NoLabel')
    where.push(`NOT EXISTS (SELECT 1 FROM ${kind}_label l WHERE l.${kind}_top_id=t.${kind}_top_id)`);
  else if (label && label !== 'All') {
    const id = labelInteger(label),
      parameter = bind(id);
    where.push(
      `EXISTS (SELECT 1 FROM ${kind}_label l WHERE l.${kind}_top_id=t.${kind}_top_id AND l.mst_label_id ${labelChecked(input.IsLabelUnderSearch) ? `IN (WITH RECURSIVE tree AS (SELECT mst_label_id FROM mst_label_${kind} WHERE mst_label_id=${parameter} UNION SELECT m.mst_label_id FROM mst_label_${kind} m JOIN tree ON m.upper_label_id=tree.mst_label_id) SELECT mst_label_id FROM tree)` : '=' + parameter})`,
    );
  }
  for (const [field, column] of [
    ['PublicStatus', 'public_status'],
    ...(kind === 'rep' ? [['EditReferStatus', 'edit_refer_status']] : []),
  ]) {
    const value = labelString(input[field]);
    if (value && value !== '-1') where.push(`t.${column}=${bind(labelInteger(value))}`);
  }
  const search = labelString(input['SearchInfo.SearchName'] ?? input.SearchName);
  if (search) where.push(`t.${kind}_top_name ILIKE ${bind('%' + search + '%')}`);
  const id = labelString(input.SearchId);
  if (id) where.push(`t.${kind}_top_id=${bind(labelInteger(id))}`);
  if (['0', '1'].includes(labelString(input.CheckedStateValue)))
    where.push(`t.${kind}_top_id ${input.CheckedStateValue === '1' ? '<>ALL' : '=ANY'}(${bind(selected)}::int[])`);
  const from = `FROM ${kind}_top t WHERE ${where.join(' AND ')}`;
  const total = Number((await db.query(`SELECT COUNT(*) AS count ${from}`, values)).rows[0].count);
  const size = Math.max(1, Math.min(1000, labelInteger(input.PageSize, 20))),
    pages = Math.max(1, Math.ceil(total / size)),
    index = Math.max(0, Math.min(pages - 1, labelInteger(input.PageIndex, 0)));
  const allowed = [
    `${kind}_top_id`,
    `${kind}_top_org`,
    `${kind}_top_name`,
    'rev_no',
    'sys_regist_time',
    'sys_update_time',
    'sys_regist_user',
    'sys_update_user',
  ];
  const requested = labelString(input.SortColumn).toLowerCase().replace(/^a\./, ''),
    order = allowed.includes(requested) ? requested : `${kind}_top_org`,
    direction = input.SortDirection === 'ASC' ? 'ASC' : 'DESC';
  const rows = (
    await db.query(
      `SELECT t.${kind}_top_id AS id,t.${kind}_top_name AS name,t.${kind}_top_org AS org,t.rev_no,t.public_status,t.sys_regist_time,t.sys_update_time,
    COALESCE((SELECT u.user_name FROM mst_user u WHERE u.user_id=t.sys_regist_user),t.sys_regist_user) AS created_by,
    COALESCE((SELECT u.user_name FROM mst_user u WHERE u.user_id=t.sys_update_user),t.sys_update_user) AS updated_by,
    EXISTS(SELECT 1 FROM ${kind}_current c WHERE c.${kind}_top_id=t.${kind}_top_id) AS is_current${kind === 'rep' ? ',t.edit_refer_status,t.def_top_id' : ''} ${from} ORDER BY t.${order} ${direction},t.rev_no DESC,t.${kind}_top_id DESC${all ? '' : ` LIMIT ${bind(size)} OFFSET ${bind(index * size)}`}`,
      values,
    )
  ).rows;
  return { rows, total, size, index, pages, order, direction };
}
function parseLayout(xml: string): Node {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new LibraryError('', 'Invalid output layout XML.');
  const document = parser.parse(xml),
    root = document.conmas ?? document.conams;
  if (!root?.top || typeof root.top !== 'object') throw new LibraryError('', 'Invalid output layout.');
  return document;
}
const layoutTop = (document: Node): LayoutTop => (document.conmas ?? document.conams)!.top;
export async function outputLayouts(
  db: Database,
  reports: number[],
  user: string,
  auto = false,
): Promise<OutputLayout[]> {
  await outputAuthorize(db, 'rep', reports, user);
  const families = (
    await db.query(
      `SELECT DISTINCT d.def_top_org AS org,d.def_top_name AS name FROM rep_top r JOIN def_top d USING(def_top_id) WHERE r.rep_top_id=ANY($1::int[]) ORDER BY org,name`,
      [reports],
    )
  ).rows;
  const result: OutputLayout[] = [];
  for (const family of families) {
    if (result.some((item) => item.org === family.org)) continue;
    const saved = (
      await db.query(
        `SELECT ${auto ? 'auto_output_layout' : 'manager_output_layout'} AS xml FROM data_output_layout WHERE def_top_org=$1`,
        [family.org],
      )
    ).rows[0]?.xml;
    const sheets = (
      await db.query(
        `SELECT s.rep_sheet_id,s.rep_sheet_name,COALESCE(s.sheet_no_org,s.rep_sheet_no) AS org,c.cluster_id,c.cluster_name FROM rep_sheet s JOIN rep_top r USING(rep_top_id) JOIN def_top d ON d.def_top_id=r.def_top_id
      LEFT JOIN rep_cluster c USING(rep_sheet_id) WHERE r.rep_top_id=ANY($1::int[]) AND d.def_top_org=$2 ORDER BY org,s.rep_sheet_id,c.cluster_id`,
        [reports, family.org],
      )
    ).rows;
    const document: Node = saved
      ? parseLayout(saved)
      : { conmas: { top: { fields: { field: topFields }, isClusterDetail: 'False', sheets: { sheet: [] } } } };
    const top = layoutTop(document),
      rawSheets = array<LayoutSheet>(top.sheets?.sheet);
    const design: OutputSheet[] = [];
    for (const row of sheets) {
      let sheet = design.find((item) => item.org === row.org);
      if (!sheet) {
        const raw = rawSheets.find((item) => Number(item.sheetOrg) === row.org);
        if (saved && rawSheets.some((item) => !item.sheetOrg && item.sheetId))
          throw new LibraryPendingError('', 'Older sheetId output-layout conversion is not implemented yet.');
        sheet = { org: row.org, fields: raw ? array<string>(raw.fields?.field) : [], clusters: [] };
        design.push(sheet);
      }
      if (row.cluster_id === null || sheet.clusters.some((item) => item.id === row.cluster_id)) continue;
      const raw = rawSheets.find((item) => Number(item.sheetOrg) === row.org),
        cluster = array<LayoutCluster>(raw?.clusters?.cluster).find((item) => Number(item['#text']) === row.cluster_id);
      sheet.clusters.push({
        id: row.cluster_id,
        name: cluster?.['@_name'] || row.cluster_name || 'cluster_' + row.cluster_id,
        selected: cluster ? cluster['@_isOutput'] !== '0' : true,
        display: cluster?.['@_outputType'] === '1',
      });
    }
    result.push({
      org: family.org,
      name: family.name,
      xml: builder.build(document),
      fields: array<string>(top.fields?.field),
      sheets: design,
      clusterDetails: labelChecked(top.isClusterDetail),
    });
  }
  return result;
}
export function outputLayoutInput(layout: OutputLayout, input: Record<string, unknown>): OutputLayout {
  const fieldValues = (key: string) =>
    Array.isArray(input[key]) ? input[key].map(labelString) : labelString(input[key]).split(',').filter(Boolean);
  const fields = fieldValues('TopFields');
  if (fields.some((field) => !topFields.includes(field))) throw new LibraryError('', 'Invalid output field.');
  const sheets = layout.sheets.map((sheet) => {
    const selectedFields = fieldValues('SheetFields_' + sheet.org);
    if (selectedFields.some((field) => !sheetFields.includes(field)))
      throw new LibraryError('', 'Invalid sheet output field.');
    return {
      ...sheet,
      fields: selectedFields,
      clusters: sheet.clusters.map((cluster) => ({
        ...cluster,
        selected: labelChecked(input[`Cluster_${sheet.org}_${cluster.id}`]),
        display: labelChecked(input[`Display_${sheet.org}_${cluster.id}`]),
      })),
    };
  });
  const document = parseLayout(layout.xml),
    top = layoutTop(document);
  top.fields = { field: fields };
  top.sheets = {
    sheet: sheets.map((sheet) => ({
      sheetOrg: sheet.org,
      fields: { field: sheet.fields },
      clusters: {
        cluster: sheet.clusters.map((cluster) => ({
          '#text': cluster.id,
          '@_name': cluster.name,
          '@_isOutput': cluster.selected ? '1' : '0',
          '@_outputType': cluster.display ? '1' : '0',
        })),
      },
    })),
  };
  top.isClusterDetail = labelChecked(input.IsClusterDetails) ? 'True' : 'False';
  return {
    ...layout,
    fields,
    sheets,
    clusterDetails: labelChecked(input.IsClusterDetails),
    xml: builder.build(document),
  };
}
export async function saveOutputLayout(
  db: pg.Pool,
  layout: OutputLayout,
  user: string,
  auto: boolean,
  clear: boolean,
  reports: number[],
) {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    if (!(await managerLibraryPermissions(connection, user)).output)
      throw new LibraryError('', 'Role authority is insufficient.');
    await outputAuthorize(connection, 'rep', reports, user);
    if (
      !(
        await connection.query(
          `SELECT 1 FROM rep_top r JOIN def_top d USING(def_top_id) WHERE r.rep_top_id=ANY($1::int[]) AND d.def_top_org=$2`,
          [reports, layout.org],
        )
      ).rowCount
    )
      throw new LibraryError('', 'Invalid output layout family.');
    const column = auto ? 'auto_output_layout' : 'manager_output_layout';
    await connection.query(
      `INSERT INTO data_output_layout (def_top_org,${column},sys_regist_user,sys_regist_term,sys_regist_time,sys_update_user,sys_update_term,sys_update_time)
      VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$3,$4,CURRENT_TIMESTAMP) ON CONFLICT(def_top_org) DO UPDATE SET ${column}=EXCLUDED.${column},sys_update_user=$3,sys_update_term=$4,sys_update_time=CURRENT_TIMESTAMP`,
      [layout.org, clear ? null : layout.xml, user, hostname()],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
const csv = (rows: unknown[][]) =>
  rows
    .map((row) => row.map((value) => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',') + '\r\n')
    .join('');
export { csv as outputCsvText };
export async function outputLimits(db: Database, count: number) {
  const settings = clientSettingsDirectory();
  const cloud = settings
    ? await readFile(join(settings, 'cloudLimit.xml'), 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      })
    : '';
  const limit = cloud
    ? parser.parse(cloud)?.conmas?.dataoutputLimitCsv
    : (
        await db.query(
          "SELECT com_value FROM mst_common WHERE com_key='DATAOUTPUT_LIMIT' AND com_name='CSV' ORDER BY com_index LIMIT 1",
        )
      ).rows[0]?.com_value;
  if (/^\d+$/.test(String(limit)) && Number(limit) > 0 && count > Number(limit))
    throw new LibraryError('', 'The CSV output limit has been exceeded.');
  const selection = Number(
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='LIMIT' AND com_name='DATAOUTPUT' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value,
  );
  if (selection > 0 && count > selection)
    throw new LibraryError('', 'The data output selection limit has been exceeded.');
}
export async function outputCsvFiles(
  db: Database,
  reports: number[],
  layouts: OutputLayout[],
  user: string,
  locale: string,
) {
  if (!reports.length || !layouts.length) throw new LibraryError('', 'Select documents and output fields first.');
  await outputAuthorize(db, 'rep', reports, user);
  await outputLimits(db, reports.length);
  const entries: { name: string; data: Buffer; date: Date }[] = [],
    previews: { name: string; rows: unknown[][] }[] = [],
    exported = new Set<number>();
  if (new Set(layouts.map((layout) => layout.org)).size !== layouts.length)
    throw new LibraryError('', 'Duplicate output layout family.');
  for (const layout of layouts) {
    const top = layoutTop(parseLayout(layout.xml));
    if (
      String(top.outputType ?? '0') !== '0' ||
      ['withImageOutput', 'withPdfOutput', 'withPdfLayerOutput', 'withExcelOutput', 'pdfOutput', 'excelOutput'].some(
        (key) => String(top[key] ?? '0') === '1',
      ) ||
      String(top.isClusterDetail).toLowerCase() === 'true'
    )
      throw new LibraryPendingError(
        '',
        'PDF/Excel/image bundles and cluster-detail output are not implemented yet. No partial archive was returned.',
      );
    const tops = (
      await db.query(
        `SELECT r.*,d.def_top_name,d.def_top_org,u.user_name AS current_regist_name,v.user_name AS current_update_name,o.rep_top_name AS rep_top_org_name,
      TO_CHAR(r.sys_regist_time,'YYYY/MM/DD HH24:MI:SS') AS regist_time_text,TO_CHAR(r.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS update_time_text
      FROM rep_top r JOIN def_top d USING(def_top_id) LEFT JOIN mst_user u ON u.user_id=r.sys_regist_user LEFT JOIN mst_user v ON v.user_id=r.sys_update_user LEFT JOIN rep_top o ON o.rep_top_id=r.rep_top_org
      WHERE r.rep_top_id=ANY($1::int[]) AND d.def_top_org=$2 ORDER BY d.def_top_org,d.def_top_id,r.rep_top_id`,
        [reports, layout.org],
      )
    ).rows;
    if (!tops.length) continue;
    const headers = layout.fields.map((field) => outputFieldLabels[field] ?? field);
    for (const sheet of layout.sheets) {
      headers.push(
        ...sheet.fields.map((field) => outputFieldLabels[field] ?? field),
        ...sheet.clusters.filter((cluster) => cluster.selected).map((cluster) => cluster.name),
      );
    }
    if (!headers.length) throw new LibraryError('', 'Select output fields.');
    const rows: unknown[][] = [headers];
    for (const topRow of tops) {
      exported.add(topRow.rep_top_id);
      const row = layout.fields.map((field) => {
        const key = field.slice(4);
        if (!topFields.includes(field))
          throw new LibraryPendingError('', 'This metadata output field is not implemented yet.');
        if (key === 'sys_regist_time') return topRow.regist_time_text;
        if (key === 'sys_update_time') return topRow.update_time_text;
        if (key === 'sys_regist_user_name') return topRow.current_regist_name;
        if (key === 'sys_update_user_name') return topRow.current_update_name;
        const enums: Record<string, Record<string, string>> = {
          report_type: { 1: 'Sheet', 2: 'Set', 3: 'Book' },
          auto_gen: { 0: 'No', 1: 'Yes' },
          public_status: { 0: 'Non-disclosure', 1: 'Test', 2: 'Published' },
          edit_refer_status: {
            0: 'Before editing',
            1: 'In editing',
            2: 'Waiting for approval',
            3: 'Rejected',
            4: 'Completed',
          },
          auto_select_gen: { 0: 'No', 1: 'Yes' },
          mobile_save: { 0: 'Not available to save on iPad', 1: 'Available to save on iPad' },
          remarks_edit: { 0: 'Not editable', 1: 'Editable' },
        };
        if (key.endsWith('_name') && Object.hasOwn(enums, key.slice(0, -5)))
          return enums[key.slice(0, -5)][String(topRow[key.slice(0, -5)])] ?? '';
        return topRow[key] ?? '';
      });
      const sheets = (
        await db.query('SELECT * FROM rep_sheet WHERE rep_top_id=$1 ORDER BY rep_sheet_no,rep_sheet_id', [
          topRow.rep_top_id,
        ])
      ).rows;
      for (const design of layout.sheets) {
        const matches = sheets.filter((sheet) => Number(sheet.sheet_no_org ?? sheet.rep_sheet_no) === design.org);
        if (matches.length > 1)
          throw new LibraryPendingError(
            '',
            'Copied-sheet output expansion is not implemented yet. No partial archive was returned.',
          );
        const sheet = matches[0];
        for (const field of design.fields) {
          if (!sheetFields.includes(field)) throw new LibraryError('', 'Invalid sheet field.');
          if (field === 'Sheet_layer_input_value')
            row.push(
              sheet
                ? ((
                    await db.query('SELECT input_value FROM rep_layer WHERE rep_sheet_id=$1 AND layer_id=1', [
                      sheet.rep_sheet_id,
                    ])
                  ).rows[0]?.input_value ?? '')
                : '',
            );
          else row.push(sheet?.[field.slice(6)] ?? '');
        }
        const clusters = sheet
          ? (
              await db.query(
                'SELECT cluster_id,cluster_type,input_value,display_value,input_parameter,verified FROM rep_cluster WHERE rep_sheet_id=$1',
                [sheet.rep_sheet_id],
              )
            ).rows
          : [];
        for (const selected of design.clusters.filter((cluster) => cluster.selected)) {
          const cluster = clusters.find((cluster) => cluster.cluster_id === selected.id);
          if (!cluster) {
            row.push('');
            continue;
          }
          if (
            ['Registration', 'LatestUpdate', 'RegistrationDate', 'LatestUpdateDate', 'Date', 'CalendarDate'].includes(
              cluster.cluster_type,
            ) ||
            /(?:^|;)AutoNumber=1(?:;|$)/.test(String(cluster.input_parameter ?? ''))
          )
            throw new LibraryPendingError(
              '',
              'Computed/date/numbering cluster output is not implemented yet. No partial archive was returned.',
            );
          const image = ['FixedText', 'FreeText', 'Image', 'DrawingImage', 'FreeDraw', 'AudioRecording'].includes(
            cluster.cluster_type,
          );
          const empty =
            !cluster.input_value ||
            (cluster.cluster_type === 'Check' && String(cluster.input_value).toUpperCase() === 'FALSE') ||
            (['Approve', 'Create', 'Inspect'].includes(cluster.cluster_type) && cluster.input_value === '0');
          row.push(
            image
              ? ''
              : empty && cluster.verified === '1'
                ? (topRow.no_need_to_fill_string ?? '')
                : ((selected.display ? cluster.display_value : cluster.input_value) ?? ''),
          );
        }
      }
      rows.push(row);
    }
    const encoding = String(
      (
        await db.query(
          "SELECT com_value FROM mst_common WHERE com_key='ENCODING' AND com_name=$1 ORDER BY com_index LIMIT 1",
          [locale],
        )
      ).rows[0]?.com_value ?? '65001',
    );
    if (!['932', '65001'].includes(encoding))
      throw new LibraryPendingError('', 'This CSV character encoding is not implemented yet.');
    const name = `report_${tops.at(-1)!.def_top_id}_${String(layout.name).replace(unsafeFileName, '_')}.csv`;
    entries.push({ name, data: encodeExport(csv(rows), 'csv', encoding), date: new Date() });
    previews.push({ name, rows: rows.slice(0, 4) });
  }
  if (!entries.length || reports.some((id) => !exported.has(id)))
    throw new LibraryError('', 'The output layouts do not cover every selected document.');
  return { data: zipBuffer(entries), previews };
}
