'use strict';

/**
 * Swarm 专属宿主 Loopback HTTP 桥（契约 2.1）。
 *
 * agy 外部队友通过 `src/mcp-stdio-entry.js`（零依赖 Stdio MCP 子进程）访问留言板，
 * 子进程再把 `read_board` / `post_message` 以 `POST /rpc` 转发到这里。
 *
 * 安全模型：
 *   - 只监听 127.0.0.1 的随机端口（惰性启动 + unref，不阻止宿主退出）；
 *   - 每一轮 agy 轮次签发一次性 Bearer Token（32 字节随机），内存只存 SHA-256，
 *     比对使用 crypto.timingSafeEqual；轮次结束即吊销并删除落盘的 token 文件；
 *   - 每次请求五重校验：Token 有效未过期 / 控制器与留言板未关闭 / 成员存在且未 kill /
 *     activationEpoch 与签发时一致 / 发帖时 swarm 未结项且本轮发帖数未超上限；
 *   - 身份一律取自服务端 grant.memberName，客户端载荷里的任何身份字段都被忽略。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const { redactSensitiveText } = require('./redaction.js');

const MAX_POSTS_PER_TURN = 8;
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_GRANT_TTL_MS = 6 * 60 * 60 * 1000;
const BRIDGE_TOOLS = Object.freeze(['read_board', 'post_message']);

class BridgeHttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'BridgeHttpError';
    this.status = status;
    this.code = code || 'SWARM_BRIDGE_ERROR';
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function sanitizeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
}

/** 原子写入 token 文件：临时文件 + rename，权限尽量收紧到 0600。 */
function writeAuthFileAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

function unlinkQuiet(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      // 删除失败不影响吊销（内存 Map 已移除），token 本身已失效。
    }
  }
}

