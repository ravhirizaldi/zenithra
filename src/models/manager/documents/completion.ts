import type pg from 'pg';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { clientSettingsDirectory } from '../../../shared/license-counts.js';
import { child, children, must, optionalField, root, type XmlNode } from '../../client-definition-xml.js';
import { ReportUnsupported } from '../../client-reports.js';

type Database = Pick<pg.Pool, 'query'>;
type RequiredCluster = {
  rep_sheet_id: number;
  cluster_type: string;
  input_parameter: string | null;
  input_value: string | null;
  verified: string | null;
  has_image: boolean;
};

// InputReportRepository.IsAllRequired(id, false), including its case-sensitive ordinary-field check.
export function documentAllRequired(rows: RequiredCluster[], includeApprovals = false): boolean {
  const checks = rows
    .filter((row) => row.cluster_type === 'Check' && row.input_parameter)
    .map((row) => {
      let group = '-1',
        required = false;
      for (const parameter of row.input_parameter!.split(';')) {
        const [name, value] = parameter.split('=');
        if (value === undefined) continue;
        if (name === 'Group') group = value;
        if (name === 'Required' && (value === '1' || value.toUpperCase() === 'TRUE')) required = true;
      }
      return { ...row, group, required, checked: row.input_value?.toUpperCase() === 'TRUE' || row.verified === '1' };
    });
  return (
    rows.every((row) => {
      if (
        row.cluster_type === 'Check' ||
        row.verified === '1' ||
        (!/Required=(?:true|1)/.test(row.input_parameter ?? '') &&
          !(includeApprovals && row.cluster_type === 'Approve'))
      )
        return true;
      if (['FixedText', 'Image', 'DrawingImage', 'FreeText', 'FreeDraw'].includes(row.cluster_type))
        return row.has_image;
      if (row.cluster_type === 'Approve') return row.input_value === '4';
      return row.input_value !== null && row.input_value !== '';
    }) &&
    checks.every(
      (row) =>
        !row.required ||
        (!(row.group === '-1' && !row.checked && (!row.input_value || row.input_value.toUpperCase() === 'FALSE')) &&
          checks.some(
            (other) => other.rep_sheet_id === row.rep_sheet_id && other.group === row.group && other.checked,
          )),
    )
  );
}

export async function documentRequiredComplete(db: Database, id: number, includeApprovals = false): Promise<boolean> {
  return documentAllRequired(
    (
      await db.query<RequiredCluster>(
        `SELECT c.rep_sheet_id,c.cluster_type,c.input_parameter,c.input_value,c.verified,
    COALESCE(octet_length(c.image_file),0)>0 AS has_image FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id)
    WHERE s.rep_top_id=$1`,
        [id],
      )
    ).rows,
    includeApprovals,
  );
}

export async function checkDocumentCompletionFeatures(
  db: Database,
  id: number,
  top: XmlNode,
  output: string,
  mail: string,
): Promise<void> {
  const unsupported = (code: string) => {
    throw new ReportUnsupported(
      'Report completion requires an unmigrated ' + code + ' pipeline.',
      'report_completion_' + code,
    );
  };
  // shortcut: configured outputs/layouts/notifications are refused even when inactive; refine with their complete delivery pipelines.
  if (
    (
      await db.query(
        `SELECT 1 FROM binder_rep_src src JOIN rep_top r ON r.rep_top_org=src.rep_top_org WHERE r.rep_top_id=$1 LIMIT 1`,
        [id],
      )
    ).rowCount
  )
    unsupported('binder');
  const common = (
    await db.query("SELECT com_name,com_value FROM mst_common WHERE com_key='OUTPUT_SETTING' ORDER BY com_index")
  ).rows;
  const setting = (name: string) => String(common.find((row) => row.com_name === name)?.com_value ?? '');
  if (output !== '0' && setting('FINISH') === 'true') unsupported('output');

  const layout = (
    await db.query(
      `SELECT l.auto_output_layout,l.cooperation_view_output_layout FROM data_output_layout l JOIN def_top d USING(def_top_org)
    WHERE d.def_top_id=$1`,
      [Number(optionalField(top, 'defTopId'))],
    )
  ).rows[0];
  if (output !== '0') {
    if (layout?.auto_output_layout) unsupported('interface');
    if (
      (
        await db.query('SELECT 1 FROM def_external_output WHERE def_top_id=$1 AND enabled_system_types<>0', [
          Number(optionalField(top, 'defTopId')),
        ])
      ).rowCount
    )
      unsupported('external_output');
    const settings = clientSettingsDirectory();
    if (settings) {
      let files: string[];
      try {
        files = await readdir(join(settings, 'interface', 'report'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        files = [];
      }
      if (files.length) {
        const revisions = (
          await db.query(
            `SELECT def_top_id FROM def_top WHERE def_top_org=(SELECT def_top_org FROM def_top WHERE def_top_id=$1) OR def_top_id=$1`,
            [Number(optionalField(top, 'defTopId'))],
          )
        ).rows;
        if (revisions.some((row) => files.includes(String(row.def_top_id) + '.xml'))) unsupported('interface');
      }
    }
  }
  if (layout?.cooperation_view_output_layout) {
    const views = child(must(root(layout.cooperation_view_output_layout), 'top'), 'views');
    if (
      views &&
      children(views, 'view').some((view) => {
        const cloud = child(view, 'mbcloud');
        return cloud && optionalField(cloud, 'enabled') === '1';
      })
    )
      unsupported('cloud_notification');
  }
  if (mail.trim()) unsupported('mail');
  const defaultMail = (await db.query('SELECT xml_data FROM mst_mail WHERE mail_file_name=$1', ['MailComplete.xml']))
    .rows[0]?.xml_data;
  if (defaultMail && (root(defaultMail)[':@'] as Record<string, string> | undefined)?.['@_default'])
    unsupported('mail');
  const management = child(top, 'management');
  if (management && ['completeDirect', 'completeWebhook'].some((name) => optionalField(management, name).trim()))
    unsupported('notification');
  const direct = (await db.query('SELECT xml_data FROM mst_direct WHERE key=$1', ['Complete'])).rows[0]?.xml_data;
  if (direct && optionalField(root(direct), 'defaultTemplateId')) unsupported('notification');
}
