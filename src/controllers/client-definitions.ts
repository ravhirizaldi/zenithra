import type { Request, Response } from 'express';
import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { clientParameter } from './client-account.js';
import { clientTerminal } from '../models/client-account.js';
import {
  DefinitionUploadUnsupported,
  getDefinitionData,
  getDefinitionDetail,
  getDefinitionList,
  getReportDetail,
  getReportList,
  registerDefinition,
  unlockDefinition,
} from '../models/client-definitions.js';
import { clientError } from '../services/client-xml.js';
import { requestFailure } from '../middleware/request-log.js';
import { getDefinitionUpdateList } from '../models/client-definition-updates.js';

export async function clientDefinitionAction(
  db: pg.Pool,
  command: string,
  req: Request,
  res: Response,
): Promise<boolean> {
  if (
    ![
      'GetDefinitionList',
      'GetDefinitionUpdateList',
      'GetReportList',
      'GetReportDetail',
      'GetDefinitionData',
      'GetDefinitionDetail',
      'GetDefinitionPreview',
      'UnlockDefinition',
      'RegistDefinition',
    ].includes(command)
  )
    return false;
  const account = req.session.clientAccount;
  if (!account) {
    res.send(clientError(5, 'no session.'));
    return true;
  }
  if (command === 'GetDefinitionPreview') {
    // The deployed handler only initializes DefinitionBiz; it never calls its sample loader or writes a preview.
    res.end();
    return true;
  }
  if (command === 'GetDefinitionUpdateList') {
    try {
      const terminal = await clientTerminal(db, account);
      res.send(
        terminal.code !== 0 ? clientError(3) : await getDefinitionUpdateList(db, clientParameter(req, 'defTopId')),
      );
    } catch (error) {
      requestFailure(res, error);
      res.send(clientError(-1, 'server error.'));
    }
    return true;
  }
  const terminal = await clientTerminal(db, account);
  if (terminal.code !== 0) {
    res.send(clientError(3));
    return true;
  }
  const unsupported = ['urlSchemeMode', 'createReportMode', 'ResultType'];
  if (
    (account.client !== 'Designer' &&
      ['GetDefinitionData', 'UnlockDefinition', 'RegistDefinition'].includes(command)) ||
    unsupported.some((name) => clientParameter(req, name))
  ) {
    res.status(501).send(clientError(-1, 'This definition request mode has not been migrated.'));
    return true;
  }
  // CheckTerminal uses the registered numeric terminal ID for locks, not the device's physical ID.
  const actor = { userId: account.userId, terminalId: String(terminal.id), client: account.client };
  if (command === 'RegistDefinition') {
    try {
      if (!req.file) {
        res.send(clientError(-1, 'server error.'));
        return true;
      }
      res.send(
        await registerDefinition(db, actor, await readFile(req.file.path, 'utf8'), clientParameter(req, 'approveType')),
      );
    } catch (error) {
      requestFailure(res, error);
      if (error instanceof DefinitionUploadUnsupported) res.status(501).send(clientError(-1, error.message));
      else res.send(clientError(-1, 'server error.'));
    }
    return true;
  }
  if (command === 'GetDefinitionList' || command === 'GetReportList') {
    const names = [
      'labelId',
      'topId',
      'publicStatus',
      'editStatus',
      'sortId',
      'sortType',
      'word',
      'history',
      'wordTargetName',
      'wordTargetRemarks',
      'wordTargetId',
      'wordTargetValue',
      'itemTargetLabel',
      'itemTargetSheet',
      'itemTargetSet',
      'itemTargetBook',
      'systemKey1',
      'systemKey2',
      'systemKey3',
      'systemKey4',
      'systemKey5',
      'registTimeFrom',
      'registTimeTo',
      'updateTimeFrom',
      'updateTimeTo',
      'definition',
      'definitionHistory',
      'autoNumberingValue',
    ];
    res.send(
      await (command === 'GetReportList' ? getReportList : getDefinitionList)(
        db,
        actor,
        Object.fromEntries(names.map((name) => [name, clientParameter(req, name)])),
      ),
    );
    return true;
  }
  const text = clientParameter(req, 'topId').trim();
  const topId = Number(text);
  if (!/^[+-]?\d+$/.test(text) || topId < -2147483648 || topId > 2147483647) {
    res.send(clientError(2));
    return true;
  }
  const xml =
    command === 'GetDefinitionData'
      ? await getDefinitionData(db, actor, topId, clientParameter(req, 'designerVersion'))
      : command === 'GetDefinitionDetail'
        ? await getDefinitionDetail(db, actor, topId)
        : command === 'GetReportDetail'
          ? await getReportDetail(db, actor, topId)
          : await unlockDefinition(db, actor, topId);
  res.send(xml);
  return true;
}
