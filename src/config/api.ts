import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { root } from './manager.js';

export const apiBase = '/ConMasAPI';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

export function apiConfiguration() {
  const xml = readFileSync(join(root, 'config/api.xml'), 'utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error('Invalid API configuration.');
  const config = parser.parse(xml).ConMasAPI;
  const minutes = Number(config?.['@_sessionTimeoutMinutes']),
    maxRequestBytes = Number(config?.['@_maxRequestBytes']);
  const executeType = config?.['@_executeType'];
  if (
    !Number.isSafeInteger(minutes) ||
    minutes <= 0 ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes <= 0 ||
    !['0', '1', '2'].includes(executeType) ||
    !['true', 'false'].includes(config?.['@_tokenCheck']) ||
    !['true', 'false'].includes(config?.['@_secureCookie'])
  )
    throw new Error('Invalid API configuration.');
  if (typeof config['@_culture'] !== 'string' || !/^[a-z]{2,3}-[A-Za-z]{2,4}$/.test(config['@_culture']))
    throw new Error('Invalid API culture.');
  const entries = config.commands?.Command;
  const result = new Map<string, string>();
  for (const entry of Array.isArray(entries) ? entries : entries ? [entries] : []) {
    const name = entry['@_name'],
      path = entry['#text'];
    if (
      typeof name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9]*$/.test(name) ||
      typeof path !== 'string' ||
      !/^\.\/[A-Za-z][A-Za-z0-9]*\.aspx$/.test(path) ||
      result.has(name)
    )
      throw new Error('Invalid API command mapping.');
    result.set(name, path.slice(2, -5));
  }
  if (!result.size) throw new Error('Empty API command mapping.');
  const names = (value: unknown): Set<string> => {
    if (typeof value !== 'string') throw new Error('Invalid API handler list.');
    const entries = value.trim().split(/\s+/);
    if (entries.some((name) => !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) || new Set(entries).size !== entries.length)
      throw new Error('Invalid API handler list.');
    return new Set(entries);
  };
  const freeDrawCommands = names(config.freeDrawCommands);
  if ([...freeDrawCommands].some((name) => !result.has(name))) throw new Error('Invalid API FreeDraw command list.');
  return {
    idleMs: minutes * 60000,
    executeType,
    tokenCheck: config['@_tokenCheck'] === 'true',
    secureCookie: config['@_secureCookie'] === 'true',
    maxRequestBytes,
    culture: config['@_culture'] as string,
    commands: result,
    freeDrawCommands,
    directHandlers: names(config.directHandlers),
  };
}
