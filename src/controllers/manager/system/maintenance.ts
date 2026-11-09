import { text as pageText } from '../../../config/manager/system/resources.js';
import type { Express, Response } from 'express';
import type pg from 'pg';
import { licenseStatus } from '../../../shared/license-counts.js';
import { hostname } from 'node:os';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

type Render = (res: Response, data: Record<string, unknown>) => unknown;
type CustomForm = { DeleteType: string; DeleteDays: string; DeleteResult: number };
type VoiceGrammar = {
  CommonKey: string | null;
  CommonName: string;
  VoiceValue: string | null;
  AnswerBack: string | null;
  IsAnsverBackCluster: boolean;
};
type GrammarRow = {
  common_key: string | null;
  voice_value: string | null;
  anwser_back: string | null;
  anwser_back_option: string | number | null;
};
type DeleteDaysResult = { days: number; error: string };

const root = '/ConMasManager/System';
const customTitle = 'Custom master maintenance';
const voiceTitle = 'Voice recognition common dictionary - Common operation';
const voiceNames: Record<string, string> = {
  retry: 'Turn focused cluster to editing status',
  ok: 'Confirm',
  cancel: 'Cancel',
  undo: 'Undo',
  redo: 'Redo',
};
const batchSize = 1000;
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
function licenseStatusUnavailable(res: Response): boolean {
  try {
    if (!licenseStatus().freeDrawOnly) return false;
    res.status(403).type('text/plain').send(pageText['Role authority is insufficient.']);
  } catch {
    res.status(503).type('text/plain').send(pageText['License information is unavailable.']);
  }
  return true;
}

export function parseDeleteDays(value: unknown): DeleteDaysResult {
  if (value === undefined) return { days: 365, error: '' };
  if (typeof value !== 'string') return { days: 365, error: pageText['The value is not valid for DeleteDays.'] };
  const raw = value.trim();
  if (!/^[+-]?\d+$/.test(raw)) return { days: 365, error: `The value '${value}' is not valid for DeleteDays.` };
  const days = Number(raw);
  if (!Number.isInteger(days) || days < -2147483648 || days > 2147483647) {
    return { days: 365, error: `The value '${value}' is not valid for DeleteDays.` };
  }
  if (days < 1 || days > 999) return { days, error: pageText['The field DeleteDays must be between 1 and 999.'] };
  return { days, error: '' };
}

function emptyVoiceGrammar(): VoiceGrammar[] {
  return ['retry', 'ok', 'cancel', 'undo', 'redo'].map((CommonKey) => ({
    CommonKey,
    CommonName: voiceNames[CommonKey],
    VoiceValue: null,
    AnswerBack: null,
    IsAnsverBackCluster: false,
  }));
}

export function voiceGrammarFromRows(rows: readonly GrammarRow[]): VoiceGrammar[] {
  const grammars = emptyVoiceGrammar();
  for (const row of rows) {
    const grammar = grammars.find((item) => item.CommonKey === row.common_key);
    if (!grammar) continue;
    grammar.VoiceValue = (row.voice_value ?? '').replaceAll('、', ',');
    grammar.AnswerBack = row.anwser_back ?? '';
    grammar.IsAnsverBackCluster = String(row.anwser_back_option ?? '') === '1';
  }
  return grammars;
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string');
  return undefined;
}

function bodyBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => typeof item === 'string' && ['true', '1'].includes(item.toLowerCase()));
}

