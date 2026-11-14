'use strict';

/**
 * Swarm 专属零依赖 Stdio MCP Server（契约 2.2）。
 *
 * agy 通过 ACP session/new 的 mcpServers 以子进程方式拉起本脚本：
 *   node mcp-stdio-entry.js --auth-file <~/.dsh/swarm/<coord>/tokens/<member>.json>
 *
 * 本脚本只做协议转换：MCP JSON-RPC（stdio）⇄ 宿主 Loopback HTTP 桥（POST /rpc）。
 * 身份、权限、发帖上限全部由宿主侧 SwarmMcpBridgeServer 裁决；这里不持有任何
 * 业务状态，token 每次调用都重新读取（轮次结束 token 文件被删除后立即失效）。
 *
 * 仅依赖 Node 内置：node:fs、node:http、node:process、node:buffer。
 */

const fs = require('node:fs');
const http = require('node:http');
const process = require('node:process');
const { Buffer } = require('node:buffer');

const SERVER_NAME = 'dsh_swarm_bridge';
const SERVER_VERSION = '0.2.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 60 * 1000;

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'read_board',
    description:
      'Read the shared Swarm message board (oldest first). Pass the highest seq you have read as `since` for incremental reads. ' +
      'Use status:true for the member roster; inbox_only:true returns only messages that @mention you.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', minimum: 0, description: 'Return messages with seq > since.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max messages (default 20).' },
        seqs: { type: 'array', items: { type: 'integer' }, description: 'Exact message seqs to fetch.' },
        channel: { type: 'string', description: 'Optional single channel filter (without #).' },
        status: { type: 'boolean', description: 'Return roster / cursor status instead of messages.' },
        inbox_only: { type: 'boolean', description: 'Only messages whose doorbell targets you.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'post_message',
    description:
      'Post a message to the shared Swarm board as yourself. Include @<name> (or @<group-prefix>, @#<channel>, @all) ' +
      'to wake the recipient; your turn ending is your sleep, no wait tool is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message body. Mention @recipient to deliver it.' },
        channel: { type: 'string', description: 'Target channel (defaults to main).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
]);

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 读取 token 文件：{ url, token }。 */
function readAuthFile(authFile) {
  if (!authFile) throw new Error('未提供 --auth-file（或 DSH_SWARM_BRIDGE_AUTH_FILE）');
  let raw;
  try {
    raw = fs.readFileSync(authFile, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error('本轮 Swarm 桥授权已失效（token 文件不存在，轮次可能已结束或成员已被 kill）');
    }
    throw new Error('读取 Swarm 桥授权文件失败：' + (err?.message || String(err)));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Swarm 桥授权文件不是合法 JSON');
  }
  if (!isPlainObject(parsed) || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') {
    throw new Error('Swarm 桥授权文件缺少 url / token 字段');
  }
  return { url: parsed.url, token: parsed.token };
}

/**
 * 默认 HTTP 调用：强制 127.0.0.1 + agent:false，绕开任何 HTTP(S)_PROXY 环境变量
 * 与全局 Agent，杜绝代理劫持 loopback 流量。
 */
function defaultHttpRequest({ url, token, body, timeoutMs = HTTP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error('Swarm 桥地址非法：' + String(url)));
      return;
    }
    if (parsedUrl.hostname !== '127.0.0.1') {
      reject(new Error('Swarm 桥只允许连接 127.0.0.1，拒绝地址：' + parsedUrl.hostname));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(parsedUrl.port),
        path: '/rpc',
        method: 'POST',
        agent: false,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json, text });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Swarm 桥请求超时（' + timeoutMs + 'ms）'));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function toolTextResult(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

function toolErrorResult(message) {
  return {
    content: [{ type: 'text', text: 'Swarm Error: ' + String(message || 'unknown error') }],
    isError: true,
  };
}

