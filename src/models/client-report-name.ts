import { ReportUnsupported } from './client-reports.js';
import { reportTableValue } from './client-report-tables.js';
import {
  child,
  children,
  element,
  field,
  integerField,
  must,
  optionalField,
  replace,
  type XmlNode,
} from './client-definition-xml.js';

export function reportNameDate(now: Date, format: string, culture = 'en-US'): string {
  // shortcut: numeric formats and en-US/ja-JP weekdays are supported; other textual/zone formats need parity before use.
  const unsupported = () =>
    new ReportUnsupported('Report-name date format is not implemented.', 'report_name_date_format');
  if (!format || format.length === 1) throw unsupported();
  let result = '';
  for (let index = 0; index < format.length;) {
    const character = format[index++];
    if (character === '\\') {
      if (index === format.length) throw unsupported();
      result += format[index++];
      continue;
    }
    if (character === '"' || character === "'") {
      let closed = false;
      while (index < format.length) {
        const literal = format[index++];
        if (literal === character) {
          closed = true;
          break;
        }
        if (literal === '\\') {
          if (index === format.length) throw unsupported();
          result += format[index++];
        } else result += literal;
      }
      if (!closed) throw unsupported();
      continue;
    }
    if (character === '%' || /[gzKtF]/.test(character)) throw unsupported();
    if (!/[yMdHhmsf]/.test(character)) {
      result += character;
      continue;
    }
    let length = 1;
    while (format[index] === character) {
      length++;
      index++;
    }
    if (character === 'y') {
      const year = length <= 2 ? now.getFullYear() % 100 : now.getFullYear();
      result += String(year).padStart(length === 1 ? 1 : length, '0');
      continue;
    }
    if (character === 'f') {
      if (length > 7) throw unsupported();
      result += String(now.getMilliseconds()).padStart(3, '0').padEnd(7, '0').slice(0, length);
      continue;
    }
    if (character === 'd' && (length === 3 || length === 4)) {
      if (!/^(en-US|ja-JP)$/i.test(culture)) throw unsupported();
      result += new Intl.DateTimeFormat(culture, { weekday: length === 3 ? 'short' : 'long' }).format(now);
      continue;
    }
    if (length > 2) throw unsupported();
    const numbers: Record<string, number> = {
      M: now.getMonth() + 1,
      d: now.getDate(),
      H: now.getHours(),
      h: now.getHours() % 12 || 12,
      m: now.getMinutes(),
      s: now.getSeconds(),
    };
    result += String(numbers[character]).padStart(length, '0');
  }
  return result;
}

// ReportBiz updates these server fields after merging client values, including fields omitted by the upload.
export function setReportAuditFields(top: XmlNode, sheet: XmlNode, culture = 'en-US'): string[] {
  const changed: string[] = [];
  for (const cluster of children(must(sheet, 'clusters'), 'cluster')) {
    const type = field(cluster, 'type');
    if (!['Registration', 'LatestUpdate', 'RegistrationDate', 'LatestUpdateDate'].includes(type)) continue;
    const prefix = type.startsWith('Registration') ? 'regist' : 'update',
      parameters = optionalField(cluster, 'inputParameters');
    let result: string, display: string;
    if (!type.endsWith('Date')) {
      const id = optionalField(top, prefix + 'User'),
        name = optionalField(top, prefix + 'UserName');
      result = parameters.includes('DisplayUserName=UserIDandName')
        ? id + ':' + name
        : parameters.includes('DisplayUserName=UserName')
          ? name
          : parameters.includes('DisplayUserName=UserID')
            ? id
            : '';
      display = result;
    } else {
      const raw = optionalField(top, prefix + 'Time');
      const parsed = raw
        ? reportTableValue(element('cluster', [element('type', 'Date'), element('value', raw)]), 'D', culture)
        : null;
      if (raw && !parsed) throw new Error('Invalid report audit date.');
      const date = new Date(parsed?.replace(' ', 'T') ?? 0);
      result = raw ? reportNameDate(date, 'yyyy/MM/dd') : raw;
      const format = parameters
        .split(';')
        .find((part) => part.includes('DateFormat='))
        ?.split('=')[1];
      if (raw && !format) throw new Error('Missing report audit date format.');
      display = raw ? reportNameDate(date, format!.replace('(ccc)', '(ddd)'), culture) : raw;
    }
    replace(cluster, 'value', result);
    replace(cluster, 'displayValue', display);
    changed.push(field(cluster, 'clusterId'));
  }
  return changed;
}

// ReportBiz.Regist uses the definition's ordered parts on creation, or the report's nameRegenerate flag on update.
export function setReportName(top: XmlNode, now: Date, create: boolean): void {
  if (!child(top, 'nameParts') || (!create && optionalField(top, 'nameRegenerate') !== '1')) return;
  const parts = children(must(top, 'nameParts'), 'part').sort(
    (a, b) => integerField(a, 'partId') - integerField(b, 'partId'),
  );
  if (!parts.length) return;
  const result = parts
    .map((part) => {
      const type = field(part, 'type'),
        value = field(part, 'value');
      if (['date', 'dateTime', 'time'].includes(type)) return reportNameDate(now, value);
      if (type === 'user') return field(top, value === 'id' ? 'registUser' : 'registUserName');
      if (type === 'report') return field(top, value);
      if (type === 'value') return value;
      if (type === 'inputValue' || type === 'displayValue') {
        const [sheetNo, clusterId] = value.split(',');
        const sheet = children(must(top, 'sheets'), 'sheet').find((node) => field(node, 'sheetNo') === sheetNo);
        const cluster =
          sheet && children(must(sheet, 'clusters'), 'cluster').find((node) => field(node, 'clusterId') === clusterId);
        if (!cluster) throw new Error('Missing report-name cluster.');
        return field(cluster, type === 'inputValue' ? 'value' : 'displayValue');
      }
      return '';
    })
    .join('');
  replace(top, 'repTopName', result);
}
