import type { Request, Response } from 'express';
import type pg from 'pg';
import { clientParameter } from './client-account.js';
import { putClientLog } from '../models/client-log.js';
import { clientError } from '../services/client-xml.js';
import { requestFailure } from '../middleware/request-log.js';

export async function clientLogAction(db: pg.Pool, command: string, req: Request, res: Response): Promise<boolean> {
  if (command !== 'PutLog') return false;
  try {
    const xml = await putClientLog(
      db,
      req.session.clientAccount?.physicalId,
      Object.fromEntries(['client', 'terminalId', 'intervalLog'].map((name) => [name, clientParameter(req, name)])),
      req.file?.path,
    );
    if (!req.file && xml === clientError(0)) requestFailure(res, { code: 'CLIENT_FILE_HANDLE' });
    res.send(xml);
  } catch (error) {
    requestFailure(res, error);
    res.send(clientError(-1, 'server error.'));
  }
  return true;
}
