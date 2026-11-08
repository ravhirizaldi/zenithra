import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { root } from './manager.js';

export const clientBase = '/ConMasWeb';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

export function clientConfiguration() {
  const config = parser.parse(readFileSync(join(root, 'config/client.xml'), 'utf8')).ConMasWeb;
  const idleMinutes = Number(config['@_sessionTimeoutMinutes']);
  const defaultRoleMode = config['@_defaultRoleMode'] ?? 'All';
  if (!['All', 'UserGroup'].includes(defaultRoleMode)) throw new Error('Invalid client default role mode.');
  if (!Number.isSafeInteger(idleMinutes) || idleMinutes <= 0 || typeof config['@_serverVersion'] !== 'string')
    throw new Error('Invalid Node client configuration.');
  return {
    authType: config['@_authType'] as string,
    serverVersion: config['@_serverVersion'] as string,
    designerVersion: config.versions['@_Designer'] as string,
    designerDisplayVersion: config.versions['@_DesignerDisplay'] as string,
    scanDesignerVersion: config.versions['@_ScanDesigner'] as string,
    edgeOcrDesignerVersion: config.versions['@_EdgeOCRDesigner'] as string,
    ipadVersion: config.versions['@_iPad'] as string,
    idleMs: idleMinutes * 60 * 1000,
    defaultRoleMode: defaultRoleMode as 'All' | 'UserGroup',
    designerDownloadUrl: config['@_designerDownloadUrl'] as string | undefined,
    commands: new Set<string>(config.commands.command),
    directHandlers: new Set<string>(config.directHandlers.handler),
  };
}

export function designerInstallerUrl(origin: string, language: string): string {
  return (
    clientConfiguration().designerDownloadUrl ??
    `${origin}${clientBase}/ConMasDesigner${language === 'EN' ? '.en' : language === 'CN' ? '.cn' : ''}.bin`
  );
}

// ConMasUtility.IsValidClientVersion compares numeric components, not strings or padded versions.
export function validClientVersion(minimum: string, actual: string): boolean {
  const parts = (value: string) =>
    value
      .split('.')
      .map((part) =>
        /^[+-]?\d+$/.test(part) && Number(part) >= -2147483648 && Number(part) <= 2147483647 ? Number(part) : NaN,
      );
  const target = parts(minimum),
    client = parts(actual);
  if (target.some(Number.isNaN) || client.some(Number.isNaN)) return false;
  for (let index = 0; index < target.length; index++) {
    if (client[index] === undefined || client[index] < target[index]) return false;
    if (client[index] > target[index]) return true;
  }
  return true;
}
