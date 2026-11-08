import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { getClientMenu } from '../../../src/models/client-menu.js';

const enabled = { skip: !process.env.DATABASE_URL };
const parser = new XMLParser({ parseTagValue: false });
function unzip(data: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let position = 0;
  while (data.readUInt32LE(position) === 0x04034b50) {
    assert.equal(data.readUInt16LE(position + 8), 0);
    const size = data.readUInt32LE(position + 18),
      length = data.readUInt16LE(position + 26),
      extra = data.readUInt16LE(position + 28);
    const name = data.subarray(position + 30, position + 30 + length).toString();
    const body = data.subarray(position + 30 + length + extra, position + 30 + length + extra + size);
    assert.equal(crc32(body), data.readUInt32LE(position + 14));
    assert(!entries.has(name));
    entries.set(name, body);
    position += 30 + length + extra + size;
  }
  assert.equal(data.readUInt32LE(position), 0x02014b50);
  assert.equal(data.readUInt32LE(data.length - 22), 0x06054b50);
  assert.equal(data.readUInt16LE(data.length - 12), entries.size);
  return entries;
}
async function fixture(run: (db: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const connection = await pool.connect();
  try {
    for (const table of [
      'custom_menu',
      'custom_menu_setting',
      'custom_menu_role',
      'mst_group_affiation',
      'def_top',
      'common_data_version',
    ])
      await connection.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await run({ query: connection.query.bind(connection) } as unknown as pg.Pool);
  } finally {
    connection.release(true);
    await pool.end();
  }
}

test(
  'classic menu ZIP retains six-item limit, default containers, source ordering and original image names',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.custom_menu (custom_id,customize_type,logo_type,menu_title,font_size,bold,font_color,image_file) VALUES (0,1,0,'Normal & menu',12,1,'#123456','normal'),(1,2,2,'Custom <menu>',14,0,'#abcdef','logo'),(2,1,1,'Not classic',15,0,'','other-logo');
    INSERT INTO pg_temp.custom_menu_setting (custom_id,custom_menu_id,customize_type,menu_title,font_size,display_number,def_top_id,device_menu_title,device_font_size,image_file) VALUES
      (1,1,1,'First',11,2,10,'Device',13,'first-image'),(1,2,2,'Second',10,1,NULL,NULL,NULL,'not-image'),(1,3,0,'Disabled',10,0,NULL,NULL,NULL,'disabled'),(1,7,1,'Seventh',10,0,NULL,NULL,NULL,'seventh'),(2,1,1,'Other menu',10,0,NULL,NULL,NULL,'other');
    INSERT INTO pg_temp.custom_menu_role (custom_id,group_id) VALUES (1,99);
    INSERT INTO pg_temp.def_top (def_top_id,def_top_org) VALUES (10,8);
    INSERT INTO pg_temp.common_data_version (data_id,data_version) VALUES ('CustomMenu','fixture-version')`);
      const entries = unzip(await getClientMenu(db, 'no-role', false));
      assert.deepEqual([...entries.keys()].sort(), [
        'customMenu.xml',
        'customMenuImage_1',
        'customMenuLogo',
        'normalMenu',
      ]);
      const xml = parser.parse(entries.get('customMenu.xml')!.toString()).conmas;
      assert.equal(xml.version, 'fixture-version');
      assert.equal(xml.normalMenuSetting.menuTitle, 'Normal & menu');
      assert.equal(xml.customMenuSettings.menuTitle, 'Custom <menu>');
      assert.deepEqual(
        xml.customMenuSettings.customMenuSetting.map((row: Record<string, string>) => row.menuTitle),
        ['Second', 'First'],
      );
      const first = xml.customMenuSettings.customMenuSetting[1];
      assert.equal(first.fontSize, '11');
      assert.equal(first.defTopOrg, '8');
      assert.equal(first.deviceMenu.fontSize, '13');
      await db.query('UPDATE pg_temp.custom_menu SET customize_type=0 WHERE custom_id=1');
      const disabled = unzip(await getClientMenu(db, 'no-role', false));
      assert(!disabled.has('customMenuImage_1'));
      assert(disabled.has('customMenuLogo'));
      assert.deepEqual(parser.parse(disabled.get('customMenu.xml')!.toString()).conmas.customMenuSettings, {
        logoType: '0',
      });
      await db.query('DELETE FROM pg_temp.custom_menu');
      assert.deepEqual(
        parser.parse(
          unzip(await getClientMenu(db, 'fixture', false))
            .get('customMenu.xml')!
            .toString(),
        ).conmas.normalMenuSetting,
        { customizeType: '0' },
      );
    }),
);

test(
  'multi-menu ZIP enforces roles on XML and images, admin bypass, 0..30 menus and parent button fonts',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.custom_menu (custom_id,customize_type,logo_type,menu_title,display_number,button_font_size,image_file) VALUES
      (0,1,0,'Normal',0,8,'normal'),(1,1,1,'Restricted',1,22,'restricted-logo'),(2,1,2,'Public',3,24,'public-logo'),(3,1,1,'Member',2,NULL,'member-logo'),(30,2,0,'Last',4,20,NULL),(31,1,1,'Beyond max',5,10,'too-far'),(4,0,1,'Disabled',0,10,'disabled-logo');
    INSERT INTO pg_temp.custom_menu_setting (custom_id,custom_menu_id,customize_type,menu_title,display_number,font_size,image_file) VALUES
      (1,1,1,'Restricted item',1,11,'restricted-image'),(2,7,1,'Seventh item',1,11,'seventh'),(2,2,1,'Second id',1,11,''::bytea),(3,1,1,'Member item',1,11,'member'),(4,1,1,'Disabled parent item',1,11,'orphan');
    INSERT INTO pg_temp.custom_menu_role (custom_id,group_id) VALUES (1,99),(3,10);
    INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (10,'fixture')`);
      const entries = unzip(await getClientMenu(db, 'fixture', true));
      assert(!entries.has('customMenuLogo_1'));
      assert(!entries.has('customMenuImage_1_1'));
      assert(!entries.has('customMenuLogo_31'));
      assert(entries.has('customMenuLogo_2'));
      assert(entries.has('customMenuImage_2_7'));
      assert(entries.has('customMenuLogo_4'));
      assert(entries.has('customMenuImage_4_1'));
      const xml = parser.parse(entries.get('customMenu.xml')!.toString()).conmas;
      assert.equal(xml.version, '');
      assert.deepEqual(
        xml.customMenuSettings.customMenu.map((row: Record<string, string>) => row.customId),
        ['3', '2', '30'],
      );
      assert.equal(xml.customMenuSettings.customMenu[0].customMenuSetting.fontSize, '');
      assert.equal(xml.customMenuSettings.customMenu[1].customMenuSetting[0].customMenuId, '2');
      assert.equal(xml.customMenuSettings.customMenu[1].customMenuSetting[0].fontSize, '24');
      const admin = unzip(await getClientMenu(db, 'conmasadmin', true));
      assert(admin.has('customMenuLogo_1'));
      assert(admin.has('customMenuImage_1_1'));
      const nonmember = unzip(await getClientMenu(db, "fixture' OR 1=1--", true));
      assert(!nonmember.has('customMenuLogo_3'));
      assert(!nonmember.has('customMenuImage_3_1'));
      await db.query('DELETE FROM pg_temp.custom_menu; DELETE FROM pg_temp.custom_menu_setting');
      const empty = unzip(await getClientMenu(db, 'fixture', true));
      assert.equal(empty.size, 1);
      assert.equal(parser.parse(empty.get('customMenu.xml')!.toString()).conmas.customMenuSettings, '');
    }),
);
