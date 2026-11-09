import type pg from 'pg';
import { child, children, element, integer, optionalField, type XmlNode } from './client-definition-xml.js';
import { reportNameDate } from './client-report-name.js';
import { reportTableValue } from './client-report-tables.js';

type Database = Pick<pg.PoolClient, 'query'>;
type Actor = { userId: string; userName: string; terminalId: string };
type Label = {
  mst_label_id: number;
  upper_label_id: number | null;
  label_id_path: string;
  label_name_path: string;
  auto_label_name: string;
  report_update_type: number;
  auto_slash_hierarchy: number;
  bottom_layer: number;
  label_icon_id: number;
  diplay_number: number;
  label_remarks: string;
  auto_delete: number;
};
const reportFields = ['repTopName', ...Array.from({ length: 10 }, (_, index) => 'remarksValue' + (index + 1))];
const excludedClusters = new Set([
  'FixedText',
  'FreeText',
  'FreeDraw',
  'Check',
  'Image',
  'Create',
  'Inspect',
  'Approve',
  'Gps',
  'Action',
  'DrawingImage',
  'DrawingPinNo',
  'PinItemTableNo',
  'AudioRecording',
  'Scandit',
]);
const clusterTokens = (rule: string) =>
  [...rule.matchAll(/\{clusterDisplayValue_\d+_\d+\}/g), ...rule.matchAll(/\{clusterValue_\d+_\d+\}/g)].map(
    (match) => match[0],
  );
