import type pg from 'pg';
import { clusterType, identifier, saveDefinitionTables } from './client-definition-tables.js';
import {
  child,
  children,
  field,
  integer,
  integerField,
  must,
  optionalField,
  root,
  type XmlNode,
} from './client-definition-xml.js';
import { ReportUnsupported } from './client-reports.js';

const excluded = ['FixedText', 'FreeText', 'FreeDraw', 'Image', 'AudioRecording', 'Action', 'DrawingImage'];
const metadata = [
  'rep_top_id',
  'rep_top_name',
  'public_status',
  'edit_refer_status',
  'rep_top_org',
  'rev_no',
  'def_top_id',
  'report_type',
  'rep_sheet_count',
  'display_sheet_number',
  'server_version',
  ...Array.from({ length: 10 }, (_, i) => 'top_remarks' + (i + 1)),
  'deleted',
  'sys_regist_term',
  'sys_regist_user',
  'sys_regist_time',
  'sys_update_term',
  'sys_update_user',
  'sys_update_time',
];

export async function checkReportTables(db: Pick<pg.PoolClient, 'query'>, top: XmlNode): Promise<void> {
  const tables = child(top, 'tables') ? children(must(top, 'tables'), 'table') : [];
  const mode = optionalField(top, 'cooperationTable');
  if (mode && !['0', '1', '2'].includes(mode))
    throw new ReportUnsupported(
      'Cooperation table mode is not implemented.',
      'report_table_mode',
      integerField(top, 'defTopId'),
    );
  if (!tables.length && !['1', '2'].includes(optionalField(top, 'cooperationTable'))) return;
  const id = integerField(top, 'defTopId');
  if (
    children(must(top, 'sheets'), 'sheet').some((sheet) =>
      children(must(sheet, 'clusters'), 'cluster').some((cluster) => field(cluster, 'type') === 'DrawingImage'),
    )
  )
    throw new ReportUnsupported('Pin cooperation tables are not implemented.', 'report_table_pin', id);
  if (
    tables.length &&
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='COOPERATION_TABLE_SETTING' AND com_name='REGIST_IMMEDIATELY' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value === '0'
  )
    throw new ReportUnsupported('Deferred cooperation tables are not implemented.', 'report_table_deferred', id);
}