export function voiceGrammarFromPost(body: Record<string, unknown>): VoiceGrammar[] {
  const indices = new Set<number>();
  for (const key of Object.keys(body)) {
    const match = /^VoiceCommonList\.CommonGrammarList\[(\d+)\]\./.exec(key);
    if (match) indices.add(Number(match[1]));
  }
  if (indices.size === 0) return emptyVoiceGrammar();
  const grammars: VoiceGrammar[] = [];
  for (let index = 0; indices.has(index); index++) {
    const prefix = `VoiceCommonList.CommonGrammarList[${index}].`;
    const key = bodyString(body, `${prefix}CommonKey`) ?? null;
    const voiceValue = bodyString(body, `${prefix}VoiceValue`);
    grammars.push({
      CommonKey: key,
      CommonName: key ? (voiceNames[key] ?? '') : '',
      VoiceValue: voiceValue?.replaceAll('、', ',') ?? null,
      AnswerBack: bodyString(body, `${prefix}AnswerBack`) ?? null,
      IsAnsverBackCluster: bodyBoolean(body, `${prefix}IsAnsverBackCluster`),
    });
  }
  return grammars;
}

async function hasCustomTableMaintenance(db: pg.Pool, userId: string): Promise<boolean> {
  const result = await db.query<{ role_custom_table_update: string | number | null }>(
    `SELECT MAX(role_custom_table_update) AS role_custom_table_update
     FROM mst_group
     WHERE group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id = $1)`,
    [userId],
  );
  return String(result.rows[0]?.role_custom_table_update ?? '') === '1';
}

async function canDeleteCustomRecords(db: pg.Pool, userId: string): Promise<boolean> {
  if (!(await hasSystemPermission(db, userId, 'data', 'delete'))) return false;
  return hasCustomTableMaintenance(db, userId);
}

async function deleteAllCustomRecords(db: pg.Pool): Promise<number> {
  const count = await db.query<{ n_live_tup: number | string | null }>(
    "SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'custom_record_delete'",
  );
  if (!count.rows[0]) throw new Error(pageText['Could not read custom record deletion count.']);
  await db.query('TRUNCATE TABLE custom_record_delete');
  return Number(count.rows[0].n_live_tup);
}

