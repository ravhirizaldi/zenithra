import { text as pageText } from '../../../config/manager/documents/resources.js';
import type pg from 'pg';
import { hostname } from 'node:os';
import { documentDetail, documentDetailId } from './details.js';
import { labelChecked, labelString, LabelValidationError } from '../labels/index.js';
import {
  child,
  children,
  content,
  element,
  must,
  optionalField,
  root,
  serialize,
  set,
  type XmlNode,
} from '../../client-definition-xml.js';
import { saveReportTables } from '../../client-report-tables.js';
import { reportNameDate, setReportName } from '../../client-report-name.js';
import { updateReportAutoLabels } from '../../client-report-labels.js';
import { documentApplicantLocked, documentClusters } from './clusters.js';
import { reportNotificationOptions, reportNotificationValues } from '../common/notifications.js';
import { validPrintPages } from '../../../shared/print-pages.js';
import { checkDocumentCompletionFeatures, documentRequiredComplete } from './completion.js';
import { documentSaveNumbering } from './numbering.js';
import { documentDocuWorksAvailable } from './output.js';

type Database = Pick<pg.Pool, 'query'>;
export type TopField = {
  name: string;
  label: string;
  value: string;
  options?: string[];
  editable: boolean;
  column?: string;
  xml?: string;
};
const fields: Array<[string, string, string | null, string | null, string[]?, boolean?]> = [
  ['rep_top_name', 'rep_top_name', 'rep_top_name', 'repTopName'],
  [
    'mobile_report_save',
    'mobile_report_save',
    'mobile_report_save',
    'mobileReportSave',
    ['YES_NO_STATE_NO', 'YES_NO_STATE_YES'],
  ],
  [
    'output_setting',
    'output_setting',
    'finish_output',
    'finishOutput',
    ['YES_NO_STATE_NO', 'SettingSystemFile', 'SettingPerFile'],
  ],
  [
    'edit_output_setting',
    'edit_output_setting',
    'edit_output',
    'editOutput',
    ['YES_NO_STATE_NO', 'SettingSystemFile', 'SettingPerFile'],
  ],
  [
    'PdfAutoOutputSheetSelect',
    'PdfAutoOutputSheetSetting',
    'pdf_auto_output_sheet_select',
    null,
    ['allData', 'SetPage'],
  ],
  ['PdfAutoOutputSheetSelectNo', 'SetPage', 'pdf_auto_output_sheet_select_no', null],
  [
    'use_applicant_lock',
    'ApplicantLockSetting',
    'use_applicant_lock',
    null,
    ['YES_NO_STATE_NO', 'YES_NO_STATE_YES'],
    true,
  ],
  [
    'use_input_history',
    'ClusterHistorySetting',
    'use_input_history',
    null,
    ['SELECTED_CLUSTER_HISTORY_LEVEL_0', 'SELECTED_CLUSTER_HISTORY_LEVEL_1', 'SELECTED_CLUSTER_HISTORY_LEVEL_2'],
    true,
  ],
  [
    'use_init_input_judge',
    'InitInputJudgeSetting',
    'use_init_input_judge',
    null,
    ['YES_NO_STATE_NO', 'YES_NO_STATE_YES'],
    true,
  ],
  [
    'use_change_reason',
    'ClusterChangeReasonSetting',
    'use_change_reason',
    'useChangeReason',
    ['YES_NO_STATE_NO', 'YES_NO_STATE_YES'],
    true,
  ],
  [
    'use_exclusive_mode',
    'use_exclusive_mode',
    'use_exclusive_mode',
    null,
    ['YES_NO_STATE_NO', 'YES_NO_STATE_YES'],
    true,
  ],
  [
    'use_exclusive_mode_manager',
    'use_exclusive_mode_manager',
    'use_exclusive_mode_manager',
    null,
    ['YES_NO_STATE_NO', 'YES_NO_STATE_YES'],
    true,
  ],
  [
    'no_need_to_fill_type',
    'NoNeedToFillType',
    'no_need_to_fill_type',
    'noNeedToFillOutType',
    Array.from({ length: 8 }, (_, i) => 'NoNeedToFillType' + i),
  ],
  ['no_need_to_fill_string', 'NoNeedToFillString', 'no_need_to_fill_string', 'noNeedToFillOutString'],
  [
    'no_need_to_fill_out_mode',
    'NoNeedToFillOutMode',
    null,
    'noNeedToFillOutMode',
    ['NoNeedToFillOutMode0', 'NoNeedToFillOutMode1'],
  ],
  ['IsReportCopy', 'ReportCopyEnable', 'report_copy_enable', 'isReportCopy', ['YES_NO_STATE_NO', 'YES_NO_STATE_YES']],
  [
    'reportCopyType',
    'ReportCopyType',
    null,
    'reportCopyType',
    ['CopyReportSameDef', 'CopyReportCurrentDef', 'CopyReportSelectType'],
  ],
  [
    'required_check_mode',
    'RequiredCheckMode',
    'required_check_mode',
    null,
    ['SELECTED_REQUIRED_CHECK_MODE_0', 'SELECTED_REQUIRED_CHECK_MODE_1'],
    true,
  ],
  [
    'required_save_mode',
    'RequiredSaveMode',
    'required_save_mode',
    null,
    ['SELECTED_REQUIRED_SAVE_MODE_0', 'SELECTED_REQUIRED_SAVE_MODE_1'],
    true,
  ],
  ['CalculateMode', 'calculate_mode', 'calculate_mode', null, ['double型', 'decimal型']],
  ['IndexType', 'IndexType', null, 'indexType', ['ClusterIndexDisplayNo', 'MobileListDisplayNo']],
  ['UseVoiceInputEndTime', 'VoiceInputEndTime', null, null, ['YES_NO_STATE_NO', 'YES_NO_STATE_YES']],
  ['VoiceInputEndTime', 'VoiceInputEndTime', null, 'voiceInputEndTime'],
  [
    'NetworkAnswerbackMode',
    'NetworkAnswerbackMode',
    null,
    'networkAnswerbackMode',
    ['YES_NO_STATE_NO', 'YES_NO_STATE_YES'],
  ],
];
export const documentPatchXml = (node: XmlNode, name: string, value: string) => {
  const existing = child(node, name);
  if (existing) set(existing, value);
  else content(node).push(element(name, value));
};
export const documentOutputFields = [
  'Csv',
  'CsvImageAudio',
  'CsvZip',
  'DataOutputCsv',
  'DataOutputCsvImageAudio',
  'Xml',
  'Pdf',
  'PdfLayer',
  'Docuworks',
  'Excel',
] as const;
export const documentLineColors = [
  ['255,0,0', 'Red'],
  ['0,0,0', 'Black'],
  ['255,255,255', 'White'],
  ['125,125,125', 'Gray'],
  ['255,255,153', 'LightYellow'],
  ['255,255,0', 'Yellow'],
  ['255,153,0', 'Orange'],
  ['255,102,153', 'Pink'],
  ['204,0,255', 'VioletRed'],
  ['102,153,255', 'Purple'],
  ['0,51,255', 'Blue'],
  ['153,204,255', 'LightBlue'],
  ['102,255,0', 'LightGreen'],
  ['0,102,0', 'Green'],
  ['153,102,0', 'Brown'],
];

