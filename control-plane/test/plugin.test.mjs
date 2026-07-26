import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('native plugin package and manifest agree', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../openclaw-plugin/openclaw.plugin.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await fs.readFile(new URL('../openclaw-plugin/package.json', import.meta.url), 'utf8'));
  const source = await fs.readFile(new URL('../openclaw-plugin/index.mjs', import.meta.url), 'utf8');
  assert.equal(manifest.id, 'delegation-guard');
  assert.ok(pkg.openclaw.extensions.includes('./index.mjs'));
  assert.match(source, /id: 'delegation-guard'/);
  assert.match(source, /before_tool_call/);
  assert.match(source, /block: true/);
  assert.doesNotMatch(source, /startup-probe/);
  assert.doesNotMatch(source, /SAFE_WHEN_OFFLINE/);
  assert.match(source, /fail-closed blocked/);
});
