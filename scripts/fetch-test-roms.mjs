// Downloads c-sp's collection of Game Boy test ROMs (blargg's tests, the Mooneye Test Suite,
// dmg-acid2, cgb-acid2 and others, with their expected screenshots) into tests/fixtures/test-roms/.
// Some of the ROMs have no licence, so they are only fetched for the tests and never published;
// the tests that need them skip when they are missing.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = 'https://github.com/c-sp/game-boy-test-roms/releases/download/v7.0/game-boy-test-roms-v7.0.zip';
const sha256 = 'b9a9d7a1075aa35a3d07c07c34974048672d8520dca9e07a50178f5860c3832c';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'test-roms');

const response = await fetch(url);
if (!response.ok) {
  console.error(`Download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
  console.error('The test ROM collection has changed (checksum mismatch)');
  process.exit(1);
}
const zipPath = join(tmpdir(), 'game-boy-test-roms.zip');
await writeFile(zipPath, bytes);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
execFileSync('unzip', ['-q', zipPath, '-d', outDir]);
await rm(zipPath);
console.log(`Saved the test ROMs in ${outDir}`);
