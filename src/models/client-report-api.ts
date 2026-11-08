import type pg from 'pg';
import { clientError } from '../services/client-xml.js';
import { content, element, integer, root as parseXml, serialize, tag } from './client-definition-xml.js';

// Exact property order from API/Data/RepTop.cs, used by the legacy selectable-items validator.
export const clientReportTopItems =
  `repTopId defTopId repTopName reportType repSheetCount autoGen mobileSave remarksEdit publicStatus xmlData
  topRemarksName1 topRemarksName2 topRemarksName3 topRemarksName4 topRemarksName5 topRemarksName6 topRemarksName7 topRemarksName8 topRemarksName9 topRemarksName10
  topRemarks1 topRemarks2 topRemarks3 topRemarks4 topRemarks5 topRemarks6 topRemarks7 topRemarks8 topRemarks9 topRemarks10 editReferStatus deleted
  sysRegistTerm sysRegistUser sysRegistTime sysUpdateTerm sysUpdateUser sysUpdateTime repTopOrg revNo autoSelectGen thumbnail csvUrl pdfUrl completeMail
  defFile defFileType defFileName thumbnailFile backgroundImageFile finishOutput editOutput mobileReportSave displaySheetNumber serverVersion
  picOriginalResolution imageSize excelOutput canSendMailAsAttachment canOpenAsPdf reportCopyEnable mobileEditType useApplicantLock useInputHistory
  useInitInputJudge useInitInputJudgeParameters useExclusiveMode useExclusiveModeManager finishReason finishCompulsoryType defTopOrg
  sysRegistUserName sysUpdateUserName useStartDate useEndDate systemKey1 systemKey2 systemKey3 systemKey4 systemKey5 useChangeReason
  noNeedToFillType noNeedToFillString editMail calculateMode isSortReport journalizingDefTopId requiredCheckMode requiredSaveMode autoNumberingValue
  autoNumberingMessage autoNumberingSaveCount autoNumberingDisplaySaveCount fdSheetInfo`.split(/\s+/);
const column = (item: string) => item.replace(/[A-Z]/g, (character) => '_' + character.toLowerCase());

export async function getClientReportTopDetail(
  db: Pick<pg.Pool, 'query'>,
  userId: string,
  topId: string,
  itemsText: string,
): Promise<string> {
  const errors: string[] = [];
  if (!topId) errors.push("'repTopId' is required.");
  if (!itemsText) errors.push("'items' is required.");
  const items = itemsText ? itemsText.split(',') : [];
  for (const item of items)
    if (!clientReportTopItems.includes(item))
      errors.push(
        `Invalid value '${item}' specified for 'items'. It must be one of the following: '${clientReportTopItems.join("', '")}'.`,
      );
  if (errors.length) return clientError(2, [...new Set(errors)]);
  const id = integer(topId);
  if (id === undefined) throw new Error('Invalid report ID.');
  // The source's SELECT rep_top_id, {fields} is invalid if only repTopId is requested.
  if (items.every((item) => item === 'repTopId')) throw new Error('Empty report detail selection.');
  const selected = [...new Set(['repTopId', ...items])].map((item) => {
    const name = column(item);
    if (['sysRegistTime', 'sysUpdateTime', 'useStartDate', 'useEndDate'].includes(item))
      return `TO_CHAR(${name},'YYYY/MM/DD HH24:MI${item.endsWith('Time') ? ':SS' : ''}') AS ${name}`;
    return name;
  });
  const record = (await db.query(`SELECT ${selected.join(',')} FROM rep_top WHERE rep_top_id=$1`, [id])).rows[0];
  if (!record) return clientError(8, 'input report does not exist.');
  if (
    userId !== 'conmasadmin' &&
    !(
      await db.query(
        `SELECT 1 FROM rep_role r WHERE r.rep_top_id=$1 AND r.role_rep_read=1
    AND EXISTS (SELECT 1 FROM mst_group_affiation a WHERE a.group_id=r.group_id AND a.user_id=$2)`,
        [id, userId],
      )
    ).rows.length
  )
    return clientError(3, `Unauthorized to refer the report 'id: ${id}'.`);
  return serialize(
    element('conmas', [
      element(
        'top',
        items.map((item) => {
          const value = record[column(item)];
          if (item === 'xmlData' || item === 'useInitInputJudgeParameters') {
            if (value === null || value === undefined) throw new Error('Null report XML.');
            const xml = parseXml(String(value));
            return element(
              item,
              item === 'useInitInputJudgeParameters' && tag(xml) === item
                ? content(xml).filter((node) => !Object.hasOwn(node, '#text'))
                : [xml],
            );
          }
          return element(item, Buffer.isBuffer(value) ? value.toString('base64') : String(value ?? ''));
        }),
      ),
    ]),
  );
}

export async function unlockClientReport(db: pg.Pool, userId: string, termId: number, topId: string): Promise<string> {
  const id = integer(topId);
  if (id === undefined) throw new Error('Invalid report ID.');
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('DELETE FROM rep_lock WHERE rep_top_id=$1 AND user_id=$2', [id, userId]);
    await connection.query('DELETE FROM rep_lock WHERE rep_top_id=$1 AND sys_regist_term=$2', [id, String(termId)]);
    await connection.query('COMMIT');
    return clientError(0);
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
