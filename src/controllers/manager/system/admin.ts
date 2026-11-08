import type { Express, Response } from 'express';
import type pg from 'pg';
import { hostname } from 'node:os';
import { legacyPassword } from '../../../shared/legacy-auth.js';

// SystemController.EditAdmin and SystemRepository.UpdateAdmin.
export function registerAdmin(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
) {
  const show = (res: Response, error = '') =>
    render(res, {
      active: 'System',
      section: 'UserList',
      login: false,
      title: 'Change Password of Administrator',
      userName: res.locals.userName,
      adminForm: { error },
    });
  app.get('/ConMasManager/System/EditAdmin', (_req, res) => show(res));
  app.post('/ConMasManager/System/EditAdmin', async (req, res) => {
    const password = typeof req.body.new_password === 'string' ? req.body.new_password : '';
    if (!password) return show(res.status(400), 'New password is required.');
    if (password !== req.body.confirm_password) return show(res.status(400), 'The passwords do not match.');
    if (!process.env.CONMAS_LEGACY_KEY) return res.status(503).send('Password encryption key is not configured.');
    const id = req.session.userId;
    if (id !== 'conmasadmin') return res.sendStatus(403);
    await db.query(
      `UPDATE mst_user SET password=$1, sys_update_term=$2, sys_update_user=$3, sys_update_time=now() WHERE user_id=$3`,
      [legacyPassword(id, password, process.env.CONMAS_LEGACY_KEY), hostname(), id],
    );
    return res.redirect('/ConMasManager/System/UserList');
  });
}
