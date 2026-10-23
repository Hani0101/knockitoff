// Compresses Blender exports from assets-src/*.glb into public/models/*.glb
// and checks them against the game's size budget.
//
// Usage: npm run compress
//
// Geometry is compressed with meshopt. Textures are compressed to KTX2 when
// the `toktx` tool (KTX-Software) is on PATH, otherwise to WebP.
// Scene structure is left untouched (no flatten/join/simplify/prune) because the
// game reads object names and custom properties.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';

const SRC_DIR = 'assets-src';
const OUT_DIR = 'public/models';
const TEXTURE_SIZE = 2048;
const TOTAL_BUDGET_MB = 30;
const TRIANGLE_BUDGETS = { 'cat.glb': 20_000, 'room.glb': 200_000 };

function hasToktx() {
  const result = spawnSync('toktx', ['--version'], { stdio: 'ignore', shell: true });
  return result.status === 0;
}

async function countTriangles(path) {
  const doc = await new NodeIO().read(path);
  let triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // TRIANGLES only
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : prim.getAttribute('POSITION')?.getCount() ?? 0;
      triangles += count / 3;
    }
  }
  return Math.round(triangles);
}

if (!existsSync(SRC_DIR)) {
  console.log(`No ${SRC_DIR}/ folder yet. Export your .glb files from Blender into it.`);
  process.exit(0);
}

const files = readdirSync(SRC_DIR).filter((f) => f.toLowerCase().endsWith('.glb'));
if (files.length === 0) {
  console.log(`No .glb files in ${SRC_DIR}/.`);
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
const textureFormat = hasToktx() ? 'ktx2' : 'webp';
if (textureFormat === 'webp') {
  console.log('toktx not found, using WebP textures. Install KTX-Software for KTX2.\n');
}

let totalBytes = 0;
let overBudget = false;

for (const file of files) {
  const input = join(SRC_DIR, file);
  const output = join(OUT_DIR, file);

  const triangles = await countTriangles(input);
  const budget = TRIANGLE_BUDGETS[file];
  const triNote = budget ? ` / ${budget.toLocaleString()} budget` : '';
  if (budget && triangles > budget) overBudget = true;

  execFileSync(
    'npx',
    [
      'gltf-transform', 'optimize', input, output,
      '--compress', 'meshopt',
      '--texture-compress', textureFormat,
      '--texture-size', String(TEXTURE_SIZE),
      '--flatten', 'false',
      '--join', 'false',
      '--instance', 'false',
      '--simplify', 'false',
      '--palette', 'false',
      // Pruning drops empty leaf nodes, which removes markers like `spawn`.
      '--prune', 'false',
    ],
    { stdio: 'inherit', shell: true },
  );

  const bytes = statSync(output).size;
  totalBytes += bytes;
  const flag = budget && triangles > budget ? '  <-- OVER TRIANGLE BUDGET' : '';
  console.log(`${file}: ${triangles.toLocaleString()} triangles${triNote}, ${(bytes / 1e6).toFixed(2)} MB${flag}`);
}

const totalMb = totalBytes / 1e6;
console.log(`\nTotal models: ${totalMb.toFixed(2)} MB / ${TOTAL_BUDGET_MB} MB budget (sounds not included)`);
if (totalMb > TOTAL_BUDGET_MB) overBudget = true;
if (overBudget) process.exitCode = 1;
