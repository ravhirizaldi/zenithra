import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentScalarValue } from '../../../../src/models/manager/documents/cluster-value.js';

const format = (type: string, value: string, parameters = '', locale = 'en-US') =>
  documentScalarValue(type, value, parameters, locale);

test('numeric sheet values use exact decimal bounds and source-specific numeric, percent and duration displays', () => {
  assert.deepEqual(format('InputNumeric', '1234.565', 'Decimal=2;Comma=1;Prefix=$;Suffix= USD'), {
    value: '1234.565',
    display: '$1,234.57 USD',
  });
  assert.equal(format('InputNumeric', '-1234.565', 'Decimal=2;Comma=TRUE').display, '-1,234.57');
  assert.equal(format('InputNumeric', '0', 'Comma=1').display, '');
  assert.equal(format('InputNumeric', '0', 'Comma=1;Decimal=2').display, '0.00');
  assert.equal(format('InputNumeric', '1.2000', 'Decimal=4;TruncateZeroMode=1').display, '1.2');
  assert.equal(format('InputNumeric', '1.999', 'Decimal=2;TruncateZeroMode=1').display, '2');
  assert.equal(format('InputNumeric', '001.20').display, '1.20');
  assert.equal(format('Numeric', '001.20', 'Decimal=2;Comma=1').display, '001.20');
  assert.equal(format('InputNumeric', '0.125', 'ShowPercent=1;Decimal=2').display, '12.500%');
  assert.equal(format('InputNumeric', '0.125', 'ShowPercent=1;ShowPercent=0;Decimal=2').display, '12.500%');
  assert.equal(format('InputNumeric', '1.25', 'Decimal= 1 ').display, '1.3');
  assert.equal(
    format('NumberHours', '90', 'TimeFormat=colon;InputType=Formatted;TimeUnit=Hour;Maximum=2').display,
    '1:30',
  );
  assert.equal(format('NumberHours', '-90', 'TimeFormat=h/m').display, '-1h-30m');
  assert.equal(
    format('InputNumeric', '9999999999999999999999999.995', 'Decimal=2;Comma=1').display,
    '10,000,000,000,000,000,000,000,000.00',
  );
  assert.equal(format('Numeric', '79228162514264337593543950335').value, '79228162514264337593543950335');
  for (const value of ['NaN', '1e3', '(1)', '79228162514264337593543950336', '1 OR 1=1'])
    assert.throws(() => format('Numeric', value), /Invalid cluster/);
  assert.throws(() => format('Numeric', '10.000000000000000000000000001', 'Maximum=10'), /minimum or maximum/);
  assert.throws(() => format('Numeric', '0.9999999999999999999999999999', 'Minimum=1'), /minimum or maximum/);
  assert.throws(
    () => format('NumberHours', '121', 'InputType=Formatted;TimeUnit=Hour;Maximum=2'),
    /minimum or maximum/,
  );
  assert.throws(() => format('NumberHours', '1.5', 'TimeFormat=colon'), /Invalid cluster/);
  assert.throws(() => format('InputNumeric', '1', 'KeypadMode=2'), /Invalid cluster/);
  assert.throws(() => format('InputNumeric', '1', 'Decimal=29'), /not implemented/);
  assert.throws(() => format('Numeric', '0.12345678901234567890123456789'), /not implemented/);
  assert.throws(() => format('Numeric', '1', '', 'fr-FR'), /not implemented/);
});

test('date/time sheet values preserve calendar validity, split-time precision and configured display formats', () => {
  assert.deepEqual(format('Date', '11/9/2026', 'DateFormat=MM/dd/yyyy'), {
    value: '2026/11/09',
    display: '11/09/2026',
  });
  assert.equal(format('Date', '2024/02/29', 'DateFormat=yyyy/MM/dd').display, '2024/02/29');
  assert.deepEqual(format('CalendarDate', '2026/11/09 13:14:59', 'UseTime=1;DateFormat=yyyy/MM/dd HH:mm'), {
    value: '2026/11/09 13:14:00',
    display: '2026/11/09 13:14',
  });
  assert.equal(
    format('CalendarDate', '2026/11/09 1:14 pm', 'UseTime=1;DateFormat=yyyy/MM/dd HH:mm:ss').value,
    '2026/11/09 13:14:00',
  );
  assert.equal(format('Date', '2026/11/09 13:14:15', 'UseTime=1;DateFormat=yyyy/MM/dd').value, '2026/11/09 00:00:00');
  assert.deepEqual(format('Time', '1:14:59 pm', 'DateFormat=HH:mm'), { value: '13:14:00', display: '13:14' });
  assert.equal(format('Time', '12:00 AM').value, '00:00:00');
  assert.equal(format('Time', '12:00 PM').value, '12:00:00');
  assert.deepEqual(format('Date', '', 'Prefix=Date: '), { value: '', display: '' });
  assert.deepEqual(format('InputNumeric', '', 'Minimum=1;Prefix=$'), { value: '', display: '' });
  for (const value of ['2026/02/29', '2026/11/31', '2026/13/01'])
    assert.throws(() => format('Date', value), /Invalid cluster/);
  for (const value of ['24:00', '12:60', '13:00 PM', '1:01:60'])
    assert.throws(() => format('Time', value), /Invalid cluster/);
  assert.throws(() => format('Date', '2026/11/09', 'DateFormat=MMM dd, yyyy'), /not implemented/);
  assert.throws(
    () => format('CalendarDate', '2026/11/09 13:14:59', 'UseTime=1;DateFormat=yyyy年MM月dd日 HH時mm分'),
    /not implemented/,
  );
});

