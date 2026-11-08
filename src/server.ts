import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { formatServerFailure } from './services/server-console.js';
import { createServerConsole } from './services/server-dashboard.js';

export { createApp } from './app.js';
export { systemMenuFor } from './services/manager/system/navigation.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const host = '127.0.0.1';
  const terminal = createServerConsole();
  createApp(undefined, true, undefined, (entry) => terminal.request(entry))
    .listen(port, host, () => terminal.start(`http://${host}:${port}`))
    .on('error', (error: NodeJS.ErrnoException) => {
      terminal.stop();
      console.error(formatServerFailure(error.code));
      process.exitCode = 1;
    });
}
