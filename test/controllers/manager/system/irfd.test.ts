import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateIrfdTemplate } from '../../../../src/controllers/manager/system/irfd.js';

test('IRFD template validation converts duration and rejects invalid fields', () => {
  const valid = validateIrfdTemplate({
    TemplateId: -1,
    TemplateName: 'Field template',
    DocumentMobileSave: '1',
    DocumentLifeTimeDay: '1',
    DocumentLifeTimeHour: '2',
    DocumentLifeTimeMinute: '5',
    UseEndTime: '2024/02/29',
    IsOtherAppOpen: '0',
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.documentLifeTime, 1565);
  assert.equal(valid.useEndTime, '2024-02-29');

  const invalid = validateIrfdTemplate({
    TemplateId: -1,
    TemplateName: ' ',
    DocumentMobileSave: '1',
    DocumentLifeTimeDay: '-1',
    DocumentLifeTimeHour: '',
    DocumentLifeTimeMinute: '1.5',
    UseEndTime: '2023/02/29',
    IsOtherAppOpen: '0',
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.TemplateName);
  assert.ok(invalid.errors.DocumentLifeTimeDay);
  assert.ok(invalid.errors.DocumentLifeTimeMinute);
  assert.ok(invalid.errors.UseEndTime);
});

test('IRFD lint cleanup retains date validation and the existing Number-based decimal boundary', () => {
  const input = {
    TemplateId: -1,
    TemplateName: 'Fixture',
    DocumentMobileSave: '79228162514264337593543950335',
    DocumentLifeTimeDay: '',
    DocumentLifeTimeHour: '',
    DocumentLifeTimeMinute: '',
    UseEndTime: '2/29/2024',
    IsOtherAppOpen: '0',
  };
  const valid = validateIrfdTemplate(input);
  assert.equal(valid.valid, true);
  assert.equal(valid.useEndTime, '2024-02-29');
  assert.equal(valid.documentMobileSave, Number(79228162514264337593543950335n));
  assert.equal(validateIrfdTemplate({ ...input, DocumentMobileSave: '792281625142643375935439503350' }).valid, false);
  assert.equal(validateIrfdTemplate({ ...input, UseEndTime: '2/29/2023' }).valid, false);
});
