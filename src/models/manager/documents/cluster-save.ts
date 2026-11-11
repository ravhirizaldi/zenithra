import type pg from 'pg';
import { text as pageText } from '../../../config/manager/documents/resources.js';
import { documentCheckUnchangedClusters, splitClusterItems } from './clusters.js';
import { documentScalarValue } from './cluster-value.js';
import {
  child,
  children,
  element,
  must,
  optionalField,
  replace,
  content,
  type XmlNode,
} from '../../client-definition-xml.js';
import { LabelValidationError } from '../labels/index.js';

// shortcut: approval and binary editors stay guarded until their full save pipelines are ported.
const scalar = new Set([
  'Numeric',
  'InputNumeric',
  'NumberHours',
  'Date',
  'CalendarDate',
  'Time',
  'Calculate',
  'TimeCalculate',
]);
const editable = new Set([
  'KeyboardText',
  'Handwriting',
  'Text',
  'Check',
  'Action',
  'Select',
  'MultiSelect',
  'MultipleChoiceNumber',
  ...scalar,
]);
const mutable = new Set([
  'input_value',
  'input_value_date',
  'input_value_time',
  'input_check_value',
  'multi_input_value',
  'KeyboardValue',
  'IsKeyboardInput',
  'Verified',
  'ChangeReason',
  'comment_value',
]);
type Row = Record<string, unknown>;
type Change = {
  row: Row;
  node: XmlNode;
  value: string;
  display: string;
  verified: boolean;
  comment: string;
  reason: string;
};
const string = (value: unknown) => String(value ?? '');
const pending = () =>
  new LabelValidationError(
    'pending',
    pageText['Cluster editing for this control has not been migrated. No changes were saved.'],
  );
const invalid = () =>
  new LabelValidationError('rep_clusters', pageText['Invalid cluster input. No changes were saved.']);

function text(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  return value;
}
function checked(value: unknown): boolean {
  const parts = Array.isArray(value) ? value : [value];
  if (
    !parts.length ||
    parts.length > 2 ||
    parts.some((part) => typeof part !== 'string' || !/^(true|false)$/i.test(part))
  )
    throw invalid();
  return parts.some((part) => /^true$/i.test(part));
}

