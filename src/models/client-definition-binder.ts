import type pg from 'pg';
import {
  type XmlNode,
  child,
  children,
  field,
  must,
  optionalField,
  root,
  integerField,
} from './client-definition-xml.js';

const excluded = [
  'Calculate',
  'TimeCalculate',
  'MCNCalculate',
  'Registration',
  'RegistrationDate',
  'LatestUpdate',
  'LatestUpdateDate',
  'LoginUser',
  'Gps',
  'Action',
  'DrawingImage',
  'PinItemTableNo',
  'DrawingPinNo',
  'Scandit',
  'EdgeOCR',
];
function autoNumber(parameter: string): boolean {
  // InputParametersDictionary uses the first matching semicolon-delimited key.
  return (
    parameter
      .split(';')
      .find((item) => item.split('=')[0] === 'AutoNumber')
      ?.split('=')[1] === '1'
  );
}
function validTypes(source: Record<string, string>, dest: Record<string, string>): boolean {
  if (source.cluster_type !== dest.cluster_type)
    return (
      source.cluster_type === 'Calculate' &&
      ['KeyboardText', 'InputNumeric'].includes(dest.cluster_type) &&
      !autoNumber(dest.input_parameter ?? '')
    );
  return (
    !excluded.includes(dest.cluster_type) &&
    (dest.cluster_type !== 'KeyboardText' || !autoNumber(dest.input_parameter ?? ''))
  );
}

// BinderMappingOperator.CheckDefMapping: warnings are sticky, and mappings without edit rights are deliberately skipped.
export async function checkDefinitionBinder(
  client: pg.PoolClient,
  top: XmlNode,
  topId: number,
  orgId: number,
  userId: string,
  termId: string,
  now: Date,
): Promise<void> {
  const warnings = new Set<number>(),
    type = optionalField(top, 'workReportType');
  const workTable = optionalField(top, 'workReportTableNo') ? integerField(top, 'workReportTableNo') : null;
  const sources = (
    await client.query(
      'SELECT src.binder_def_id,binder.binder_type FROM binder_def_src src JOIN binder_def binder USING (binder_def_id) WHERE src.def_top_org=$1',
      [orgId],
    )
  ).rows;
  for (const row of sources)
    if ([1, 2].includes(Number(row.binder_type)) && Number(type || 0) !== 1) warnings.add(row.binder_def_id);
  const dests = (
    await client.query(
      'SELECT dest.binder_def_id,binder.binder_type FROM binder_def_dest dest JOIN binder_def binder USING (binder_def_id) WHERE dest.def_top_org=$1',
      [orgId],
    )
  ).rows;
  for (const row of dests) {
    if (![1, 2].includes(Number(row.binder_type))) continue;
    if (Number(type || 0) !== (Number(row.binder_type) === 1 ? 2 : 3)) warnings.add(row.binder_def_id);
    // Keep source's <> NULL semantics and its origin-wide test, followed by binder-wide deletion.
    if (
      (
        await client.query(
          'SELECT 1 FROM binder_def_mapping_table WHERE dest_def_top_org=$1 AND dest_table_no<>$2 LIMIT 1',
          [orgId, workTable],
        )
      ).rowCount
    ) {
      warnings.add(row.binder_def_id);
      await client.query('DELETE FROM binder_def_mapping_table WHERE binder_def_id=$1', [row.binder_def_id]);
    }
  }
  const tops = new Map<number, Record<string, unknown> | null>();
  async function editable(origin: number) {
    if (!tops.has(origin)) {
      const row = (
        await client.query(
          `SELECT top.def_top_id,top.xml_data FROM def_current cur JOIN def_top top USING (def_top_id)
        WHERE cur.def_top_org=$1 AND EXISTS (SELECT 1 FROM def_role role JOIN mst_group_affiation membership USING (group_id) WHERE role.def_top_id=top.def_top_id AND membership.user_id=$2 AND role.role_def_update>0)
        ORDER BY top.def_top_id DESC LIMIT 1`,
          [origin, userId],
        )
      ).rows[0];
      tops.set(origin, row ?? null);
    }
    return tops.get(origin);
  }
  async function cluster(id: unknown, sheet: unknown, clusterId: unknown) {
    return (
      await client.query(
        `SELECT cluster.cluster_type,cluster.input_parameter FROM def_sheet sheet JOIN def_cluster cluster USING (def_sheet_id)
      WHERE sheet.def_top_id=$1 AND sheet.def_sheet_no=$2 AND cluster.cluster_id=$3`,
        [id, sheet, clusterId],
      )
    ).rows[0];
  }
  for (const table of ['binder_def_mapping_cluster', 'binder_def_mapping_table']) {
    const rows = (await client.query(`SELECT * FROM ${table} WHERE src_def_top_org=$1 OR dest_def_top_org=$1`, [orgId]))
      .rows;
    const invalid = new Set<number>();
    for (const mapping of rows) {
      if (invalid.has(mapping.binder_def_id)) continue;
      const source = await editable(mapping.src_def_top_org);
      if (!source) continue;
      const sourceCluster = await cluster(source.def_top_id, mapping.src_def_sheet_no, mapping.src_def_cluster_id);
      if (!sourceCluster) {
        warnings.add(mapping.binder_def_id);
        invalid.add(mapping.binder_def_id);
        continue;
      }
      const dest = await editable(mapping.dest_def_top_org);
      if (!dest) continue;
      let sheetNo = mapping.dest_def_sheet_no,
        clusterId = mapping.dest_def_cluster_id;
      if (table === 'binder_def_mapping_table') {
        const destTop = must(root(String(dest.xml_data)), 'top'),
          tables = child(destTop, 'tables');
        const match =
          tables && children(tables, 'table').find((table) => field(table, 'no') === String(mapping.dest_table_no));
        const row =
          match && child(match, 'rows') && children(must(match, 'rows'), 'row').find((row) => field(row, 'no') === '1');
        const cell =
          row &&
          child(row, 'clusters') &&
          children(must(row, 'clusters'), 'cluster').find(
            (cell) => field(cell, 'columnKey') === mapping.dest_column_key,
          );
        if (!cell) {
          warnings.add(mapping.binder_def_id);
          invalid.add(mapping.binder_def_id);
          continue;
        }
        sheetNo = integerField(cell, 'sheetNo');
        clusterId = integerField(cell, 'clusterId');
      }
      const destCluster = await cluster(dest.def_top_id, sheetNo, clusterId);
      if (!destCluster || !validTypes(sourceCluster, destCluster)) {
        warnings.add(mapping.binder_def_id);
        invalid.add(mapping.binder_def_id);
      }
    }
  }
  if (warnings.size)
    await client.query(
      'UPDATE binder_def SET warning_flg=1,sys_update_term=$2,sys_update_user=$3,sys_update_time=$4 WHERE binder_def_id=ANY($1::int[])',
      [[...warnings], termId, userId, now],
    );
}
