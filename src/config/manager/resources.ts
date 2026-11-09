import { text as shared } from './shared/resources.js';
import { text as account } from './account/resources.js';
import { text as catalog } from './catalog/resources.js';
import { text as documents } from './documents/resources.js';
import { text as labels } from './labels/resources.js';
import { text as library } from './library/resources.js';
import { text as dataOutput } from './data-output/resources.js';
import { text as system } from './system/resources.js';

export const managerResources = {
  shared,
  account,
  catalog,
  documents,
  labels,
  library,
  'data-output': dataOutput,
  system,
};

export function managerScriptText(value: string, quote: string): string {
  const encoded = JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  if (quote === '"') return encoded;
  return "'" + encoded.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'") + "'";
}

export const managerResourceLocals = { managerResources, managerScriptText };
