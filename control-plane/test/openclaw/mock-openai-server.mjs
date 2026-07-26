import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.MOCK_OPENAI_PORT || 4000);
const markerDir = process.env.MOCK_MARKER_DIR || '/tmp/ocwd-e2e-markers';
await fs.mkdir(markerDir, { recursive: true });
const logPath = path.join(markerDir, 'mock-openai.ndjson');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n');
  return '';
}

function lastUserText(messages = []) {
  return [...messages].reverse().find((message) => message?.role === 'user')?.content
    ? textOf([...messages].reverse().find((message) => message?.role === 'user').content)
    : '';
}

function allText(messages = []) {
  return messages.map((message) => `${message?.role || ''}: ${textOf(message?.content)}`).join('\n');
}

function toolCall(name, args, id = `call_${Date.now()}`) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

async function decide(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = messages.some((message) => message?.role === 'tool');
  const user = lastUserText(messages);
  const combined = allText(messages);

  await fs.appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), user, combined: combined.slice(0, 12000), tools: (body.tools || []).map((tool) => tool?.function?.name), stream: body.stream === true })}\n`);

  if (hasToolResult) return { content: 'OCWD_TOOL_LOOP_COMPLETE' };

  if (combined.includes('OCWD_DELAY_WORKER_EXEC')) {
    await fs.writeFile(path.join(markerDir, 'worker-model-requested'), '1');
    await new Promise((resolve) => setTimeout(resolve, 7000));
    return { tool: toolCall('exec', { command: `printf OCWD_DELAY_SHOULD_NOT_RUN > ${markerDir}/worker-delayed-exec` }) };
  }
  if (combined.includes('OCWD_WORKER_EXEC')) {
    return { tool: toolCall('exec', { command: `printf OCWD_WORKER_OK > ${markerDir}/worker-exec-ok` }) };
  }
  if (user.includes('OCWD_SPAWN_WORKER')) {
    return { tool: toolCall('sessions_spawn', { task: 'OCWD_WORKER_EXEC', taskName: 'e2e_worker', agentId: 'body-worker', runtime: 'subagent' }) };
  }
  if (user.includes('OCWD_SPAWN_DELAYED_WORKER')) {
    return { tool: toolCall('sessions_spawn', { task: 'OCWD_DELAY_WORKER_EXEC', taskName: 'e2e_delayed_worker', agentId: 'body-worker', runtime: 'subagent' }) };
  }
  if (user.includes('OCWD_ALLOW_MAIN_EXEC')) {
    return { tool: toolCall('exec', { command: `printf OCWD_MAIN_OK > ${markerDir}/main-exec-ok` }) };
  }
  if (user.includes('OCWD_ONE_SHOT_MAIN')) {
    return { tool: toolCall('exec', { command: `printf OCWD_ONE_SHOT_OK > ${markerDir}/one-shot-main-ok` }) };
  }
  if (user.includes('OCWD_ONE_SHOT_SECOND')) {
    return { tool: toolCall('exec', { command: `printf OCWD_ONE_SHOT_SECOND_BAD > ${markerDir}/one-shot-second-bad` }) };
  }
  if (user.includes('OCWD_OFFLINE_EXEC')) {
    return { tool: toolCall('exec', { command: `printf OCWD_OFFLINE_BAD > ${markerDir}/offline-exec-bad` }) };
  }
  if (user.includes('OCWD_BLOCK_MAIN_EXEC')) {
    return { tool: toolCall('exec', { command: `printf OCWD_BLOCK_BAD > ${markerDir}/main-block-bad` }) };
  }
  return { content: 'OCWD_PONG' };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendCompletion(res, body, decision) {
  const id = `chatcmpl_${Date.now()}`;
  const model = body.model || 'mock-model';
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    if (decision.tool) {
      send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: decision.tool.id, type: 'function', function: { name: decision.tool.function.name, arguments: decision.tool.function.arguments } }] }, finish_reason: null }] });
      send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: decision.content || '' }, finish_reason: null }] });
      send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    if (body.stream_options?.include_usage) send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.end('data: [DONE]\n\n');
    return;
  }
  sendJson(res, 200, {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: decision.tool ? { role: 'assistant', content: '', tool_calls: [decision.tool] } : { role: 'assistant', content: decision.content || '' }, finish_reason: decision.tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'ocwd-e2e' }] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return sendCompletion(res, body, await decide(body));
    }
    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    await fs.appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), error: String(error?.stack || error) })}\n`);
    return sendJson(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`mock OpenAI listening on 127.0.0.1:${port}`));