export async function documentTop(db: Database, id: number, user: string, locale = 'en-US') {
  const report = await documentDetail(db, id, user);
  if (!report) throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
  const row = (
    await db.query(
      "SELECT t.*,to_char(t.sys_regist_time,'YYYY/MM/DD HH24:MI') AS registered,to_char(t.sys_update_time,'YYYY/MM/DD HH24:MI') AS updated,COALESCE(NULLIF(t.sys_regist_user_name,''),NULLIF(u.user_name,''),t.sys_regist_user,'') AS created_by,COALESCE(NULLIF(t.sys_update_user_name,''),NULLIF(v.user_name,''),t.sys_update_user,'') AS updated_by FROM rep_top t LEFT JOIN mst_user u ON u.user_id=t.sys_regist_user LEFT JOIN mst_user v ON v.user_id=t.sys_update_user WHERE t.rep_top_id=$1",
      [id],
    )
  ).rows[0];
  const [definition, option, history, sheets, common] = await Promise.all([
    db.query('SELECT def_top_id,def_top_name,def_file_type FROM def_top WHERE def_top_id=$1', [report.def_top_id]),
    db.query('SELECT pdf_fontsize_deduction FROM rep_top_option WHERE rep_top_id=$1', [id]),
    db.query(
      `SELECT t.rep_top_id,t.rep_top_name,t.rev_no,t.public_status,
      to_char(t.sys_regist_time,'YYYY/MM/DD HH24:MI') AS registered,to_char(t.sys_update_time,'YYYY/MM/DD HH24:MI') AS updated,
      COALESCE(NULLIF(t.sys_regist_user_name,''),NULLIF(u.user_name,''),t.sys_regist_user,'') AS created_by,
      COALESCE(NULLIF(t.sys_update_user_name,''),NULLIF(v.user_name,''),t.sys_update_user,'') AS updated_by
      FROM rep_top t LEFT JOIN mst_user u ON u.user_id=t.sys_regist_user LEFT JOIN mst_user v ON v.user_id=t.sys_update_user
      WHERE t.rep_top_org=(SELECT rep_top_org FROM rep_top WHERE rep_top_id=$1) AND t.deleted=0
      AND EXISTS(SELECT 1 FROM rep_role r JOIN mst_group_affiation a USING(group_id) WHERE r.rep_top_id=t.rep_top_id AND r.role_rep_read>0 AND a.user_id=$2)
      ORDER BY t.rev_no,t.rep_top_id`,
      [id, user],
    ),
    db.query('SELECT rep_sheet_id,rep_sheet_no FROM rep_sheet WHERE rep_top_id=$1 ORDER BY rep_sheet_no', [id]),
    db.query(
      "SELECT com_key,com_name,com_value FROM mst_common WHERE com_key IN ('HISTORY_SETTING','CONMAS_FUNCTION','FUNCTION_SETTING','OUTPUT_SETTING','ROLE_SETTING','CUSTOM_GRID') ORDER BY com_index",
    ),
  ]);
  const xml = must(root(row.xml_data), 'top');
  const topFields: TopField[] = fields.map(([name, label, column, xmlName, options, definitionEdit]) => ({
    name,
    label,
    value: String((column ? row[column] : optionalField(xml, xmlName ?? name)) ?? ''),
    options,
    editable: !definitionEdit || report.def_role_update,
    column: column ?? undefined,
    xml: xmlName ?? undefined,
  }));
  const field = (name: string) => topFields.find((item) => item.name === name)!;
  field('IsReportCopy').value = optionalField(xml, 'isReportCopy') || '1';
  field('IsReportCopy').editable = optionalField(xml, 'reportCopySetting') !== '0';
  for (const name of ['reportCopyType', 'IndexType', 'NetworkAnswerbackMode', 'no_need_to_fill_out_mode'])
    field(name).value ||= '0';
  for (const name of ['mobile_report_save', 'output_setting', 'edit_output_setting']) field(name).value ||= '1';
  for (const item of topFields) if (item.options) item.value ||= '0';
  field('PdfAutoOutputSheetSelect').value ||= '0';
  field('UseVoiceInputEndTime').value = optionalField(xml, 'voiceInputEndTime') ? '1' : '0';
  const commonValue = (key: string, name: string) =>
    common.rows.find((row) => row.com_key === key && row.com_name === name)?.com_value ?? '';
  field('CalculateMode').editable = commonValue('CONMAS_FUNCTION', 'CALCULATE_MODE_FUNCTION') === '1';
  for (let index = 1; index <= 10; index++)
    topFields.push({
      name: 'top_remarks' + index,
      label: String(row['top_remarks_name' + index] ?? ''),
      value: String(row['top_remarks' + index] ?? ''),
      editable: true,
      column: 'top_remarks' + index,
      xml: 'remarksValue' + index,
    });
  for (let index = 1; index <= 5; index++)
    topFields.push({
      name: 'system_key' + index,
      label: 'system_key',
      value: String(row['system_key' + index] ?? ''),
      editable: true,
      column: 'system_key' + index,
    });
  let format: XmlNode | undefined;
  try {
    format = row.use_init_input_judge_parameters
      ? child(root(row.use_init_input_judge_parameters), 'format')
      : undefined;
  } catch {
    /* FindTop falls back to the default initial-input formatting. */
  }
  topFields.push({
    name: 'InitInputJudgeColor',
    label: 'LineColor',
    value: format ? optionalField(format, 'color') : '255,0,0',
    editable: report.def_role_update,
  });
  const thickness = format ? optionalField(format, 'thickness') : '';
  topFields.push({
    name: 'InitInputJudgeThickness',
    label: 'LineThickness',
    value: /^[1-5]$/.test(thickness) ? thickness : '1',
    editable: report.def_role_update,
  });
  const management = child(xml, 'management');
  const notificationOptions = await reportNotificationOptions(db, locale);
  const notifications = [
    ['edit_mail', 'edit_mail', String(row.edit_mail ?? '')],
    ['complete_mail', 'complete_mail', String(row.complete_mail ?? '')],
    ...['editDirect', 'completeDirect', 'editWebhook', 'completeWebhook'].map((name) => [
      name.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()),
      name.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()),
      management ? optionalField(management, name) : '',
    ]),
  ].map(([name, label, value]) => ({
    name,
    label: name.endsWith('_mail')
      ? label
      : name
          .replace(/^([a-z])/, (letter) => letter.toUpperCase())
          .replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()) + pageText['Templete'],
    value,
    multiple: name.endsWith('_direct'),
    options: notificationOptions.get(name),
  }));
  const outputs = [
    ['output_files', 'finishOutputFiles', row.finish_output_files],
    ['edit_output_files', 'editOutputFiles', row.edit_output_files],
  ].map(([name, xmlName, source]) => {
    const node = source ? root(source) : child(xml, xmlName);
    return {
      name,
      xmlName,
      fields: documentOutputFields.map((name) => ({
        name,
        checked: !!node && optionalField(node, name[0].toLowerCase() + name.slice(1)) === '1',
      })),
    };
  });
  return {
    reportHeading: commonValue('CUSTOM_GRID', 'REP_REPORT'),
    xdwDownload: await documentDocuWorksAvailable(id, commonValue('OUTPUT_SETTING', 'XDW_MANUAL_OUTPUT')),
    managerRoleType: commonValue('ROLE_SETTING', 'MANAGER_INPUT_REPORT_MANGERROLE_TYPE'),
    showNumbering: optionalField(xml, 'useAutoNumbering') === '1' && !!child(xml, 'autoNumbering'),
    csvDownload: (commonValue('OUTPUT_SETTING', 'CSV_MANUAL_OUTPUT') || 'true').toUpperCase() === 'TRUE',
    pdfDownload: (commonValue('OUTPUT_SETTING', 'PDF_MANUAL_OUTPUT') || 'true').toUpperCase() === 'TRUE',
    excelRecovery:
      commonValue('FUNCTION_SETTING', 'EXCELFILE_RECOVERY') === '1' &&
      (commonValue('OUTPUT_SETTING', 'EXCEL_MANUAL_OUTPUT') || 'true').toUpperCase() === 'TRUE',
    canForceComplete: !!(
      await db.query(
        `SELECT 1 FROM mst_group g JOIN mst_group_affiation a USING(group_id) WHERE a.user_id=$1 AND g.role_rep_super_manager=1 LIMIT 1`,
        [user],
      )
    ).rowCount,
    report: { ...row, ...report, applicant_locked: await documentApplicantLocked(db, id, user) },
    definition: definition.rows[0],
    fields: topFields,
    sheets: sheets.rows,
    fontDeduction: String(option.rows[0]?.pdf_fontsize_deduction ?? ''),
    history: history.rows,
    historyEnabled:
      ['1', '2'].includes(commonValue('HISTORY_SETTING', 'ENABLE')) || Number(row.use_input_history) !== 0,
    notifications,
    outputs,
    lineColors: documentLineColors,
    attachment: (optionalField(xml, 'canSendMailAsAttachment') || '1') === '1',
    openPdf: optionalField(xml, 'canOpenAsPdf') === '1',
    biometrics: optionalField(xml, 'useBiometrics') === '1',
    identification: optionalField(xml, 'useIdentification') === '1',
    audioFormat: optionalField(xml, 'audioRecordingFileFormat') === '1' ? 'wav' : 'm4a',
  };
}

