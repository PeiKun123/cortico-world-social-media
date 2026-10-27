import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
await import('./build.mjs');
for (const [pkg, bin, args] of [
  ['typescript', 'bin/tsc', ['--noEmit']],
  ['vitest', 'vitest.mjs', ['run']],
]) {
  const executable = join(dirname(require.resolve(`${pkg}/package.json`)), bin);
  const result = spawnSync(process.execPath, [executable, ...args], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
