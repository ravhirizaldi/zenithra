import type pg from 'pg';
import { directIsLinked } from '../../../controllers/manager/system/direct.js';
import { webhookIsLinked } from '../../../controllers/manager/system/webhook.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import type { SystemMenuFlags } from '../../../services/manager/system/navigation.js';

export async function loadNavigationFlags(database: pg.Pool): Promise<SystemMenuFlags> {
  const [settings, directLinked, webhookLinked] = await Promise.all([
    database.query<{ com_key: string; com_name: string; com_value: string }>(
      `SELECT com_key, com_name, com_value FROM mst_common
       WHERE (com_key = $1 AND com_name = $2)
          OR (com_key = $3 AND com_name = $4)
          OR (com_key = $5 AND com_name = $6)
          OR (com_key = $7 AND com_name = $8)
          OR (com_key = $9 AND com_name = $10)
          OR (com_key = $11 AND com_name = $12)
       ORDER BY com_index`,
      [
        'APP_STORAGE_MODE',
        'LOG',
        'APP_STORAGE_MODE',
        'IMAGE_BACKUP',
        'OUTPUT_SETTING',
        'TYPE',
        'CONMAS_FUNCTION',
        'UPLOAD_LIST',
        'CONMAS_FUNCTION',
        'SERVER_LOG',
        'SYSTEM',
        'LICENSE_UPLOADING_IS_ENABLED',
      ],
    ),
    directIsLinked(database),
    webhookIsLinked(database),
  ]);
  const flag = (key: string, name: string) =>
    settings.rows.some((row) => row.com_key === key && row.com_name === name && row.com_value === '1');
  const currentLicense = licenseStatus();
  const flags: SystemMenuFlags = {
    directLinked,
    webhookLinked,
    uploadEnabled: flag('CONMAS_FUNCTION', 'UPLOAD_LIST'),
    backupLogEnabled: flag('APP_STORAGE_MODE', 'LOG'),
    backupImageEnabled: flag('APP_STORAGE_MODE', 'IMAGE_BACKUP'),
    autoOutputEnabled: flag('OUTPUT_SETTING', 'TYPE'),
    serverLogEnabled: flag('CONMAS_FUNCTION', 'SERVER_LOG'),
    licenseUploadEnabled: flag('SYSTEM', 'LICENSE_UPLOADING_IS_ENABLED'),
    hasFreeDrawLicense: currentLicense.hasFreeDrawLicense,
    freeDrawOnly: currentLicense.freeDrawOnly,
  };
  return flags;
}
