import type pg from 'pg';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { importRowResult, parseImportCsv, type ImportResult } from './data-import.js';

type XmlNode = Record<string, unknown>;
class SelectionError extends Error {
  constructor(
    readonly code: number,
    readonly info: string,
  ) {
    super(info);
  }
}
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
});
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, suppressEmptyNode: true });
const tag = (node: XmlNode) => Object.keys(node).find((key) => key !== ':@')!;
const contents = (node: XmlNode) => node[tag(node)] as XmlNode[];
const children = (node: XmlNode, name: string) => contents(node).filter((item) => Object.hasOwn(item, name));
const child = (node: XmlNode, name: string) => children(node, name)[0];
function must(node: XmlNode, name: string): XmlNode {
  const item = child(node, name);
  if (!item) throw new Error('Missing XML element.');
  return item;
}
function value(node: XmlNode): string {
  return contents(node)
    .map((item) => (Object.hasOwn(item, '#text') ? String(item['#text']) : value(item)))
    .join('');
}
const field = (node: XmlNode, name: string) => value(must(node, name));
function setValue(node: XmlNode, text: string): void {
  node[tag(node)] = text ? [{ '#text': text }] : [];
}
const element = (name: string, text: string | XmlNode[] = ''): XmlNode => ({
  [name]: typeof text === 'string' ? (text ? [{ '#text': text }] : []) : text,
});
function xmlRoot(text: string): XmlNode {
  if (/<!DOCTYPE/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('Invalid XML.');
  const root = (parser.parse(text) as XmlNode[]).find(
    (node) => !tag(node).startsWith('?') && !tag(node).startsWith('#'),
  );
  if (!root) throw new Error('Missing XML root.');
  return root;
}
function integer(text: string): number | undefined {
  return /^[+-]?\d+$/.test(text.trim()) && Number(text) >= -2147483648 && Number(text) <= 2147483647
    ? Number(text)
    : undefined;
}
function key(node: XmlNode, name: string, info: string): number {
  const item = child(node, name);
  if (!item) throw new SelectionError(11010, info);
  const number = integer(value(item));
  if (number === undefined) throw new SelectionError(11030, info);
  return number;
}

export function splitSelectionValues(text: string, separator: string): string[] {
  const parts = text.split(separator);
  for (let index = parts.length - 2; index > 0; index--)
    if (!parts[index]) {
      parts[index - 1] += separator + separator + parts[index + 1];
      parts[index + 1] = '';
    }
  return parts.filter((part) => part !== '');
}
export function replaceSelectionParameters(source: string, items: string, labels: string, selected: string): string {
  const parts = splitSelectionValues(source, ';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index), part.slice(index + 1)];
  });
  const missingSelected = !parts.some(([name]) => name === 'Selected');
  return parts
    .map(([name, old]) => {
      const trim = (value: string) => value.replace(/;+$/, '');
      if (name === 'Items') return name + '=' + trim(items);
      if (name === 'Labels')
        return name + '=' + trim(labels) + (missingSelected && selected ? ';Selected=' + trim(selected) : '');
      if (name === 'Selected') return name + '=' + trim(selected);
      return name + '=' + old;
    })
    .join(';');
}

function csvDocument(text: string): XmlNode {
  const root = element('conmas', []);
  let top: XmlNode | undefined,
    line = 0;
  for (const row of parseImportCsv(text)) {
    line++;
    if (row.length < 2) throw new Error('Missing CSV type.');
    if (!top || field(top, 'defTopId') !== row[0]) {
      top = element('top', [element('defTopId', row[0]), element('sheets', []), element('networks', [])]);
      contents(root).push(top);
    }
    if (row[1] === 'S') {
      if (row.length !== 7) throw new SelectionError(10050, 'line:' + line);
      const sheets = must(top, 'sheets');
      let sheet = children(sheets, 'sheet').find((item) => field(item, 'sheetNo') === row[2]);
      if (!sheet) {
        sheet = element('sheet', [element('sheetNo', row[2]), element('clusters', [])]);
        contents(sheets).push(sheet);
      }
      const clusters = must(sheet, 'clusters');
      let cluster = children(clusters, 'cluster').find((item) => field(item, 'clusterId') === row[3]);
      if (!cluster) {
        cluster = element('cluster', [
          element('clusterId', row[3]),
          element('labels'),
          element('items'),
          element('selected'),
        ]);
        contents(clusters).push(cluster);
      }
      for (const [index, name] of ['labels', 'items', 'selected'].entries())
        setValue(must(cluster, name), row[index + 4]);
    } else {
      if (row[1] !== 'L') throw new SelectionError(10050, importRowResult(10050, 'line:' + line).remark);
      if (row.length !== 8) throw new SelectionError(10050, 'line:' + line);
      const networks = must(top, 'networks');
      const names = ['prevSheetNo', 'prevClusterId', 'nextSheetNo', 'nextClusterId'];
      let network = children(networks, 'network').find((item) =>
        names.every((name, index) => field(item, name) === row[index + 2]),
      );
      if (!network) {
        network = element('network', [
          ...names.map((name, index) => element(name, row[index + 2])),
          element('valueLinks', []),
        ]);
        contents(networks).push(network);
      }
      if (row[6] || row[7])
        contents(must(network, 'valueLinks')).push(
          element('valueLink', [element('parentValue', row[6]), element('selectValues', row[7])]),
        );
    }
  }
  return root;
}

