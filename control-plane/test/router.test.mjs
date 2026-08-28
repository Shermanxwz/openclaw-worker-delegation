import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../src/router.mjs';

test('worker mode delegates tool work', () => assert.equal(routeTask({ mode: 'worker', task: '修改配置并运行测试' }).actor, 'worker'));
test('worker mode delegates substantive pure text work too', () => assert.equal(routeTask({ mode: 'worker', task: '为什么要使用 worker？' }).actor, 'worker'));
test('worker mode keeps control-plane status requests on main', () => assert.equal(routeTask({ mode: 'worker', task: 'worker status' }).actor, 'main'));
test('auto delegates English mutation and execution', () => assert.equal(routeTask({ mode: 'auto', task: 'fix the config and run tests' }).actor, 'worker'));
test('auto understands Chinese tool work', () => assert.equal(routeTask({ mode: 'auto', task: '扫描仓库并修复失败的测试' }).actor, 'worker'));
test('auto keeps an unambiguous lightweight question in main', () => assert.equal(routeTask({ mode: 'auto', task: '为什么天空是蓝色？' }).actor, 'main'));
test('auto sends ambiguous non-QA work to worker', () => assert.equal(routeTask({ mode: 'auto', task: 'review this approach carefully' }).actor, 'worker'));
test('supplied false cannot erase inferred mutation risk', () => assert.equal(routeTask({ mode: 'auto', task: 'fix the config', properties: { requiresMutation: false } }).actor, 'worker'));
test('main mode never routes to worker', () => assert.equal(routeTask({ mode: 'main', task: 'scan the repository and fix tests' }).actor, 'main'));
