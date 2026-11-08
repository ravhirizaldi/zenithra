import type pg from 'pg';
import { element, integer, serialize, type XmlNode } from './client-definition-xml.js';
import { syncClientMasterTerminal } from './client-files.js';

type Database = Pick<pg.Pool, 'query'>;
type Parameters = Record<string, string>;
const fields = (row: Record<string, unknown>, mapping: Record<string, string>) =>
  Object.entries(mapping).map(([name, key]) => element(name, String(row[key] ?? '')));
const trueValue = (value: string | undefined) => value?.trim().toLowerCase() === 'true';

function downloadDate(value: string | undefined): Date | undefined {
  if (!value) return;
  // shortcut: protocol year-first and installed en-US numeric dates; review other .NET culture formats before claiming exhaustive parsing parity.
  const match =
    /^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?\s*(AM|PM)?)?$/i.exec(
      value.trim(),
    );
  if (!match) return;
  const yearFirst = match[1]!.length === 4,
    year = Number(match[yearFirst ? 1 : 3]),
    month = Number(match[yearFirst ? 2 : 1]),
    day = Number(match[yearFirst ? 3 : 2]);
  let hour = Number(match[4] ?? 0);
  if (match[8]) {
    if (hour < 1 || hour > 12) return;
    hour = (hour % 12) + (match[8].toUpperCase() === 'PM' ? 12 : 0);
  }
  const minute = Number(match[5] ?? 0),
    second = Number(match[6] ?? 0),
    result = new Date(0);
  result.setFullYear(year, month - 1, day);
  result.setHours(hour, minute, second, Number((match[7] ?? '').padEnd(3, '0').slice(0, 3)));
  if (
    year > 0 &&
    year <= 9999 &&
    result.getFullYear() === year &&
    result.getMonth() === month - 1 &&
    result.getDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  )
    return result;
}

