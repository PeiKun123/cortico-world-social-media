import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { build } from 'esbuild';
await build({
  entryPoints: ['src/webui/client.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/webui-surf-idle-clock.js',
  minify: true,
  legalComments: 'none',
});

await build({
  entryPoints: ['src/webui/style.css'],
  bundle: true,
  minify: true,
  outfile: 'dist/webui-surf-idle-clock.css',
  legalComments: 'none',
});

// Use the same dry export as Cortico so the catalog includes the environment prompt.
const { SOCIALMEDIA } = await tsImport('../src/definition.ts', import.meta.url);
const { exportDescribe } = await tsImport('cortico/extensions/describe-export.ts', import.meta.url);
const scratchDir = await mkdtemp(join(tmpdir(), 'socialmedia-describe-'));
try {
  const packageDir = fileURLToPath(new URL('..', import.meta.url));
  const describe = await exportDescribe('world', SOCIALMEDIA, { packageDir, scratchDir });
  if (!describe) throw Error('SocialMediaWorld has no catalog description.');
  await writeFile(new URL('../describe.json', import.meta.url), JSON.stringify(describe, null, 2) + '\n');
} finally {
  await rm(scratchDir, { recursive: true, force: true });
}