class SwarmMcpBridgeServer {
  /**
   * @param {object} options
   * @param {string} [options.baseDir] Swarm 存储根目录（token 文件落在 <baseDir>/<coordDir>/tokens/）
   * @param {(coordinatorSessionId: string) => any} options.resolveStore 返回 BoardStore
   * @param {() => boolean} [options.isDisposed] 控制器是否已释放
   * @param {(ctx: object) => any} options.onReadBoard
   * @param {(ctx: object) => any} options.onPostMessage
   * @param {number} [options.maxPostsPerTurn]
   * @param {number} [options.maxBodyBytes]
   * @param {number} [options.defaultTtlMs]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(os.homedir(), '.dsh', 'swarm');
    this.resolveStore =
      typeof options.resolveStore === 'function' ? options.resolveStore : () => null;
    this.isDisposed = typeof options.isDisposed === 'function' ? options.isDisposed : () => false;
    this.onReadBoard = options.onReadBoard;
    this.onPostMessage = options.onPostMessage;
    this.maxPostsPerTurn =
      Number.isSafeInteger(options.maxPostsPerTurn) && options.maxPostsPerTurn > 0
        ? options.maxPostsPerTurn
        : MAX_POSTS_PER_TURN;
    this.maxBodyBytes =
      Number.isSafeInteger(options.maxBodyBytes) && options.maxBodyBytes > 0
        ? options.maxBodyBytes
        : MAX_BODY_BYTES;
    this.defaultTtlMs =
      Number.isFinite(options.defaultTtlMs) && options.defaultTtlMs > 0
        ? options.defaultTtlMs
        : DEFAULT_GRANT_TTL_MS;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    /** tokenHashHex -> grant */
    this.grants = new Map();
    this.server = null;
    this.port = 0;
    this.closed = false;
    this._startPromise = null;
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}/rpc` : '';
  }

  get listening() {
    return Boolean(this.server && this.server.listening);
  }

  /** 惰性启动（singleflight）：首个 agy 轮次时才真正 listen。 */
  ensureStarted() {
    if (this.closed) return Promise.reject(new Error('Swarm MCP 桥已关闭'));
    if (this.listening) return Promise.resolve(this.port);
    if (this._startPromise) return this._startPromise;
    this._startPromise = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handleRequest(req, res).catch((err) => {
          this._sendJson(res, err?.status || 500, {
            ok: false,
            error: redactSensitiveText(err?.message || String(err), { maxChars: 300 }),
            code: err?.code || 'SWARM_BRIDGE_INTERNAL',
          });
        });
      });
      server.on('error', (err) => {
        this._startPromise = null;
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        this.server = server;
        this.port = server.address().port;
        resolve(this.port);
      });
    });
    return this._startPromise;
  }

  defaultAuthFilePath(coordinatorSessionId, memberName) {
    return path.join(
      this.baseDir,
      sanitizeSegment(coordinatorSessionId),
      'tokens',
      `${sanitizeSegment(memberName)}.json`
    );
  }

  /**
   * 为一轮 agy 轮次签发一次性 Token，并把 { url, token } 原子写入 token 文件。
   * 同一成员的旧 Token 会先被吊销（保证任意时刻每个成员至多一个有效 Token）。
   */
  issueTurnGrant({
    coordinatorSessionId,
    memberName,
    memberSessionId,
    activationEpoch,
    ttlMs,
    authFilePath,
  } = {}) {
    if (this.closed) throw new Error('Swarm MCP 桥已关闭，无法签发 Token');
    if (!this.port) throw new Error('Swarm MCP 桥尚未启动（请先 await ensureStarted()）');
    if (!coordinatorSessionId || !memberName) {
      throw new Error('issueTurnGrant 需要 coordinatorSessionId 与 memberName');
    }
    this.revokeMemberGrants(coordinatorSessionId, memberName);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    const filePath = authFilePath || this.defaultAuthFilePath(coordinatorSessionId, memberName);
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.defaultTtlMs;
    const grantState = { postCount: 0, postedSeqs: [] };
    const grant = {
      tokenHash,
      coordinatorSessionId,
      memberName,
      memberSessionId: memberSessionId || '',
      activationEpoch: Number.isSafeInteger(activationEpoch) ? activationEpoch : 0,
      issuedAt: this.now(),
      expiresAt: this.now() + ttl,
      authFilePath: filePath,
      grantState,
      revoked: false,
    };
    const key = tokenHash.toString('hex');
    this.grants.set(key, grant);
    try {
      writeAuthFileAtomic(filePath, { url: this.url, token });
    } catch (err) {
      this.grants.delete(key);
      throw err;
    }

    const revoke = () => this._revokeGrant(grant);
    return {
      token,
      authFilePath: filePath,
      grantState,
      expiresAt: grant.expiresAt,
      get revoked() {
        return grant.revoked;
      },
      revoke,
    };
  }

  _revokeGrant(grant) {
    if (!grant) return false;
    const first = grant.revoked !== true;
    grant.revoked = true;
    const key = grant.tokenHash.toString('hex');
    if (this.grants.get(key) === grant) this.grants.delete(key);
    if (first) unlinkQuiet(grant.authFilePath);
    return first;
  }

  /** 吊销某成员当前全部 Token（kill / [done] / session-stop 使用）。幂等。 */
  revokeMemberGrants(coordinatorSessionId, memberName) {
    let count = 0;
    for (const grant of [...this.grants.values()]) {
      if (grant.coordinatorSessionId === coordinatorSessionId && grant.memberName === memberName) {
        if (this._revokeGrant(grant)) count += 1;
      }
    }
    return count;
  }

  /** 吊销某个 swarm（或全部）的 Token。 */
  revokeAll(coordinatorSessionId) {
    let count = 0;
    for (const grant of [...this.grants.values()]) {
      if (!coordinatorSessionId || grant.coordinatorSessionId === coordinatorSessionId) {
        if (this._revokeGrant(grant)) count += 1;
      }
    }
    return count;
  }

  /** 关闭监听并吊销全部 Token。幂等。 */
  async close() {
    this.closed = true;
    this.revokeAll();
    const server = this.server;
    this.server = null;
    this._startPromise = null;
    if (!server) return;
    await new Promise((resolve) => {
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {
        // ignore
      }
      server.close(() => resolve());
    });
  }

  /* ------------------------------------------------------------------ */
  /* 请求处理                                                            */
  /* ------------------------------------------------------------------ */

  _sendJson(res, status, payload) {
    if (res.headersSent || res.writableEnded) return;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      Connection: 'close',
    });
    res.end(body);
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let failed = false;
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
        failed = true;
        reject(new BridgeHttpError(413, `请求体超过 ${this.maxBodyBytes} 字节上限`, 'SWARM_BRIDGE_TOO_LARGE'));
        req.resume();
        return;
      }
      req.on('data', (chunk) => {
        if (failed) return;
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          failed = true;
          reject(new BridgeHttpError(413, `请求体超过 ${this.maxBodyBytes} 字节上限`, 'SWARM_BRIDGE_TOO_LARGE'));
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', (err) => {
        if (!failed) {
          failed = true;
          reject(err);
        }
      });
    });
  }

  /** 校验 1：Bearer Token 命中、未吊销、未过期（SHA-256 + timingSafeEqual）。 */
  _authenticate(req) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+([A-Za-z0-9]+)$/.exec(header.trim());
    if (!match) throw new BridgeHttpError(401, '缺少或格式错误的 Bearer Token', 'SWARM_BRIDGE_UNAUTHORIZED');
    const presented = sha256(match[1]);
    const grant = this.grants.get(presented.toString('hex'));
    if (!grant || grant.tokenHash.length !== presented.length) {
      throw new BridgeHttpError(401, 'Token 无效或已吊销', 'SWARM_BRIDGE_UNAUTHORIZED');
    }
    if (!crypto.timingSafeEqual(grant.tokenHash, presented)) {
      throw new BridgeHttpError(401, 'Token 无效或已吊销', 'SWARM_BRIDGE_UNAUTHORIZED');
    }
    if (grant.revoked) throw new BridgeHttpError(401, 'Token 已吊销', 'SWARM_BRIDGE_UNAUTHORIZED');
    if (this.now() > grant.expiresAt) {
      this._revokeGrant(grant);
      throw new BridgeHttpError(401, 'Token 已过期', 'SWARM_BRIDGE_EXPIRED');
    }
    return grant;
  }

  async _handleRequest(req, res) {
    const url = String(req.url || '');
    const pathname = url.split('?')[0];
    if (req.method !== 'POST' || pathname !== '/rpc') {
      req.resume();
      this._sendJson(res, 404, { ok: false, error: '仅支持 POST /rpc', code: 'SWARM_BRIDGE_NOT_FOUND' });
      return;
    }
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      req.resume();
      this._sendJson(res, 415, {
        ok: false,
        error: 'Content-Type 必须为 application/json',
        code: 'SWARM_BRIDGE_UNSUPPORTED_MEDIA',
      });
      return;
    }

    let grant;
    let rawBody;
    try {
      rawBody = await this._readBody(req);
      grant = this._authenticate(req);
    } catch (err) {
      this._sendJson(res, err?.status || 400, {
        ok: false,
        error: redactSensitiveText(err?.message || String(err), { maxChars: 300 }),
        code: err?.code || 'SWARM_BRIDGE_BAD_REQUEST',
      });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody || '{}');
    } catch {
      this._sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON', code: 'SWARM_BRIDGE_BAD_JSON' });
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this._sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象', code: 'SWARM_BRIDGE_BAD_JSON' });
      return;
    }
    const tool = typeof payload.tool === 'string' ? payload.tool : '';
    if (!BRIDGE_TOOLS.includes(tool)) {
      this._sendJson(res, 400, {
        ok: false,
        error: `未知工具 "${tool}"：仅支持 ${BRIDGE_TOOLS.join(' / ')}`,
        code: 'SWARM_BRIDGE_UNKNOWN_TOOL',
      });
      return;
    }
    const args =
      payload.arguments && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments)
        ? payload.arguments
        : {};

    try {
      const result = await this._dispatch(grant, tool, args);
      this._sendJson(res, 200, { ok: true, result });
    } catch (err) {
      this._sendJson(res, err?.status || 400, {
        ok: false,
        error: redactSensitiveText(err?.message || String(err), { maxChars: 300 }),
        code: err?.code || 'SWARM_BRIDGE_TOOL_ERROR',
      });
    }
  }

  async _dispatch(grant, tool, args) {
    // 校验 2：控制器 / 留言板仍可用
    if (this.closed || this.isDisposed()) {
      throw new BridgeHttpError(410, 'Swarm 控制器已释放', 'SWARM_BRIDGE_GONE');
    }
    const store = this.resolveStore(grant.coordinatorSessionId);
    if (!store || store.closed) {
      throw new BridgeHttpError(410, 'Swarm 留言板已关闭', 'SWARM_BRIDGE_GONE');
    }
    // 校验 3：成员存在且未 kill
    const member = store.getMember(grant.memberName);
    if (!member || member.killed) {
      throw new BridgeHttpError(403, `成员 "${grant.memberName}" 不存在或已被 kill`, 'SWARM_BRIDGE_FORBIDDEN');
    }
    // 校验 4：激活代次一致（防止旧轮次 Token 越过新轮次）
    if ((member.activationEpoch || 0) !== grant.activationEpoch) {
      throw new BridgeHttpError(
        409,
        `Token 所属轮次已失效（epoch ${grant.activationEpoch} ≠ 当前 ${member.activationEpoch || 0}）`,
        'SWARM_BRIDGE_STALE_EPOCH'
      );
    }
    // 身份防伪：callerName / authorName 一律取服务端 grant.memberName
    const callerName = grant.memberName;
    const context = { store, member, grant, callerName, authorName: callerName, args };

    if (tool === 'read_board') {
      if (typeof this.onReadBoard !== 'function') {
        throw new BridgeHttpError(501, 'read_board 未实现', 'SWARM_BRIDGE_NOT_IMPLEMENTED');
      }
      return this.onReadBoard(context);
    }

    // 校验 5：发帖前置条件
    if (store.state?.done) {
      throw new BridgeHttpError(409, 'Swarm 已结项（[done]），禁止继续发帖', 'SWARM_BRIDGE_DONE');
    }
    if (grant.grantState.postCount >= this.maxPostsPerTurn) {
      throw new BridgeHttpError(
        429,
        `本轮发帖已达上限 ${this.maxPostsPerTurn} 条，请整合内容后结束本轮`,
        'SWARM_BRIDGE_POST_LIMIT'
      );
    }
    if (typeof this.onPostMessage !== 'function') {
      throw new BridgeHttpError(501, 'post_message 未实现', 'SWARM_BRIDGE_NOT_IMPLEMENTED');
    }
    // 先占名额再执行，防并发请求越过上限；失败则归还。
    grant.grantState.postCount += 1;
    try {
      const result = await this.onPostMessage(context);
      const seq = Number.isSafeInteger(result?.seq) ? result.seq : null;
      if (seq !== null) grant.grantState.postedSeqs.push(seq);
      return result;
    } catch (err) {
      grant.grantState.postCount -= 1;
      throw err;
    }
  }
}

module.exports = {
  MAX_POSTS_PER_TURN,
  MAX_BODY_BYTES,
  DEFAULT_GRANT_TTL_MS,
  BRIDGE_TOOLS,
  BridgeHttpError,
  SwarmMcpBridgeServer,
  writeAuthFileAtomic,
};