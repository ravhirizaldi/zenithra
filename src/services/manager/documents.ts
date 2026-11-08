import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ejs from 'ejs';
import { XMLParser } from 'fast-xml-parser';
import { root } from '../../config/manager.js';
import { legacyEncrypt } from '../../shared/legacy-auth.js';

const installedViews = '/mnt/c/Users/DELL/CONMASSERVER/ConMasManager/Views';
const resources = join(root, 'legacy/decompiled/conmas-manager-decompiled/Cimtops.ConMasBiz');
let cached: ReturnType<typeof load> | undefined;
let schemeKey: Promise<string> | undefined;
let taskScript: Promise<string> | undefined;
export async function documentSchemeAuth(user: string, password: string) {
  schemeKey ??= readFile(join(resources, 'Cimtops/ConMasBiz/Util/ConMasUtility.cs'), 'utf8').then((source) => {
    const key = source.match(/\burlSchemeKey\s*=\s*"([^"]+)"/)?.[1];
    if (!key) throw new Error('The Documents app-launch compatibility key is unavailable.');
    return key;
  });
  return encodeURIComponent(legacyEncrypt(`user=${user}&pass=${password}`, await schemeKey)).replace(
    /%[0-9A-F]{2}/g,
    (value) => value.toLowerCase(),
  );
}
async function load() {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
  const resource = async (name: string): Promise<Record<string, string>> => {
    const xml = await readFile(join(resources, `Cimtops.ConMasBiz.Properties.${name}.resx`), 'utf8');
    const data = parser.parse(xml).root.data as { '@_name': string; value: string }[];
    return Object.fromEntries(
      data.flatMap((row) => [
        [row['@_name'], row.value ?? ''],
        [row['@_name'].replace(/-/g, '_'), row.value ?? ''],
      ]),
    );
  };
  const [r, v, index] = await Promise.all([
    resource('IRResources.IRResource'),
    resource('IRViewResources.IRViewResource'),
    readFile(join(installedViews, 'InputReport/Index.cshtml'), 'utf8'),
  ]);
  const scripts = [...index.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  if (scripts.length !== 2) throw new Error('Unexpected installed Documents script structure.');
  const js = scripts[0]
    .replace(/@\*[\s\S]*?\*@/g, '')
    .replace(
      '@string.Format(IRResource.SelectDataMessage, IRResource.Target)',
      ejs.escapeXML(r.SelectDataMessage.replace('{0}', r.Target)),
    )
    .replace(/@IR(View)?Resource\.(\w+)/g, (_match, view: string | undefined, key: string) => {
      const values = view ? v : r;
      if (!Object.hasOwn(values, key)) throw new Error('Missing Documents resource.');
      return ejs.escapeXML(values[key]);
    });
  if (/@(?:IR|Html|Model|string\.)/.test(js)) throw new Error('Unresolved Documents script expression.');
  return { r, v, js, searchJs: scripts[1] };
}
// Retain the installed inline JavaScript rather than maintaining a second rewritten copy.
export function documentViewSource() {
  cached ??= load();
  return cached;
}
export async function documentTaskScript(closed: '0' | '2') {
  taskScript ??= Promise.all([
    documentViewSource(),
    readFile(join(installedViews, 'Common/RegistTask.cshtml'), 'utf8'),
  ]).then(([{ r }, source]) => {
    const script = source.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error('The installed task script is unavailable.');
    const result = script
      .replace(/@\(Model.ControllerName\)/g, 'InputReport')
      .replace(/@Model.RegistTackClosed/g, '__TASK_CLOSED__')
      .replace(/@Model.Selected(?:User|Group)String/g, '')
      .replace(/@CommonRegistTaskModel.ActionType\.(\w+)/g, '$1')
      .replace(/@string.Format\(IRResource.SelectDataMessage, IRResource\.(\w+)\)/g, (_match, key: string) =>
        ejs.escapeXML(r.SelectDataMessage.replace('{0}', r[key])),
      )
      .replace(/@IRResource\.(\w+)/g, (_match, key: string) => {
        if (!Object.hasOwn(r, key)) throw new Error('Missing task resource.');
        return ejs.escapeXML(r[key]);
      })
      .replace(/@@/g, '@');
    if (/@(?:Model|IRResource|Html|CommonRegistTaskModel|string\.)/.test(result))
      throw new Error('Unresolved task script expression.');
    return result;
  });
  return (await taskScript).replace(/__TASK_CLOSED__/g, closed);
}
