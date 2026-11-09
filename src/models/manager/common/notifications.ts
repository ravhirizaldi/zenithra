import type pg from 'pg';
import { directIsLinked } from '../../../controllers/manager/system/direct.js';
import { webhookIsLinked } from '../../../controllers/manager/system/webhook.js';
import { child, children, optionalField, root, value } from '../../client-definition-xml.js';
import { LabelValidationError } from '../labels/index.js';

type Database = Pick<pg.Pool, 'query'>;
export type NotificationOption = { value: string; text: string };

export async function reportNotificationOptions(db: Database, locale: string) {
  const direct = await directIsLinked(db),
    webhook = await webhookIsLinked(db);
  const options = new Map<string, NotificationOption[]>();
  for (const event of ['Edit', 'Complete']) {
    const prefix = event.toLowerCase();
    const mail = (
      await db.query<{ xml_data: string }>('SELECT xml_data FROM mst_mail WHERE mail_file_name=$1', [
        'Mail' + event + '.xml',
      ])
    ).rows[0]?.xml_data;
    const mailOptions: NotificationOption[] = [{ value: '', text: '' }];
    if (mail)
      for (const template of children(root(mail), 'template')) {
        const names = children(template, 'name');
        const name =
          names.find(
            (node) => (node[':@'] as Record<string, string> | undefined)?.['@_locale'] === locale && value(node),
          ) ?? names.find((node) => value(node));
        const id = (template[':@'] as Record<string, string> | undefined)?.['@_id'];
        if (name && id) mailOptions.push({ value: id, text: value(name) });
      }
    options.set(prefix + '_mail', mailOptions);
    if (direct) {
      const xml = (await db.query<{ xml_data: string }>('SELECT xml_data FROM mst_direct WHERE key=$1', [event]))
        .rows[0]?.xml_data;
      const templates = xml ? child(root(xml), 'templates') : undefined;
      options.set(
        prefix + '_direct',
        templates
          ? children(templates, 'template').map((node) => ({
              value: optionalField(node, 'templateId'),
              text: optionalField(node, 'templateName'),
            }))
          : [],
      );
    }
    if (webhook)
      options.set(prefix + '_webhook', [
        { value: '', text: '' },
        ...(
          await db.query<{ value: string; text: string }>(
            `SELECT webhook_id::text AS value,webhook_name AS text FROM mst_webhook WHERE ${prefix}=true ORDER BY webhook_id`,
          )
        ).rows,
      ]);
  }
  return options;
}

export function reportNotificationValues(input: unknown, multiple: boolean): string[] {
  const values = Array.isArray(input) ? input : [input];
  if (values.some((item) => typeof item !== 'string'))
    throw new LabelValidationError('', 'Invalid notification setting.');
  const result = multiple
    ? (values as string[]).flatMap((item) => item.split(',')).filter(Boolean)
    : (values as string[]);
  if ((!multiple && result.length !== 1) || result.some((item) => item.length > 4000))
    throw new LabelValidationError('', 'Invalid notification setting.');
  return result;
}
