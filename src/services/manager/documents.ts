import { text as pageText } from '../../config/manager/documents/resources.js';
import { join } from 'node:path';
import ejs from 'ejs';
import { root } from '../../config/manager.js';
import { r, v } from '../../config/manager/documents/resources.js';
import { managerResourceLocals } from '../../config/manager/resources.js';
import { legacyEncrypt } from '../../shared/legacy-auth.js';

const scripts = join(root, 'src/views/manager/documents/scripts');
let cached: ReturnType<typeof load> | undefined;
export async function documentSchemeAuth(user: string, password: string) {
  const key = process.env.CONMAS_URL_SCHEME_KEY;
  if (!key) throw new Error(pageText['The Documents app-launch compatibility key is not configured.']);
  return encodeURIComponent(legacyEncrypt(`user=${user}&pass=${password}`, key)).replace(/%[0-9A-F]{2}/g, (value) =>
    value.toLowerCase(),
  );
}
async function load() {
  const [js, searchJs] = await Promise.all([
    ejs.renderFile(join(scripts, 'index.ejs'), { r, v }),
    ejs.renderFile(join(scripts, 'search.ejs'), { r, v }),
  ]);
  return { ...managerResourceLocals, r, v, js, searchJs };
}
export function documentViewSource() {
  cached ??= load();
  return cached;
}
export async function documentTaskScript(closed: '0' | '2') {
  return ejs.renderFile(join(scripts, 'regist-task.ejs'), { r, closed }, { cache: true });
}

const detailScripts = {
  Details: 'details',
  DetailsLabel: 'detail-message',
  DetailsRole: 'detail-message',
  EditLabel: 'detail-message',
  EditRole: 'edit-role',
  DetailsTop: 'details-top',
  EditTop: 'edit-top',
  DetailsSheet: 'details-sheet',
  EditSheet: 'edit-sheet',
  DetailsClusterHistory: 'detail-message',
  DetailsClusterHistoryTop: 'detail-message',
} as const;

export async function documentDetailScript(view: keyof typeof detailScripts, id: number, copyError = false) {
  return ejs.renderFile(join(scripts, detailScripts[view] + '.ejs'), { r, v, id, copyError }, { cache: true });
}
