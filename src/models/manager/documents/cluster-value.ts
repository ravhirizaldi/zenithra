import { text as pageText } from '../../../config/manager/documents/resources.js';
import { reportTableValue } from '../../client-report-tables.js';
import { reportNameDate } from '../../client-report-name.js';
import { element } from '../../client-definition-xml.js';
import { ReportUnsupported } from '../../client-reports.js';
import { LabelValidationError } from '../labels/index.js';

const decimalMaximum = 79228162514264337593543950335n;
const invalid = () =>
  new LabelValidationError('rep_clusters', pageText['Invalid cluster input. No changes were saved.']);
const pending = () => new ReportUnsupported('Cluster value format is not implemented.', 'manager_cluster_format');

function decimal(raw: string, locale: string) {
  if (/[()]/.test(raw)) throw invalid();
  let normalized: string | null;
  try {
    normalized = reportTableValue(element('cluster', [element('type', 'Numeric'), element('value', raw)]), 'N', locale);
  } catch (error) {
    if (error instanceof ReportUnsupported) throw error;
    throw invalid();
  }
  if (!normalized) throw invalid();
  const negative = normalized.startsWith('-');
  const [whole, fraction = ''] = normalized.replace(/^-/, '').split('.');
  // shortcut: values requiring .NET decimal precision reduction remain explicit failures, not float-rounded saves.
  if (fraction.length > 28) throw pending();
  const significant = whole.replace(/^0+/, '') || '0';
  if (significant.length > 29) throw invalid();
  const scale = 10n ** BigInt(fraction.length),
    magnitude = BigInt(significant + fraction);
  if (magnitude > decimalMaximum * scale) throw invalid();
  let coefficient = magnitude,
    precision = fraction.length;
  while (precision && coefficient % 10n === 0n) {
    coefficient /= 10n;
    precision--;
  }
  if (coefficient > decimalMaximum) throw pending();
  return { magnitude, precision: fraction.length, scale, negative: negative && magnitude !== 0n };
}
type Decimal = ReturnType<typeof decimal>;

function decimalText(number: Decimal, places = number.precision, trim = false, comma = false, optionalZero = false) {
  let coefficient = number.magnitude;
  if (places >= number.precision) coefficient *= 10n ** BigInt(places - number.precision);
  else {
    const divisor = 10n ** BigInt(number.precision - places);
    coefficient = coefficient / divisor + ((coefficient % divisor) * 2n >= divisor ? 1n : 0n);
  }
  const digits = coefficient.toString().padStart(places + 1, '0');
  let whole = places ? digits.slice(0, -places) : digits;
  let fraction = places ? digits.slice(-places) : '';
  if (trim) fraction = fraction.replace(/0+$/, '');
  if (optionalZero && coefficient === 0n) return '';
  if (comma) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (number.negative && coefficient !== 0n ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}

function clock(raw: string) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap]m))?$/i.exec(raw.trim());
  if (!match) throw invalid();
  let hour = Number(match[1]);
  const minute = Number(match[2]),
    second = Number(match[3] ?? 0);
  if (minute > 59 || second > 59 || (match[4] ? hour < 1 || hour > 12 : hour > 23)) throw invalid();
  if (match[4]) hour = (hour % 12) + (match[4].toLowerCase() === 'pm' ? 12 : 0);
  return [hour, minute, second].map((value) => String(value).padStart(2, '0')).join(':');
}

function duration(raw: string, format: string) {
  if (format.length < 2) throw pending();
  if (!/^[+-]?\d+$/.test(raw.trim())) throw invalid();
  const milliseconds = Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < -2147483648 || milliseconds > 2147483647) throw invalid();
  const time = Math.abs(milliseconds);
  const parts: Record<string, number> = {
    d: Math.trunc(time / 86400000),
    h: Math.trunc(time / 3600000) % 24,
    m: Math.trunc(time / 60000) % 60,
    s: Math.trunc(time / 1000) % 60,
  };
  let display = '';
  for (let index = 0; index < format.length;) {
    const character = format[index++];
    if (character === '\\') {
      if (index === format.length) throw pending();
      display += format[index++];
    } else if (character === '"' || character === "'") {
      let closed = false;
      while (index < format.length) {
        const literal = format[index++];
        if (literal === character) {
          closed = true;
          break;
        }
        if (literal === '\\') {
          if (index === format.length) throw pending();
          display += format[index++];
        } else display += literal;
      }
      if (!closed) throw pending();
    } else {
      let length = 1;
      while (format[index] === character) {
        length++;
        index++;
      }
      if (character === 'f' && length <= 7)
        display += String(time % 1000)
          .padStart(3, '0')
          .padEnd(7, '0')
          .slice(0, length);
      else if (Object.hasOwn(parts, character) && length <= (character === 'd' ? 8 : 2))
        display += String(parts[character]).padStart(length, '0');
      else throw pending();
    }
  }
  return display;
}

