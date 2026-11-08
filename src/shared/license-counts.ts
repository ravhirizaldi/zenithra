import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { legacyDecrypt } from './legacy-auth.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const installedSettings = '/mnt/c/Users/DELL/CONMASSERVER/SettingFiles/xml';
export function clientSettingsDirectory(): string | null {
  const configured = process.env.CONMAS_CLIENT_SETTINGS?.trim();
  if (configured) return isAbsolute(configured) ? resolve(configured) : null;
  return existsSync(installedSettings) ? installedSettings : null;
}
const preservedLicenseFile = fileURLToPath(new URL('../../legacy/SettingFiles/xml/License.xml', import.meta.url));
export const nodeLicenseFile = fileURLToPath(
  new URL('../../legacy/SettingFiles/xml/License.node.xml', import.meta.url),
);

export function parseLicenseFields(xml: string, key: string): Map<string, string> {
  if (!key) throw new Error('License compatibility key is not configured.');
  if (XMLValidator.validate(xml) !== true) throw new Error('The license XML is invalid.');
  const encrypted = xmlParser.parse(xml)?.ConMas?.license;
  if (typeof encrypted !== 'string' || !encrypted.trim()) throw new Error('The license XML has no license value.');
  const fields = new Map<string, string>();
  for (const part of legacyDecrypt(encrypted.trim(), key).split(';')) {
    const delimiter = part.indexOf('=');
    if (delimiter > 0) fields.set(part.slice(0, delimiter).trim(), part.slice(delimiter + 1).trim());
  }
  return fields;
}

export function readLicenseXml(): string {
  const settings = clientSettingsDirectory();
  const installedLicenseFile = settings ? resolve(settings, 'License.xml') : preservedLicenseFile;
  const file = existsSync(nodeLicenseFile) ? nodeLicenseFile : installedLicenseFile;
  return readFileSync(file, 'utf8');
}

export function readLicenseFields(): Map<string, string> {
  const key = process.env.CONMAS_LICENSE_KEY;
  if (!key) throw new Error('License compatibility key is not configured.');
  return parseLicenseFields(readLicenseXml(), key);
}

// Common.GetLicenseAll: use the preserved installation license and its original cipher.
export function licenseCounts(
  fields = readLicenseFields(),
): Record<'User' | 'iPad' | 'Designer' | 'Type' | 'Scandit', number> {
  const result = { User: 0, iPad: 0, Designer: 0, Type: 0, Scandit: 0 };
  for (const name of Object.keys(result) as (keyof typeof result)[]) {
    const value = Number(fields.get(name));
    if (Number.isSafeInteger(value)) result[name] = value;
  }
  return result;
}

export function licenseDate(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1) return null;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? value : null;
}

export function clientIoTLicenseStatus(fields = readLicenseFields(), today = new Date()): number {
  const todayCode = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const state = (name: string) => {
    const enabled = /^[+-]?\d+$/.test((fields.get(name) ?? '').trim()) && Number(fields.get(name)) === 1;
    const expiry = licenseDate(fields.get(`${name}Expire`));
    return enabled ? (expiry && expiry < todayCode ? 2 : 1) : 0;
  };
  const states = [state('ConMasIoTGateway'), state('MappingTool')];
  return states.includes(1) ? 1 : states.includes(2) ? 2 : 0;
}

export function edgeOcrLicense(fields = readLicenseFields()): {
  enabled: boolean;
  token: string;
  limit: number | null;
  expires: string | null;
} {
  let limit: number | null = null,
    expires: string | null = null;
  for (const [name, value] of fields) {
    if (
      ['EdgeOCRLimited', 'i-RepoEdgeOCRLimited'].includes(name) &&
      /^[+-]?\d+$/.test(value.trim()) &&
      Number(value) > 0 &&
      Number(value) <= 2147483647
    )
      limit = Number(value);
    if (['EdgeOCRExpire', 'i-RepoEdgeOCRLimitedExpire'].includes(name) && licenseDate(value)) expires = value;
  }
  const token = fields.get('EdgeOCRTokenID') ?? '';
  return { enabled: Boolean(token && expires && limit !== null), token, limit, expires };
}

export function licenseStatus(checkFreeDrawExpiry = false): {
  freeDrawOnly: boolean;
  freeDraw: boolean;
  hasFreeDrawLicense: boolean;
  mobileIron: boolean;
  edgeOCR: boolean;
} {
  const fields = readLicenseFields();
  const freeDrawOnly = fields.get('FreeDrawOnly') === '1';
  const freeDraw = Number(fields.get('FreeDraw')) > 0;
  const expires = licenseDate(freeDraw ? fields.get('FreeDrawExprie') : fields.get('FreeDrawOnlyExpire'));
  const today = new Date();
  const todayCode = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  return {
    freeDrawOnly,
    freeDraw,
    hasFreeDrawLicense: (freeDraw || freeDrawOnly) && (!checkFreeDrawExpiry || !expires || expires >= todayCode),
    mobileIron: fields.get('MobileIron') === '1',
    edgeOCR: edgeOcrLicense(fields).enabled,
  };
}
