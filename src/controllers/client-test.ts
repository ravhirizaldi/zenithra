import type { Request, Response } from 'express';
import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { XMLValidator } from 'fast-xml-parser';
import { clientElement, clientError } from '../services/client-xml.js';
import { decodeImport } from '../models/manager/system/data-import.js';
import { root as parseXml, serialize } from '../models/client-definition-xml.js';

declare module 'express-session' {
  interface SessionData {
    clientLastResult?: string;
  }
}

export async function clientTestAction(
  db: pg.Pool | null,
  command: string,
  req: Request,
  res: Response,
): Promise<boolean> {
  if (!['Test/GetTest', 'Test/PostTest', 'Test/UploadTest', 'Test/SessionTest', 'Test/Sample'].includes(command))
    return false;
  try {
    if (command === 'Test/Sample') {
      if (!db) {
        res.status(503).send(clientError(-1, 'The local client database is not configured.'));
        return true;
      }
      const rows = (await db.query('SELECT user_name FROM mst_user WHERE user_id=$1', ['cimtops'])).rows;
      res.send(
        `<NewDataSet>${rows.map((row) => `<Table>${row.user_name === null ? '' : clientElement('user_name', row.user_name)}</Table>`).join('')}</NewDataSet>`,
      );
      return true;
    }
    if (command === 'Test/SessionTest') {
      if (!req.session.clientLastResult) throw new Error('No LastResult in this session.');
      res.send(req.session.clientLastResult);
      return true;
    }
    let xml: string;
    if (command === 'Test/UploadTest') {
      if (!req.file) throw new Error('No uploaded file.');
      xml = serialize(parseXml(decodeImport(await readFile(req.file.path), 'xml', 'utf-8')));
    } else {
      const params = command === 'Test/GetTest' ? req.query : (req.body ?? {});
      const entries = Object.entries(params).map(([name, value]) => {
        if (!/^[_\p{L}\p{Nl}][_\p{L}\p{Nl}\p{N}\p{M}\u00B7.\-\u203F\u2040]*$/u.test(name))
          throw new Error('Invalid XML element name.');
        return clientElement(name, Array.isArray(value) ? value.join(',') : value);
      });
      xml = `<ConMas>${entries.join('')}</ConMas>`;
      if (XMLValidator.validate(xml) !== true) throw new Error('Invalid XML value.');
    }
    // WebForms Session.Clear retains the cookie/ID but removes authentication and the previous result.
    for (const key of Object.keys(req.session))
      if (key !== 'cookie') delete (req.session as unknown as Record<string, unknown>)[key];
    req.session.clientLastResult = xml;
    res.send(xml);
  } catch (error) {
    // Return the legacy data/error envelope without leaking Node stack paths or internals.
    res.send(
      `<data type="error">${clientElement('message', error instanceof Error ? error.message : 'server error.')}</data>`,
    );
  }
  return true;
}
