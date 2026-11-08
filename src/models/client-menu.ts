import type pg from 'pg';
import { zipBuffer } from '../controllers/manager/system/files.js';
import { element, serialize, type XmlNode } from './client-definition-xml.js';

const style = { menuTitle: 'menu_title', fontSize: 'font_size', bold: 'bold', fontColor: 'font_color' };
const itemFields = {
  customMenuId: 'custom_menu_id',
  customizeType: 'customize_type',
  ...style,
  mode: 'mode',
  searchRule: 'search_rule',
  defTopId: 'def_top_id',
  defTopOrg: 'def_top_org',
  decodeLogic: 'decode_logic',
  uuid: 'uuid',
  distance: 'distance',
  nfcUseField: 'nfc_use_field',
  encoding: 'encoding_type',
  deviceType: 'device_type',
  systemKey1: 'system_key1',
  systemKey2: 'system_key2',
  systemKey3: 'system_key3',
  systemKey4: 'system_key4',
  systemKey5: 'system_key5',
  displayNumber: 'display_number',
};
function fields(row: Record<string, unknown>, mapping: Record<string, string>): XmlNode[] {
  return Object.entries(mapping).map(([name, column]) => element(name, String(row[column] ?? '')));
}
function item(row: Record<string, unknown>, fontSize?: unknown): XmlNode {
  return element('customMenuSetting', [
    ...fields(fontSize === undefined ? row : { ...row, font_size: fontSize }, itemFields),
    element(
      'deviceMenu',
      fields(row, {
        menuTitle: 'device_menu_title',
        fontSize: 'device_font_size',
        bold: 'device_bold',
        fontColor: 'device_font_color',
      }),
    ),
  ]);
}

// Multi-menu roles intentionally use source membership alone (no added deleted-group or System privilege gate).
export async function getClientMenu(db: pg.Pool, userId: string, multi: boolean): Promise<Buffer> {
  const roles = (alias: string) =>
    userId === 'conmasadmin' || !multi
      ? ''
      : ` AND (NOT EXISTS (SELECT 1 FROM custom_menu_role r WHERE r.custom_id=${alias}.custom_id)
    OR EXISTS (SELECT 1 FROM custom_menu_role r JOIN mst_group_affiation a ON a.group_id=r.group_id WHERE r.custom_id=${alias}.custom_id AND a.user_id=$1))`;
  const parameters = multi && userId !== 'conmasadmin' ? [userId] : [];
  const menus = (
    await db.query(
      `SELECT cm.* FROM custom_menu cm WHERE cm.customize_type>0${multi ? ' AND cm.custom_id BETWEEN 0 AND 30' : ''}${roles('cm')}${multi ? ' ORDER BY cm.display_number,cm.custom_id' : ''}`,
      parameters,
    )
  ).rows;
  const settings = (
    await db.query(
      `SELECT cms.*,top.def_top_org FROM custom_menu_setting cms LEFT JOIN def_top top ON top.def_top_id=cms.def_top_id
    WHERE cms.customize_type>0${multi ? '' : ' AND cms.custom_id=1 AND cms.custom_menu_id BETWEEN 1 AND 6'}${roles('cms')}
    ORDER BY ${multi ? 'cms.custom_id,' : ''}cms.display_number,cms.custom_menu_id`,
      parameters,
    )
  ).rows;
  const version =
    (await db.query("SELECT data_version FROM common_data_version WHERE data_id='CustomMenu'")).rows[0]?.data_version ??
    '';
  const normal = menus.find((row) => row.custom_id === 0);
  const normalXml = element(
    'normalMenuSetting',
    normal ? fields(normal, { customizeType: 'customize_type', ...style }) : [element('customizeType', '0')],
  );
  let customXml: XmlNode;
  if (multi)
    customXml = element(
      'customMenuSettings',
      menus
        .filter((row) => row.custom_id !== 0)
        .map((menu) =>
          element('customMenu', [
            ...fields(menu, {
              customId: 'custom_id',
              logoType: 'logo_type',
              layoutType: 'layout_type',
              ...style,
              displayNumber: 'display_number',
            }),
            ...settings
              .filter((row) => row.custom_id === menu.custom_id)
              .map((row) => item(row, menu.button_font_size ?? null)),
          ]),
        ),
    );
  else {
    const menu = menus.find((row) => row.custom_id === 1);
    customXml = element(
      'customMenuSettings',
      menu
        ? [...fields(menu, { logoType: 'logo_type', ...style }), ...settings.map((row) => item(row))]
        : [element('logoType', '0')],
    );
  }
  const xml = serialize(element('conmas', [element('version', version), normalXml, customXml]));
  const entries: { name: string; data: Buffer; date: Date }[] = [
    {
      name: 'customMenu.xml',
      data: Buffer.from('\ufeff<?xml version="1.0" encoding="utf-8"?>\n' + xml),
      date: new Date(),
    },
  ];
  const addImage = (name: string, data: unknown) => {
    if (data === null || data === undefined) return;
    if (!Buffer.isBuffer(data)) throw new Error('Invalid custom-menu image.');
    if (data.length) entries.push({ name, data, date: new Date() });
  };
  const logos = (
    await db.query(
      `SELECT cm.custom_id,cm.image_file FROM custom_menu cm WHERE ((cm.custom_id=0 AND cm.customize_type=1)
    OR (${multi ? 'cm.custom_id BETWEEN 0 AND 30' : 'cm.custom_id=1'} AND cm.logo_type IN (1,2)))${roles('cm')}`,
      parameters,
    )
  ).rows;
  for (const row of logos)
    addImage(
      row.custom_id === 0 ? 'normalMenu' : multi ? `customMenuLogo_${row.custom_id}` : 'customMenuLogo',
      row.image_file,
    );
  if (multi || menus.some((row) => row.custom_id === 1)) {
    const images = (
      await db.query(
        `SELECT cms.custom_id,cms.custom_menu_id,cms.image_file FROM custom_menu_setting cms WHERE cms.customize_type=1
      ${multi ? '' : ' AND cms.custom_id=1 AND cms.custom_menu_id BETWEEN 1 AND 6'}${roles('cms')}`,
        parameters,
      )
    ).rows;
    for (const row of images)
      addImage(
        multi ? `customMenuImage_${row.custom_id}_${row.custom_menu_id}` : `customMenuImage_${row.custom_menu_id}`,
        row.image_file,
      );
  }
  return zipBuffer(entries);
}