/**
 * 在任意一对可读/可写流上挂载一个 MCP stdio 会话。
 *
 * @param {object} options
 * @param {import('node:stream').Readable} options.readable
 * @param {import('node:stream').Writable} options.writable
 * @param {() => Promise<{url:string, token:string}> | {url:string, token:string}} [options.resolveAuth]
 * @param {string} [options.authFile] 未传 resolveAuth 时每次调用读取该文件
 * @param {(req: {url, token, body}) => Promise<{status:number, json:any, text?:string}>} [options.httpRequest]
 * @param {(err: Error) => void} [options.onError]
 */
function createMcpStdioSession(options = {}) {
  const { readable, writable } = options;
  if (!readable || typeof readable.on !== 'function') {
    throw new TypeError('createMcpStdioSession 需要 readable 流');
  }
  if (!writable || typeof writable.write !== 'function') {
    throw new TypeError('createMcpStdioSession 需要 writable 流');
  }
  const resolveAuth =
    typeof options.resolveAuth === 'function'
      ? options.resolveAuth
      : () => readAuthFile(options.authFile);
  const httpRequest =
    typeof options.httpRequest === 'function' ? options.httpRequest : defaultHttpRequest;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const maxFrameBytes =
    Number.isSafeInteger(options.maxFrameBytes) && options.maxFrameBytes > 0
      ? options.maxFrameBytes
      : MAX_FRAME_BYTES;

  /** 'unknown' | 'ndjson' | 'content-length' */
  let framing = 'unknown';
  let buffer = Buffer.alloc(0);
  let closed = false;
  const inflight = new Set();
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const send = (message) => {
    if (closed && framing === 'unknown') return;
    const body = JSON.stringify(message);
    try {
      if (framing === 'content-length') {
        const bytes = Buffer.from(body, 'utf8');
        writable.write(`Content-Length: ${bytes.length}\r\n\r\n`);
        writable.write(bytes);
      } else {
        writable.write(body + '\n');
      }
    } catch (err) {
      onError(err);
    }
  };

  const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) =>
    send({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

  async function callTool(name, args) {
    if (!TOOL_NAMES.has(name)) return toolErrorResult(`未知工具 "${name}"`);
    let auth;
    try {
      auth = await resolveAuth();
    } catch (err) {
      return toolErrorResult(err?.message || String(err));
    }
    let response;
    try {
      response = await httpRequest({
        url: auth.url,
        token: auth.token,
        body: { tool: name, arguments: isPlainObject(args) ? args : {} },
      });
    } catch (err) {
      return toolErrorResult('无法连接宿主 Swarm 桥：' + (err?.message || String(err)));
    }
    const status = Number(response?.status) || 0;
    const json = response?.json;
    if (status >= 200 && status < 300 && json && json.ok === true) {
      return toolTextResult(json.result ?? {});
    }
    const reason =
      (json && typeof json.error === 'string' && json.error) ||
      (response?.text ? String(response.text).slice(0, 500) : '') ||
      'HTTP ' + status;
    return toolErrorResult(`${reason}${status ? ` (HTTP ${status})` : ''}`);
  }

  async function handleMessage(message) {
    if (!isPlainObject(message)) {
      respondError(null, -32600, 'Invalid Request');
      return;
    }
    const { id, method } = message;
    const hasId = id !== undefined && id !== null;
    if (typeof method !== 'string') {
      // 客户端发来的响应（本服务不发请求），忽略。
      return;
    }
    const params = isPlainObject(message.params) ? message.params : {};
    switch (method) {
      case 'initialize':
        if (hasId) {
          respond(id, {
            protocolVersion:
              typeof params.protocolVersion === 'string' && params.protocolVersion
                ? params.protocolVersion
                : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              'DeepSeek Harness Swarm 留言板桥：read_board 读板，post_message 发帖（带 @收件人 才会唤醒对方）。',
          });
        }
        return;
      case 'ping':
        if (hasId) respond(id, {});
        return;
      case 'tools/list':
        if (hasId) respond(id, { tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool })) });
        return;
      case 'tools/call': {
        if (!hasId) return;
        const name = typeof params.name === 'string' ? params.name : '';
        const result = await callTool(name, params.arguments);
        respond(id, result);
        return;
      }
      case 'resources/list':
        if (hasId) respond(id, { resources: [] });
        return;
      case 'prompts/list':
        if (hasId) respond(id, { prompts: [] });
        return;
      default:
        if (method.startsWith('notifications/')) return;
        if (hasId) respondError(id, -32601, 'Method not found: ' + method);
    }
  }

  function dispatchText(text) {
    if (!text.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      respondError(null, -32700, 'Parse error');
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of list) {
      const task = handleMessage(message).catch((err) => {
        onError(err);
        if (isPlainObject(message) && message.id !== undefined && message.id !== null) {
          respondError(message.id, -32603, err?.message || String(err));
        }
      });
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    }
  }

  function detectFraming() {
    let index = 0;
    while (index < buffer.length && (buffer[index] === 0x20 || buffer[index] === 0x09 || buffer[index] === 0x0d || buffer[index] === 0x0a)) {
      index += 1;
    }
    if (index >= buffer.length) return false;
    const head = buffer.subarray(index, Math.min(buffer.length, index + 15)).toString('latin1');
    const prefix = 'content-length:';
    if (head.length < prefix.length && prefix.startsWith(head.toLowerCase())) return false;
    framing = head.toLowerCase().startsWith(prefix) ? 'content-length' : 'ndjson';
    return true;
  }

  function drain() {
    for (;;) {
      if (framing === 'unknown' && !detectFraming()) return;
      if (framing === 'ndjson') {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > maxFrameBytes) {
            buffer = Buffer.alloc(0);
            respondError(null, -32600, '单帧超过上限');
          }
          return;
        }
        let line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        // 一次推入的完整超长行（末尾带 \n）同样必须拦截，绝不进入 JSON.parse。
        if (line.length > maxFrameBytes) {
          line = null;
          respondError(null, -32600, '单帧超过上限（' + maxFrameBytes + ' 字节），已丢弃');
          continue;
        }
        dispatchText(line.toString('utf8'));
        continue;
      }
      // Content-Length 帧
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (buffer.length > 64 * 1024) {
          buffer = Buffer.alloc(0);
          respondError(null, -32600, '帧头过长');
        }
        return;
      }
      const headerText = buffer.subarray(0, headerEnd).toString('latin1');
      const match = /content-length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        respondError(null, -32600, '缺少 Content-Length 帧头');
        continue;
      }
      const length = Number(match[1]);
      if (length > maxFrameBytes) {
        buffer = Buffer.alloc(0);
        respondError(null, -32600, '单帧超过上限');
        return;
      }
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      dispatchText(body);
    }
  }

  const onData = (chunk) => {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
    drain();
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    readable.removeListener('data', onData);
    Promise.allSettled([...inflight]).then(() => resolveDone());
  };

  readable.on('data', onData);
  readable.on('end', finish);
  readable.on('close', finish);

  return {
    done,
    get framing() {
      return framing;
    },
    close() {
      finish();
      return done;
    },
  };
}

function parseCliArgs(argv) {
  const result = { authFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--auth-file' && index + 1 < argv.length) {
      result.authFile = argv[index + 1];
      index += 1;
    } else if (typeof arg === 'string' && arg.startsWith('--auth-file=')) {
      result.authFile = arg.slice('--auth-file='.length);
    }
  }
  return result;
}

function runCli() {
  const cli = parseCliArgs(process.argv.slice(2));
  const authFile = cli.authFile || process.env.DSH_SWARM_BRIDGE_AUTH_FILE || '';
  if (!authFile) {
    process.stderr.write('[dsh_swarm_bridge] 缺少 --auth-file <path>\n');
    process.exitCode = 2;
  }
  const session = createMcpStdioSession({
    readable: process.stdin,
    writable: process.stdout,
    authFile,
    onError: (err) => {
      try {
        process.stderr.write('[dsh_swarm_bridge] ' + (err?.message || String(err)) + '\n');
      } catch {
        // ignore
      }
    },
  });
  session.done.then(() => {
    process.exit(process.exitCode || 0);
  });
}

if (require.main === module) {
  runCli();
}

module.exports = {
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_DEFINITIONS,
  createMcpStdioSession,
  defaultHttpRequest,
  readAuthFile,
  parseCliArgs,
};
