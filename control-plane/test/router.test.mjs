import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../src/router.mjs';

test('worker mode delegates tool work', () => {
  const result = routeTask({ mode: 'worker', task: '修改配置并运行测试' });
  assert.equal(result.actor, 'worker');
});

test('worker mode keeps pure text QA in main', () => {
  const result = routeTask({ mode: 'worker', task: '为什么要使用 worker？' });
  assert.equal(result.actor, 'main');
});

test('auto mode delegates mutation and execution', () => {
  const result = routeTask({ mode: 'auto', task: 'fix the config and run tests' });
  assert.equal(result.actor, 'worker');
  assert.ok(result.score >= 3);
});

test('main mode never routes to worker', () => {
  const result = routeTask({ mode: 'main', task: 'scan the repository and fix tests' });
  assert.equal(result.actor, 'main');
});
