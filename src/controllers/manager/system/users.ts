import type { Express, Response } from 'express';
import type pg from 'pg';
import sharp from 'sharp';
import { legacyPassword } from '../../../shared/legacy-auth.js';
import { licenseCounts } from '../../../shared/license-counts.js';
import { passwordStrength } from '../../../shared/user-password-strength.js';
import { logUserAccountChange, userAuditSnapshot } from '../../../shared/operation-log.js';

type Fields = Record<string, string>;
const input = (body: Record<string, unknown>, key: string) =>
  typeof body[key] === 'string' ? (body[key] as string) : '';
export function userDate(value: string, end = false): string | null {
  const match = value.replaceAll('/', '-').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((x) => Number(x ?? 0));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  return `${match[1]}-${match[2]}-${match[3]} ${end && hour === 0 && minute === 0 && second === 0 ? '23:59:59' : `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`}`;
}
export function validUserId(id: string, maxLength = 0): boolean {
  return (
    Boolean(id) &&
    !/[<>"{}|\\^[\]`#%;/?:@&=+$,'()*]/.test(id) &&
    !id.endsWith('.') &&
    (!maxLength || id.length <= maxLength)
  );
}

// Standard on-premise branch of SystemController user actions and SystemRepository user writes.
export function registerUsers(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
) {
  const root = '/ConMasManager/System';
  const groupRows = async (id: string) =>
    (
      await db.query(
        `SELECT g.group_id,g.group_name_path,(a.user_id IS NOT NULL) AS chk,
    coalesce(a.group_admin,0)::int AS group_admin,to_char(a.use_start_time,'YYYY-MM-DD"T"HH24:MI:SS') AS use_start_time,to_char(a.use_end_time,'YYYY-MM-DD"T"HH24:MI:SS') AS use_end_time
    FROM mst_group g LEFT JOIN mst_group_affiation a ON g.group_id=a.group_id AND a.user_id=$1
    WHERE g.deleted=0 AND g.group_id > -999 ORDER BY g.group_name_path,g.group_id`,
        [id],
      )
    ).rows;
  const load = async (id: string) =>
    (
      await db.query(
        `SELECT user_id,user_name,e_mail,approval_sign,identification_code,meid_upn,meid_oid,amivoice_enable,workflow_enable,irfd_enable,irchat_enable,
    to_char(coalesce(use_start_time,now()),'YYYY-MM-DD"T"HH24:MI:SS') AS use_start_time,
    to_char(coalesce(use_end_time,timestamp '2038-01-01'),'YYYY-MM-DD"T"HH24:MI:SS') AS use_end_time,
    EXISTS(SELECT 1 FROM user_lock WHERE user_id=mst_user.user_id) AS has_lock FROM mst_user WHERE user_id=$1`,
        [id],
      )
    ).rows[0];
  const show = async (
    res: Response,
    mode: string,
    record: Record<string, unknown>,
    error = '',
    groups?: Record<string, unknown>[],
  ) =>
    render(res, {
      active: 'System',
      section: 'UserList',
      login: false,
      title: mode === 'CreateUser' ? 'Create User' : mode === 'EditUser' ? 'Edit User' : 'User details',
      userName: res.locals.userName,
      userPage: { mode, record, error, groups: groups ?? (await groupRows(String(record.user_id ?? ''))) },
    });
  app.get(`${root}/GetTemporaryUserSign`, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.session.temporaryUserSign) return res.status(200).end();
    return res
      .set({ 'Content-Type': 'image', 'Content-Disposition': 'attachment; filename="sign"' })
      .send(Buffer.from(req.session.temporaryUserSign, 'base64'));
  });
  app.get(`${root}/CreateUser`, async (req, res) => {
    delete req.session.temporaryUserSign;
    const count = Number(
      (await db.query("SELECT count(*) AS count FROM mst_user WHERE user_id<>'conmasadmin'")).rows[0].count,
    );
    if (count >= licenseCounts().User) return res.status(409).send('The licensed user count has been reached.');
    return show(res, 'CreateUser', {
      user_id: '',
      user_name: '',
      e_mail: '',
      use_start_time: '',
      use_end_time: '',
      meid_upn: '',
      meid_oid: '',
    });
  });
  for (const action of ['DetailsUser', 'EditUser'])
    app.get(`${root}/${action}`, async (req, res) => {
      if (action === 'EditUser') delete req.session.temporaryUserSign;
      const id = typeof req.query.id === 'string' ? req.query.id : '';
      if (id === 'conmasadmin') return res.redirect(`${root}/EditAdmin`);
      const record = await load(id);
      if (!record) return res.status(404).send('User not found.');
      return show(res, action, record);
    });
  app.post(`${root}/DetailsUser`, async (req, res) => {
    const id = input(req.body, 'mst_user.user_id');
    if (id === 'conmasadmin') return res.sendStatus(403);
    if (!(await load(id))) return res.status(404).send('User not found.');
    if (req.body.act === 'delete') {
      const before = await userAuditSnapshot(db, id);
      try {
        await db.query('DELETE FROM mst_user WHERE user_id=$1', [id]);
      } catch (error) {
        if ((error as { code: string }).code === '23503')
          return show(
            res.status(409),
            'DetailsUser',
            await load(id),
            'The user still owns locked records. Unlock those records before deleting the user.',
          );
        throw error;
      }
      await logUserAccountChange(db, before, null, req.session.userId ?? '', req.ip ?? '');
      return res.redirect(`${root}/UserList`);
    }
    await db.query('DELETE FROM user_lock WHERE user_id=$1', [id]);
    return res.redirect(`${root}/DetailsUser?id=${encodeURIComponent(id)}`);
  });
  for (const action of ['CreateUser', 'EditUser'])
    app.post(`${root}/${action}`, async (req, res) => {
      const create = action === 'CreateUser';
      const record: Fields = {};
      for (const field of ['user_id', 'user_name', 'e_mail', 'use_start_time', 'use_end_time'])
        record[field] = input(req.body, `mst_user.${field}`);
      record.user_id = record.user_id.trim();
      record.meid_upn = input(req.body, 'mst_user.MeIdUpn');
      record.meid_oid = input(req.body, 'mst_user.MeIdOid');
      if (record.user_id === 'conmasadmin') return res.sendStatus(403);
      const old = create ? null : await load(record.user_id);
      if (!create && !old) return res.status(404).send('User not found.');
      const groups = await groupRows(record.user_id);
      const memberships: {
        group_id: number;
        use_start_time: string | null;
        use_end_time: string | null;
        group_admin: number;
      }[] = [];
      let error = '';
      for (let index = 0; index < groups.length; index++) {
        const prefix = `userGroupsPage[${index}]`;
        const id = Number(input(req.body, `${prefix}.group_id`));
        const group = groups.find((row) => row.group_id === id);
        if (!group) continue;
        group.chk = input(req.body, `${prefix}.chk`) === 'true';
        const adminKey = `${prefix}.group_admin`,
          startKey = `${prefix}.use_start_time`,
          endKey = `${prefix}.use_end_time`;
        const groupAdmin = Object.hasOwn(req.body, adminKey)
          ? input(req.body, adminKey) === 'true'
            ? 1
            : 0
          : Number(group.group_admin);
        const start = Object.hasOwn(req.body, startKey)
          ? input(req.body, startKey)
          : String(group.use_start_time ?? '');
        const end = Object.hasOwn(req.body, endKey) ? input(req.body, endKey) : String(group.use_end_time ?? '');
        group.use_start_time = start;
        group.use_end_time = end;
        if (!group.chk) continue;
        const from = start ? userDate(start) : null,
          to = end ? userDate(end, true) : null;
        if ((start && !from) || (end && !to) || (from && to && from > to))
          error = 'Check the group membership validity dates.';
        memberships.push({ group_id: id, use_start_time: from, use_end_time: to, group_admin: groupAdmin });
      }
      const password = input(req.body, 'new_password') || (create ? input(req.body, 'mst_user.password') : '');
      const confirm =
        input(req.body, 'new_password') && create
          ? input(req.body, 'new_confirm_password')
          : input(req.body, 'confirm_password');
      const identification = input(req.body, create ? 'mst_user.IdentificationCode' : 'NewIdentificationCode');
      const from = userDate(record.use_start_time),
        to = userDate(record.use_end_time, true);
      if (!record.user_name.trim()) error = 'User name is required.';
      if (!from || !to || from > to) error = 'Check the user validity dates.';
      if ((create && !password) || password !== confirm) error = 'Enter matching passwords.';
      if (/[\s\u3000]/.test(identification)) error = 'Identity verification code must not contain spaces.';
      const maximum = Number(
        (
          await db.query(
            "SELECT com_value FROM mst_common WHERE com_key='USER_SETTING' AND com_name='USER_ID_MAX_LENGTH' ORDER BY com_index LIMIT 1",
          )
        ).rows[0]?.com_value ?? 0,
      );
      if (!validUserId(record.user_id, maximum > 0 ? maximum : 0))
        error = 'The user ID contains an invalid character or exceeds the configured length.';
      if (req.file) {
        try {
          const image = sharp(req.file.buffer, { limitInputPixels: 16777216 });
          const meta = await image.metadata();
          if (
            !req.file.mimetype.startsWith('image/') ||
            !['png', 'jpeg', 'gif', 'tiff', 'bmp'].includes(meta.format ?? '')
          )
            throw new Error();
          await image.raw().toBuffer();
          req.session.temporaryUserSign = req.file.buffer.toString('base64');
        } catch {
          error = 'Upload a valid image for the signature.';
        }
      }
      if (!create && input(req.body, 'IsClearImage') === 'true') {
        delete req.session.temporaryUserSign;
        record.approval_sign = '';
        record.clear_sign = 'true';
      } else if (req.session.temporaryUserSign) {
        record.approval_sign = req.session.temporaryUserSign;
        record.temporary_sign = '1';
      }
      if (error) return show(res.status(400), action, { ...old, ...record }, error, groups);
      const key = process.env.CONMAS_LEGACY_KEY;
      if (!key) return res.status(503).send('Password encryption key is not configured.');
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('conmas-system-user-write'))");
        if (create) {
          const count = Number(
            (await client.query("SELECT count(*) AS count FROM mst_user WHERE user_id<>'conmasadmin'")).rows[0].count,
          );
          if (count >= licenseCounts().User) {
            await client.query('ROLLBACK');
            return show(res.status(409), action, record, 'The licensed user count has been reached.', groups);
          }
        }
        const previous = (await client.query('SELECT password FROM mst_user WHERE user_id=$1', [record.user_id]))
          .rows[0]?.password;
        const errors = await passwordStrength(client, record.user_id, password, key, previous);
        for (const field of ['meid_upn', 'meid_oid'])
          if (
            record[field] &&
            (
              await client.query(`SELECT 1 FROM mst_user WHERE ${field}=$1 AND user_id<>$2`, [
                record[field],
                record.user_id,
              ])
            ).rowCount
          )
            errors.push(`${field === 'meid_upn' ? 'User Principal Name' : 'Object ID'} is already registered.`);
        if (errors.length) {
          await client.query('ROLLBACK');
          return show(res.status(400), action, { ...old, ...record }, errors.join(' '), groups);
        }
        const signature =
          record.approval_sign || (input(req.body, 'IsClearImage') === 'true' ? '' : (old?.approval_sign ?? ''));
        const before = create ? null : await userAuditSnapshot(client, record.user_id);
        const encryptedId = identification
          ? legacyPassword(record.user_id, identification, key)
          : (old?.identification_code ?? null);
        const values = [
          record.user_id,
          record.user_name,
          record.e_mail,
          signature,
          from,
          to,
          encryptedId,
          record.meid_upn,
          record.meid_oid,
          req.ip ?? '',
          req.session.userId,
        ];
        if (create)
          await client.query(
            `INSERT INTO mst_user (user_id,user_name,e_mail,approval_sign,use_start_time,use_end_time,identification_code,meid_upn,meid_oid,sys_regist_term,sys_regist_user,sys_update_term,sys_update_user,password,password_change_time,amivoice_enable,workflow_enable,irfd_enable,irchat_enable)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$11,$12,now(),0,0,0,0)`,
            [...values, legacyPassword(record.user_id, password, key)],
          );
        else
          await client.query(
            `UPDATE mst_user SET user_name=$2,e_mail=$3,approval_sign=$4,use_start_time=$5,use_end_time=$6,identification_code=$7,meid_upn=$8,meid_oid=$9,sys_update_term=$10,sys_update_user=$11,sys_update_time=now(),password=CASE WHEN $12='' THEN password ELSE $12 END,password_change_time=CASE WHEN $12='' THEN password_change_time ELSE now() END WHERE user_id=$1`,
            [...values, password ? legacyPassword(record.user_id, password, key) : ''],
          );
        await client.query('DELETE FROM mst_group_affiation WHERE user_id=$1', [record.user_id]);
        for (const group of memberships)
          await client.query(
            `INSERT INTO mst_group_affiation(group_id,user_id,use_start_time,use_end_time,group_admin,sys_regist_term,sys_regist_user,sys_update_term,sys_update_user) VALUES($1,$2,$3,$4,$5,$6,$7,$6,$7)`,
            [
              group.group_id,
              record.user_id,
              group.use_start_time,
              group.use_end_time,
              group.group_admin,
              req.ip ?? '',
              req.session.userId,
            ],
          );
        const after = await userAuditSnapshot(client, record.user_id);
        await client.query('COMMIT');
        await logUserAccountChange(db, before, after, req.session.userId ?? '', req.ip ?? '');
        return res.redirect(`${root}/DetailsUser?id=${encodeURIComponent(record.user_id)}`);
      } catch (cause) {
        await client.query('ROLLBACK');
        if ((cause as { code: string }).code === '23505')
          return show(res.status(409), action, { ...old, ...record }, 'This user ID is already registered.', groups);
        throw cause;
      } finally {
        client.release();
      }
    });
  app.get(`${root}/GetStamp`, async (req, res) => {
    const record = await load(typeof req.query.userId === 'string' ? req.query.userId : '');
    if (!record?.approval_sign) return res.sendStatus(404);
    const buffer = Buffer.from(record.approval_sign, 'base64');
    const metadata = await sharp(buffer).metadata();
    res.type(metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`).send(buffer);
  });
}