export function reportTableValue(cluster: XmlNode, type: string, culture = 'en-US', modern = false): string | null {
  const raw = optionalField(cluster, 'value');
  if (!raw) return null;
  if (type === 'T') return raw;
  if (type === 'N') {
    // shortcut: installed en-US/ja-JP decimal rules; other cultures require an explicit parser before saving.
    if (!/^(en-US|ja-JP)$/i.test(culture))
      throw new ReportUnsupported('Cooperation numeric culture is not implemented.', 'report_table_culture');
    let number = raw.trim(),
      negative = false,
      signed = false;
    if (/^\(.*\)$/.test(number)) {
      if (modern) return null;
      negative = true;
      number = number.slice(1, -1);
    }
    if (/^[+-]/.test(number)) {
      if (negative) {
        if (modern || field(cluster, 'type') === 'Calculate') return null;
        throw new Error('Invalid cooperation number.');
      }
      signed = true;
      negative = number[0] === '-';
      number = number.slice(1);
    }
    if (/[+-]$/.test(number)) {
      if (negative || signed) {
        if (modern || field(cluster, 'type') === 'Calculate') return null;
        throw new Error('Invalid cooperation number.');
      }
      negative = number.endsWith('-');
      number = number.slice(0, -1);
    }
    if (!/^(?:\d[\d,]*(?:\.\d*)?|\.\d+)$/.test(number)) {
      if (modern || field(cluster, 'type') === 'Calculate') return null;
      throw new Error('Invalid cooperation number.');
    }
    number = number.replaceAll(',', '');
    if (modern) {
      const [whole, fraction = ''] = number.split('.'),
        digits = whole.replace(/^0+/, '');
      if (
        digits.length > 9 ||
        (digits === '999999999' && fraction.startsWith('9999999999') && /[1-9]/.test(fraction.slice(10)))
      )
        return null;
    }
    return (negative ? '-' : '') + number;
  }
  if (type === 'I') {
    if (!/^\d{6}$/.test(raw)) return null;
    const [hours, minutes, seconds] = [raw.slice(0, 2), raw.slice(2, 4), raw.slice(4, 6)].map(Number);
    return hours > 23 || minutes > 59 || seconds > 59 ? null : `${hours}:${minutes}:${seconds}`;
  }
  // Calculate date values are always yyyyMMdd, independent of their display format.
  let match: string[] | null =
    field(cluster, 'type') === 'Calculate' || (modern && /^\d{8}$/.test(raw))
      ? /^(\d{4})(\d{2})(\d{2})$/.exec(raw)
      : /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (!match && culture.toLowerCase() === 'en-us' && field(cluster, 'type') !== 'Calculate') {
    const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
    if (local) match = [local[0], local[3], local[1], local[2], ...local.slice(4)];
  }
  if (!match) {
    if (modern || field(cluster, 'type') === 'Calculate') return null;
    throw new ReportUnsupported('Cooperation date format is not implemented.', 'report_table_date_format');
  }
  const [year, month, day, hour, minute, second] = Array.from({ length: 6 }, (_, i) => Number(match[i + 1] ?? 0));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    year < 1 ||
    year > 9999 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Called inside report finish: schema repair and derived values share its commit/rollback.
export async function saveReportTables(
  client: pg.PoolClient,
  top: XmlNode,
  changed: Set<string>,
  culture?: string,
): Promise<void> {
  const mode = optionalField(top, 'cooperationTable'),
    tables = child(top, 'tables') ? children(must(top, 'tables'), 'table') : [];
  if (!['1', '2'].includes(mode) && !tables.length) return;
  await checkReportTables(client, top);
  const id = integerField(top, 'defTopId'),
    repId = integerField(top, 'repTopId');
  const definition = (await client.query('SELECT def_top_org,xml_data FROM def_top WHERE def_top_id=$1', [id])).rows[0];
  if (!definition) throw new Error('Missing cooperation definition.');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['report-tables:' + definition.def_top_org]);
  const privateOnly = (
    await client.query("SELECT relpersistence='t' AS private FROM pg_class WHERE oid='def_top'::regclass")
  ).rows[0].private;
  const prefix = privateOnly ? 'pg_temp.' : '';
  const viewFiles = new Set<string>(),
    published = optionalField(top, 'publicStatus') === '2';
  if (published && ['1', '2'].includes(mode)) viewFiles.add(`view${definition.def_top_org}.xml`);
  const settings = (
    await client.query(
      'SELECT report_file_name,xml_data FROM mst_report_table WHERE report_file_name=$1 OR report_file_name LIKE $2',
      [id + '.xml', id + '\\_%.xml'],
    )
  ).rows;
  const expected = settings
    .map((setting) => {
      const attributes = root(setting.xml_data)[':@'] as Record<string, string> | undefined;
      const count = attributes?.['@_tableDivideNumber'];
      if (count !== undefined) {
        const number = integer(count);
        if (number === undefined || number < 1 || number > 4) throw new Error('Invalid cooperation split mapping.');
        return Array.from({ length: number }, (_, i) => `report_${id}_s_${i + 1}`);
      }
      return ['report_' + setting.report_file_name.replace('.xml', '')];
    })
    .flat();
  for (const table of tables.filter(
    (table) => mode === '1' || (mode === '2' && optionalField(table, 'cooperationTable') === '1'),
  )) {
    const no = integerField(table, 'no');
    if (no) expected.push(`report_${id}_${no}`);
    if (published) viewFiles.add(`view_report_${definition.def_top_org}${no ? '_' + no : ''}.xml`);
  }
  for (const sheet of children(must(top, 'sheets'), 'sheet'))
    for (const cluster of children(must(sheet, 'clusters'), 'cluster')) {
      if (optionalField(cluster, 'remarksValue1') === '{ir_detail}') {
        const no = integerField(cluster, 'remarksValue2');
        expected.push(`report_${id}_${no}`);
        if (published) viewFiles.add(`view${definition.def_top_org}_${no}.xml`);
      }
    }
  const savedViews = (
    await client.query('SELECT report_file_name FROM mst_report_table WHERE report_file_name=ANY($1)', [[...viewFiles]])
  ).rows;
  expected.push(...[...viewFiles].map((name) => name.replace('.xml', '').replace(/^view(\d)/, 'view_report_$1')));
  const missing = (
    await client.query('SELECT to_regclass(name) AS object FROM unnest($1::text[]) AS name', [
      expected.map((name) => prefix + identifier(name)),
    ])
  ).rows.some((row) => !row.object);
  if (
    !settings.some((setting) => setting.report_file_name === id + '.xml') ||
    savedViews.length !== viewFiles.size ||
    missing
  )
    await saveDefinitionTables(
      client,
      must(root(definition.xml_data), 'top'),
      id,
      Number(definition.def_top_org),
      false,
      true,
    );
  const mapping = (await client.query('SELECT xml_data FROM mst_report_table WHERE report_file_name=$1', [id + '.xml']))
    .rows[0]?.xml_data;
  if (!mapping && ['1', '2'].includes(mode)) throw new Error('Missing cooperation table mapping.');
  const attributes = mapping ? (root(mapping)[':@'] as Record<string, string> | undefined) : undefined;
  const splitText = attributes?.['@_tableDivideNumber'],
    split = splitText === undefined ? 0 : integer(splitText);
  if (split === undefined || split < 0 || split > 4 || (splitText !== undefined && split === 0))
    throw new Error('Invalid cooperation split mapping.');
  const all = children(must(top, 'sheets'), 'sheet').flatMap((sheet) =>
    children(must(sheet, 'clusters'), 'cluster').map((cluster) => ({
      cluster,
      sheetNo: integerField(sheet, 'sheetNo'),
    })),
  );
  const selected = all.filter(
    ({ cluster }) =>
      !excluded.includes(field(cluster, 'type')) &&
      (mode !== '2' || optionalField(cluster, 'cooperationCluster') === '1'),
  );
  const key = ({ cluster, sheetNo }: (typeof all)[number]) => sheetNo + ',' + integerField(cluster, 'clusterId');
  const values = (nodes: typeof all, kind: 'cluster' | 'header' | 'detail', modern = false) =>
    new Map(
      nodes.map((item) => [
        identifier(
          kind === 'cluster'
            ? `cluster_${item.sheetNo}_${integerField(item.cluster, 'clusterId')}_${clusterType(item.cluster)}`
            : `${kind}_${integerField(item.cluster, 'remarksValue3')}_${clusterType(item.cluster)}`,
        ).toLowerCase(),
        { cluster: item.cluster, type: clusterType(item.cluster, modern), modern, changed: changed.has(key(item)) },
      ]),
    );
  type FieldValue = { value?: string | null; cluster?: XmlNode; type?: string; modern?: boolean; changed: boolean };
  async function save(name: string, fields: Map<string, FieldValue>, row?: number, rowName?: string): Promise<void> {
    const table = prefix + identifier(name);
    const columns = new Set<string>(
      (
        await client.query(
          'SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped',
          [table],
        )
      ).rows.map((row) => row.attname),
    );
    if (!columns.has('rep_top_id')) throw new Error('Missing cooperation table.');
    const keys = ['rep_top_id', ...(row === undefined ? [] : ['rep_row_no'])];
    const existing =
      (
        await client.query(
          `SELECT 1 FROM ${table} WHERE rep_top_id=$1${row === undefined ? '' : ' AND rep_row_no=$2'}`,
          [repId, ...(row === undefined ? [] : [row])],
        )
      ).rowCount !== 0;
    const common = metadata.filter((name) => columns.has(name)),
      parameters: unknown[] = [repId];
    const insert = common.slice(),
      expressions = common.map((name) => 'src.' + name);
    if (row !== undefined) {
      insert.push('rep_row_no');
      parameters.push(row);
      expressions.push('$' + parameters.length);
    }
    if (columns.has('rep_row_name')) {
      insert.push('rep_row_name');
      parameters.push(rowName ?? '');
      expressions.push('$' + parameters.length);
    }
    for (const [name, item] of fields)
      if (columns.has(name) && (!existing || item.changed)) {
        insert.push(identifier(name));
        parameters.push(
          item.cluster ? reportTableValue(item.cluster, item.type!, culture || 'en-US', item.modern) : item.value,
        );
        expressions.push('$' + parameters.length);
      }
    await client.query(
      `INSERT INTO ${table} (${insert.join(',')}) SELECT ${expressions.join(',')} FROM rep_top src WHERE src.rep_top_id=$1 ON CONFLICT (${keys.join(',')}) DO UPDATE SET ${
        insert
          .filter((name) => !keys.includes(name))
          .map((name) => `${name}=EXCLUDED.${name}`)
          .join(',') || 'rep_top_id=EXCLUDED.rep_top_id'
      }`,
      parameters,
    );
  }
  if (['1', '2'].includes(mode)) {
    const headers = selected.filter(
      ({ cluster }) => split || optionalField(cluster, 'remarksValue1') !== '{ir_detail}',
    );
    for (let number = 1; number <= Math.max(1, split); number++)
      await save(`report_${id}${split ? '_s_' + number : ''}`, values(headers, 'cluster'));
    if (!split) {
      const headers = selected.filter(({ cluster }) => optionalField(cluster, 'remarksValue1') === '{ir_header}');
      const details = selected.filter(({ cluster }) => optionalField(cluster, 'remarksValue1') === '{ir_detail}');
      for (const group of new Set(details.map(({ cluster }) => integerField(cluster, 'remarksValue2')))) {
        const grouped = details.filter(({ cluster }) => integerField(cluster, 'remarksValue2') === group);
        for (const row of new Set(grouped.map(({ cluster }) => integerField(cluster, 'remarksValue4')))) {
          const nodes = grouped.filter(({ cluster }) => integerField(cluster, 'remarksValue4') === row),
            fields: Map<string, FieldValue> = values(headers, 'header');
          for (const [name, item] of values(nodes, 'detail')) fields.set(name, item);
          for (const item of nodes)
            if (
              field(item.cluster, 'type') === 'Check' &&
              optionalField(item.cluster, 'value').toUpperCase() === 'TRUE'
            ) {
              const parameter = optionalField(item.cluster, 'inputParameters')
                .split(';')
                .find((pair) => pair.startsWith('Group='));
              const group = parameter ? integer(parameter.slice(6)) : undefined;
              if (group !== undefined && group >= 0)
                fields.set(`group_${group}_t`, { value: field(item.cluster, 'name'), changed: changed.has(key(item)) });
            }
          await save(`report_${id}_${group}`, fields, row);
        }
      }
    }
  }
  // Modern fixed-sheet tables map columns to source cluster references, not client-supplied SQL or row values.
  const references = tables.flatMap((table) =>
    children(must(table, 'rows'), 'row').flatMap((row) => children(must(row, 'clusters'), 'cluster')),
  );
  const headers = selected.filter(
    (item) =>
      !references.some(
        (ref) =>
          integerField(ref, 'sheetNo') === item.sheetNo &&
          integerField(ref, 'clusterId') === integerField(item.cluster, 'clusterId'),
      ),
  );
  for (const table of tables.filter(
    (table) => mode === '1' || (mode === '2' && optionalField(table, 'cooperationTable') === '1'),
  )) {
    const no = integerField(table, 'no');
    if (!no) {
      await save(`report_${id}`, values(headers, 'cluster', true));
      continue;
    }
    for (const row of children(must(table, 'rows'), 'row')) {
      const fields: Map<string, FieldValue> = values(headers, 'cluster', true);
      for (const column of children(must(table, 'columns'), 'column')) {
        const ref = children(must(row, 'clusters'), 'cluster').find(
          (ref) => field(ref, 'columnKey') === field(column, 'key'),
        );
        const item =
          ref &&
          all.find(
            (item) =>
              item.sheetNo === integerField(ref, 'sheetNo') &&
              integerField(item.cluster, 'clusterId') === integerField(ref, 'clusterId'),
          );
        if (!item) throw new Error('Missing cooperation row cluster.');
        const type = field(column, 'type')[0].toUpperCase();
        fields.set(identifier(`cluster_${field(column, 'key')}_${type}`).toLowerCase(), {
          cluster: item.cluster,
          type,
          modern: true,
          changed: changed.has(key(item)),
        });
      }
      await save(`report_${id}_${no}`, fields, integerField(row, 'no'), optionalField(row, 'name'));
    }
  }
}
