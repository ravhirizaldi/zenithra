import type pg from 'pg';
import { hostname } from 'node:os';
import {
  child,
  children,
  integerField,
  must,
  optionalField,
  replace,
  root,
  serialize,
} from '../../client-definition-xml.js';
import { reportNameDate, setReportName } from '../../client-report-name.js';
import { checkReportTables, saveReportTables } from '../../client-report-tables.js';
import { ReportUnsupported } from '../../client-reports.js';
import { LabelValidationError } from '../labels/index.js';
import { documentDetail } from './details.js';
import { documentSettings } from './index.js';
import { documentSaveNumbering } from './numbering.js';
import { documentRefreshThumbnail } from './thumbnail.js';
import { text as pageText } from '../../../config/manager/documents/resources.js';

const remarks = (prefix: string) =>
  Array.from({ length: 10 }, (_, i) => `${prefix}_remarks_name${i + 1} ${prefix}_remarks${i + 1}`).join(' ');
const audit = 'sys_regist_term sys_regist_user sys_regist_time sys_update_term sys_update_user sys_update_time';
// InputReportRepository.CopyTop's explicit column lists: new revisions retain original registration and input/approval values.
const topColumns = `rep_top_id def_top_id rep_top_name report_type rep_sheet_count auto_gen mobile_save remarks_edit public_status complete_mail edit_mail xml_data
  ${remarks('top')} edit_refer_status deleted ${audit} sys_regist_user_name sys_update_user_name rep_top_org rev_no auto_select_gen thumbnail csv_url pdf_url
  def_file def_file_type def_file_name thumbnail_file background_image_file finish_output edit_output mobile_report_save display_sheet_number server_version
  pic_original_resolution image_size excel_output can_send_mail_as_attachment can_open_as_pdf report_copy_enable mobile_edit_type use_applicant_lock use_input_history
  use_init_input_judge use_init_input_judge_parameters use_exclusive_mode use_exclusive_mode_manager def_top_org system_key1 system_key2 system_key3 system_key4 system_key5
  no_need_to_fill_type no_need_to_fill_string use_change_reason is_sort_report journalizing_def_top_id required_check_mode required_save_mode calculate_mode
  pdf_auto_output_sheet_select pdf_auto_output_sheet_select_no auto_numbering_value auto_numbering_message auto_numbering_save_count auto_numbering_display_save_count
  fd_sheet_info finish_output_files edit_output_files use_identification`;
const sheetColumns = `rep_sheet_id rep_top_id def_sheet_id rep_sheet_name rep_sheet_no background_image input_image thumbnail import_image xml_data ${remarks('sheet')}
  ${audit} auto_select_gen copy_disable image_url background_image_file thumbnail_file input_image_file sheet_no_org`;
const clusterColumns = `rep_sheet_id cluster_id cluster_name cluster_type input_parameter left_position right_position top_position bottom_position input_value display_value
  applicant applicant_name applicant_comment applicant_date approver approver_name approver_date approver_comment approval_sign apply_mail approve_mail remand_mail change_mail
  ${audit} cell_addr image_file binary_file comment_value comment_input_parameters edit_user edit_user_name edit_time gps_lat gps_lon gps_alt
  ${Array.from({ length: 10 }, (_, i) => 'cluster_remarks' + (i + 1)).join(' ')} verified change_reason binary_file_win binary_file_type pin_value is_hidden recording_file recording_file_extension`;

