import type pg from 'pg';
import { hostname } from 'node:os';
import {
  child,
  children,
  must,
  optionalField,
  integerField,
  replace,
  root,
  serialize,
  value,
} from '../../client-definition-xml.js';
import { documentDetail } from './details.js';
import { documentClusters, documentApplicantLocked } from './clusters.js';
import { documentRequiredComplete, checkDocumentCompletionFeatures } from './completion.js';
import { documentSaveNumbering } from './numbering.js';
import { documentRefreshThumbnail } from './thumbnail.js';
import { reportNameDate, setReportName } from '../../client-report-name.js';
import { checkReportTables, saveReportTables } from '../../client-report-tables.js';
import { updateReportAutoLabels } from '../../client-report-labels.js';
import { ReportUnsupported } from '../../client-reports.js';
import { LabelValidationError } from '../labels/index.js';
import { text as pageText } from '../../../config/manager/documents/resources.js';

// InputReportRepository.ApproveClusterMain; unsupported delivery/network work must fail before the transaction commits.
export async function documentApprove(
  db: pg.Pool,
  id: number,
  sheetId: number,
  clusterId: number,
  status: string,
  comment: string,
  user: string,
  locale: string,
) {
  if (!['3', '4'].includes(status))
    throw new LabelValidationError('approveEditStatus', pageText['Invalid setting value.']);
  if (comment.length > 4000) throw new LabelValidationError('approveComment', pageText['The value is too long.']);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const stored = (await client.query('SELECT * FROM rep_top WHERE rep_top_id=$1 FOR UPDATE', [id])).rows[0];
    const report = await documentDetail(client, id, user, true);
    if (
      !report ||
      report.locked ||
      report.workflow_locked ||
      !report.current ||
      Number(report.deleted) !== 0 ||
      Number(report.edit_refer_status) === 4 ||
      (await documentApplicantLocked(client, id, user))
    )
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    const selected = (await documentClusters(client, id, user, sheetId)).find(
      (row) => Number(row.cluster_id) === clusterId,
    );
    if (
      !selected ||
      selected.cluster_type !== 'Approve' ||
      selected.cluster_role !== '1' ||
      selected.input_value !== '2'
    )
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    const xml = root(stored.xml_data),
      top = must(xml, 'top'),
      previous = must(root(stored.xml_data), 'top');
    if (integerField(top, 'repTopId') !== id || integerField(top, 'defTopId') !== Number(report.def_top_id))
      throw new Error(pageText['Report XML identity differs.']);
    const sheets = children(must(top, 'sheets'), 'sheet');
    const sheet = sheets.find((node) => optionalField(node, 'repSheetId') === String(sheetId));
    const cluster =
      sheet &&
      children(must(sheet, 'clusters'), 'cluster').find(
        (node) => optionalField(node, 'clusterId') === String(clusterId),
      );
    if (!sheet || !cluster || optionalField(cluster, 'readOnly') === '1')
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    const unsupported = (code: string) => {
      throw new ReportUnsupported(
        'Report approval requires an unmigrated ' + code + ' pipeline.',
        'report_approval_' + code,
      );
    };
    if (Number(stored.journalizing_def_top_id) > 0) unsupported('journalizing');
    const networks = child(top, 'networks');
    if (networks && children(networks, 'network').length) unsupported('network');
    if (
      (
        await client.query(
          'SELECT 1 FROM binder_rep_src src JOIN rep_top t ON t.rep_top_org=src.rep_top_org WHERE t.rep_top_id=$1 LIMIT 1',
          [id],
        )
      ).rowCount
    )
      unsupported('binder');
    await checkReportTables(client, top);
    const targets = [{ sheet, cluster }];
    const carbon = child(cluster, 'carbonCopy');
    for (const target of carbon ? children(carbon, 'targetCluster') : []) {
      const otherSheet = sheets.find((node) => optionalField(node, 'sheetNo') === optionalField(target, 'sheetNo'));
      const otherCluster =
        otherSheet &&
        children(must(otherSheet, 'clusters'), 'cluster').find(
          (node) => optionalField(node, 'clusterId') === optionalField(target, 'clusterId'),
        );
      if (otherSheet && otherCluster) targets.push({ sheet: otherSheet, cluster: otherCluster });
    }
    const event = status === '4' ? 'Approve' : 'Remand';
    // shortcut: configured notifications are refused even when disabled; refine with the delivery pipelines.
    for (const { cluster: target } of targets) {
      const management = child(target, 'management');
      if (management && value(management).trim()) unsupported('notification');
    }
    if (
      (
        await client.query(
          `SELECT 1 FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id) WHERE s.rep_top_id=$1 AND (COALESCE(c.approve_mail,'')<>'' OR COALESCE(c.remand_mail,'')<>'') LIMIT 1`,
          [id],
        )
      ).rowCount
    )
      unsupported('mail');
    const mail = (
      await client.query('SELECT xml_data FROM mst_mail WHERE mail_file_name=$1', ['Mail' + event + '.xml'])
    ).rows[0]?.xml_data;
    if (mail && (root(mail)[':@'] as Record<string, string> | undefined)?.['@_default']) unsupported('mail');
    const direct = (await client.query('SELECT xml_data FROM mst_direct WHERE key=$1', [event])).rows[0]?.xml_data;
    if (direct && optionalField(root(direct), 'defaultTemplateId')) unsupported('notification');
    if (
      (await client.query(`SELECT 1 FROM mst_webhook WHERE ${status === '4' ? 'approve' : 'remand'}=true LIMIT 1`))
        .rowCount
    )
      unsupported('notification');
    const history =
      Number(stored.use_input_history) !== 0 ||
      (
        await client.query(
          "SELECT 1 FROM mst_common WHERE com_key='HISTORY_SETTING' AND com_name='ENABLE' AND com_value IN ('1','2')",
        )
      ).rowCount;
    if (
      history &&
      !(
        await client.query(
          `SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='rep_cluster'::regclass AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND p.proname='func_rep_cluster_trigger' AND (t.tgtype::int & 21)=21`,
        )
      ).rowCount
    )
      throw new LabelValidationError(
        'pending',
        pageText['Report history trigger is unavailable. No changes were saved.'],
      );
    const now = new Date(),
      date = reportNameDate(now, 'yyyy/MM/dd HH:mm:ss');
    const actor = (await client.query('SELECT user_name,approval_sign FROM mst_user WHERE user_id=$1', [user])).rows[0];
    const changed = new Set<string>();
    for (const target of targets) {
      let parameters = optionalField(target.cluster, 'inputParameters');
      const lock = status === '4' && target.cluster === cluster && optionalField(top, 'reEditDisable') === '1';
      if (lock) {
        const pairs = new Map(
          parameters
            .split(';')
            .filter((part) => part.includes('='))
            .map((part) => {
              const [key, ...values] = part.split('=');
              return [key, values.join('=')];
            }),
        );
        pairs.set('Locked', '1');
        parameters = [...pairs].map(([key, value]) => key + '=' + value).join(';');
        replace(target.cluster, 'inputParameters', parameters);
        replace(target.sheet, 'copyDisable', '1');
        await client.query('UPDATE rep_sheet SET copy_disable=1 WHERE rep_sheet_id=$1', [
          integerField(target.sheet, 'repSheetId'),
        ]);
      }
      const row = (
        await client.query(
          `UPDATE rep_cluster SET input_value=$3,display_value=$3,approver=$4,approver_name=$5,approver_date=$6,approver_comment=$7,
        approval_sign=CASE WHEN $3='4' THEN $8 ELSE approval_sign END,verified='0',input_parameter=CASE WHEN $9 THEN $10 ELSE input_parameter END,
        sys_update_term=$11,sys_update_user=$4,sys_update_time=$6 WHERE rep_sheet_id=$1 AND cluster_id=$2 RETURNING *`,
          [
            integerField(target.sheet, 'repSheetId'),
            integerField(target.cluster, 'clusterId'),
            status,
            user,
            actor?.user_name ?? '',
            now,
            comment,
            actor?.approval_sign ?? null,
            lock,
            parameters,
            hostname(),
          ],
        )
      ).rows[0];
      if (!row) throw new Error(pageText['Report XML identity differs.']);
      replace(target.cluster, 'value', status);
      replace(target.cluster, 'displayValue', status);
      replace(target.cluster, 'verified', '0');
      if (['Approve', 'Create', 'Inspect'].includes(row.cluster_type)) {
        replace(target.cluster, 'approver', user);
        replace(target.cluster, 'approverName', actor?.user_name ?? '');
        replace(target.cluster, 'approvalDate', date);
        replace(target.cluster, 'approverComment', comment);
        replace(target.cluster, 'approvalSignImage', row.approval_sign ?? '');
        if (row.cluster_type === 'Approve') {
          replace(target.cluster, 'applicant', row.applicant ?? '');
          replace(target.cluster, 'applicantName', row.applicant_name ?? '');
          replace(target.cluster, 'applicantComment', row.applicant_comment ?? '');
          replace(
            target.cluster,
            'applicationDate',
            row.applicant_date ? reportNameDate(row.applicant_date, 'yyyy/MM/dd HH:mm:ss') : '',
          );
        }
      }
      changed.add(optionalField(target.sheet, 'sheetNo') + ',' + integerField(target.cluster, 'clusterId'));
    }
    const approvals = (
      await client.query(
        "SELECT c.input_value FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id) WHERE s.rep_top_id=$1 AND c.cluster_type='Approve'",
        [id],
      )
    ).rows.map((row) => row.input_value);
    const editStatus = approvals.every((value) => value === '4')
      ? (await documentRequiredComplete(client, id, true))
        ? '4'
        : '1'
      : approvals.includes('3')
        ? '3'
        : approvals.includes('2')
          ? '2'
          : '1';
    replace(top, 'editStatus', editStatus);
    replace(top, 'updateUser', user);
    replace(top, 'updateUserName', actor?.user_name ?? '');
    replace(top, 'updateTime', date);
    if (editStatus === '4')
      await checkDocumentCompletionFeatures(
        client,
        id,
        top,
        String(stored.finish_output ?? '1'),
        String(stored.complete_mail ?? ''),
      );
    const numbering = await documentSaveNumbering(client, id, top, user, now, locale, 'sheet');
    for (const key of numbering.changed) changed.add(key);
    setReportName(top, now, numbering.regenerateName);
    for (const targetSheet of new Set(targets.map((target) => target.sheet)))
      await client.query('UPDATE rep_sheet SET xml_data=$2 WHERE rep_sheet_id=$1', [
        integerField(targetSheet, 'repSheetId'),
        serialize(targetSheet),
      ]);
    await client.query(
      `UPDATE rep_top SET xml_data=$2,edit_refer_status=$3,rep_top_name=$4,sys_update_user=$5,sys_update_user_name=$6,sys_update_term=$7,sys_update_time=$8 WHERE rep_top_id=$1`,
      [id, serialize(xml), editStatus, optionalField(top, 'repTopName'), user, actor?.user_name ?? '', hostname(), now],
    );
    await saveReportTables(client, top, changed, locale);
    await updateReportAutoLabels(
      client,
      previous,
      top,
      { userId: user, userName: actor?.user_name ?? '', terminalId: hostname() },
      now,
    );
    if ([...changed].some((key) => key.startsWith('1,')))
      await documentRefreshThumbnail(client, id, Number(report.def_top_id), user, locale);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
