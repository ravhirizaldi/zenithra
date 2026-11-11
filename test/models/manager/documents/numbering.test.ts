import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numberingParts, nextNumberReset } from '../../../../src/models/manager/documents/numbering.js';
import { must, root } from '../../../../src/models/client-definition-xml.js';

const top = must(
  root(
    '<conmas><top><repTopName>Report</repTopName><registUser>fixture</registUser><registUserName>Fixture user</registUserName><sheets><sheet><sheetNo>3</sheetNo><clusters><cluster><clusterId>2</clusterId><value>raw</value><displayValue>Display</displayValue></cluster></clusters></sheet></sheets></top></conmas>',
  ),
  'top',
);
const rule = (parts: string, extra = '') =>
  root(
    '<autoNumbering><startValue>1</startValue><increment>1</increment><digit>4</digit><zeroPadding>1</zeroPadding><numberingTiming>1</numberingTiming>' +
      extra +
      parts +
      '</autoNumbering>',
  );
const part = (id: number, type: string, value = '') =>
  `<part><partId>${id}</partId><type>${type}</type><value>${value}</value></part>`;

test('numbering formats every legacy part type with exact zero padding and deterministic ordering', () => {
  const now = new Date(2026, 10, 11, 9, 15, 0);
  assert.equal(
    numberingParts(
      top,
      rule(
        part(5, 'autoNumber') +
          part(1, 'value', 'IR-') +
          part(2, 'date', 'yyyyMMdd') +
          part(3, 'user', 'id') +
          part(4, 'report', 'repTopName') +
          part(6, 'inputValue', '3,2') +
          part(7, 'displayValue', '3,2') +
          part(8, 'user', 'name') +
          part(9, 'time', 'HHmm') +
          part(10, 'dateTime', 'yyyy-MM-dd HH:mm'),
      ),
      now,
      '7',
    ),
    'IR-20261111fixtureReport0007rawDisplayFixture user09152026-11-11 09:15',
  );
  const saveCount = rule(part(1, 'autoNumber') + part(2, 'saveCount'), '<useSaveCount>1</useSaveCount>');
  assert.throws(() => numberingParts(top, saveCount, now, '7'), /automatic-numbering/);
  const firstSave = root(
    '<autoNumbering><startValue>1</startValue><increment>1</increment><digit>2</digit><zeroPadding>0</zeroPadding><numberingTiming>0</numberingTiming><useSaveCount>1</useSaveCount>' +
      part(1, 'autoNumber') +
      part(2, 'saveCount') +
      '</autoNumbering>',
  );
  assert.equal(numberingParts(top, firstSave, now, '7'), '7{SAVE_COUNT}');
});

test('invalid numbering settings reject before issuing a sequence value', () => {
  const now = new Date(2026, 10, 11);
  for (const [parts, extra] of [
    [part(1, 'autoNumber') + part(2, 'autoNumber'), ''],
    [part(0, 'autoNumber'), ''],
    [part(1, 'autoNumber') + part(2, 'unknown'), ''],
    [part(1, 'autoNumber') + part(2, 'inputValue', '3,404'), ''],
    [part(1, 'autoNumber') + part(2, 'saveCount'), ''],
    [part(1, 'autoNumber'), '<numberingCyclicEnabled>invalid</numberingCyclicEnabled>'],
  ])
    assert.throws(() => numberingParts(top, rule(parts, extra), now, '1'));
});

test('scheduled numbering resets preserve daily intervals, Monday-based week cycles and month-end/leap rules', () => {
  const reset = (extra: string) => root('<reset><startDate>2026/01/01</startDate>' + extra + '</reset>');
  const daily = reset('<termType>1</termType><interval>3</interval>');
  assert.equal(
    nextNumberReset(daily, new Date(2026, 0, 1, 2), new Date(2026, 0, 5)).getTime(),
    new Date(2026, 0, 7, 2).getTime(),
  );
  const weekly = reset('<termType>2</termType><interval>2</interval><week>1,5</week>');
  for (const date of ['2026/02/31', '2026/13/01', '0000/01/01'])
    assert.throws(
      () =>
        nextNumberReset(
          root(
            '<reset><startDate>' +
              date +
              '</startDate><termType>2</termType><interval>1</interval><week>1</week></reset>',
          ),
          new Date(2026, 0, 1),
          new Date(2026, 0, 2),
        ),
      /automatic-numbering/,
    );
  assert.equal(
    nextNumberReset(weekly, new Date(2026, 0, 2, 2), new Date(2026, 0, 3)).getTime(),
    new Date(2026, 0, 12, 2).getTime(),
  );
  const monthly = reset('<termType>3</termType><month>2,4</month><day>99</day>');
  assert.equal(
    nextNumberReset(monthly, new Date(2028, 0, 31, 2), new Date(2028, 1, 1)).getTime(),
    new Date(2028, 1, 29, 2).getTime(),
  );
  const impossible = reset('<termType>3</termType><month>2</month><day>30</day>');
  assert.throws(() => nextNumberReset(impossible, new Date(2026, 0, 1), new Date(2026, 0, 2)), /automatic-numbering/);
  assert.throws(
    () => nextNumberReset(reset('<termType>1</termType><interval>0</interval>'), new Date(), new Date()),
    /automatic-numbering/,
  );
});
