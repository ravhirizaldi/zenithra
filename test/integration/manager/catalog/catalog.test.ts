import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../../helpers/app.js';

test('unfinished Manager sections remain disabled at canonical and Index URLs', async () => {
  const server = createApp(null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const routes = ['DefReport', 'AutoGenerate', 'CustomMaster', 'CustomMenu', 'Binder', 'Schedule'].flatMap(
      (route) => [route, `${route}/Index`],
    );
    for (const route of [...routes, 'Schedule/CalendarView']) {
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/ConMasManager/${route}`)).status, 503);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
