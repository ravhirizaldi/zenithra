import type pg from 'pg';
import { readLicenseFields } from '../shared/license-counts.js';
import { clientError } from '../services/client-xml.js';
import {
  child,
  children,
  content,
  element,
  field,
  integer,
  must,
  remove,
  root,
  serialize,
  set,
} from './client-definition-xml.js';

async function commonGrammar(db: pg.Pool) {
  const common = element('common');
  for (const row of (await db.query('SELECT common_key,voice_value,anwser_back,anwser_back_option FROM common_grammar'))
    .rows) {
    // Stored keys become XML names, not markup; reject malformed database data.
    if (!/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(row.common_key)) throw new Error('Invalid common grammar key.');
    const item = element(row.common_key, [element('answerBack', row.anwser_back ?? '')]);
    if (row.common_key === 'retry')
      content(item).push(element('moveClusterAnswerBack', String(row.anwser_back_option ?? '')));
    content(item).push(
      element(
        'addWords',
        String(row.voice_value ?? '')
          .split(',')
          .map((word) => element('word', word)),
      ),
    );
    content(common).push(item);
  }
  return common;
}

export async function getVoiceCommonGrammar(db: pg.Pool): Promise<string> {
  return serialize(element('conmas', [element('grammar', [await commonGrammar(db)])]));
}

// AmiVoice.GetVoiceGrammarXML: Designer bypasses the voice license gate; no dictionary is error 8, not a server error.
export async function getVoiceGrammar(
  db: pg.Pool,
  terminalType: string | null,
  defTopId: string,
  repTopId = '',
): Promise<string> {
  if (terminalType !== null && terminalType !== 'Designer') {
    const limit = integer(readLicenseFields().get('AmiVoice') ?? '') ?? 0;
    const used = Number(
      (await db.query('SELECT COUNT(1) AS count FROM mst_user WHERE amivoice_enable=1')).rows[0].count,
    );
    if (limit <= 0 || used > limit) return clientError(11050);
  }
  const id = integer(defTopId),
    reportId = repTopId ? integer(repTopId) : 0;
  if (id === undefined || reportId === undefined) return clientError(2);
  const stored = (await db.query('SELECT xml_data FROM def_grammar WHERE def_top_id=$1', [id])).rows[0]?.xml_data;
  let grammar = stored ? root(stored) : undefined;
  if (reportId > 0) {
    const report = (await db.query('SELECT xml_data FROM rep_grammar WHERE rep_top_id=$1', [reportId])).rows[0]
      ?.xml_data;
    const movement = report ? child(root(report), 'moveClusterWords') : undefined;
    if (movement && content(movement).some((node) => !Object.hasOwn(node, '#text'))) {
      grammar ??= element('grammar');
      remove(grammar, 'moveClusterWords');
      content(grammar).push(movement);
    }
  }
  if (!grammar) return clientError(8);
  content(grammar).push(await commonGrammar(db));
  if (repTopId) {
    const movement = child(grammar, 'moveClusterWords');
    // Match source's first-cluster sheetNo guard and sequential copying (including chained copies).
    if (movement && child(movement, 'cluster') && child(must(movement, 'cluster'), 'sheetNo')) {
      const copies = (
        await db.query(
          `SELECT sh.rep_sheet_no,COALESCE(sh.sheet_no_org,sh.rep_sheet_no) AS sheet_no_org
        FROM rep_top top INNER JOIN rep_sheet sh ON top.rep_top_id=sh.rep_top_id
        WHERE top.rep_top_id=$1 AND sh.rep_sheet_no<>COALESCE(sh.sheet_no_org,sh.rep_sheet_no)`,
          [reportId],
        )
      ).rows;
      for (const copy of copies)
        for (const cluster of children(movement, 'cluster').filter(
          (node) => field(node, 'sheetNo') === String(copy.sheet_no_org),
        )) {
          const cloned = structuredClone(cluster);
          set(must(cloned, 'sheetNo'), String(copy.rep_sheet_no));
          content(movement).push(cloned);
        }
    }
  }
  return serialize(element('conmas', [grammar]));
}