function sheetFor(top: XmlNode, no: number): XmlNode | undefined {
  return children(must(top, 'sheets'), 'sheet').find((item) => {
    const n = integer(field(item, 'sheetNo'));
    if (n === undefined) throw new Error('Invalid stored sheet number.');
    return n === no;
  });
}
function containsItem(item: string, parameters: string): boolean {
  let items: string[] = [];
  for (const part of splitSelectionValues(parameters, ';'))
    if (part.includes('Items=')) {
      items = splitSelectionValues(part, ',');
      items[0] = items[0].slice(6);
    }
  return items.includes(item);
}
async function updateSelections(
  client: pg.PoolClient,
  input: XmlNode,
  target: XmlNode,
  id: number,
  actor: string,
  host: string,
  now: Date,
): Promise<void> {
  const sheets = child(input, 'sheets');
  if (!sheets) return;
  for (const sheet of children(sheets, 'sheet')) {
    let info = 'defTopId=' + id;
    const sheetNo = key(sheet, 'sheetNo', info + '[sheetNo]');
    info += ';sheetNo=' + sheetNo;
    const targetSheet = sheetFor(target, sheetNo);
    if (!targetSheet) throw new SelectionError(10060, info + '[sheetNo]');
    const clusters = child(sheet, 'clusters');
    if (!clusters) throw new SelectionError(11010, info + '[clusters]');
    if (!children(clusters, 'cluster').length) throw new SelectionError(11010, info + '[cluster]');
    for (const cluster of children(clusters, 'cluster')) {
      const clusterId = key(cluster, 'clusterId', info + '[clusterId]');
      info += ';clusterId=' + clusterId;
      const targetCluster = children(must(targetSheet, 'clusters'), 'cluster').find(
        (item) => field(item, 'clusterId') === field(cluster, 'clusterId'),
      );
      if (!targetCluster) throw new SelectionError(10060, info + '[clusterId]');
      const labels = child(cluster, 'labels');
      if (!labels || !value(labels)) throw new SelectionError(11010, info + '[labels]');
      const labelValues = splitSelectionValues(value(labels), ',');
      if (new Set(labelValues).size !== labelValues.length) throw new SelectionError(11020, info + '[labels]');
      const items = child(cluster, 'items');
      if (!items || !value(items)) throw new SelectionError(11010, info + '[items]');
      const itemValues = splitSelectionValues(value(items), ',');
      if (new Set(itemValues).size !== itemValues.length || itemValues.length !== labelValues.length)
        throw new SelectionError(11020, info + '[items]');
      const selected = child(cluster, 'selected'),
        selectedValue = selected ? value(selected) : '';
      if (selectedValue && !itemValues.includes(selectedValue)) throw new SelectionError(11020, info + '[selected]');
      const parameters = must(targetCluster, 'inputParameters');
      setValue(parameters, replaceSelectionParameters(value(parameters), value(items), value(labels), selectedValue));
      await client.query(
        'UPDATE def_cluster SET input_parameter=$1,sys_update_term=$2,sys_update_user=$3,sys_update_time=$4 WHERE def_sheet_id=$5 AND cluster_id=$6',
        [
          value(parameters),
          'WEBAPI/' + host,
          actor,
          now,
          field(targetSheet, 'defSheetId'),
          field(targetCluster, 'clusterId'),
        ],
      );
    }
  }
}