export function documentClusterChanges(
  input: Record<string, unknown>,
  rows: Row[],
  sheet: XmlNode,
  changeReason: boolean,
  locale = 'en-US',
): Change[] {
  const groups = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith('rep_clusters[')) continue;
    const match = /^rep_clusters\[(\d+)\]\.(\w+)$/.exec(key);
    if (!match || !rows[Number(match[1])]) throw pending();
    const index = Number(match[1]),
      fields = groups.get(index) ?? {};
    fields[match[2]] = value;
    groups.set(index, fields);
    if (!mutable.has(match[2])) documentCheckUnchangedClusters({ [key]: value }, rows);
  }
  const changes: Change[] = [];
  for (const [index, fields] of groups) {
    const row = rows[index],
      type = string(row.cluster_type);
    const original = Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [`rep_clusters[${index}].${name}`, value]),
    );
    if (row.cluster_role !== '1' || !editable.has(type)) {
      documentCheckUnchangedClusters(original, rows);
      continue;
    }
    const dateWithTime = ['Date', 'CalendarDate'].includes(type) && row.useTime;
    const controls = new Set([
      'Verified',
      'ChangeReason',
      ...(!['Check', 'Action', 'MultiSelect'].includes(type) && !dateWithTime ? ['input_value'] : []),
      ...(dateWithTime ? ['input_value_date', 'input_value_time'] : []),
      ...(['Check', 'Action'].includes(type) ? ['input_check_value'] : []),
      ...(['Check', 'MultipleChoiceNumber'].includes(type) ? ['comment_value'] : []),
      ...(['Select', 'MultiSelect'].includes(type) ? ['KeyboardValue', 'IsKeyboardInput'] : []),
      ...(type === 'MultiSelect' ? ['multi_input_value'] : []),
    ]);
    for (const [name, value] of Object.entries(fields))
      if (mutable.has(name) && !controls.has(name))
        documentCheckUnchangedClusters({ [`rep_clusters[${index}].${name}`]: value }, rows);
    const read = (name: string, fallback: unknown) =>
      Object.hasOwn(fields, name) ? text(fields[name]) : string(fallback);
    const flag = (name: string, fallback: boolean) => (Object.hasOwn(fields, name) ? checked(fields[name]) : fallback);
    let value = read('input_value', type === 'MultipleChoiceNumber' ? row.selected : row.input_value);
    if (Object.hasOwn(fields, 'input_value')) value = value.replace(/\r\n|\r/g, '\n');
    let display = string(row.display_value);
    const verified = flag('Verified', Number(row.verified) === 1);
    const comment = read('comment_value', row.comment_value),
      reason = read('ChangeReason', row.change_reason);
    const keyboard = flag('IsKeyboardInput', Boolean(row.isKeyboardEnable && row.isKeyboardInput));
    const options = row.options as Array<{ value: string; text: string }>;
    const parameters = string(row.input_parameter)
      .split(';')
      .map((part) => part.split('='));
    const parameter = (name: string) => parameters.filter((part) => part[0] === name && part[1]).at(-1)?.[1] ?? '';
    const selectionDisplay = (value: string) => {
      if (!value) return '';
      const items = splitClusterItems(string(row.selectItems)),
        labels = splitClusterItems(string(row.selectLabels));
      const mode = string(row.input_parameter).includes('Display=ItemsAndLabels')
        ? 'both'
        : string(row.input_parameter).includes('Display=Items')
          ? 'items'
          : string(row.input_parameter).includes('Display=Labels')
            ? 'labels'
            : 'items';
      let label = '';
      // displaySelectValue splits saved values literally and retains the previous label on an unmatched item.
      return value
        .split(',')
        .map((item) => {
          const index = items.indexOf(item);
          if (index >= 0 && labels[index] !== undefined) label = labels[index];
          return mode === 'both' ? item + ' - ' + label : mode === 'labels' ? label : item;
        })
        .join(parameter('Punctuation') === '2' ? '\n' : parameter('Punctuation') === '0' ? '' : ',');
    };
    if (['Select', 'MultiSelect'].includes(type) && keyboard) {
      if (!row.isKeyboardEnable) throw invalid();
      value = read('KeyboardValue', row.keyboardValue);
      display = value;
    } else if (type === 'MultiSelect') {
      // A multiple-select with nothing selected contributes no value; its posted identity distinguishes omission.
      const selected =
        fields.multi_input_value === undefined
          ? fields.cluster_id === undefined
            ? row.multi_input_value
            : []
          : Array.isArray(fields.multi_input_value)
            ? fields.multi_input_value
            : [fields.multi_input_value];
      if (
        !Array.isArray(selected) ||
        selected.some((item) => typeof item !== 'string' || !options.some((option) => option.value === item)) ||
        new Set(selected).size !== selected.length
      )
        throw invalid();
      value = selected.join(',');
      display = selectionDisplay(value);
      if (
        JSON.stringify([...selected].sort()) ===
        JSON.stringify([...string(row.input_value).split(',').filter(Boolean)].sort())
      ) {
        value = string(row.input_value);
        display = string(row.display_value);
      }
    } else if (type === 'Select' || type === 'MultipleChoiceNumber') {
      const option = options.find((option) => option.value === value);
      // Preserve a stored non-option value unless the user actually replaces it.
      if (!option && value !== string(type === 'Select' ? row.input_value : row.selected)) throw invalid();
      if (type === 'MultipleChoiceNumber') {
        display = value;
        value =
          value === string(row.selected)
            ? string(row.input_value)
            : value
              ? (splitClusterItems(string(row.selectLabels))[
                  options.findIndex((option) => option.value === value) - 1
                ] ?? '')
              : '';
      } else display = option ? selectionDisplay(value) : string(row.display_value);
    } else if (type === 'Check' || type === 'Action') {
      value = String(flag('input_check_value', Boolean(row.input_check_value)));
      if (
        type === 'Action' &&
        parameter('ActionType') !== 'document' &&
        value !== String(Boolean(row.input_check_value))
      )
        throw pending();
      // An untouched unchecked box must not replace the source's empty initial value.
      if (!row.input_value && value === 'false') value = '';
      else if (value === String(Boolean(row.input_check_value))) value = string(row.input_value);
    }
    if (dateWithTime && (Object.hasOwn(fields, 'input_value_date') || Object.hasOwn(fields, 'input_value_time'))) {
      const date = read('input_value_date', row.input_value_date),
        time = read('input_value_time', row.input_value_time);
      if (Boolean(date) !== Boolean(time)) throw invalid();
      value = (date + ' ' + time).trim();
    }
    if (scalar.has(type) && value !== string(row.input_value)) {
      const formatted = documentScalarValue(type, value, string(row.input_parameter), locale);
      if (type === 'Time' && row.input_value) {
        let previous = string(row.input_value);
        try {
          previous = documentScalarValue('Time', previous, '', locale).value;
        } catch (error) {
          if (!(error instanceof LabelValidationError)) throw error;
        }
        if (formatted.value === previous) formatted.value = string(row.input_value);
      }
      value = formatted.value;
      display = formatted.display;
    }
    const valueChanged = value !== string(row.input_value);
    const changed = valueChanged || verified !== (Number(row.verified) === 1) || comment !== string(row.comment_value);
    if (!changed && reason !== string(row.change_reason))
      throw new LabelValidationError(
        'rep_clusters',
        pageText['A change reason cannot be changed without changing the input.'],
      );
    if (!changed) continue;
    if (
      fields.cluster_id !== string(row.cluster_id) ||
      fields.rep_sheet_id !== string(row.rep_sheet_id) ||
      fields.cluster_role !== '1'
    )
      throw pending();
    if (verified && value && !(type === 'Check' && /^false$/i.test(value))) throw invalid();
    if (changeReason && !['Action', 'Calculate', 'TimeCalculate'].includes(type) && !reason)
      throw new LabelValidationError('rep_clusters', pageText['Enter a reason for the input change.']);
    if (['KeyboardText', 'Handwriting'].includes(type)) {
      if (parameters.some(([name, value]) => name === 'AutoNumber' && value === '1')) throw pending();
      const maximum =
        parameters
          .filter(
            ([name, value]) =>
              name === 'MaxLength' &&
              /^[+-]?\d+$/.test(value?.trim() ?? '') &&
              Number(value) >= -2147483648 &&
              Number(value) <= 2147483647,
          )
          .map(([, value]) => Number(value))
          .at(-1) ?? 0;
      if (maximum > 0 && read('input_value', row.input_value).length > maximum)
        throw new LabelValidationError('rep_clusters', pageText['The input exceeds the cluster maximum length.']);
    }
    if (valueChanged && !scalar.has(type) && !['Select', 'MultiSelect', 'MultipleChoiceNumber'].includes(type)) {
      if (
        parameter('DateFormat') ||
        parameter('TimeFormat') ||
        parameter('TimeCalculateType') === '1' ||
        /^(1|true)$/i.test(parameter('ShowPercent'))
      )
        throw pending();
      display =
        type === 'Action'
          ? value === 'true'
            ? parameter('FinishMessage')
            : ''
          : value
            ? parameter('Prefix') + value + parameter('Suffix')
            : '';
    }
    const node = children(must(sheet, 'clusters'), 'cluster').find(
      (node) => optionalField(node, 'clusterId') === string(row.cluster_id),
    );
    if (!node || optionalField(node, 'type') !== type) throw pending();
    changes.push({ row, node, value, display, verified, comment, reason });
  }
  return changes;
}