export async function documentCopy(db: pg.Pool, id: number, user: string, locale: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const source = (await client.query('SELECT * FROM rep_top WHERE rep_top_id=$1 FOR UPDATE', [id])).rows[0];
    const report = await documentDetail(client, id, user);
    const settings = await documentSettings(client);
    const role = (
      await client.query(
        `SELECT MAX(role_rep_super_manager)=1 AS super,MAX(role_rep_update_manager)=1 AS update FROM mst_group g JOIN mst_group_affiation a USING(group_id) WHERE a.user_id=$1`,
        [user],
      )
    ).rows[0];
    if (
      !report ||
      (settings.managerRoleType === '1' ? !role?.super : !report.role_update || !(role?.super || role?.update))
    )
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    if (
      report.locked ||
      report.workflow_locked ||
      Number(report.deleted) !== 0 ||
      (Number(report.edit_refer_status) !== 4 && report.current)
    )
      throw new LabelValidationError('', pageText['This report cannot be edited in its current state.']);
    if (!(await client.query('SELECT 1 FROM def_top WHERE def_top_id=$1', [report.def_top_id])).rowCount)
      throw new LabelValidationError('', pageText['The original form is unavailable. No changes were saved.']);
    const xml = root(source.xml_data),
      top = must(xml, 'top');
    if (integerField(top, 'repTopId') !== id || integerField(top, 'defTopId') !== Number(report.def_top_id))
      throw new Error(pageText['Report XML identity differs.']);
    const org = Number(source.rep_top_org ?? id);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['report-revision:' + org]);
    const latest = (
      await client.query(
        'SELECT rev_no,public_status FROM rep_top WHERE rep_top_org=$1 AND rev_no=(SELECT COALESCE(MAX(rev_no),1) FROM rep_top WHERE rep_top_org=$1) ORDER BY rep_top_id DESC LIMIT 1',
        [org],
      )
    ).rows[0];
    const revision = Number(latest?.rev_no ?? 1) + 1;
    if (!Number.isSafeInteger(revision) || revision > 2147483647) throw new Error('Invalid report revision.');
    if ((await client.query('SELECT 1 FROM binder_rep_src WHERE rep_top_org=$1 LIMIT 1', [org])).rowCount)
      throw new ReportUnsupported('Report copy requires an unmigrated binder pipeline.', 'report_copy_binder');
    await checkReportTables(client, top);
    const privateOnly = (
      await client.query("SELECT relpersistence='t' AS private FROM pg_class WHERE oid='rep_top'::regclass")
    ).rows[0].private;
    const prefix = privateOnly ? 'pg_temp.' : '';
    const next = (await client.query('SELECT nextval($1::regclass) AS id', [prefix + 'rep_top_rep_top_id_seq'])).rows[0]
      .id;
    const now = new Date(),
      terminal = hostname(),
      date = reportNameDate(now, 'yyyy/MM/dd HH:mm:ss');
    const actor =
      (await client.query('SELECT user_name FROM mst_user WHERE user_id=$1', [user])).rows[0]?.user_name ?? '';
    const updates = { sys_update_term: terminal, sys_update_user: user, sys_update_time: now };
    const fresh = { ...updates, sys_regist_term: terminal, sys_regist_user: user, sys_regist_time: now };
    const copy = async (
      table: string,
      columns: string,
      overrides: Record<string, unknown>,
      where: string,
      values: unknown[],
    ) => {
      const fields = columns.trim().split(/\s+/);
      const expressions = fields.map((field) => {
        if (!Object.hasOwn(overrides, field)) return field;
        values.push(overrides[field]);
        return '$' + values.length;
      });
      await client.query(
        `INSERT INTO ${table}(${fields.join(',')}) SELECT ${expressions.join(',')} FROM ${table} WHERE ${where}`,
        values,
      );
    };
    await copy(
      'rep_top',
      topColumns,
      {
        ...updates,
        sys_update_user_name: actor,
        rep_top_id: next,
        rep_top_org: org,
        rev_no: revision,
        public_status: latest?.public_status ?? 2,
        edit_refer_status: 1,
        ...(optionalField(top, 'useAutoNumbering') === '1' && child(top, 'autoNumbering')
          ? {}
          : {
              auto_numbering_value: null,
              auto_numbering_message: null,
              auto_numbering_save_count: null,
              auto_numbering_display_save_count: '0',
            }),
      },
      'rep_top_id=$1',
      [id],
    );
    for (const [table, columns] of [
      ['rep_role', 'rep_top_id group_id role_rep_read role_rep_update role_rep_delete'],
      ['rep_label', 'rep_top_id mst_label_id'],
      ['rep_report_document', 'rep_top_id document_id'],
    ])
      await copy(table, columns + ' ' + audit, { ...fresh, rep_top_id: next }, 'rep_top_id=$1', [id]);
    // The source copies FreeDraw sheets from the report origin, not the selected historical revision.
    await copy(
      'rep_fd_sheet',
      'top_id fd_sheet_no sheet_index pdf_file irfd_file ' + audit,
      { ...fresh, top_id: next },
      'top_id=$1',
      [org],
    );
    const storedSheets = (
      await client.query('SELECT rep_sheet_id FROM rep_sheet WHERE rep_top_id=$1 ORDER BY rep_sheet_no', [id])
    ).rows;
    const sheets = children(must(top, 'sheets'), 'sheet');
    if (sheets.length !== storedSheets.length) throw new Error(pageText['Report XML identity differs.']);
    for (const old of storedSheets) {
      const sheet = sheets.find((sheet) => integerField(sheet, 'repSheetId') === Number(old.rep_sheet_id));
      if (!sheet) throw new Error(pageText['Report XML identity differs.']);
      const sheetId = (
        await client.query('SELECT nextval($1::regclass) AS id', [prefix + 'rep_sheet_rep_sheet_id_seq'])
      ).rows[0].id;
      replace(sheet, 'repSheetId', String(sheetId));
      await copy(
        'rep_sheet',
        sheetColumns,
        { ...updates, rep_sheet_id: sheetId, rep_top_id: next, xml_data: serialize(sheet) },
        'rep_sheet_id=$1',
        [old.rep_sheet_id],
      );
      for (const [table, columns] of [
        ['rep_cluster', clusterColumns],
        ['rep_layer', 'rep_sheet_id layer_id rep_top_id rep_sheet_no image_file binary_file ' + audit],
        [
          'rep_reference',
          'rep_sheet_id reference_id rep_top_id rep_sheet_no reference_type reference_name reference_value diplay_number document_id ' +
            audit,
        ],
        ['rep_cluster_role', 'rep_sheet_id cluster_id group_id ' + audit],
        ['rep_cluster_refer', 'rep_sheet_id cluster_id group_id ' + audit],
        ['rep_layer_draw', 'rep_sheet_id key_id image_no image_file ' + audit],
        ['rep_cluster_draw', 'rep_sheet_id key_id image_no image_file ' + audit],
      ])
        await copy(table, columns, { ...fresh, rep_sheet_id: sheetId, rep_top_id: next }, 'rep_sheet_id=$1', [
          old.rep_sheet_id,
        ]);
    }
    const numbering = await documentSaveNumbering(client, Number(next), top, user, now, locale, 'copy');
    setReportName(top, now, numbering.regenerateName);
    replace(top, 'repTopId', String(next));
    replace(top, 'repTopOrg', String(org));
    replace(top, 'editStatus', '1');
    replace(top, 'publicStatus', String(source.public_status ?? ''));
    for (const name of ['regist', 'update']) {
      replace(top, name + 'Time', date);
      replace(top, name + 'User', user);
    }
    await client.query('UPDATE rep_top SET xml_data=$2,rep_top_name=$3 WHERE rep_top_id=$1', [
      next,
      serialize(xml),
      optionalField(top, 'repTopName'),
    ]);
    await saveReportTables(
      client,
      top,
      new Set(
        sheets.flatMap((sheet) =>
          children(must(sheet, 'clusters'), 'cluster').map(
            (cluster) => integerField(sheet, 'sheetNo') + ',' + integerField(cluster, 'clusterId'),
          ),
        ),
      ),
      locale,
    );
    await client.query('DELETE FROM rep_current WHERE rep_top_org=$1', [org]);
    await client.query('INSERT INTO rep_current(rep_top_id,rep_top_org) VALUES($1,$2)', [next, org]);
    if ([...numbering.changed].some((key) => key.startsWith('1,')))
      await documentRefreshThumbnail(client, Number(next), Number(report.def_top_id), user, locale);
    await client.query('COMMIT');
    return Number(next);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
