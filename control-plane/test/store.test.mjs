import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';

test('mode precedence is task > session > project > global', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocwd-store-'));
  const store = new StateStore({ dataDir: dir, defaultMode: 'auto' });
  await store.init();
  await store.setMode({ scope: 'project', id: 'p1', mode: 'worker' });
  await store.setMode({ scope: 'session', id: 's1', mode: 'main' });
  assert.equal(store.resolveMode({ projectId: 'p1' }).mode, 'worker');
  assert.equal(store.resolveMode({ projectId: 'p1', sessionId: 's1' }).mode, 'main');
  assert.equal(store.resolveMode({ projectId: 'p1', sessionId: 's1', taskMode: 'auto' }).mode, 'auto');
});