export async function getClientMasterList(
  db: Database,
  userId: string,
  physicalId: string,
  params: Parameters,
  now = new Date(),
): Promise<string> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const masterId = integer(params.masterId ?? '') ?? -1,
    defId = integer(params.defTopId ?? '') ?? -1,
    repId = integer(params.repTopId ?? '') ?? -1;
  const downloaded = downloadDate(params.lastDownloadTime),
    values: unknown[] = [],
    conditions: string[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return '$' + values.length;
  };
  if (params.masterType === '0' || params.masterType === '1')
    conditions.push(`mst.master_type=${bind(params.masterType)}`);
  if (masterId !== -1 && masterId !== 0) conditions.push(`mst.master_id=${bind(masterId)}`);
  if (params.masterKey) conditions.push(`mst.master_key=${bind(params.masterKey)}`);
  if (defId > -1)
    conditions.push(
      `EXISTS (SELECT 1 FROM def_report_custom_table d WHERE d.master_id=mst.master_id AND d.def_top_id=${bind(defId)})`,
    );
  if (repId > -1)
    conditions.push(
      `EXISTS (SELECT 1 FROM rep_report_custom_table r WHERE r.master_id=mst.master_id AND r.rep_top_id=${bind(repId)})`,
    );
  if (downloaded) conditions.push(`mst.sys_update_time>=${bind(downloaded)}`);
  const filters = conditions.length ? ' AND ' + conditions.join(' AND ') : '';
  const expiry = `(mst.expire IS NULL OR mst.expire>=${bind(today)})`;
  const masters = (
    await db.query(
      `SELECT mst.*,COALESCE(mst.master_type,0) AS master_type,COALESCE(mst.mobile_save,0) AS mobile_save,
    COALESCE(mst.download_type,0) AS download_type,COALESCE(mst.display_number,0) AS display_number,
    TO_CHAR(mst.expire,'YYYY/MM/DD 23:59:59') AS expire_text,TO_CHAR(mst.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS updated_text,
    TO_CHAR(mst.sys_regist_time,'YYYY/MM/DD HH24:MI:SS') AS created_text,upd.user_name AS updated_user,reg.user_name AS created_user
    FROM mst_custom_table mst LEFT JOIN mst_user upd ON upd.user_id=mst.sys_update_user LEFT JOIN mst_user reg ON reg.user_id=mst.sys_regist_user
    WHERE NOT EXISTS (SELECT 1 FROM custom_table_delete d WHERE d.master_id=mst.master_id)${filters}
    ${trueValue(params.ignoreExpire) ? '' : 'AND ' + expiry} ORDER BY COALESCE(mst.display_number,0),mst.master_name,mst.master_key`,
      trueValue(params.ignoreExpire) ? values.slice(0, -1) : values,
    )
  ).rows;
  const ids = masters.map((row) => row.master_id);
  const groups = (await db.query('SELECT group_id FROM mst_group_affiation WHERE user_id=$1', [userId])).rows.map(
    (row) => row.group_id,
  );
  const roles = ids.length
    ? (await db.query('SELECT master_id,group_id FROM mst_custom_table_role WHERE master_id=ANY($1::int[])', [ids]))
        .rows
    : [];
  const labels: Record<string, unknown>[][] = [];
  for (const mode of ['common', 'report'])
    labels.push(
      ids.length
        ? (
            await db.query(
              `SELECT master_id,mst_label_id FROM ${mode}_custom_table_label WHERE master_id=ANY($1::int[])`,
              [ids],
            )
          ).rows
        : [],
    );
  // Unlike the master query, the source column query always applies expiry even with ignoreExpire=true.
  const columns = (
    await db.query(
      `SELECT col.master_id,col.field_no,col.value,col.type FROM mst_custom_column col JOIN mst_custom_table mst ON mst.master_id=col.master_id WHERE ${expiry}${filters} ORDER BY col.master_id,col.field_no`,
      values,
    )
  ).rows;
  const defaults = ids.length
    ? (
        await db.query(
          "SELECT d.*,TO_CHAR(sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS updated_text FROM mst_custom_default_record d WHERE master_id=ANY($1::int[])",
          [ids],
        )
      ).rows
    : [];
  const defaultRoles = defaults.length
    ? (
        await db.query('SELECT record_id,group_id FROM mst_custom_default_record_role WHERE record_id=ANY($1::int[])', [
          defaults.map((row) => row.record_id),
        ])
      ).rows
    : [];
  const output: XmlNode[] = [];
  for (const row of masters) {
    const allowed = roles.filter((role) => role.master_id === row.master_id).map((role) => role.group_id);
    if (physicalId && (!groups.length || (allowed.length > 0 && !allowed.some((group) => groups.includes(group)))))
      continue;
    const report = String(row.master_type) === '1',
      ownColumns = columns.filter((column) => column.master_id === row.master_id);
    const nodes = [
      ...fields(row, {
        masterId: 'master_id',
        key: 'master_key',
        masterName: 'master_name',
        masterType: 'master_type',
        mobileSave: 'mobile_save',
        updateTime: 'updated_text',
        registTime: 'created_text',
        updateUser: 'updated_user',
        registUser: 'created_user',
        expire: 'expire_text',
      }),
      element('keyName', row.record_key_name || 'Record key'),
      element('valueName', row.record_value_name || 'Record value'),
      element('downloadType', report ? '0' : String(row.download_type)),
      element('lifeTime', report ? '' : String(row.life_time ?? '')),
      ...fields(row, { displayNumber: 'display_number', recordVersion: 'record_version' }),
      element(
        'labelId',
        labels[String(row.master_type) === '0' ? 0 : 1]!.filter((label) => label.master_id === row.master_id)
          .map((label) => label.mst_label_id)
          .join(','),
      ),
      element('group', allowed.join(',')),
      element(
        'fields',
        trueValue(params.isColumn)
          ? ownColumns
              .filter((column) => column.field_no <= 100)
              .map((column) =>
                element('field', fields(column, { fieldNo: 'field_no', fieldName: 'value', type: 'type' })),
              )
          : [],
      ),
      element(
        'imageFields',
        trueValue(params.isColumn)
          ? ownColumns
              .filter((column) => column.field_no >= 1001 && column.field_no <= 1005)
              .map((column) => element('field', fields(column, { fieldNo: 'field_no', fieldName: 'value' })))
          : [],
      ),
    ];
    const record = defaults.find((record) => record.master_id === row.master_id);
    if (record) {
      const allowedGroups = defaultRoles
        .filter((role) => role.record_id === record.record_id)
        .map((role) => role.group_id);
      if (userId === 'conmasadmin' || !allowedGroups.length || allowedGroups.some((group) => groups.includes(group))) {
        if (!record.updated_text) throw new Error('Missing default record timestamp.');
        const textFields: XmlNode[] = [],
          imageFields: XmlNode[] = [];
        for (const column of ownColumns) {
          const number = Number(column.field_no),
            key = 'field' + String(number).padStart(4, '0');
          if (!Object.hasOwn(record, key)) throw new Error('Invalid default record field.');
          const data = record[key];
          if (number >= 1 && number <= 100 && typeof data === 'string' && data.trim())
            textFields.push(element('field', [element('fieldNo', String(number)), element('value', data)]));
          if (number >= 1001 && number <= 1005 && Buffer.isBuffer(data) && data.length)
            imageFields.push(
              element('field', [
                element('fieldNo', String(number)),
                element('imageName', `image_${record.record_id}_${number}`),
              ]),
            );
        }
        nodes.push(
          element('defaultRecord', [
            ...fields(record, { recordId: 'record_id', updateTime: 'updated_text', value: 'value' }),
            element('group', allowedGroups.join(',')),
            element('fields', textFields),
            element('imageFields', imageFields),
          ]),
        );
      }
    }
    output.push(element('master', [element('action', 'M'), ...nodes]));
  }
  if (trueValue(params.isDeleteTran)) {
    const deletedValues: unknown[] = [],
      deletedWhere: string[] = [];
    if (masterId !== -1 && masterId !== 0) {
      deletedValues.push(masterId);
      deletedWhere.push('master_id=$' + deletedValues.length);
    }
    if (downloaded) {
      deletedValues.push(downloaded);
      deletedWhere.push('sys_update_time>=$' + deletedValues.length);
    }
    const deleted = (
      await db.query(
        'SELECT master_id FROM custom_table_delete' +
          (deletedWhere.length ? ' WHERE ' + deletedWhere.join(' AND ') : ''),
        deletedValues,
      )
    ).rows;
    for (const row of deleted)
      output.push(element('master', [element('action', 'D'), element('masterId', String(row.master_id))]));
  }
  return serialize(element('conmas', [element('masters', output)]));
}