export async function saveDocumentClusters(
  db: Pick<pg.PoolClient, 'query'>,
  changes: Change[],
  user: string,
  userName: string,
  terminal: string,
  now: Date,
  timestamp: string,
) {
  for (const change of changes) {
    const { row, node, value, display, verified, comment, reason } = change;
    await db.query(
      `UPDATE rep_cluster SET input_value=$3,display_value=$4,verified=$5,comment_value=$6,change_reason=$7,
      edit_user=CASE WHEN COALESCE(edit_user,'')='' THEN $8 ELSE edit_user END,
      edit_user_name=CASE WHEN COALESCE(edit_user,'')='' THEN $9 ELSE edit_user_name END,
      edit_time=CASE WHEN COALESCE(edit_user,'')='' THEN $11 ELSE edit_time END,
      sys_update_user=$8,sys_update_term=$10,sys_update_time=$11 WHERE rep_sheet_id=$1 AND cluster_id=$2`,
      [
        row.rep_sheet_id,
        row.cluster_id,
        value,
        display,
        verified ? '1' : '0',
        comment,
        reason,
        user,
        userName,
        terminal,
        now,
      ],
    );
    for (const [name, fieldValue] of Object.entries({
      value,
      displayValue: display,
      inputParameters: string(row.input_parameter),
      verified: verified ? '1' : '0',
      changeReasonValue: reason,
    }))
      replace(node, name, fieldValue);
    const commentNode = child(node, 'comment') ?? element('comment', []);
    if (!child(node, 'comment')) content(node).push(commentNode);
    replace(commentNode, 'value', comment);
    if (!row.edit_user) {
      replace(node, 'editUser', user);
      replace(node, 'editUserName', userName);
      replace(node, 'editTime', timestamp);
    }
  }
}
