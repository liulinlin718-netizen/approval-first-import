import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

test('the publication manifest includes bilingual docs, public types and runnable host examples', async () => {
  const root = new URL('../', import.meta.url), manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  for (const path of ['README.md', 'README_EN.md', 'docs/host-integration.md', 'src/index.js', 'src/index.d.ts',
    'src/redaction.js', 'src/wait.js', 'examples/host-adapter.js', 'examples/host-store.js', 'examples/host-demo.js', 'examples/typecheck.mts']) {
    assert.ok(manifest.files.some(entry => entry.endsWith('/') ? path.startsWith(entry) : entry === path), path);
    await access(new URL(path, root));
  }
  assert.equal(manifest.exports['.'].types, './src/index.d.ts');
  assert.equal(manifest.scripts['demo:host'], 'node examples/host-demo.js');
  assert.deepEqual(manifest.dependencies ?? {}, {});
});