export async function documentEditLock(db: pg.Pool, id: number, user: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT rep_top_id FROM rep_top WHERE rep_top_id=$1 FOR UPDATE', [id]);
    const report = await documentDetail(client, id, user, true);
    if (!report) throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    if (
      report.workflow_locked ||
      !report.current ||
      Number(report.deleted) !== 0 ||
      Number(report.edit_refer_status) === 4 ||
      (await documentApplicantLocked(client, id, user)) ||
      (await client.query('SELECT 1 FROM rep_lock WHERE rep_top_id=$1 AND user_id<>$2', [id, user])).rowCount
    ) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO rep_lock(rep_top_id,user_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      VALUES($1,$2,$3,$2,LOCALTIMESTAMP,$3,$2,LOCALTIMESTAMP) ON CONFLICT(rep_top_id) DO UPDATE SET user_id=$2,sys_regist_term=$3,sys_regist_user=$2,sys_regist_time=LOCALTIMESTAMP,sys_update_term=$3,sys_update_user=$2,sys_update_time=LOCALTIMESTAMP`,
      [id, user, hostname()],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function documentSaveTop(
  db: pg.Pool,
  id: number,
  input: Record<string, unknown>,
  user: string,
  locale = 'en-US',
) {
  for (const key of ['IsComplete', 'IsCompleteSuperManager'])
    if (Object.hasOwn(input, key) && !['true', 'false'].includes(labelString(input[key]).toLowerCase()))
      throw new LabelValidationError(key, pageText['Invalid setting value.']);
  const forced = labelChecked(input.IsCompleteSuperManager),
    complete = forced || labelChecked(input.IsComplete);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT rep_top_id FROM rep_top WHERE rep_top_id=$1 FOR UPDATE', [id]);
    const model = await documentTop(client, id, user, locale);
    if (!model.report.role_update)
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    if ((await client.query('SELECT 1 FROM rep_lock WHERE rep_top_id=$1 AND user_id<>$2', [id, user])).rowCount)
      throw new LabelValidationError('', pageText['The report is locked by another user.']);
    if (
      model.report.workflow_locked ||
      !model.report.current ||
      Number(model.report.deleted) !== 0 ||
      Number(model.report.edit_refer_status) === 4 ||
      model.report.applicant_locked
    )
      throw new LabelValidationError('', pageText['This report cannot be edited in its current state.']);
    if (forced && !model.canForceComplete)
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    if (complete && !forced && !(await documentRequiredComplete(client, id)))
      throw new LabelValidationError(
        'IsComplete',
        pageText['Required inputs are missing. The report cannot be completed.'],
      );
    const xml = root(model.report.xml_data),
      top = must(xml, 'top');
    if (
      documentDetailId(optionalField(top, 'repTopId')) !== id ||
      (complete && documentDetailId(optionalField(top, 'defTopId')) !== Number(model.report.def_top_id))
    )
      throw new Error(pageText['Report XML identity differs.']);
    const updates = new Map<string, string>();
    for (const field of model.fields) {
      const key = 'rep_top.' + field.name;
      if (!Object.hasOwn(input, key)) continue;
      let value = labelString(input[key]);
      if (field.name === 'UseVoiceInputEndTime') {
        if (!['true', 'false', '0', '1'].includes(value.toLowerCase()))
          throw new LabelValidationError(key, pageText['Invalid setting value.']);
        value = ['true', '1'].includes(value.toLowerCase()) ? '1' : '0';
      }
      if (!field.editable && value !== field.value)
        throw new LabelValidationError('access', pageText['A form-controlled setting cannot be changed.']);
      if (field.options && !field.options.some((_, index) => String(index) === value))
        throw new LabelValidationError(key, pageText['Invalid setting value.']);
      if (value.length > 4000) throw new LabelValidationError(key, pageText['The value is too long.']);
      field.value = value;
      if (field.column) updates.set(field.column, value);
      if (field.xml && !(field.name === 'no_need_to_fill_string' && !value)) documentPatchXml(top, field.xml, value);
    }
    // Settings-only SaveTop stores event selections without sending notifications.
    const supported = new Set(model.fields.map((field) => 'rep_top.' + field.name));
    supported.add('rep_top.finish_reason');
    const reason = Object.hasOwn(input, 'rep_top.finish_reason')
      ? labelString(input['rep_top.finish_reason'])
      : String(model.report.finish_reason ?? '');
    if (reason.length > 4000)
      throw new LabelValidationError('rep_top.finish_reason', pageText['The value is too long.']);
    if (
      Object.hasOwn(input, 'rep_top.finish_reason') &&
      !model.canForceComplete &&
      reason !== String(model.report.finish_reason ?? '')
    )
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    for (const notification of model.notifications) {
      const key = 'rep_top.' + notification.name;
      supported.add(key);
      if (!Object.hasOwn(input, key)) continue;
      const values = reportNotificationValues(input[key], notification.multiple),
        selected = values.join(',');
      if (selected === notification.value) continue;
      if (
        !notification.options ||
        values.some((value) => value && !notification.options!.some((option) => option.value === value))
      )
        throw new LabelValidationError(key, pageText['Select an available notification template.']);
      if (notification.name.endsWith('_mail')) {
        updates.set(notification.name, selected);
        // EditTopXmlData updates completeMail only; edit_mail is relational in Manager.
        if (notification.name === 'complete_mail') documentPatchXml(top, 'completeMail', selected);
      } else {
        const management = child(top, 'management') ?? element('management', []);
        if (!child(top, 'management')) content(top).push(management);
        documentPatchXml(
          management,
          notification.name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
          selected,
        );
      }
    }
    for (const output of model.outputs) {
      const setting = model.fields.find(
        (field) => field.name === (output.name === 'output_files' ? 'output_setting' : 'edit_output_setting'),
      )!;
      const posted = output.fields.some((field) => Object.hasOwn(input, `rep_top.${output.name}.${field.name}`));
      for (const field of output.fields) {
        const key = `rep_top.${output.name}.${field.name}`;
        supported.add(key);
        if (!Object.hasOwn(input, key)) continue;
        if (!['true', 'false'].includes(labelString(input[key]).toLowerCase()))
          throw new LabelValidationError(key, pageText['Invalid output setting.']);
        field.checked = labelChecked(input[key]);
      }
      if (posted || Object.hasOwn(input, 'rep_top.' + setting.name)) {
        const existing = child(top, output.xmlName);
        if (setting.value === '2') {
          const node = existing ?? element(output.xmlName, []);
          for (const field of output.fields)
            documentPatchXml(node, field.name[0].toLowerCase() + field.name.slice(1), field.checked ? '1' : '0');
          if (!existing) content(top).push(node);
          updates.set(output.name === 'output_files' ? 'finish_output_files' : 'edit_output_files', serialize(node));
        } else {
          if (existing) content(top).splice(content(top).indexOf(existing), 1);
          updates.set(output.name === 'output_files' ? 'finish_output_files' : 'edit_output_files', '');
        }
      }
    }
    for (const key of Object.keys(input))
      if (
        (key.startsWith('rep_top.') && !supported.has(key) && key !== 'rep_top.rep_top_id') ||
        (key.startsWith('rep_top_option.') && key !== 'rep_top_option.PdfFontSizeDeductionAmount')
      )
        throw new LabelValidationError(
          'pending',
          pageText['This report setting has not been migrated. No changes were saved.'],
        );
    const get = (name: string) => model.fields.find((field) => field.name === name)!.value;
    if (!get('rep_top_name').trim())
      throw new LabelValidationError('rep_top.rep_top_name', pageText['Enter a report name.']);
    if (
      get('UseVoiceInputEndTime') === '1' &&
      (!/^\d+$/.test(get('VoiceInputEndTime')) ||
        Number(get('VoiceInputEndTime')) < 10 ||
        Number(get('VoiceInputEndTime')) > 1000)
    )
      throw new LabelValidationError('rep_top.VoiceInputEndTime', pageText['Enter an integer from 10 to 1000.']);
    if (Object.hasOwn(input, 'rep_top.UseVoiceInputEndTime') && get('UseVoiceInputEndTime') !== '1')
      documentPatchXml(top, 'voiceInputEndTime', '');
    if (!/^[1-5]$/.test(get('InitInputJudgeThickness')))
      throw new LabelValidationError('rep_top.InitInputJudgeThickness', pageText['Enter a thickness from 1 to 5.']);
    if (
      get('PdfAutoOutputSheetSelect') === '1' &&
      (!get('PdfAutoOutputSheetSelectNo').trim() || !validPrintPages(get('PdfAutoOutputSheetSelectNo')))
    )
      throw new LabelValidationError(
        'rep_top.PdfAutoOutputSheetSelectNo',
        pageText['Enter valid output page numbers.'],
      );
    if (Object.hasOwn(input, 'rep_top.required_check_mode') && get('required_check_mode') !== '1')
      updates.set('required_save_mode', '1');
    if (Object.hasOwn(input, 'rep_top.InitInputJudgeColor') || Object.hasOwn(input, 'rep_top.InitInputJudgeThickness'))
      updates.set(
        'use_init_input_judge_parameters',
        serialize(
          element('useInitInputJudgeParameters', [
            element('format', [
              element('color', get('InitInputJudgeColor')),
              element('thickness', get('InitInputJudgeThickness')),
            ]),
          ]),
        ),
      );
    const font = Object.hasOwn(input, 'rep_top_option.PdfFontSizeDeductionAmount')
      ? labelString(input['rep_top_option.PdfFontSizeDeductionAmount']).trim()
      : model.fontDeduction;
    if (font && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(font) || Number(font) < 0.1 || Number(font) > 10))
      throw new LabelValidationError(
        'rep_top_option.PdfFontSizeDeductionAmount',
        pageText['Enter a font deduction from 0.1 to 10.'],
      );
    const now = new Date();
    documentPatchXml(top, 'updateUser', user);
    documentPatchXml(top, 'updateTime', reportNameDate(now, 'yyyy/MM/dd HH:mm:ss'));
    let numbered = new Set<string>();
    if (complete) {
      await checkDocumentCompletionFeatures(
        client,
        id,
        top,
        get('output_setting'),
        updates.get('complete_mail') ?? String(model.report.complete_mail ?? ''),
      );
      updates.set('edit_refer_status', '4');
      documentPatchXml(top, 'editStatus', '4');
      const numbering = await documentSaveNumbering(client, id, top, user, now, locale);
      numbered = numbering.changed;
      setReportName(top, now, numbering.regenerateName);
      updates.set('rep_top_name', optionalField(top, 'repTopName'));
      if (forced) {
        updates.set('finish_compulsory_type', '1');
        updates.set('finish_reason', reason);
      }
    }
    const parameters: unknown[] = [id, user, hostname(), now, serialize(xml)];
    const assignments = [
      'sys_update_user=$2',
      'sys_update_user_name=(SELECT user_name FROM mst_user WHERE user_id=$2)',
      'sys_update_term=$3',
      'sys_update_time=$4',
      'xml_data=$5',
    ];
    for (const [column, value] of updates) {
      parameters.push(column.endsWith('_output_files') && !value ? null : value);
      assignments.push(column + '=$' + parameters.length);
    }
    await client.query(`UPDATE rep_top SET ${assignments.join(',')} WHERE rep_top_id=$1`, parameters);
    await client.query(
      `INSERT INTO rep_top_option(rep_top_id,pdf_fontsize_deduction,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      VALUES($1,$2,$3,$4,$5,$3,$4,$5) ON CONFLICT(rep_top_id) DO UPDATE SET pdf_fontsize_deduction=$2,sys_update_term=$3,sys_update_user=$4,sys_update_time=$5`,
      [id, font || null, hostname(), user, now],
    );
    await saveReportTables(client as pg.PoolClient, top, numbered, locale);
    await updateReportAutoLabels(
      client,
      must(root(model.report.xml_data), 'top'),
      top,
      {
        userId: user,
        userName:
          (await client.query('SELECT user_name FROM mst_user WHERE user_id=$1', [user])).rows[0]?.user_name ?? '',
        terminalId: hostname(),
      },
      now,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function documentApprovalRows(db: Database, id: number, user: string) {
  const rows = (await documentClusters(db, id, user)).filter((row) => row.cluster_type === 'Approve');
  if (!rows.length) return [];
  const top = must(
    root((await db.query('SELECT xml_data FROM rep_top WHERE rep_top_id=$1', [id])).rows[0].xml_data),
    'top',
  );
  return rows.map((row) => {
    const sheet = children(must(top, 'sheets'), 'sheet').find(
      (node) => optionalField(node, 'repSheetId') === String(row.rep_sheet_id),
    );
    const cluster =
      sheet &&
      children(must(sheet, 'clusters'), 'cluster').find(
        (node) => optionalField(node, 'clusterId') === String(row.cluster_id),
      );
    return { ...row, approval_read_only: !cluster || optionalField(cluster, 'readOnly') === '1' };
  });
}
