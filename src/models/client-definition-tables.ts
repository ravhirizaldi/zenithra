import type pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientSettingsDirectory } from '../shared/license-counts.js';
import {
  type XmlNode,
  child,
  children,
  content,
  element,
  field,
  integer,
  integerField,
  must,
  optionalField,
  root,
  serialize,
  value,
} from './client-definition-xml.js';

export class DefinitionTableError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
const capacities = [373, 400, 400, 399];
const excluded = ['FixedText', 'FreeText', 'FreeDraw', 'Image', 'AudioRecording', 'Action'];
const attributes = (node: XmlNode) => (node[':@'] ?? {}) as Record<string, string>;
function attributed(name: string, text: string | XmlNode[], attrs: Record<string, string | number>): XmlNode {
  const node = element(name, text);
  node[':@'] = Object.fromEntries(Object.entries(attrs).map(([key, item]) => ['@_' + key, String(item)]));
  return node;
}
export function identifier(text: string): string {
  // SQL object names cannot be parameters; allow only source-generated identifiers, never uploaded SQL.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text) || Buffer.byteLength(text) > 63)
    throw new Error('Invalid report table identifier.');
  return text;
}
function parameter(text: string, key: string, last = false): string {
  const pairs = text.split(';').map((part) => part.split('='));
  return (last ? pairs.reverse() : pairs).find((pair) => pair.length > 1 && pair[0] === key)?.[1] ?? '';
}
export function clusterType(cluster: XmlNode, modern = false): string {
  const type = field(cluster, 'type');
  if (
    ['InputNumeric', 'Numeric', 'NumberHours', 'MultipleChoiceNumber', 'MCNCalculate', 'TimeCalculate'].includes(type)
  )
    return 'N';
  if (['Date', 'CalendarDate', 'RegistrationDate', 'LatestUpdateDate'].includes(type)) return 'D';
  if (type !== 'Calculate') return 'T';
  const parameters = field(cluster, 'inputParameters'),
    dataType = parameter(parameters, 'DataType', !modern);
  if (dataType === '1') {
    const format = parameter(parameters, 'DateFormat');
    return /[yMd]/.test(format) ? 'D' : /[Hms]/.test(format) ? 'I' : 'T';
  }
  return dataType === '2' ? 'T' : modern && dataType !== '' && dataType !== '0' ? '' : 'N';
}
const sqlType = (name: string) =>
  ({ N: 'numeric(19,10)', D: 'timestamp without time zone', I: 'interval' })[name.slice(-1)] ?? 'text';
const columns = (fields: XmlNode[]) =>
  fields.map((node) => ` , ${identifier(value(node))} ${sqlType(value(node))}`).join('');
const sortedHeader = (a: XmlNode, b: XmlNode) => {
  const parts = (node: XmlNode) => value(node).split('_').slice(1, 3).map(Number);
  const x = parts(a),
    y = parts(b);
  return x[0] - y[0] || x[1] - y[1];
};
const sortedModern = (a: XmlNode, b: XmlNode) => {
  const x = attributes(a)['@_colNo'],
    y = attributes(b)['@_colNo'];
  return x === undefined && y === undefined
    ? sortedHeader(a, b)
    : x === undefined
      ? -1
      : y === undefined
        ? 1
        : Number(x) - Number(y);
};
function templates(detail: boolean, modern = false): Record<string, string> {
  const directory = clientSettingsDirectory();
  if (!directory) throw new Error('Client settings directory is unavailable.');
  const document = root(readFileSync(join(directory, detail ? 'ReportTableDetail.xml' : 'ReportTable.xml'), 'utf8'));
  const scripts = Object.fromEntries(
    content(document)
      .filter((node) => !Object.hasOwn(node, '#text'))
      .map((node) => [Object.keys(node)[0], value(node)]),
  );
  // PostgreSQL 12+ removed OIDS; FALSE was the old default and has no replacement clause.
  scripts.table = scripts.table.replace(/WITH\s*\(\s*OIDS\s*=\s*FALSE\s*\)/gi, '');
  if (scripts.tableDivide) scripts.tableDivide = scripts.tableDivide.replace(/WITH\s*\(\s*OIDS\s*=\s*FALSE\s*\)/gi, '');
  if (modern && detail)
    for (const key of ['table', 'view', 'viewparts'])
      scripts[key] = scripts[key].replace(
        /(rep_row_no(?:\s+integer\s+NOT\s+NULL)?)/i,
        '$1 , rep_row_name' + (key === 'table' ? ' text' : ''),
      );
  return scripts;
}
const format = (sql: string, ...parts: (string | number)[]) =>
  sql.replace(/\{(\d+)\}/g, (_, index: string) => String(parts[Number(index)]));
