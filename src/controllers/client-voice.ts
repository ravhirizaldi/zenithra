import type { Request, Response } from 'express';
import type pg from 'pg';
import { clientParameter } from './client-account.js';
import { clientTerminal } from '../models/client-account.js';
import { getVoiceCommonGrammar, getVoiceGrammar } from '../models/client-voice.js';
import { clientError } from '../services/client-xml.js';
import { requestFailure } from '../middleware/request-log.js';

export async function clientVoiceAction(db: pg.Pool, command: string, req: Request, res: Response): Promise<boolean> {
  if (!['GetVoiceGrammar', 'GetVoiceCommonGrammar'].includes(command)) return false;
  const account = req.session.clientAccount;
  if (!account) {
    res.send(clientError(5, 'no session.'));
    return true;
  }
  const terminal = await clientTerminal(db, account);
  if (terminal.code !== 0) {
    res.send(clientError(3));
    return true;
  }
  try {
    res.send(
      command === 'GetVoiceCommonGrammar'
        ? await getVoiceCommonGrammar(db)
        : await getVoiceGrammar(db, account.client, clientParameter(req, 'defTopId'), clientParameter(req, 'repTopId')),
    );
  } catch (error) {
    requestFailure(res, error);
    res.send(clientError(-1, 'server error.'));
  }
  return true;
}
