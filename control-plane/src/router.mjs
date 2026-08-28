const patterns = {
  mutation: /(edit|write|modify|change|patch|fix|implement|create|delete|refactor|update|install|修改|编辑|写入|修复|实现|创建|删除|重构|更新|安装)/i,
  exec: /(run|execute|shell|command|test|build|deploy|lint|compile|restart|npm|pnpm|yarn|pytest|运行|执行|命令|测试|构建|部署|编译|重启)/i,
  multiRead: /(scan|search|grep|audit|repository|repo|codebase|logs?|all files|tree|批量|扫描|搜索|审计|仓库|项目|日志|所有文件)/i,
  retry: /(debug|failing|failure|retry|flaky|broken|investigate|调试|失败|重试|不稳定|排查)/i,
  planning: /(plan|design|architecture|proposal|compare|方案|设计|架构|规划|比较)/i,
  pureQa: /^(what|why|how|explain|describe|tell me|who|when|where|是什么|为什么|怎么|如何|解释|说明|告诉我|谁|何时|哪里)/i,
  knownRead: /(read|show|open|查看|读取).*(file|readme|package\.json|文件)/i,
  coordinationOnly: /(status|progress|cancel|stop|resume|worker status|task status|状态|进度|取消|停止|恢复|任务状态)/i,
};

export function classifyTask(task = '', supplied = {}) {
  const text = String(task).trim().slice(0, 20_000);
  const inferred = {
    requiresMutation: patterns.mutation.test(text),
    requiresExec: patterns.exec.test(text),
    requiresMultiFileRead: patterns.multiRead.test(text),
    likelyRetryLoop: patterns.retry.test(text),
    heavyPlanning: patterns.planning.test(text),
    pureQa: patterns.pureQa.test(text),
    knownSingleRead: patterns.knownRead.test(text),
    coordinationOnly: patterns.coordinationOnly.test(text) && text.length < 500,
  };
  // Host-supplied properties may add evidence, but may not erase a positive
  // safety signal inferred from the actual task text.
  const properties = { ...inferred };
  for (const [key, value] of Object.entries(supplied || {})) {
    properties[key] = typeof inferred[key] === 'boolean' ? Boolean(inferred[key] || value) : value;
  }
  properties.requiresTool = Boolean(properties.requiresMutation || properties.requiresExec || properties.requiresMultiFileRead || properties.knownSingleRead);
  properties.highRisk = Boolean(properties.requiresMutation || properties.requiresExec || properties.likelyRetryLoop);
  return properties;
}

export function scoreTask(properties) {
  let score = 0;
  const reasons = [];
  const add = (condition, points, reason) => {
    if (!condition) return;
    score += points;
    reasons.push({ points, reason });
  };
  add(properties.requiresMutation, 4, 'requires file or state mutation');
  add(properties.requiresExec, 4, 'requires command execution');
  add(properties.requiresMultiFileRead, 3, 'requires multi-file or repository scan');
  add(properties.likelyRetryLoop, 3, 'likely retry or debugging loop');
  add(properties.heavyPlanning, 2, 'contains substantial planning work');
  add(properties.knownSingleRead && !properties.requiresMutation && !properties.requiresExec, 1, 'requires a known read tool');
  add(properties.pureQa && !properties.requiresTool && !properties.heavyPlanning, -5, 'pure text question');
  add(properties.coordinationOnly, -6, 'control-plane coordination request');
  return { score, reasons };
}

export function routeTask({ task = '', mode = 'auto', properties = {} } = {}) {
  const classified = classifyTask(task, properties);
  const { score, reasons } = scoreTask(classified);
  let actor = 'main';
  let decision = 'direct-answer';

  if (mode === 'main') {
    actor = 'main';
    decision = 'main-mode';
  } else if (mode === 'worker') {
    // "Worker" is literal: Main is the coordinator and does not perform the
    // body of a user task. Only control-plane/status requests stay on Main.
    actor = classified.coordinationOnly ? 'main' : 'worker';
    decision = classified.coordinationOnly ? 'worker-mode-control-only' : 'worker-mode-delegate';
  } else if (classified.coordinationOnly) {
    actor = 'main';
    decision = 'auto-control-only';
  } else if (classified.requiresTool || classified.heavyPlanning || classified.likelyRetryLoop || score >= 2) {
    actor = 'worker';
    decision = classified.highRisk ? 'auto-high-risk-worker' : 'auto-worker';
  } else if (classified.pureQa && score < 1) {
    actor = 'main';
    decision = 'auto-light-question';
  } else {
    // Ambiguous work is delegated rather than granting Main progressively
    // broader tools. This keeps AUTO deterministic and fail-safe.
    actor = 'worker';
    decision = 'auto-ambiguous-worker';
  }

  const confidence = Math.min(0.99, Math.max(0.6, 0.68 + Math.abs(score) * 0.045));
  return { mode, actor, decision, score, confidence, properties: classified, reasons };
}
