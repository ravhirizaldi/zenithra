import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

test('dev watcher passes mouse/keyboard input without restarting, but reloads source changes', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(scripts.dev, 'node --watch --watch-preserve-output --import tsx src/server.ts');
  const directory = await mkdtemp('/tmp/opencode/conmas-watcher-');
  const filename = join(directory, 'fixture.ts');
  const source = `const ready: string = 'fixture-ready'; console.log(ready); process.stdin.on('data', () => console.log('fixture-input')); setInterval(() => {}, 1000);`;
  await writeFile(filename, source);
  const child = spawn(process.execPath, ['--watch', '--watch-preserve-output', '--import', 'tsx', filename], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '',
    exited = false;
  const exit = new Promise<void>((resolve) =>
    child.once('exit', () => {
      exited = true;
      resolve();
    }),
  );
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    errors += data;
  });
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (predicate()) return;
      assert(!exited, 'Isolated watcher exited before its check completed.');
      await setTimeout(40);
    }
    assert.fail(
      'Isolated watcher did not produce the expected fixture event. ' +
        errors.replace(/[^A-Za-z0-9 .:_/-]/g, '').slice(0, 120),
    );
  };
  try {
    await waitFor(() => output.includes('fixture-ready'));
    child.stdin.write('a\x1b[A\x1b[<0;5;5M');
    await waitFor(() => output.includes('fixture-input'));
    await setTimeout(350);
    assert.equal(output.match(/fixture-ready/g)?.length, 1);
    await writeFile(filename, source + '\n// isolated hot-reload check\n');
    await waitFor(() => (output.match(/fixture-ready/g)?.length ?? 0) === 2);
  } finally {
    if (!exited) child.kill('SIGTERM');
    await exit;
    await rm(directory, { recursive: true, force: true });
  }
});
