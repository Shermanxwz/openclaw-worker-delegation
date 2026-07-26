import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../src/router.mjs';

test('worker mode delegates tool work', () => assert.equal(routeTask({ mode: 'worker', task: '修改配置并运行测试' }).actor, 'worker'));
test('worker mode keeps pure text QA in main', () => assert.equal(routeTask({ mode: 'worker', task: '为什么要使用 worker？' }).actor, 'main'));
test('auto delegates English mutation and execution', () => assert.equal(routeTask({ mode: 'auto', task: 'fix the config and run tests' }).actor, 'worker'));
test('auto understands Chinese tool work', () => assert.equal(routeTask({ mode: 'auto', task: '扫描仓库并修复失败的测试' }).actor, 'worker'));
test('main mode never routes to worker', () => assert.equal(routeTask({ mode: 'main', task: 'scan the repository and fix tests' }).actor, 'main'));