test('calculated sheet values preserve entered results and use their own numeric/date/text display rules without evaluating formulas', () => {
  assert.deepEqual(format('Calculate', '1234.565', 'Decimal=2;Comma=1;Prefix=$;Suffix= USD'), {
    value: '1234.565',
    display: '$1,234.57 USD',
  });
  assert.equal(format('Calculate', '0', 'Comma=1').display, '0');
  assert.equal(format('Calculate', '1.25', 'Decimal=1;TruncateZeroMode=1').display, '1.3');
  assert.equal(format('Calculate', 'text', 'Prefix=[;Suffix=]').display, '[text]');
  assert.equal(format('Calculate', '1.2000', 'DataType=2;Decimal=3;TruncateZeroMode=1;Prefix=$').display, '1.2');
  assert.equal(format('Calculate', '001.2000', 'DataType=2;Decimal=3').display, '001.2000');
  assert.equal(format('Calculate', 'text', 'DataType=2;Prefix=$').display, 'text');
  assert.equal(format('Calculate', '20261109', 'DataType=1;DateFormat=yyyy/MM/dd').display, '2026/11/09');
  assert.equal(format('Calculate', '131415', 'DataType=1;DateFormat=HH:mm:ss').display, '13:14:15');
  assert.equal(format('Calculate', '20260229', 'DataType=1;DateFormat=yyyy/MM/dd').display, '20260229');
  assert.equal(format('Calculate', 'bad result', 'DataType=1;DateFormat=yyyy/MM/dd').display, 'bad result');
  assert.equal(format('Calculate', 'unchanged', 'DataType=3;Prefix=$').display, 'unchanged');
  assert.deepEqual(format('Calculate', '', 'Prefix=$'), { value: '', display: '' });
});

test('time calculations display source int32 milliseconds as numerical units or formatted components', () => {
  assert.equal(
    format('TimeCalculate', '5400000', 'TimeCalculateType=1;InputType=Numerical;TimeUnit=Hour').display,
    '1',
  );
  assert.equal(
    format('TimeCalculate', '-5400000', 'TimeCalculateType=1;InputType=Numerical;TimeUnit=Minute').display,
    '-90',
  );
  assert.equal(
    format('TimeCalculate', '5400123', 'TimeCalculateType=1;InputType=Numerical;TimeUnit=Second;Suffix=s').display,
    '5400s',
  );
  assert.equal(
    format('TimeCalculate', '5400123', 'TimeCalculateType=1;InputType=Formatted;DateFormat=HH:mm:ss.000').display,
    '01:30:00.123',
  );
  assert.equal(
    format('TimeCalculate', '-5400123', 'TimeCalculateType=1;InputType=Formatted;DateFormat=HH時mm分ss秒').display,
    '01時30分00秒',
  );
  assert.equal(
    format('TimeCalculate', '123', 'TimeCalculateType=1;InputType=Formatted;DateFormat=ss.0000000').display,
    '00.1230000',
  );
  assert.equal(
    format('TimeCalculate', '5400123', "TimeCalculateType=1;InputType=Formatted;DateFormat=hh' hours '").display,
    '01 hours ',
  );
  for (const value of ['2147483648', '-2147483649', '1.5', 'NaN'])
    assert.throws(
      () => format('TimeCalculate', value, 'TimeCalculateType=1;InputType=Numerical;TimeUnit=Second'),
      /Invalid cluster/,
    );
  assert.throws(
    () => format('TimeCalculate', '1', 'TimeCalculateType=1;InputType=Formatted;DateFormat=HHH'),
    /not implemented/,
  );
  assert.throws(
    () =>
      format('NumberHours', '121', 'TimeCalculateType=1;InputType=Formatted;TimeUnit=Hour;Maximum=2;DateFormat=HH:mm'),
    /minimum or maximum/,
  );
});