function clusterValue(top: XmlNode, token: string) {
  const [type, sheetNo, clusterId] = token.slice(1, -1).split('_');
  const sheets = child(top, 'sheets');
  const sheet = sheets && children(sheets, 'sheet').find((node) => optionalField(node, 'sheetNo') === sheetNo);
  const clusters = sheet && child(sheet, 'clusters');
  const cluster =
    clusters && children(clusters, 'cluster').find((node) => optionalField(node, 'clusterId') === clusterId);
  return !cluster || excludedClusters.has(optionalField(cluster, 'type'))
    ? ''
    : optionalField(cluster, type === 'clusterValue' ? 'value' : 'displayValue');
}
function labelParts(top: XmlNode, template: Label, actor: Actor, registered: Date) {
  const escape = (text: string) => (Number(template.auto_slash_hierarchy) === 1 ? text.replaceAll('/', '@／@') : text);
  let rule = template.auto_label_name ?? '';
  for (const name of ['defTopName', ...reportFields])
    rule = rule.replaceAll('{report:' + name + '}', escape(optionalField(top, name)));
  for (const format of ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss'])
    rule = rule.replaceAll('{regist:' + format + '}', reportNameDate(registered, format));
  rule = rule.replaceAll('{regist:User}', escape(actor.userId)).replaceAll('{regist:UserName}', escape(actor.userName));
  for (const token of clusterTokens(rule)) rule = rule.replaceAll(token, escape(clusterValue(top, token)));
  return rule
    .split('/')
    .map((part) => (Number(template.auto_slash_hierarchy) === 1 ? part.replaceAll('@／@', '/') : part));
}
async function templates(db: Database, top: XmlNode): Promise<Label[]> {
  const id = integer(optionalField(top, 'defTopId'));
  if (id === undefined) return [];
  return (
    await db.query<Label>(
      `SELECT m.* FROM mst_label_rep m WHERE m.auto_creation=1
    AND EXISTS(SELECT 1 FROM def_rep_label l WHERE l.mst_label_id=m.mst_label_id AND l.def_top_id=$1)`,
      [id],
    )
  ).rows;
}
function registrationDate(top: XmlNode, now: Date) {
  const value = reportTableValue(
    element('cluster', [element('type', 'Date'), element('value', optionalField(top, 'registTime'))]),
    'D',
    'en-US',
    true,
  );
  return value ? new Date(value.replace(' ', 'T')) : now;
}
async function parentLabel(db: Database, template: Label) {
  return (await db.query<Label>('SELECT * FROM mst_label_rep WHERE mst_label_id=$1', [template.upper_label_id]))
    .rows[0];
}
async function existingLabel(db: Database, path: string) {
  return (
    await db.query<Label>(
      'SELECT * FROM mst_label_rep WHERE COALESCE(auto_creation,0)=0 AND label_name_path=$1 LIMIT 1',
      [path],
    )
  ).rows[0];
}
async function createLabel(db: Database, top: XmlNode, template: Label, actor: Actor, now: Date, registered: Date) {
  const parts = labelParts(top, template, actor, registered);
  let parent = await parentLabel(db, template);
  for (const [index, name] of parts.entries()) {
    // LabelManager stops at the first empty part, even in bottom-layer-only mode.
    if (!name) break;
    const path = (parent ? parent.label_name_path + '/' : '') + name;
    let label = await existingLabel(db, path);
    if (!label) {
      const id = Number((await db.query("SELECT nextval('mst_label_def_mst_label_id_seq') AS id")).rows[0].id);
      const idPath = (parent ? parent.label_id_path + '/' : '') + id;
      await db.query(
        `INSERT INTO mst_label_rep(mst_label_id,upper_label_id,label_name,label_id_path,label_name_path,
        label_icon_id,diplay_number,label_remarks,auto_delete,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10,$11,$12)`,
        [
          id,
          parent?.mst_label_id ?? null,
          name,
          idPath,
          path,
          template.label_icon_id,
          template.diplay_number,
          template.label_remarks,
          template.auto_delete ?? 0,
          actor.terminalId,
          actor.userId,
          now,
        ],
      );
      await db.query(
        `INSERT INTO rep_label_role(mst_label_id,group_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
        SELECT $1,group_id,$2,$3,$4,$2,$3,$4 FROM rep_label_role WHERE mst_label_id=$5`,
        [id, actor.terminalId, actor.userId, now, template.mst_label_id],
      );
      label = { ...template, mst_label_id: id, label_id_path: idPath, label_name_path: path };
    }
    if (Number(template.bottom_layer) !== 1 || index === parts.length - 1)
      await db.query(
        `INSERT INTO rep_label(rep_top_id,mst_label_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
        VALUES($1,$2,$3,$4,$5,$3,$4,$5) ON CONFLICT(rep_top_id,mst_label_id) DO NOTHING`,
        [integer(optionalField(top, 'repTopId')), label.mst_label_id, actor.terminalId, actor.userId, now],
      );
    parent = label;
  }
}

export async function attachedAutoDeleteLabels(db: Database, id: number) {
  return (
    await db.query<{ mst_label_id: number }>(
      `WITH RECURSIVE seeds AS (
    SELECT m.* FROM mst_label_rep m JOIN rep_label l USING(mst_label_id) WHERE l.rep_top_id=$1 AND m.auto_delete=1
  ), parents AS (
    SELECT * FROM seeds UNION SELECT m.* FROM mst_label_rep m JOIN parents p ON m.mst_label_id=p.upper_label_id WHERE p.auto_delete=1
  ), descendants AS (
    SELECT * FROM seeds UNION SELECT m.* FROM mst_label_rep m JOIN descendants d ON m.upper_label_id=d.mst_label_id WHERE d.auto_delete=1
  ) SELECT mst_label_id FROM mst_label_rep WHERE auto_delete=1
  AND mst_label_id IN (SELECT mst_label_id FROM parents UNION SELECT mst_label_id FROM descendants)
  ORDER BY label_name_path DESC,mst_label_id`,
      [id],
    )
  ).rows;
}
export async function deleteEmptyReportLabels(db: Database, labels: { mst_label_id: number }[], moveOnly = false) {
  for (const label of labels)
    await db.query(
      `DELETE FROM mst_label_rep m WHERE m.mst_label_id=$1 AND m.auto_delete=1 AND m.auto_creation<>1
      AND NOT EXISTS(SELECT 1 FROM mst_label_rep child WHERE child.upper_label_id=m.mst_label_id)
      AND NOT EXISTS(SELECT 1 FROM rep_label l ${moveOnly ? '' : 'JOIN rep_top t USING(rep_top_id)'}
        WHERE l.mst_label_id=m.mst_label_id ${moveOnly ? '' : 'AND t.deleted=0'})`,
      [label.mst_label_id],
    );
}

// Call inside the report transaction: generated labels, inherited roles and links must roll back with the report.
export async function createReportAutoLabels(db: Database, top: XmlNode, actor: Actor, now: Date) {
  if (integer(optionalField(top, 'repTopId')) === undefined) return;
  const rules = await templates(db, top);
  if (!rules.length) return;
  await db.query('LOCK TABLE mst_label_rep IN SHARE ROW EXCLUSIVE MODE');
  const registered = registrationDate(top, now);
  for (const template of rules) await createLabel(db, top, template, actor, now, registered);
}
export async function updateReportAutoLabels(
  db: Database,
  previous: XmlNode,
  top: XmlNode,
  actor: Actor,
  now: Date,
  moveOnly = false,
) {
  const id = integer(optionalField(top, 'repTopId'));
  if (id === undefined) return;
  const rules = await templates(db, top);
  // The source regenerates all update-enabled templates when any referenced cluster changes.
  const clusterChanged = rules
    .flatMap((rule) => clusterTokens(rule.auto_label_name ?? ''))
    .some((token) => clusterValue(previous, token) !== clusterValue(top, token));
  const changed = rules.filter(
    (rule) =>
      Number(rule.report_update_type) === 1 &&
      rule.auto_label_name &&
      (clusterChanged ||
        reportFields.some(
          (name) =>
            rule.auto_label_name.includes('{report:' + name + '}') &&
            optionalField(previous, name) !== optionalField(top, name),
        )),
  );
  if (!changed.length) return;
  await db.query('LOCK TABLE mst_label_rep IN SHARE ROW EXCLUSIVE MODE');
  const mode =
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='LABEL_SETTING' AND com_name='LABEL_AUTO_DELETE_MODE' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value || '1';
  const labels = mode === '1' ? await attachedAutoDeleteLabels(db, id) : [];
  const registered = registrationDate(top, now);
  let found = false;
  for (const template of changed) {
    let parent = await parentLabel(db, template);
    for (const name of labelParts(previous, template, actor, registered)) {
      if (!name) break;
      const label = await existingLabel(db, (parent ? parent.label_name_path + '/' : '') + name);
      if (!label) break;
      found = true;
      await db.query('DELETE FROM rep_label WHERE rep_top_id=$1 AND mst_label_id=$2', [id, label.mst_label_id]);
      parent = label;
    }
    await createLabel(db, top, template, actor, now, registered);
  }
  if (found) await deleteEmptyReportLabels(db, labels, moveOnly);
}