function updateLinks(input: XmlNode, target: XmlNode, id: number): void {
  const networks = child(input, 'networks');
  if (!networks) return;
  for (const network of children(networks, 'network')) {
    let info = 'defTopId=' + id;
    const prevSheetNo = key(network, 'prevSheetNo', info + '[prevSheetNo]');
    info += ';prevSheetNo=' + prevSheetNo;
    const prevSheet = sheetFor(target, prevSheetNo);
    if (!prevSheet) throw new SelectionError(10060, info + '[prevSheetNo]');
    const prevClusterId = key(network, 'prevClusterId', info + '[prevClusterId]');
    info += ';prevClusterId=' + prevClusterId;
    const numericCluster = (sheet: XmlNode, no: number) =>
      children(must(sheet, 'clusters'), 'cluster').find((item) => {
        const n = integer(field(item, 'clusterId'));
        if (n === undefined) throw new Error('Invalid stored cluster ID.');
        return n === no;
      });
    const prev = numericCluster(prevSheet, prevClusterId);
    if (!prev) throw new SelectionError(10060, info + '[prevClusterId]');
    if (!['Select', 'MultiSelect'].includes(field(prev, 'type')))
      throw new SelectionError(11020, info + '[prevClusterId]');
    const nextSheetNo = key(network, 'nextSheetNo', info + '[nextSheetNo]');
    info += ';nextSheetNo=' + nextSheetNo;
    const nextSheet = sheetFor(target, nextSheetNo);
    if (!nextSheet) throw new SelectionError(10060, info + '[nextSheetNo]');
    const nextClusterId = key(network, 'nextClusterId', info + '[nextClusterId]');
    info += ';nextClusterId=' + nextClusterId;
    const next = numericCluster(nextSheet, nextClusterId);
    if (!next) throw new SelectionError(10060, info + '[nextClusterId]');
    if (!['Select', 'MultiSelect'].includes(field(next, 'type')))
      throw new SelectionError(11020, info + '[nextClusterId]');
    const names = ['prevSheetNo', 'prevClusterId', 'nextSheetNo', 'nextClusterId'],
      numbers = [prevSheetNo, prevClusterId, nextSheetNo, nextClusterId];
    const stored = children(must(target, 'networks'), 'network').find((item) =>
      names.every((name, index) => {
        const n = integer(field(item, name));
        if (n === undefined) throw new Error('Invalid stored network.');
        return n === numbers[index];
      }),
    );
    if (!stored) throw new SelectionError(10060, info + '[network]');
    const links = must(stored, 'valueLinks');
    links.valueLinks = [];
    delete links[':@'];
    const uploaded = child(network, 'valueLinks');
    if (!uploaded) continue;
    for (const link of children(uploaded, 'valueLink')) {
      const parent = child(link, 'parentValue');
      if (!parent || !value(parent)) throw new SelectionError(11010, info + '[parentValue]');
      if (!containsItem(value(parent), field(prev, 'inputParameters')))
        throw new SelectionError(11020, info + '[parentValue]');
      const selected = child(link, 'selectValues');
      if (
        selected &&
        value(selected) &&
        splitSelectionValues(value(selected), ',').some((item) => !containsItem(item, field(next, 'inputParameters')))
      )
        throw new SelectionError(11020, info + '[selectValues]');
      const existing = children(links, 'valueLink').find((item) => field(item, 'parentValue') === value(parent));
      if (existing) setValue(must(existing, 'selectValues'), field(link, 'selectValues'));
      else contents(links).push(structuredClone(link));
    }
  }
}

async function acquireLock(
  client: pg.PoolClient,
  id: number,
  force: boolean,
  actor: string,
  host: string,
  now: Date,
): Promise<boolean> {
  await client.query('BEGIN');
  try {
    await client.query(
      'DELETE FROM def_lock WHERE def_top_id=$1' + (force ? '' : ' AND user_id=$2'),
      force ? [id] : [id, actor],
    );
    await client.query(
      'INSERT INTO def_lock (def_top_id,user_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$2,$4,$3,$2,$4)',
      [id, actor, 'WEBAPI/' + host, now],
    );
    await client.query('COMMIT');
    return true;
  } catch {
    await client.query('ROLLBACK');
    return false;
  }
}
async function releaseLock(client: pg.PoolClient, id: number, actor: string): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM def_lock WHERE def_top_id=$1 AND user_id=$2', [id, actor]);
    await client.query('COMMIT');
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Legacy unlock is best effort. */
    }
  }
}

export async function importSelectionItems(
  db: pg.Pool,
  text: string,
  format: string,
  actor: string,
  host: string,
  force = '',
): Promise<ImportResult[]> {
  if (force && !/^(true|false)$/i.test(force.trim())) return [{ code: '2', remark: '' }];
  let input: XmlNode;
  try {
    input = format === 'csv' ? csvDocument(text) : xmlRoot(text);
  } catch (error) {
    if (format === 'csv' && error instanceof SelectionError) return [{ code: String(error.code), remark: error.info }];
    throw error;
  }
  const results: ImportResult[] = [],
    now = new Date();
  for (const top of children(input, 'top')) {
    const client = await db.connect();
    let id: number | undefined,
      locked = false;
    try {
      id = key(top, 'defTopId', '[defTopId]');
      const stored = (await client.query('SELECT xml_data FROM def_top WHERE def_top_id=$1', [id])).rows[0];
      if (!stored) throw new SelectionError(10060, 'defTopId=' + id + '[defTopId]');
      const root = xmlRoot(stored.xml_data),
        target = must(root, 'top');
      locked = await acquireLock(client, id, force.trim().toLowerCase() === 'true', actor, host, now);
      if (!locked) throw new SelectionError(10070, 'defTopId=' + id);
      await client.query('BEGIN');
      try {
        await updateSelections(client, top, target, id, actor, host, now);
        updateLinks(top, target, id);
        await client.query(
          'UPDATE def_top SET xml_data=$1,sys_update_term=$2,sys_update_user=$3,sys_update_time=$4 WHERE def_top_id=$5',
          [builder.build([root]), 'WEBAPI/' + host, actor, now, id],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      results.push(importRowResult(0));
    } catch (error) {
      results.push(error instanceof SelectionError ? importRowResult(error.code, error.info) : importRowResult(10020));
    } finally {
      if (locked && id !== undefined) await releaseLock(client, id, actor);
      client.release();
    }
  }
  return results;
}