export async function getClientCustomMasterLabels(db: Database): Promise<string> {
  // GetCustomMasterLabelList forces common-master labels, ignoring request masterType and user group filters.
  const labels = (
    await db.query(
      'SELECT mst_label_id,upper_label_id,label_name,diplay_number,label_icon_id FROM mst_label_common_custom_table',
    )
  ).rows;
  const roles = (await db.query('SELECT mst_label_id,group_id FROM common_custom_table_label_role')).rows;
  return serialize(
    element('conmas', [
      element(
        'localLabels',
        labels.map((row) =>
          element('localLabel', [
            ...fields(row, {
              labelId: 'mst_label_id',
              iconId: 'label_icon_id',
              name: 'label_name',
              upperLabelId: 'upper_label_id',
              displayNumber: 'diplay_number',
            }),
            element(
              'group',
              roles
                .filter((role) => role.mst_label_id === row.mst_label_id)
                .map((role) => role.group_id)
                .join(','),
            ),
          ]),
        ),
      ),
    ]),
  );
}

export async function getClientMasterRecords(
  db: pg.Pool,
  actor: { userId: string; termType: string; termId: string },
  params: Parameters,
  now = new Date(),
): Promise<string> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const masterId = integer(params.masterId ?? '') ?? -1,
    defId = integer(params.defTopId ?? '') ?? -1;
  const downloaded = downloadDate(params.lastDownloadTime),
    start = integer(params.startNo ?? '') ?? 0;
  let max = integer(params.max ?? '') ?? 500;
  const search = new Map<number, string>(),
    tokens = (params.fieldSearch ?? '').split('\t');
  for (let i = 0; i < tokens.length && params.fieldSearch; i += 2) {
    const number = integer(tokens[i]!);
    if (number === undefined) break;
    if (number < -1) continue;
    if (search.has(number)) throw new Error('Duplicate master search field.');
    search.set(number, tokens[i + 1] ?? '');
  }
  if (
    process.env.CONMAS_PLATFORM?.toLowerCase() === 'cloud' &&
    actor.termType !== 'API' &&
    masterId > 0 &&
    integer(actor.termId) !== undefined &&
    Number(
      (await db.query('SELECT mobile_save FROM mst_custom_table WHERE master_id=$1', [masterId])).rows[0]?.mobile_save,
    ) === 1
  ) {
    const error = await syncClientMasterTerminal(db, actor.userId, integer(actor.termId)!);
    if (error) return error;
  }
  const values: unknown[] = [today],
    bind = (value: unknown) => {
      values.push(value);
      return '$' + values.length;
    };
  const conditions = ['(mst.expire IS NULL OR mst.expire>=$1)'];
  if (params.masterType === '0' || params.masterType === '1')
    conditions.push('mst.master_type=' + bind(params.masterType));
  if (masterId !== -1 && masterId !== 0) conditions.push('mst.master_id=' + bind(masterId));
  if (params.masterKey) conditions.push('mst.master_key=' + bind(params.masterKey));
  if (defId > -1)
    conditions.push(
      `EXISTS (SELECT 1 FROM def_report_custom_table d WHERE d.master_id=mst.master_id AND d.def_top_id=${bind(defId)})`,
    );
  // GetCustomRecordList resets repTopId to -1, never uses recordId and never parses ignoreExpire/exact-match flags.
  const masterValues = [...values],
    masterConditions = [...conditions];
  if (downloaded) masterConditions.push('mst.sys_update_time>=$' + masterValues.push(downloaded));
  const masters = (
    await db.query(
      `SELECT mst.master_id,COALESCE(mst.mobile_save,0) AS mobile_save FROM mst_custom_table mst
    WHERE NOT EXISTS (SELECT 1 FROM custom_table_delete d WHERE d.master_id=mst.master_id) AND ${masterConditions.join(' AND ')}`,
      masterValues,
    )
  ).rows;
  const recordNodes: XmlNode[] = [],
    output = [element('records', recordNodes)];
  if (masters.length === 1 && Number(masters[0]!.mobile_save) === 0 && actor.termType === 'iPad') {
    const limit = (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='CUSTOM_MASTER' AND com_name='SERVER_MAX_RECORDS' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value;
    const parsed = integer(limit ?? '');
    if (parsed === undefined) throw new Error('Invalid master server record limit.');
    max = parsed;
    output.push(
      element(
        'recordCount',
        String(
          (await db.query('SELECT count(*) FROM mst_custom_record WHERE master_id=$1', [masters[0]!.master_id])).rows[0]
            .count,
        ),
      ),
    );
    if (start >= max) return serialize(element('conmas', output));
  }
  const columnValues = [...values],
    columnConditions = [...conditions];
  if (downloaded) {
    conditions.push('rec.sys_update_time>=' + bind(downloaded));
    columnConditions.push(
      `EXISTS (SELECT 1 FROM mst_custom_record r WHERE r.master_id=mst.master_id AND r.sys_update_time>=$${columnValues.push(downloaded)})`,
    );
  }
  if (params.recordVersion) conditions.push('rec.record_version<>' + bind(params.recordVersion));
  for (const [number, value] of search) {
    if (number > 100) throw new Error('Invalid master search column.');
    const source =
      number < 1
        ? value
            .replace(/[！＃＄％＆（）＊＋，－．／０-９：；＜＝＞？＠Ａ-Ｚ［］＾＿｀ａ-ｚ｛｜｝～]/g, (char) =>
              String.fromCharCode(char.charCodeAt(0) - 65248),
            )
            .replaceAll('　', ' ')
        : value;
    const column =
      number === -1
        ? 'convert_full2half(rec.record_key)'
        : number === 0
          ? 'convert_full2half(rec.value)'
          : 'rec.field' + String(number).padStart(4, '0');
    conditions.push(column + ' ILIKE ' + bind('%' + source.replace(/[\\%_]/g, '\\$&') + '%'));
  }
  if (Object.hasOwn(params, 'recordKey')) conditions.push('rec.record_key=' + bind(params.recordKey));
  const groups = (await db.query('SELECT group_id FROM mst_group_affiation WHERE user_id=$1', [actor.userId])).rows.map(
    (row) => row.group_id,
  );
  if (actor.userId !== 'conmasadmin' && groups.length)
    conditions.push(`(rec.group_array && ${bind(groups)}::int[] OR rec.group_id='' OR rec.group_id IS NULL)`);
  const from = `FROM mst_custom_record rec JOIN mst_custom_table mst ON mst.master_id=rec.master_id WHERE ${conditions.join(' AND ')}`;
  const selection = [
    'rec.master_id',
    'rec.record_id',
    'rec.record_key',
    'rec.value',
    'rec.group_id',
    'COALESCE(rec.display_number,0) AS display_number',
    "TO_CHAR(rec.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS updated_text",
    ...Array.from({ length: 100 }, (_, i) => 'rec.field' + String(i + 1).padStart(4, '0')),
    ...Array.from(
      { length: 5 },
      (_, i) => `CASE WHEN LENGTH(rec.field${1001 + i})=0 THEN 0 ELSE 1 END AS image${1001 + i}`,
    ),
  ];
  const rows = (
    await db.query(
      `SELECT ${selection.join(',')} ${from} ORDER BY COALESCE(mst.display_number,0),mst.master_id,COALESCE(rec.display_number,0),rec.record_key OFFSET $${values.length + 1} LIMIT $${values.length + 2}`,
      [...values, start, max],
    )
  ).rows;
  const columns = (
    await db.query(
      `SELECT col.master_id,col.field_no FROM mst_custom_column col JOIN mst_custom_table mst ON mst.master_id=col.master_id WHERE ${columnConditions.join(' AND ')} ORDER BY col.master_id,col.field_no`,
      columnValues,
    )
  ).rows;
  let previous: number | undefined,
    count = 0;
  for (const row of rows) {
    const own = columns.filter((col) => col.master_id === row.master_id);
    recordNodes.push(
      element('record', [
        element('action', 'M'),
        ...fields(row, {
          masterId: 'master_id',
          recordId: 'record_id',
          updateTime: 'updated_text',
          key: 'record_key',
          value: 'value',
          displayNumber: 'display_number',
        }),
        element('group', String(row.group_id ?? '').replaceAll(';', ',')),
        element(
          'fields',
          own
            .filter((col) => col.field_no <= 100)
            .map((col) => {
              const key = 'field' + String(col.field_no).padStart(4, '0');
              if (!Object.hasOwn(row, key)) throw new Error('Invalid master field.');
              return element('field', [
                element('fieldNo', String(col.field_no)),
                element('value', String(row[key] ?? '')),
              ]);
            }),
        ),
        element(
          'imageFields',
          own
            .filter((col) => col.field_no >= 1001 && col.field_no <= 1005 && Number(row['image' + col.field_no]) === 1)
            .map((col) =>
              element('field', [
                element('fieldNo', String(col.field_no)),
                element('imageName', `image_${row.record_id}_${col.field_no}`),
              ]),
            ),
        ),
      ]),
    );
    count++;
    if (previous !== row.master_id && actor.termType === 'iPad' && start === 0) {
      // Preserve the source's first-record logging/count timing, not a fabricated final page total.
      try {
        await db.query(
          `INSERT INTO log_custom_table_download (master_id,master_key,master_name,master_type,mobile_save,download_type,expire,life_time,display_number,record_key_name,record_value_name,remark,record_download_count,
          log_date,log_user,log_user_name,log_term,log_term_name,log_gps_lat,log_gps_lon,log_gps_alt,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
          SELECT mst.master_id,mst.master_key,mst.master_name,COALESCE(mst.master_type,0),COALESCE(mst.mobile_save,0),COALESCE(mst.download_type,0),mst.expire,mst.life_time,COALESCE(mst.display_number,0),COALESCE(mst.record_key_name,''),COALESCE(mst.record_value_name,''),COALESCE(mst.remark,''),$2,
          $3,$4,(SELECT user_name FROM mst_user WHERE user_id=$4),$5,(SELECT term_name FROM mst_terminal WHERE term_id::text=$5),'','','',$5,$4,$3,$5,$4,$3 FROM mst_custom_table mst WHERE mst.master_id=$1`,
          [row.master_id, count, today, actor.userId, actor.termId],
        );
      } catch {
        /* Source swallows download-log failures; retrieval remains successful. */
      }
      previous = row.master_id;
      count = 0;
    }
  }
  if (trueValue(params.isDeleteTran) && !rows.length) {
    const total = Number((await db.query('SELECT count(*) ' + from, values)).rows[0].count),
      deletedValues: unknown[] = [],
      deletedConditions: string[] = [];
    const add = (value: unknown) => {
      deletedValues.push(value);
      return '$' + deletedValues.length;
    };
    if (masterId !== -1 && masterId !== 0) deletedConditions.push('master_id=' + add(masterId));
    if (downloaded) deletedConditions.push('sys_update_time>=' + add(downloaded));
    if (params.recordVersion) deletedConditions.push('record_version<>' + add(params.recordVersion));
    const deleted = (
      await db.query(
        `SELECT master_id,record_id FROM custom_record_delete${deletedConditions.length ? ' WHERE ' + deletedConditions.join(' AND ') : ''} ORDER BY record_id OFFSET ${add(Math.max(0, start - total))} LIMIT ${add(max)}`,
        deletedValues,
      )
    ).rows;
    for (const row of deleted)
      recordNodes.push(
        element('record', [element('action', 'D'), ...fields(row, { masterId: 'master_id', recordId: 'record_id' })]),
      );
  }
  return serialize(element('conmas', output));
}
