/**
 * Generates the @pulse/api-types package from openapi/pulse.yaml.
 * Run: pnpm openapi:generate
 * Output: openapi/generated/types.ts  (committed to repo)
 */
import openapiTS, { astToString } from 'openapi-typescript';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import fs from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(__dirname, '../pulse.yaml');
const outDir = resolve(__dirname, '../generated');
const outFile = resolve(outDir, 'types.ts');

const ast = await openapiTS(new URL(`file://${specPath}`));
const content = astToString(ast);

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(
  outFile,
  `// !! AUTO-GENERATED — do not edit manually. Run: pnpm openapi:generate\n\n${content}`,
  'utf-8',
);

console.log(`✓ Generated ${outFile}`);
