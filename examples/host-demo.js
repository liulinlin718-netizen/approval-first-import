import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { FileConfigStore } from './host-store.js';
import { ImportHost } from './host-adapter.js';

const directory = await mkdtemp(fileURLToPath(new URL('../.host-demo-', import.meta.url)));
const session = {}, sessions = new WeakMap([[session, { userId: 'demo-user', workspaceId: 'demo-workspace' }]]);
const store = await FileConfigStore.open(directory);
const host = new ImportHost({ store, authenticate: context => sessions.get(context) });
try {
  const candidate = { kind: 'mcp', name: 'Synthetic notes', source: { url: 'https://example.org/notes', revision: 'fixture-v1' },
    destination: 'config/notes.json', transport: 'stdio', commands: [{ executable: 'node', args: ['notes.mjs'] }],
    env: { NOTES_TOKEN: 'synthetic-demo-token' } };
  const { preview, targetVersion } = await host.prepare(session, candidate);
  console.log(JSON.stringify({ phase: 'preview', targetVersion, preview }, null, 2));
  // Synthetic consent for the demo only. Real applications use a human confirmation form.
  const confirmation = { previewId: preview.previewId, fingerprint: preview.fingerprint, confirmed: true };
  const saved = await host.confirm(session, confirmation);
  host.close();
  const reopened = await FileConfigStore.open(directory);
  const restoredHost = new ImportHost({ store: reopened, authenticate: context => sessions.get(context) });
  console.log(JSON.stringify({ phase: 'saved', saved, afterRestart: await restoredHost.receipt(session, preview.previewId) }, null, 2));
  restoredHost.close();
} finally {
  host.close();
  await unlink(join(directory, 'state.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(directory);
}
