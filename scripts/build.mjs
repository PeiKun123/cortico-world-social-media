import { writeFile } from 'node:fs/promises';
import { tsImport } from 'tsx/esm/api';
import { build } from 'esbuild';
await build({
  entryPoints: ['src/webui/client.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/webui.js',
  minify: true,
  legalComments: 'none',
});

// Keep the catalog tool declaration aligned with the installed runtime tools.
const { SOCIALMEDIA } = await tsImport('../src/definition.ts', import.meta.url);
await writeFile(
  new URL('../describe.json', import.meta.url),
  JSON.stringify(SOCIALMEDIA.describe, null, 2) + '\n',
);