export function documentScalarValue(type: string, raw: string, parameters: string, locale: string) {
  if (!raw) return { value: '', display: '' };
  if (!/^(en-US|ja-JP)$/i.test(locale)) throw pending();
  const pairs = parameters.split(';').map((pair) => pair.split('='));
  const parameter = (name: string) => pairs.filter((pair) => pair[0] === name && pair[1]).at(-1)?.[1] ?? '';
  const showPercent = pairs.some(([key, value]) => key === 'ShowPercent' && /^(1|true)$/i.test(value ?? ''));
  const integer = (name: string) =>
    pairs
      .filter(
        ([key, value]) =>
          key === name &&
          /^[+-]?\d+$/.test(value?.trim() ?? '') &&
          Number(value) >= -2147483648 &&
          Number(value) <= 2147483647,
      )
      .map(([, value]) => Number(value))
      .at(-1) ?? 0;
  const number = ['Numeric', 'InputNumeric', 'NumberHours'].includes(type) ? decimal(raw, locale) : null;
  if (number) {
    if (/KeypadMode=2/i.test(parameters)) throw invalid();
    const boundScale = parameter('InputType') === 'Formatted' && parameter('TimeUnit') === 'Hour' ? 60n : 1n;
    const signed = number.negative ? -number.magnitude : number.magnitude;
    if (
      (integer('Minimum') > 0 && signed < BigInt(integer('Minimum')) * boundScale * number.scale) ||
      (integer('Maximum') > 0 && signed > BigInt(integer('Maximum')) * boundScale * number.scale)
    )
      throw new LabelValidationError('rep_clusters', pageText['The input is outside the cluster minimum or maximum.']);
  }
  let value = raw,
    display = raw;
  if (type === 'Calculate') {
    const dataType = parameter('DataType');
    if (dataType === '1') {
      const parsed =
        raw.length === 8
          ? reportTableValue(element('cluster', [element('type', 'Calculate'), element('value', raw)]), 'D', locale)
          : raw.length === 6
            ? reportTableValue(element('cluster', [element('type', 'Calculate'), element('value', raw)]), 'I', locale)
            : null;
      if (parsed) {
        const date = new Date((raw.length === 8 ? parsed : '0001-01-01 ' + parsed).replace(' ', 'T'));
        const format =
          parameter('Day') === '1' ? parameter('DateFormat').replaceAll('(ccc)', '(ddd)') : parameter('DateFormat');
        display = reportNameDate(date, format, locale);
      }
      return { value, display };
    }
    if (dataType && !['0', '2'].includes(dataType)) return { value, display };
    let number: Decimal;
    try {
      number = decimal(raw, locale);
    } catch (error) {
      if (!(error instanceof LabelValidationError)) throw error;
      return { value, display: dataType === '2' ? raw : parameter('Prefix') + raw + parameter('Suffix') };
    }
    const places = integer('Decimal'),
      trim = integer('TruncateZeroMode') === 1;
    if (places > 28) throw pending();
    if (dataType === '2') return { value, display: trim && places >= 0 ? decimalText(number, places, true) : raw };
    display = decimalText(number, Math.max(0, places), trim, /^(1|true)$/i.test(parameter('Comma')));
  } else if (parameter('TimeCalculateType') === '1') {
    if (
      !['TimeCalculate', 'Numeric', 'InputNumeric', 'NumberHours'].includes(type) ||
      parameter('TimeFormat') ||
      showPercent ||
      type === 'InputNumeric'
    )
      throw pending();
    if (parameter('InputType') === 'Numerical') {
      if (!/^[+-]?\d+$/.test(raw.trim()) || Number(raw) < -2147483648 || Number(raw) > 2147483647) throw invalid();
      const divisor =
        ({ Hour: 3600000, Minute: 60000, Second: 1000 } as Record<string, number>)[parameter('TimeUnit')] ?? 1;
      display = String(Math.trunc(Number(raw) / divisor));
    } else if (parameter('InputType') === 'Formatted') {
      const format = parameter('DateFormat')
        .replaceAll('H', 'h')
        .replaceAll('0', 'f')
        .replace(/[:.時分秒]/g, '\\$&');
      display = duration(raw, format);
    }
  } else if (number) {
    if (parameter('DateFormat')) throw pending();
    if (showPercent) {
      const percent = { ...number, magnitude: number.magnitude * 100n };
      if (percent.magnitude > decimalMaximum * number.scale) throw invalid();
      while (percent.magnitude > decimalMaximum && percent.precision && percent.magnitude % 10n === 0n) {
        percent.magnitude /= 10n;
        percent.precision--;
      }
      if (percent.magnitude > decimalMaximum) throw pending();
      display = decimalText(percent) + '%';
    } else if (type === 'InputNumeric') {
      const places = integer('Decimal'),
        trim = integer('TruncateZeroMode') === 1,
        comma = /^(1|true)$/i.test(parameter('Comma'));
      if (places > 28) throw pending();
      const formatted = places > 0 || (trim && places >= 0) || comma;
      display = decimalText(
        number,
        formatted ? Math.max(0, places) : number.precision,
        trim,
        comma,
        comma && places <= 0 && !(trim && places >= 0),
      );
    }
    if (parameter('TimeFormat')) {
      if (
        !/^[+-]?\d+$/.test(display.trim()) ||
        BigInt(display.trim()) < -2147483648n ||
        BigInt(display.trim()) > 2147483647n
      )
        throw invalid();
      const minutes = Number(display.trim()),
        hours = Math.trunc(minutes / 60),
        remainder = minutes % 60;
      const part = (remainder < 0 ? '-' : '') + String(Math.abs(remainder)).padStart(2, '0');
      switch (parameter('TimeFormat')) {
        case 'colon':
          display = hours + ':' + part;
          break;
        case 'h/m':
          display = hours + 'h' + part + 'm';
          break;
        case '時間/分':
          display = hours + '時間' + part + '分';
          break;
        default:
          throw pending();
      }
    }
  } else if (type === 'Time') {
    value = clock(raw).slice(0, 5) + ':00';
    display = value;
    if (parameter('DateFormat')) {
      const date = new Date();
      date.setHours(...(value.split(':').map(Number) as [number, number, number]), 0);
      if (reportNameDate(date, 'HH:mm:ss') !== value) throw pending();
      display = reportNameDate(date, parameter('DateFormat').replaceAll('(ccc)', '(ddd)').replaceAll('0', 'f'), locale);
    } else if (parameter('TimeFormat')) throw pending();
  } else if (type === 'Date' || type === 'CalendarDate') {
    const normalized = raw
      .trim()
      .replace(/ (\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)$/i, (_match, time: string) => ' ' + clock(time));
    const parsed = reportTableValue(
      element('cluster', [element('type', 'Date'), element('value', normalized)]),
      'D',
      locale,
    );
    if (!parsed) throw invalid();
    const useTime = pairs.some(([key, value]) => key === 'UseTime' && value === '1');
    value = parsed.replaceAll('-', '/');
    if (!useTime) value = value.slice(0, 10);
    else if (parameter('DateFormat')) {
      // GetInputValueWithTimeFormat round-trips through the configured precision before saving.
      const format = parameter('DateFormat');
      if (!/^yyyy[/-]MM[/-]dd(?: HH:mm(?::ss)?)?$/.test(format)) throw pending();
      if (!format.includes('HH')) value = value.slice(0, 10) + ' 00:00:00';
      else if (!format.includes('ss')) value = value.slice(0, -2) + '00';
    }
    display = value;
    if (parameter('DateFormat')) {
      const canonical = value.replaceAll('/', '-') + (useTime ? '' : ' 00:00:00');
      const date = new Date(canonical.replace(' ', 'T'));
      if (!Number.isFinite(date.getTime())) throw invalid();
      const expected = value + (useTime ? '' : ' 00:00:00');
      if (reportNameDate(date, 'yyyy/MM/dd HH:mm:ss') !== expected) throw pending();
      display = reportNameDate(date, parameter('DateFormat').replaceAll('(ccc)', '(ddd)').replaceAll('0', 'f'), locale);
    } else if (parameter('TimeFormat')) throw pending();
  } else if (type === 'TimeCalculate') {
    if (parameter('DateFormat') || parameter('TimeFormat') || showPercent) throw pending();
  } else throw pending();
  return { value, display: parameter('Prefix') + display + parameter('Suffix') };
}