async function setting(client: pg.PoolClient, name: string): Promise<XmlNode | undefined> {
  const xml = (await client.query('SELECT xml_data FROM mst_report_table WHERE report_file_name=$1', [name])).rows[0]
    ?.xml_data;
  return xml ? root(xml) : undefined;
}
async function saveSetting(client: pg.PoolClient, name: string, node: XmlNode, missingOnly = false): Promise<void> {
  await client.query(
    `INSERT INTO mst_report_table (report_file_name,xml_data,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
    VALUES ($1,$2,'','',$3,'','',$3) ON CONFLICT (report_file_name) ${missingOnly ? 'DO NOTHING' : "DO UPDATE SET xml_data=EXCLUDED.xml_data,sys_update_term='',sys_update_user='',sys_update_time=EXCLUDED.sys_update_time"}`,
    [name, serialize(node), new Date()],
  );
}
async function privateObjects(client: pg.PoolClient): Promise<boolean> {
  return (await client.query("SELECT relpersistence='t' AS private FROM pg_class WHERE oid='def_top'::regclass"))
    .rows[0].private;
}
async function drop(
  client: pg.PoolClient,
  name: string,
  kind: 'TABLE' | 'VIEW',
  privateOnly: boolean,
  missingOnly = false,
): Promise<void> {
  identifier(name);
  if (missingOnly) return;
  // Temp fixtures must never resolve a missing generated object to a restored public table/view.
  await client.query(`DROP ${kind} IF EXISTS ${privateOnly ? 'pg_temp.' : ''}${name}`);
}
async function create(client: pg.PoolClient, sql: string, privateOnly: boolean, missingOnly = false): Promise<void> {
  if (missingOnly) {
    const name = /CREATE\s+(?:TABLE|(?:OR\s+REPLACE\s+)?VIEW)\s+(\w+)/i.exec(sql)?.[1];
    if (
      name &&
      (await client.query('SELECT to_regclass($1) AS object', [(privateOnly ? 'pg_temp.' : '') + identifier(name)]))
        .rows[0].object
    )
      return;
  }
  if (missingOnly) sql = sql.replace(/CREATE\s+TABLE/i, 'CREATE TABLE IF NOT EXISTS');
  await client.query(
    privateOnly
      ? sql
          .replace(/CREATE\s+TABLE/i, 'CREATE TEMP TABLE')
          .replace(/CREATE\s+(OR\s+REPLACE\s+)?VIEW/i, 'CREATE $1TEMP VIEW')
      : sql,
  );
}
function updateView(
  view: XmlNode,
  definition: XmlNode,
  replace: boolean,
  appendFields: boolean,
  sort: (a: XmlNode, b: XmlNode) => number,
): XmlNode[] {
  const definitions = must(view, 'definitions'),
    fields = must(view, 'fields');
  if (replace)
    definitions.definitions = content(definitions).filter(
      (node) =>
        !Object.hasOwn(node, 'definition') || attributes(node)['@_defTopId'] !== attributes(definition)['@_defTopId'],
    );
  content(definitions).push(definition);
  if (appendFields)
    content(fields).push(
      ...children(definition, 'field')
        .slice()
        .sort(sort)
        .map((node) => element('field', value(node))),
    );
  else
    fields.fields = [
      ...new Set(
        children(definitions, 'definition')
          .flatMap((node) => children(node, 'field'))
          .sort(sort)
          .map(value),
      ),
    ].map((name) => element('field', name));
  return children(fields, 'field');
}
function viewParts(view: XmlNode, scripts: Record<string, string>, detailNo?: number): string {
  const fields = children(must(view, 'fields'), 'field');
  return children(must(view, 'definitions'), 'definition')
    .map((definition) => {
      const id = integer(attributes(definition)['@_defTopId']);
      if (id === undefined || id < 0) throw new Error('Invalid report view definition ID.');
      const source = children(definition, 'field');
      const select = fields
        .flatMap((node) => {
          const name = identifier(value(node)),
            matches = source.filter((candidate) => value(candidate) === name);
          return (matches.length ? matches : [undefined]).map((match) => {
            const split = match && attributes(match)['@_divideTableNo'];
            if (split !== undefined && !/^[1-4]$/.test(split)) throw new Error('Invalid report split number.');
            const expression = match
              ? split
                ? `report_${id}_s_${split}.${name}`
                : name
              : name.endsWith('_T')
                ? 'null'
                : `null::${sqlType(name).replace('(19,10)', '')}`;
            return `, ${expression} as ${name}`;
          });
        })
        .join('');
      if (attributes(definition)['@_divideMode'] === 'true') {
        const splits = [...new Set(source.map((node) => attributes(node)['@_divideTableNo']).filter(Boolean))];
        const joins = splits
          .filter((no) => no !== '1')
          .map(
            (no) =>
              ` LEFT OUTER JOIN report_${id}_s_${no} ON report_${id}_s_1.rep_top_id=report_${id}_s_${no}.rep_top_id`,
          )
          .join('');
        return format(scripts.viewpartsDivide, `report_${id}_s_1`, select, joins);
      }
      return format(scripts.viewparts, select, id, detailNo ?? '');
    })
    .join(' union all ');
}
async function legacyDetails(
  client: pg.PoolClient,
  top: XmlNode,
  clusters: XmlNode[],
  id: number,
  org: number,
  privateOnly: boolean,
  missingOnly: boolean,
): Promise<void> {
  const groups = [
    ...new Set(
      clusters
        .filter((node) => optionalField(node, 'remarksValue1') === '{ir_detail}')
        .map((node) => integerField(node, 'remarksValue2')),
    ),
  ].sort((a, b) => a - b);
  for (const group of groups) {
    const scripts = templates(true),
      fields: XmlNode[] = [],
      checks = new Set<number>();
    const headers = clusters
      .filter((node) => optionalField(node, 'remarksValue1') === '{ir_header}')
      .sort((a, b) => integerField(a, 'remarksValue3') - integerField(b, 'remarksValue3'));
    const details = clusters
      .filter(
        (node) =>
          optionalField(node, 'remarksValue1') === '{ir_detail}' &&
          field(node, 'remarksValue2') === String(group) &&
          field(node, 'remarksValue4') === '1',
      )
      .sort((a, b) => integerField(a, 'remarksValue3') - integerField(b, 'remarksValue3'));
    for (const [prefix, nodes] of [
      ['header', headers],
      ['detail', details],
    ] as const)
      for (const node of nodes) {
        if (excluded.includes(field(node, 'type'))) continue;
        const name = identifier(`${prefix}_${integerField(node, 'remarksValue3')}_${clusterType(node)}`);
        fields.push(element('field', name));
        if (prefix === 'detail' && field(node, 'type') === 'Check') {
          const text = parameter(field(node, 'inputParameters'), 'Group');
          if (text !== '') {
            const number = integer(text);
            if (number === undefined) throw new Error('Invalid detail check group.');
            if (number >= 0) checks.add(number);
          }
        }
      }
    for (const number of [...checks].sort((a, b) => a - b)) fields.push(element('field', `group_${number}_T`));
    const tableName = `report_${id}_${group}`,
      viewName = `view_report_${org}_${group}`,
      fileName = `view${org}_${group}.xml`;
    if (field(top, 'publicStatus') === '2') await drop(client, viewName, 'VIEW', privateOnly, missingOnly);
    await drop(client, tableName, 'TABLE', privateOnly, missingOnly);
    const sql = format(scripts.table, id, columns(fields), group);
    await create(client, sql, privateOnly, missingOnly);
    await saveSetting(client, `${id}_${group}.xml`, element('table', sql), missingOnly);
    if (field(top, 'publicStatus') !== '2') continue;
    const savedView = await setting(client, fileName),
      view = savedView ?? element('view', [element('fields'), element('definitions')]);
    const union =
      missingOnly && savedView
        ? children(must(view, 'fields'), 'field')
        : updateView(
            view,
            attributed('definition', fields, { defTopId: id }),
            missingOnly,
            !missingOnly && org === id,
            (a, b) => value(a).localeCompare(value(b), 'en-US'),
          );
    await create(
      client,
      format(
        scripts.view,
        org,
        union.map((node) => ', ' + identifier(value(node))).join(''),
        viewParts(view, scripts, group),
        group,
      ),
      privateOnly,
      missingOnly,
    );
    await saveSetting(client, fileName, view, missingOnly);
  }
}
async function modernTables(
  client: pg.PoolClient,
  top: XmlNode,
  tables: XmlNode[],
  id: number,
  org: number,
  privateOnly: boolean,
  missingOnly: boolean,
): Promise<void> {
  const mode = field(top, 'cooperationTable');
  const references = tables.flatMap((table) =>
    children(must(table, 'rows'), 'row').flatMap((row) => children(must(row, 'clusters'), 'cluster')),
  );
  const headers = children(must(top, 'sheets'), 'sheet')
    .filter((sheet) => !child(sheet, 'sheetNoOrg') || field(sheet, 'sheetNo') === field(sheet, 'sheetNoOrg'))
    .flatMap((sheet) => children(must(sheet, 'clusters'), 'cluster'))
    .filter(
      (cluster) =>
        (mode === '1' || field(cluster, 'cooperationCluster') === '1') &&
        !references.some(
          (ref) =>
            field(ref, 'sheetNo') === field(cluster, 'sheetNo') &&
            field(ref, 'clusterId') === field(cluster, 'clusterId'),
        ),
    )
    .map((cluster) =>
      element(
        'field',
        identifier(
          `cluster_${integerField(cluster, 'sheetNo')}_${integerField(cluster, 'clusterId')}_${clusterType(cluster, true)}`,
        ),
      ),
    );
  for (const table of tables.filter(
    (table) => mode === '1' || (mode === '2' && optionalField(table, 'cooperationTable') === '1'),
  )) {
    const no = integerField(table, 'no'),
      fields = headers.slice();
    if (no !== 0)
      for (const column of children(must(table, 'columns'), 'column')) {
        const type = field(column, 'type');
        if (!type) throw new Error('Invalid table column type.');
        fields.push(
          attributed('field', identifier(`cluster_${field(column, 'key')}_${type[0].toUpperCase()}`), {
            colNo: integerField(column, 'no'),
          }),
        );
      }
    const scripts = templates(no !== 0, true),
      tableName = `report_${id}${no ? '_' + no : ''}`,
      viewName = `view_report_${org}${no ? '_' + no : ''}`;
    if (field(top, 'publicStatus') === '2') await drop(client, viewName, 'VIEW', privateOnly, missingOnly);
    await drop(client, tableName, 'TABLE', privateOnly, missingOnly);
    const sql = format(scripts.table, id, columns(fields), no);
    await create(client, sql, privateOnly, missingOnly);
    await saveSetting(client, `${id}${no ? '_' + no : ''}.xml`, element('table', sql), missingOnly);
    if (field(top, 'publicStatus') !== '2') continue;
    const savedView = await setting(client, viewName + '.xml'),
      view = savedView ?? element('view', [element('fields'), element('definitions')]);
    const union =
      missingOnly && savedView
        ? children(must(view, 'fields'), 'field')
        : updateView(view, attributed('definition', fields, { defTopId: id }), true, false, sortedModern);
    await create(
      client,
      format(
        scripts.view,
        org,
        union.map((node) => ', ' + identifier(value(node))).join(''),
        viewParts(view, scripts, no),
        no,
      ),
      privateOnly,
      missingOnly,
    );
    await saveSetting(client, viewName + '.xml', view, missingOnly);
  }
}

