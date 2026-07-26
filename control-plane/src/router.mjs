const patterns = {
  mutation: /(?:\b(?:edit|write|modify|change|patch|fix|implement|create|delete|refactor|update)\b|安装|修改|编辑|写入|修复|实现|创建|删除|重构|更新)/i,
  exec: /(?:\b(?:run|execute|shell|command|test|build|deploy|lint|compile|restart|npm|pnpm|yarn|pytest)\b|运行|执行|命令|测试|构建|部署|编译|重启)/i,
  multiRead: /(?:\b(?:scan|search|grep|audit|repository|repo|codebase|logs?|all files|tree)\b|批量|扫描|搜索|审计|仓库|项目|日志|所有文件)/i,
  retry: /(?:\b(?:debug|failing|failure|retry|flaky|broken|investigate)\b|调试|失败|重试|不稳定|排查)/i,
  planning: /(?:\b(?:plan|design|architecture|proposal|compare)\b|方案|设计|架构|规划|比较)/i,
  pureQa: /^(what|why|how|explain|describe|tell me|是什么|为什么|怎么|解释|说明|告诉我)/i,
  knownRead: /(?:(?:\b(?:read|show|open)\b|查看|读取).*(?:\b(?:file|readme|package\.json)\b|文件))/i,
};

export function classifyTask(task = '', supplied = {}) {
  const text = String(task).trim();
  const inferred = {
    requiresMutation: patterns.mutation.test(text),
    requiresExec: patterns.exec.test(text),
    requiresMultiFileRead: patterns.multiRead.test(text),
    likelyRetryLoop: patterns.retry.test(text),
    heavyPlanning: patterns.planning.test(text),
    pureQa: patterns.pureQa.test(text),
    knownSingleRead: patterns.knownRead.test(text),
  };
  const properties = { ...inferred, ...supplied };
  properties.requiresTool = Boolean(
    properties.requiresMutation ||
    properties.requiresExec ||
    properties.requiresMultiFileRead ||
    properties.knownSingleRead,
  );
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

  add(properties.requiresMutation, 3, 'requires file or state mutation');
  add(properties.requiresExec, 3, 'requires command execution');
  add(properties.requiresMultiFileRead, 2, 'requires multi-file or repository scan');
  add(properties.likelyRetryLoop, 2, 'likely retry or debugging loop');
  add(properties.heavyPlanning, 1, 'contains substantial planning work');
  add(properties.pureQa && !properties.requiresTool, -4, 'pure text question');
  add(properties.knownSingleRead && !properties.requiresMutation && !properties.requiresExec, -2, 'single known read');

  return { score, reasons };
}

export function routeTask({ task = '', mode = 'auto', properties = {}, workerAll = false } = {}) {
  const classified = classifyTask(task, properties);
  const { score, reasons } = scoreTask(classified);
  let actor = 'main';
  let decision = 'direct-answer';

  if (mode === 'main') {
    actor = 'main';
    decision = 'main-mode';
  } else if (mode === 'worker') {
    const shouldDelegate = workerAll || classified.requiresTool || !classified.pureQa;
    actor = shouldDelegate ? 'worker' : 'main';
    decision = shouldDelegate ? 'worker-mode' : 'worker-mode-pure-qa-exception';
  } else if (score >= 3) {
    actor = 'worker';
    decision = 'auto-threshold';
  } else if (score >= 1 && (classified.requiresMutation || classified.requiresExec || classified.requiresMultiFileRead)) {
    actor = 'worker';
    decision = 'auto-uncertain-fail-closed';
  } else {
    actor = 'main';
    decision = 'auto-light-task';
  }

  const confidence = Math.min(0.99, Math.max(0.55, 0.62 + Math.abs(score) * 0.055));
  return { mode, actor, decision, score, confidence, properties: classified, reasons };
}