async function deleteOldCustomRecords(db: pg.Pool, days: number): Promise<number> {
  let deleted = 0;
  for (;;) {
    const client = await db.connect();
    let batchCount = 0;
    let selectedCount: number;
    try {
      await client.query('BEGIN');
      const rows = await client.query<{ key: string }>(
        `SELECT to_char(sys_update_time, 'yyyyMMddHH24MISSMS') || to_char(record_id, 'FM0000000000') AS key
         FROM custom_record_delete
         WHERE sys_update_time < CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
         ORDER BY sys_update_time, record_id
         OFFSET 0 LIMIT ${batchSize}`,
        [days],
      );
      selectedCount = rows.rows.length;
      if (selectedCount) {
        const result = await client.query(
          `DELETE FROM custom_record_delete
           WHERE to_char(sys_update_time, 'yyyyMMddHH24MISSMS') || to_char(record_id, 'FM0000000000') <= $1`,
          [rows.rows[selectedCount - 1].key],
        );
        batchCount = result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    deleted += batchCount;
    if (selectedCount < batchSize) return deleted;
  }
}

async function loadVoiceGrammar(db: pg.Pool): Promise<VoiceGrammar[]> {
  const result = await db.query<GrammarRow>(
    'SELECT common_key, voice_value, anwser_back, anwser_back_option FROM common_grammar',
  );
  return voiceGrammarFromRows(result.rows);
}

async function saveVoiceGrammar(db: pg.Pool, grammars: readonly VoiceGrammar[], userId: string): Promise<void> {
  const client = await db.connect();
  const term = hostname();
  try {
    await client.query('BEGIN');
    for (const grammar of grammars) {
      await client.query('DELETE FROM common_grammar WHERE common_key = $1', [grammar.CommonKey]);
      await client.query(
        `INSERT INTO common_grammar (
          common_key, voice_value, anwser_back, anwser_back_option,
          sys_regist_term, sys_regist_user, sys_regist_time,
          sys_update_term, sys_update_user, sys_update_time
        ) VALUES ($1,$2,$3,$4,$5,$6,now(),$5,$6,now())`,
        [grammar.CommonKey, grammar.VoiceValue, grammar.AnswerBack, grammar.IsAnsverBackCluster ? 1 : 0, term, userId],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function registerSystemMaintenance(app: Express, db: pg.Pool, render: Render): void {
  app.get(`${root}/CustomMasterMaintenance`, async (req, res) => {
    if (licenseStatusUnavailable(res)) return;
    if (!(await canDeleteCustomRecords(db, req.session?.userId ?? ''))) return res.redirect(`${root}/Index`);
    return render(res, {
      active: 'System',
      section: 'CustomMasterMaintenance',
      login: false,
      title: customTitle,
      userName: res.locals.userName,
      systemMaintenancePage: {
        mode: 'customMasterMaintenance',
        customForm: { DeleteType: 'all', DeleteDays: '365', DeleteResult: -1 } satisfies CustomForm,
        error: '',
      },
    });
  });

  app.post(`${root}/CustomMasterMaintenance`, async (req, res) => {
    if (licenseStatusUnavailable(res)) return;
    if (!(await canDeleteCustomRecords(db, req.session?.userId ?? ''))) return res.redirect(`${root}/Index`);
    const deleteDays = parseDeleteDays(req.body?.DeleteDays);
    const customForm: CustomForm = {
      DeleteType: bodyString(req.body ?? {}, 'DeleteType') ?? 'all',
      DeleteDays: bodyString(req.body ?? {}, 'DeleteDays') ?? '365',
      DeleteResult: -1,
    };
    if (deleteDays.error) {
      return render(res, {
        active: 'System',
        section: 'CustomMasterMaintenance',
        login: false,
        title: customTitle,
        userName: res.locals.userName,
        systemMaintenancePage: { mode: 'customMasterMaintenance', customForm, error: deleteDays.error },
      });
    }
    try {
      if (customForm.DeleteType === 'all') customForm.DeleteResult = await deleteAllCustomRecords(db);
      else if (customForm.DeleteType === 'days')
        customForm.DeleteResult = await deleteOldCustomRecords(db, deleteDays.days);
      return render(res, {
        active: 'System',
        section: 'CustomMasterMaintenance',
        login: false,
        title: customTitle,
        userName: res.locals.userName,
        systemMaintenancePage: { mode: 'customMasterMaintenance', customForm, error: '' },
      });
    } catch (error) {
      return render(res, {
        active: 'System',
        section: 'CustomMasterMaintenance',
        login: false,
        title: customTitle,
        userName: res.locals.userName,
        systemMaintenancePage: { mode: 'customMasterMaintenance', customForm, error: errorMessage(error) },
      });
    }
  });

  app.get(`${root}/VoiceCommonGrammar`, async (_req, res) => {
    if (licenseStatusUnavailable(res)) return;
    try {
      return render(res, {
        active: 'System',
        section: 'VoiceCommonGrammar',
        login: false,
        title: voiceTitle,
        userName: res.locals.userName,
        systemMaintenancePage: { mode: 'voiceCommonGrammar', grammars: await loadVoiceGrammar(db), error: '' },
      });
    } catch (error) {
      return render(res, {
        active: 'System',
        section: 'VoiceCommonGrammar',
        login: false,
        title: voiceTitle,
        userName: res.locals.userName,
        systemMaintenancePage: {
          mode: 'voiceCommonGrammar',
          grammars: emptyVoiceGrammar(),
          error: errorMessage(error),
        },
      });
    }
  });

  app.post(`${root}/VoiceCommonGrammar`, async (req, res) => {
    if (licenseStatusUnavailable(res)) return;
    const grammars = voiceGrammarFromPost(req.body ?? {});
    try {
      await saveVoiceGrammar(db, grammars, req.session?.userId ?? '');
      return res.redirect(`${root}/VoiceCommonGrammar`);
    } catch (error) {
      return render(res, {
        active: 'System',
        section: 'VoiceCommonGrammar',
        login: false,
        title: voiceTitle,
        userName: res.locals.userName,
        systemMaintenancePage: { mode: 'voiceCommonGrammar', grammars, error: errorMessage(error) },
      });
    }
  });
}