// DefinitionBiz.CreateReportTable[Divide/Detail] and ReportTableManagerTable.ExecuteDefinision; report repair preserves existing objects/mappings.
export async function saveDefinitionTables(
  client: pg.PoolClient,
  top: XmlNode,
  id: number,
  org: number,
  reserved: boolean,
  missingOnly = false,
): Promise<void> {
  const tables = child(top, 'tables') ? children(must(top, 'tables'), 'table') : [],
    mode = optionalField(top, 'cooperationTable');
  if ((!mode || mode === '0') && !tables.length) return;
  if (!Number.isInteger(id) || id < 0 || !Number.isInteger(org) || org < 0) throw new Error('Invalid report table ID.');
  const clusters = children(must(top, 'sheets'), 'sheet').flatMap((sheet) =>
    children(must(sheet, 'clusters'), 'cluster'),
  );
  // shortcut: pin/deferred table worker is not ported; refuse its upload before committing until the queue and worker are implemented.
  if (clusters.some((cluster) => field(cluster, 'type') === 'DrawingImage'))
    throw new Error('Deferred pin table generation is not implemented.');
  const settings = new Map<string, string>(
    (
      await client.query(
        "SELECT com_name,com_value FROM mst_common WHERE com_key='COOPERATION_TABLE_SETTING' ORDER BY com_index",
      )
    ).rows.map((row) => [row.com_name, row.com_value]),
  );
  const privateOnly = await privateObjects(client);
  if (tables.length && settings.get('REGIST_IMMEDIATELY') !== '0' && ['1', '2'].includes(field(top, 'publicStatus')))
    await modernTables(client, top, tables, id, org, privateOnly, missingOnly);
  if (!mode || mode === '0' || field(top, 'publicStatus') === '0') return;
  const scripts = templates(false),
    savedView = await setting(client, `view${org}.xml`),
    view = savedView ?? element('view', [element('fields'), element('definitions')]);
  const existing = missingOnly ? await setting(client, `${id}.xml`) : undefined;
  const divide = existing
    ? attributes(existing)['@_tableDivideNumber'] !== undefined
    : settings.get('DIVIDE_TABLE_MODE') === '1' ||
      children(must(view, 'definitions'), 'definition').some((node) => attributes(node)['@_divideMode'] === 'true');
  const selected = clusters.filter(
    (cluster) =>
      !excluded.includes(field(cluster, 'type')) &&
      (mode !== '2' || field(cluster, 'cooperationCluster') === '1') &&
      (divide || optionalField(cluster, 'remarksValue1') !== '{ir_detail}'),
  );
  if (selected.length > 1572) throw new DefinitionTableError(12101, 'exceeded maximum cluster.');
  if (divide && selected.some((cluster) => optionalField(cluster, 'remarksValue1') === '{ir_detail}'))
    throw new DefinitionTableError(12103, "'{ir_detail}' for 'remarksValue1' is invalid.");
  let split = 0,
    used = 0;
  const fields = selected.map((cluster) => {
    const node = element(
      'field',
      identifier(
        `cluster_${integerField(cluster, 'sheetNo')}_${integerField(cluster, 'clusterId')}_${clusterType(cluster)}`,
      ),
    );
    if (divide) {
      node[':@'] = { '@_divideTableNo': String(split + 1) };
      if (++used >= capacities[split]) {
        split++;
        used = 0;
      }
    }
    return node;
  });
  if (field(top, 'publicStatus') === '2') await drop(client, `view_report_${org}`, 'VIEW', privateOnly, missingOnly);
  if (divide) {
    const old = (
      await client.query(
        `SELECT relname FROM pg_class WHERE relkind='r' AND (relname=$1 OR relname LIKE $2)
      AND relnamespace=CASE WHEN $3 THEN pg_my_temp_schema() ELSE current_schema()::regnamespace::oid END ORDER BY relname`,
        [`report_${id}`, `report\\_${id}\\_s\\_%`, privateOnly],
      )
    ).rows;
    for (const row of old) await drop(client, row.relname, 'TABLE', privateOnly, missingOnly);
  } else await drop(client, `report_${id}`, 'TABLE', privateOnly, missingOnly);
  const count = divide ? Math.max(1, ...fields.map((node) => Number(attributes(node)['@_divideTableNo']))) : 1;
  let allSql = '';
  for (let number = 1; number <= count; number++) {
    const sql = format(
      number === 1 ? scripts.table : scripts.tableDivide,
      `${id}${divide ? '_s_' + number : ''}`,
      columns(divide ? fields.filter((node) => attributes(node)['@_divideTableNo'] === String(number)) : fields),
    );
    await create(client, sql, privateOnly, missingOnly);
    allSql += sql;
  }
  await saveSetting(
    client,
    `${id}.xml`,
    attributed('table', allSql, { enableCalcDataType: 'true', ...(divide ? { tableDivideNumber: count } : {}) }),
    missingOnly,
  );
  if (!['1', '2'].includes(field(top, 'publicStatus'))) {
    if (!divide) await legacyDetails(client, top, clusters, id, org, privateOnly, missingOnly);
    return;
  }
  const definition = attributed('definition', fields, { defTopId: id, ...(divide ? { divideMode: 'true' } : {}) });
  const union =
    missingOnly && savedView
      ? children(must(view, 'fields'), 'field')
      : updateView(
          view,
          definition,
          missingOnly || !(org === id && !reserved),
          !missingOnly && org === id && !reserved,
          sortedHeader,
        );
  if (union.length > 1572) throw new DefinitionTableError(12102, "exceeded view's maximum cluster.");
  if (field(top, 'publicStatus') === '2') {
    await create(
      client,
      format(scripts.view, org, union.map((node) => ', ' + identifier(value(node))).join(''), viewParts(view, scripts)),
      privateOnly,
      missingOnly,
    );
    await saveSetting(client, `view${org}.xml`, view, missingOnly);
  }
  if (!divide) await legacyDetails(client, top, clusters, id, org, privateOnly, missingOnly);
}
