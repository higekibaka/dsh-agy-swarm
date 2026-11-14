'use strict';

/**
 * Per-coordinator persistent Swarm Board Engine (`state.json` + `board.jsonl`)
 * and multi-session lookup manager.
 *
 * Implements:
 * - Monotonic #seq message feed & channel system (`main` + custom `#area`)
 * - Word-boundary doorbell parser: `@name`, `@groupPrefix`, `@#channel` (rejects `@#main`), `@all`
 * - Race-free `prepareWait({ since, mentions_only })` cursor check
 * - Group spawning (`n` and `tasks`), reserved name validation (`all`, `coordinator`)
 * - Strict `addedBy` ownership enforcement (`kill`, `model`, `channel`, `title`)
 */

const fs = require('node:fs');
const path = require('node:path');

const { redactSensitiveText } = require('./redaction.js');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  MEMBER_STATES,
  WORKSPACE_MODES,
  AGY_MODES,
  createEmptySnapshot,
  normalizeSwarmSnapshot,
  normalizeAgyLive,
  normalizeAgyUsage,
} = require('./protocol.js');

const RESERVED_NAMES = new Set(['all', 'coordinator']);
const MEMBER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function formatTime(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeDirSegment(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
}

const RENAME_RETRY_LIMIT = 3;
const RENAME_RETRY_BASE_MS = 12;
/** In-process writer registry: resolved board dir -> ownerId. */
const WRITER_LOCKS = new Map();
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  try {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
  } catch {
    // ignore unsupported wait
  }
}

/**
 * Atomically write JSON: temp file + rename with a bounded EPERM/EBUSY retry.
 * The formal file is NEVER overwritten in place — a rename failure deletes the
 * temp file and rethrows so callers can surface the failure instead of silently
 * losing durability.
 */
function atomicWriteJsonSync(filePath, data, options = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const serialized = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, serialized, 'utf8');
  let lastError = null;
  for (let attempt = 0; attempt < RENAME_RETRY_LIMIT; attempt += 1) {
    try {
      fs.renameSync(tmpPath, filePath);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      if (code !== 'EPERM' && code !== 'EBUSY') break;
      sleepSync(RENAME_RETRY_BASE_MS * (attempt + 1));
    }
  }
  if (lastError) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw lastError;
  }
  if (options.backup === true) {
    try {
      fs.writeFileSync(`${filePath}.bak`, serialized, 'utf8');
    } catch {
      // A missing backup must not fail the authoritative write
    }
  }
}

function readWriterLock(lockFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.ownerId === 'string') return parsed;
  } catch {
    // unreadable lock treated as stale
  }
  return null;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !err || err.code !== 'ESRCH';
  }
}

/** Render a filesystem error into one lock-diagnostic line. */
function extractLockError(err) {
  if (!err) return '';
  const code = err.code ? '[' + err.code + '] ' : '';
  return code + (err.message || String(err));
}

function normalizeChannelName(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/^#+/, '').toLowerCase();
  return trimmed;
}

/**
 * Strictly validate and normalize one persisted JSONL message.
 *
 * A persisted line must carry a usable identity (positive safe-integer seq, a
 * non-empty agent, a string body). Optional fields are normalized instead of
 * trusted: a hand-edited or truncated record can never smuggle a non-array
 * `mentions` field into the doorbell router. Anything that fails the basic
 * shape returns null so the loader can drop it and schedule a real repair.
 */
function normalizeLoadedMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isSafeInteger(raw.seq) || raw.seq <= 0) return null;
  if (typeof raw.agent !== 'string' || raw.agent.length === 0) return null;
  if (typeof raw.text !== 'string') return null;
  const channelRaw =
    typeof raw.channel === 'string' && raw.channel ? normalizeChannelName(raw.channel) : '';
  return {
    seq: raw.seq,
    channel: channelRaw || 'main',
    agent: raw.agent,
    text: raw.text,
    mentions: Array.isArray(raw.mentions)
      ? raw.mentions.filter((item) => typeof item === 'string')
      : [],
    channelMentions: Array.isArray(raw.channelMentions)
      ? raw.channelMentions.filter((item) => typeof item === 'string')
      : [],
    broadcast: Boolean(raw.broadcast),
    ...(typeof raw.time === 'string' ? { time: raw.time } : {}),
    ...(Number.isSafeInteger(raw.timestampMs) ? { timestampMs: raw.timestampMs } : {}),
  };
}

function isMonitorRoleOrName(name, role) {
  if (role === 'monitor') return true;
  return name === 'monitor' || /^monitor-\d+$/.test(String(name || ''));
}

const MEMBER_BACKENDS = Object.freeze(['dsh', 'agy-acp']);

function nonNegInt(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * 二期：规范化成员的后端与 agy-acp 相关持久字段。
 * DSH 原生成员也带上 backend:'dsh' 与零值计数器，读写两端形状一致。
 */
function normalizeAgyMemberFields(raw = {}) {
  const backend = MEMBER_BACKENDS.includes(raw.backend) ? raw.backend : 'dsh';
  return {
    backend,
    agySessionId:
      typeof raw.agySessionId === 'string' && raw.agySessionId ? raw.agySessionId : null,
    agyWorkerName: typeof raw.agyWorkerName === 'string' ? raw.agyWorkerName : '',
    agyMode: AGY_MODES.includes(raw.agyMode) ? raw.agyMode : backend === 'agy-acp' ? 'plan' : '',
    agyFullAccess: backend === 'agy-acp' && raw.agyFullAccess === true,
    agyAccessMode: typeof raw.agyAccessMode === 'string' ? raw.agyAccessMode : '',
    activationEpoch: nonNegInt(raw.activationEpoch, 0),
    activationCount: nonNegInt(raw.activationCount, 0),
    consecutivePeerWakes: nonNegInt(raw.consecutivePeerWakes, 0),
    circuitBreakNotified: raw.circuitBreakNotified === true,
    // 二期：轮次实时阶段与累计 Token 账单（空闲 / 尚无账单时为 null）。
    agyLive: backend === 'agy-acp' ? normalizeAgyLive(raw.agyLive) : null,
    agyUsage: backend === 'agy-acp' ? normalizeAgyUsage(raw.agyUsage) : null,
  };
}

function validateMemberBaseName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('成员名称 name 不能为空');
  }
  const normalized = name.trim();
  if (RESERVED_NAMES.has(normalized.toLowerCase())) {
    throw new Error(`"${normalized}" 是系统保留名称（禁止用于 add 或 kill）`);
  }
  if (!MEMBER_NAME_PATTERN.test(normalized)) {
    throw new Error(
      `成员名称 "${normalized}" 不合法：须以小写字母开头，仅含小写字母、数字、连字符或下划线（长度 ≤ 48）`
    );
  }
  return normalized;
}

/**
 * Expand single worker or group shard arguments (`n` / `tasks`) into concrete member specs.
 */
function expandAddSpecs({ name, brief, n, tasks }) {
  const baseName = validateMemberBaseName(name);
  const baseBrief = typeof brief === 'string' ? brief.trim() : '';
  if (!baseBrief && (!Array.isArray(tasks) || tasks.length === 0)) {
    throw new Error('swarm add 必须提供非空的 brief 任务说明');
  }

  if (Array.isArray(tasks) && tasks.length > 0) {
    if (tasks.length > 64) {
      throw new Error(`swarm add 的 tasks 数量不能超过 64，收到：${tasks.length}`);
    }
    if (n !== undefined && n !== tasks.length) {
      throw new Error(`swarm add 同时指定了 n=${n} 与 tasks（长度 ${tasks.length}），两者数量不一致`);
    }
    return tasks.map((taskText, idx) => {
      const slice = String(taskText ?? '').trim();
      if (!slice) {
        throw new Error(`swarm add 的 tasks[${idx}] 不能为空`);
      }
      const memberName = `${baseName}-${idx + 1}`;
      const combined = baseBrief
        ? `${baseBrief}\n\n【你的专属分片 (${idx + 1}/${tasks.length})】：${slice}`
        : slice;
      return {
        name: memberName,
        brief: combined,
        groupPrefix: baseName,
      };
    });
  }

  if (n !== undefined) {
    if (!Number.isSafeInteger(n) || n < 1 || n > 64) {
      throw new Error(`swarm add 的 n 必须是 1..64 的正整数，收到：${String(n)}`);
    }
    if (n > 1) {
      const specs = [];
      for (let i = 1; i <= n; i += 1) {
        specs.push({
          name: `${baseName}-${i}`,
          brief: baseBrief,
          groupPrefix: baseName,
        });
      }
      return specs;
    }
  }

  return [
    {
      name: baseName,
      brief: baseBrief,
      groupPrefix: null,
    },
  ];
}

/**
 * Parse word-boundary doorbells from message text:
 * - `@#channel` (rejects `@#main`; requires existing unarchived channel)
 * - `@all` (`broadcast: true`)
 * - `@exactMember` (including `coordinator`)
 * - `@groupPrefix` (expands `<prefix>-1..<prefix>-k` on the roster)
 */
/**
 * Strip fenced code blocks (```...```) and inline code spans (`...`) before
 * scanning doorbells so example snippets such as "`@coordinator`" in task
 * instructions never trigger false wakeups or spurious topology edges.
 */
function stripCodeForDoorbells(text) {
  const rawLines = String(text ?? '').split(/\r?\n/);
  const unFencedLines = [];
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of rawLines) {
    if (!fenceChar) {
      const open = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        unFencedLines.push('');
        continue;
      }
      unFencedLines.push(line);
    } else {
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
      if (closeRe.test(line)) {
        fenceChar = '';
        fenceLen = 0;
      }
      unFencedLines.push('');
    }
  }

  const src = unFencedLines.join('\n');
  const runs = [];
  for (let i = 0; i < src.length; ) {
    if (src[i] === '`') {
      let end = i + 1;
      while (end < src.length && src[end] === '`') end += 1;
      runs.push({ start: i, len: end - i });
      i = end;
    } else {
      i += 1;
    }
  }
  if (runs.length === 0) return src;

  // Pair exact-length backtick runs in O(N) using per-length queues.
  const byLen = new Map();
  for (let idx = 0; idx < runs.length; idx += 1) {
    const len = runs[idx].len;
    let list = byLen.get(len);
    if (!list) {
      list = [];
      byLen.set(len, list);
    }
    list.push(idx);
  }
  const ptrByLen = new Map();
  const skipSpans = [];
  let runIdx = 0;
  while (runIdx < runs.length) {
    const openRun = runs[runIdx];
    const list = byLen.get(openRun.len);
    let p = ptrByLen.get(openRun.len) || 0;
    while (p < list.length && list[p] <= runIdx) p += 1;
    ptrByLen.set(openRun.len, p);
    if (p < list.length) {
      const closeIdx = list[p];
      const closeRun = runs[closeIdx];
      skipSpans.push({ start: openRun.start, end: closeRun.start + closeRun.len });
      ptrByLen.set(openRun.len, p + 1);
      runIdx = closeIdx + 1;
    } else {
      runIdx += 1;
    }
  }
  if (skipSpans.length === 0) return src;

  const chunks = [];
  let cursor = 0;
  for (const span of skipSpans) {
    if (span.start > cursor) chunks.push(src.slice(cursor, span.start));
    chunks.push(' ');
    cursor = span.end;
  }
  if (cursor < src.length) chunks.push(src.slice(cursor));
  return chunks.join('');
}

function parseMessageDoorbells(text, membersByName, channelsByName) {
  const body = stripCodeForDoorbells(text);
  const channelMentions = new Set();
  const mentions = new Set();
  let broadcast = false;

  // 1. Parse @#channel doorbells first
  const chRegex = /(?<![A-Za-z0-9_./-])@#([A-Za-z0-9][A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/g;
  let match;
  while ((match = chRegex.exec(body)) !== null) {
    const rawChannel = match[1].toLowerCase();
    if (rawChannel === 'main') {
      throw new Error(
        '@#main 被拒绝：不允许对默认主频道使用频道门铃；确需唤醒全员请用 @all，或先创建专题 #频道'
      );
    }
    const ch = channelsByName.get(rawChannel);
    if (!ch) {
      throw new Error(`频道门铃 "@#${rawChannel}" 指向不存在的频道`);
    }
    if (ch.archived) {
      throw new Error(`频道 "#${rawChannel}" 已归档，不能再使用 "@#${rawChannel}" 唤醒`);
    }
    channelMentions.add(rawChannel);
  }

  // 2. Parse @member / @prefix / @all doorbells (not followed by #)
  const atRegex = /(?<![A-Za-z0-9_./-])@([A-Za-z0-9][A-Za-z0-9_-]*)(?![A-Za-z0-9_#-])/g;
  while ((match = atRegex.exec(body)) !== null) {
    const token = match[1].toLowerCase();
    if (token === 'all') {
      broadcast = true;
      continue;
    }
    if (membersByName.has(token)) {
      mentions.add(token);
      continue;
    }
    // Group prefix expansion: @worker wakes worker-1..worker-k
    const groupPattern = new RegExp(`^${escapeRegExp(token)}-\\d+$`);
    for (const memberName of membersByName.keys()) {
      if (groupPattern.test(memberName)) {
        mentions.add(memberName);
      }
    }
  }

  return {
    mentions: [...mentions],
    channelMentions: [...channelMentions],
    broadcast,
  };
}

function isDonePost(agentName, channelName, text) {
  if (agentName !== 'coordinator') return false;
  if (channelName !== 'main') return false;
  return /^\s*\[done\]/i.test(String(text || ''));
}

class BoardStore {
  constructor(coordinatorSessionId, options = {}) {
    if (!coordinatorSessionId || typeof coordinatorSessionId !== 'string') {
      throw new Error('BoardStore requires a non-empty coordinatorSessionId');
    }
    this.coordinatorSessionId = coordinatorSessionId;
    this.baseDir = options.baseDir || path.join(os.homedir(), '.dsh', 'swarm');
    this.dir = path.join(this.baseDir, sanitizeDirSegment(coordinatorSessionId));
    this.stateFile = path.join(this.dir, 'state.json');
    this.boardFile = path.join(this.dir, 'board.jsonl');
    this.lockFile = path.join(this.dir, 'writer.lock');
    /**
     * Cross-process reclaim gate. Serializes the entire
     * "re-read -> prove dead -> unlink -> create" takeover sequence, which the
     * primary `writer.lock` cannot do on its own: a snapshot read before the
     * gate is worthless because the previous owner may have been replaced while
     * this process was descheduled.
     */
    this.reclaimLockFile = path.join(this.dir, 'writer.lock.reclaim');
    this.listeners = new Set();
    this.ownerId = `${process.pid}-${crypto.randomUUID()}`;
    this.lockHeld = false;
    this.closed = false;
    this._wakingMembers = new Set();
    /** Deferred self-heal flags: read-only loads NEVER touch the disk. */
    this._needsStateRepair = false;
    this._needsBoardRepair = false;

    this.state = {
      version: 1,
      coordinatorSessionId,
      title: '',
      head: 0,
      done: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      coordinatorAddedTurn: 0,
      channels: [
        {
          name: 'main',
          topic: '默认公共主频道',
          archived: false,
          createdBy: 'coordinator',
          subscribers: ['coordinator'],
        },
      ],
      members: [],
    };
    this.messages = [];
    this._loadIfPresent();
  }

  /**
   * Take this store's writer lock, or throw on a competing writer.
   *
   * The on-disk lock is an ATOMIC exclusive create (`wx`): two processes — or
   * two VM contexts inside one process — can never both observe "no lock" and
   * then both write one. A lock left behind by a provably dead process is
   * stolen exactly once and the create is retried; every other shape is a hard
   * double-writer error.
   *
   * The first successful acquisition also RELOADS the board from disk, so a
   * read-only instance that cached `head=1` can never re-emit `seq=2` after the
   * previous writer persisted `seq=2` and released the lock.
   */
  _ensureWriter() {
    if (this.lockHeld) {
      // The on-disk lock is the only cross-process truth: if it vanished or was
      // replaced, the cached flag is a lie and every later write would reuse a
      // seq the new owner already spent.
      this._assertDiskLockOwned();
      return;
    }
    if (this.closed) {
      throw new Error(`Swarm 留言板 "${this.coordinatorSessionId}" 已关闭，禁止继续写入`);
    }
    const key = this.dir;
    const registered = WRITER_LOCKS.get(key);
    if (registered && registered !== this.ownerId) {
      throw new Error(
        `Swarm 留言板目录 "${key}" 已被另一个写入者（${registered}）占用：检测到并发双写者，拒绝写入`
      );
    }
    fs.mkdirSync(this.dir, { recursive: true });
    this._acquireDiskLock(key);
    WRITER_LOCKS.set(key, this.ownerId);
    this.lockHeld = true;
    // Promotion from a read-only cache: adopt the newest on-disk state before
    // the very first write, then flush the self-heal this load deferred.
    this._loadIfPresent();
    this._applyPendingRepairs();
  }

  /**
   * Take the writer lock, or throw on a competing writer.
   *
   * Fast path: one atomic exclusive create (`wx`). Only an already existing
   * lock file sends us into the reclaim critical section, and NOTHING read
   * before that gate is trusted: the owner may have been replaced while this
   * process was descheduled, so acting on an old snapshot could delete a lock
   * another process just created.
   */
  _acquireDiskLock(key) {
    try {
      this._createDiskLockExclusive();
      return;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    this._reclaimStaleLock(key);
  }

  /** Atomically create `writer.lock` (`wx`) and stamp our ownership into it. */
  _createDiskLockExclusive() {
    const fd = fs.openSync(this.lockFile, 'wx');
    try {
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, ownerId: this.ownerId, acquiredAt: Date.now() })
      );
    } catch (writeErr) {
      // The file is OURS (the `wx` create succeeded), so a failed stamp must
      // remove it: a truncated lock would block every later takeover as
      // "corrupt" until a human deletes it. Close first — Windows refuses to
      // unlink an open file.
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      try {
        fs.unlinkSync(this.lockFile);
      } catch {
        // best-effort cleanup only
      }
      throw writeErr;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }

  /** Create the protected lock, turning a lost race into a clear refusal. */
  _createDiskLockExclusiveOrRefuse(key) {
    try {
      this._createDiskLockExclusive();
    } catch (createErr) {
      if (!createErr || createErr.code !== 'EEXIST') throw createErr;
      throw new Error(
        `Swarm 留言板目录 "${key}" 的写锁在接管临界区内被并发写入者抢占：拒绝并发双写者写入`
      );
    }
  }

  /**
   * Steal a provably stale lock inside a second `wx` gate
   * (`writer.lock.reclaim`).
   *
   * The gate serializes re-read -> prove dead -> unlink -> create across
   * processes. A competitor that cannot take the gate fails closed instead of
   * deleting a lock it cannot prove dead. A gate left behind by a crashed
   * process is NEVER force-deleted either (that would hand the very same TOCTOU
   * to whoever deletes it), so it needs manual cleanup.
   */
  _reclaimStaleLock(key) {
    let gateFd = null;
    try {
      gateFd = fs.openSync(this.reclaimLockFile, 'wx');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      const holder = readWriterLock(this.lockFile);
      throw new Error(
        `Swarm 留言板目录 "${key}" 正处于写锁接管临界区（${this.reclaimLockFile}）：` +
          (holder
            ? `主锁由进程 ${holder.pid}（owner ${holder.ownerId}）持有`
            : '无法确认主锁持有者是否存活') +
          '，拒绝并发双写者写入'
      );
    }
    // The gate is OURS from this instant (only an atomic `wx` create gets
    // here), so EVERY failure path below must release it.
    try {
      try {
        fs.writeSync(
          gateFd,
          JSON.stringify({ pid: process.pid, ownerId: this.ownerId, acquiredAt: Date.now() })
        );
      } finally {
        try {
          fs.closeSync(gateFd);
        } catch {
          // already closed
        }
      }

      // Re-read INSIDE the gate: a snapshot taken before it proves nothing.
      const fresh = readWriterLock(this.lockFile);
      if (!fresh) {
        if (!fs.existsSync(this.lockFile)) {
          // The previous holder released while we waited for the gate.
          this._createDiskLockExclusiveOrRefuse(key);
          return;
        }
        throw new Error(
          `Swarm 留言板目录 "${key}" 的写锁文件已损坏（${this.lockFile}）：` +
            '无法确认持有者是否存活，拒绝在损坏锁上写入；请人工检查并清理该 writer.lock'
        );
      }
      if (fresh.ownerId !== this.ownerId) {
        // Only a provably dead positive pid may be stolen; an unparsable or
        // live owner is always a hard double-writer refusal.
        const provablyDead =
          Number.isInteger(fresh.pid) && fresh.pid > 0 && !isProcessAlive(fresh.pid);
        if (!provablyDead) {
          throw new Error(
            `Swarm 留言板目录 "${key}" 已被进程 ${fresh.pid}（owner ${fresh.ownerId}）锁定：拒绝并发双写者写入`
          );
        }
      }
      // Provably stale (owner died, or it is our own leftover): steal it inside
      // the same gate so unlink+create cannot interleave with another reclaimer.
      try {
        fs.unlinkSync(this.lockFile);
      } catch (unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== 'ENOENT') {
          throw new Error(
            `Swarm 留言板目录 "${key}" 的陈旧写锁无法清理：${extractLockError(unlinkErr)}` +
              '拒绝在无法清理他人锁文件时继续写入'
          );
        }
      }
      this._createDiskLockExclusiveOrRefuse(key);
    } finally {
      try {
        fs.unlinkSync(this.reclaimLockFile);
      } catch {
        // gate already gone
      }
    }
  }

  /**
   * Refuse to write beneath a lock this instance no longer owns.
   *
   * `writer.lock` is the only cross-process source of truth. If it was deleted
   * or replaced externally (a stale takeover by another writer), continuing to
   * append would re-emit a `seq` the new owner already spent, so the cached
   * `lockHeld` flag is dropped and the write aborts.
   */
  _assertDiskLockOwned() {
    if (this.lockHeld !== true) return;
    const onDisk = readWriterLock(this.lockFile);
    if (onDisk && onDisk.ownerId === this.ownerId) return;
    this.lockHeld = false;
    if (WRITER_LOCKS.get(this.dir) === this.ownerId) WRITER_LOCKS.delete(this.dir);
    throw new Error('Swarm 留言板写锁已丢失或被外部覆盖，中止写入以保护序号唯一性');
  }

  /**
   * Flush repairs that a read-only load deliberately deferred.
   *
   * MUST run with the writer lock held. A failing board rewrite is rethrown on
   * purpose: continuing `appendFileSync` behind a half-written tail would glue
   * the next record onto the broken fragment and lose it on reopen.
   */
  _applyPendingRepairs() {
    if (this._needsBoardRepair) {
      this._rewriteBoardFile(this.messages);
      this._needsBoardRepair = false;
    }
    if (this._needsStateRepair) {
      this._persistState();
      this._needsStateRepair = false;
    }
  }

  /**
   * Release the on-disk writer.lock without closing in-memory subscriptions.
   * Called once a swarm settles (`done === true` with no active workers) so
   * finished swarm directories do not hold writer.lock forever; any later write
   * transparently re-acquires the lock via `_ensureWriter()`.
   */
  releaseWriterLock() {
    if (!this.lockHeld) return false;
    try {
      const onDisk = readWriterLock(this.lockFile);
      if (!onDisk || onDisk.ownerId === this.ownerId) {
        if (fs.existsSync(this.lockFile)) fs.unlinkSync(this.lockFile);
      }
    } catch {
      // ignore lock release failure
    }
    if (WRITER_LOCKS.get(this.dir) === this.ownerId) WRITER_LOCKS.delete(this.dir);
    this.lockHeld = false;
    return true;
  }

  /** Release the writer lock and stop notifying subscribers. */
  close() {
    this.releaseWriterLock();
    this.closed = true;
    this.listeners.clear();
    this._wakingMembers.clear();
  }

  _mergeLoadedState(loaded) {
    const isDone = Boolean(loaded.done);
    this.state = {
      ...this.state,
      ...loaded,
      done: isDone,
      coordinatorSessionId: this.coordinatorSessionId,
      channels:
        Array.isArray(loaded.channels) && loaded.channels.length > 0
          ? loaded.channels
          : this.state.channels,
      members: Array.isArray(loaded.members)
        ? loaded.members.map((m) => ({
            ...m,
            state:
              m.killed || m.state === 'killed'
                ? 'killed'
                : m.role === 'coordinator' && !isDone
                  ? 'waiting'
                  : 'stopped',
            activity: '',
            waitFor:
              m.killed || isDone || !Array.isArray(m.waitFor)
                ? []
                : m.waitFor.filter((item) => typeof item === 'string' && item.length > 0),
            pendingWakeup: m.killed || isDone ? false : Boolean(m.pendingWakeup),
            pendingModelSync: m.killed ? false : Boolean(m.pendingModelSync),
            ...normalizeAgyMemberFields(m),
          }))
        : [],
    };
  }

  /**
   * Load state + messages from disk.
   *
   * READ-ONLY CONTRACT: this method (and therefore the constructor, snapshot
   * reads and watchSwarm) must NEVER take the writer lock, create
   * `writer.lock`, or rewrite `state.json` / `board.jsonl`. A damaged file is
   * admitted in memory with a deferred-repair flag; only a real writer flushes
   * the repair under its lock.
   */
  _loadIfPresent() {
    const backupFile = `${this.stateFile}.bak`;
    this._needsStateRepair = false;
    if (fs.existsSync(this.stateFile)) {
      let loaded = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) loaded = parsed;
      } catch {
        loaded = null;
      }

      if (!loaded) {
        let recovered = null;
        try {
          const parsedBak = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
          if (parsedBak && typeof parsedBak === 'object' && !Array.isArray(parsedBak)) {
            recovered = parsedBak;
          }
        } catch {
          recovered = null;
        }
        if (recovered) {
          // In-memory recovery only. The disk repair is deferred until this
          // store proves it is the writer, so a read-only viewer of a shared
          // board directory never mutates it.
          this._needsStateRepair = true;
          loaded = recovered;
        } else {
          const hasData =
            (fs.existsSync(this.boardFile) && fs.statSync(this.boardFile).size > 0) ||
            (fs.existsSync(this.stateFile) && fs.statSync(this.stateFile).size > 0);
          throw new Error(
            `Swarm 留言板状态文件损坏且没有可用的 state.json.bak 备份（${this.stateFile}）` +
              (hasData ? '：目录中已有成员/留言数据，拒绝静默清空成员权限表' : '')
          );
        }
      }
      this._mergeLoadedState(loaded);
    }
    this._loadMessages();
  }

  /**
   * Parse `board.jsonl` defensively: every persisted line is validated and
   * normalized, malformed lines are dropped, and a half-written tail (no final
   * newline) schedules a deferred rewrite instead of being edited in place.
   */
  _loadMessages() {
    this.messages = [];
    this._needsBoardRepair = false;
    if (!fs.existsSync(this.boardFile)) return;
    let raw = '';
    try {
      raw = fs.readFileSync(this.boardFile, 'utf8');
    } catch {
      return;
    }
    const lines = raw.split(/\r?\n/);
    const parsed = [];
    let maxSeq = Number.isSafeInteger(this.state.head) && this.state.head > 0 ? this.state.head : 0;
    let needsRepair = raw.length > 0 && !raw.endsWith('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let candidate;
      try {
        candidate = JSON.parse(trimmed);
      } catch {
        needsRepair = true;
        continue;
      }
      const normalized = normalizeLoadedMessage(candidate);
      if (!normalized) {
        needsRepair = true;
        continue;
      }
      parsed.push(normalized);
      if (normalized.seq > maxSeq) maxSeq = normalized.seq;
    }
    parsed.sort((a, b) => a.seq - b.seq);
    this.messages = parsed;
    this.state.head = maxSeq;
    this._needsBoardRepair = needsRepair;
  }

  _rewriteBoardFile(messages) {
    this._ensureWriter();
    // Never rewrite the feed beneath a lock someone else now owns: the new
    // writer's seqs would be clobbered by a rewritten file.
    this._assertDiskLockOwned();
    fs.mkdirSync(this.dir, { recursive: true });
    const payload = messages.map((m) => JSON.stringify(m) + '\n').join('');
    const tmpPath = `${this.boardFile}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, payload, 'utf8');
    let lastError = null;
    for (let attempt = 0; attempt < RENAME_RETRY_LIMIT; attempt += 1) {
      try {
        fs.renameSync(tmpPath, this.boardFile);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const code = err && err.code;
        if (code !== 'EPERM' && code !== 'EBUSY') break;
        sleepSync(RENAME_RETRY_BASE_MS * (attempt + 1));
      }
    }
    if (lastError) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup failure
      }
      throw lastError;
    }
  }

  _persistState() {
    this._ensureWriter();
    this._assertDiskLockOwned();
    this.state.updatedAt = Date.now();
    atomicWriteJsonSync(this.stateFile, this.state, { backup: true });
    this._notify();
  }

  /**
   * Append one record, rolling a partial write back.
   *
   * `appendFileSync` can fail after writing part of the record (ENOSPC / quota).
   * Without a rollback the retry would glue the next JSON object onto that
   * fragment and the whole message would be lost on reopen, so the file is
   * truncated back to its pre-append size. If the truncate itself fails the
   * deferred-repair flag guarantees a full rewrite before any later append.
   */
  _appendMessageRecord(record) {
    this._ensureWriter();
    this._assertDiskLockOwned();
    // A repair may have become pending AFTER the lock was taken (a failed
    // truncate rollback). Appending behind a broken tail would glue the new
    // record onto the fragment, so the rewrite must happen first.
    if (this._needsBoardRepair) {
      this._rewriteBoardFile(this.messages);
      this._needsBoardRepair = false;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    let prevSize = 0;
    try {
      prevSize = fs.existsSync(this.boardFile) ? fs.statSync(this.boardFile).size : 0;
    } catch {
      prevSize = 0;
    }
    try {
      fs.appendFileSync(this.boardFile, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      try {
        if (prevSize === 0) {
          if (fs.existsSync(this.boardFile)) fs.unlinkSync(this.boardFile);
        } else {
          fs.truncateSync(this.boardFile, prevSize);
        }
      } catch {
        this._needsBoardRepair = true;
      }
      throw err;
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  _notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener(this);
      } catch {
        // Isolate subscriber errors
      }
    }
  }

  hasSwarm() {
    return this.state.members.length > 0 || this.state.head > 0 || Boolean(this.state.title);
  }

  ensureCoordinator({
    provider = '',
    model = '',
    modelDisplay = '',
    reasoningEffort = '',
    cwd = '',
    currentTurn = 0,
  } = {}) {
    this._ensureWriter();
    let coord = this.getMember('coordinator');
    if (!coord) {
      coord = {
        name: 'coordinator',
        sessionId: this.coordinatorSessionId,
        role: 'coordinator',
        addedBy: '',
        provider: provider || '',
        model: model || '',
        modelDisplay:
          modelDisplay || (provider && model ? `${provider}/${model}` : model || provider || 'default'),
        reasoningEffort: reasoningEffort || '',
        workspace: 'inherit',
        cwd: cwd || '',
        channels: ['main'],
        state: 'working',
        killed: false,
        wakeMode: 'mentions',
        waitSince: 0,
        waitFor: [],
        activity: '',
        lastError: '',
        lastReadSeq: this.state.head,
        lastPostSeq: 0,
        lastPostTime: '',
      };
      this.state.members.unshift(coord);
      if (!this.state.coordinatorAddedTurn && currentTurn > 0) {
        this.state.coordinatorAddedTurn = currentTurn;
      }
      const mainCh = this._getChannel('main');
      if (mainCh && !mainCh.subscribers.includes('coordinator')) {
        mainCh.subscribers.push('coordinator');
      }
      this._persistState();
    } else {
      let dirty = false;
      if (provider && coord.provider !== provider) {
        coord.provider = provider;
        dirty = true;
      }
      if (model && coord.model !== model) {
        coord.model = model;
        coord.modelDisplay =
          modelDisplay || (provider && model ? `${provider}/${model}` : model);
        dirty = true;
      }
      if (cwd && !coord.cwd) {
        coord.cwd = cwd;
        dirty = true;
      }
      if (!this.state.done && coord.state === 'stopped') {
        coord.state = 'working';
        dirty = true;
      }
      if (dirty) this._persistState();
    }
    return coord;
  }

  _membersMap() {
    const map = new Map();
    for (const m of this.state.members) {
      map.set(m.name, m);
    }
    return map;
  }

  _channelsMap() {
    const map = new Map();
    for (const ch of this.state.channels) {
      map.set(ch.name, ch);
    }
    return map;
  }

  _getChannel(name) {
    const norm = normalizeChannelName(name);
    return this.state.channels.find((c) => c.name === norm);
  }

  getMember(name) {
    if (typeof name !== 'string') return undefined;
    return this.state.members.find((m) => m.name === name.trim().toLowerCase());
  }

  getMemberBySessionId(sessionId) {
    return this.state.members.find((m) => m.sessionId === sessionId);
  }

  seesAllChannels(member) {
    if (!member) return false;
    return member.role === 'coordinator' || isMonitorRoleOrName(member.name, member.role);
  }

  isChannelVisibleToMember(member, channelName) {
    if (!member) return channelName === 'main';
    if (channelName === 'main') return true;
    if (this.seesAllChannels(member)) return true;
    return Array.isArray(member.channels) && member.channels.includes(channelName);
  }

  assertPermission(callerName, action, targetName) {
    const caller = this.getMember(callerName);
    if (!caller || caller.killed) {
      throw new Error(`调用方 "${callerName}" 不在活跃集群花名册中`);
    }

    if (action === 'title') {
      if (caller.name !== 'coordinator') {
        throw new Error('权限不足：仅 coordinator 可以修改集群标题 (title)');
      }
      return caller;
    }

    const target = this.getMember(targetName);
    if (!target) {
      throw new Error(`目标成员 "${targetName}" 不存在`);
    }

    if (action === 'kill') {
      if (target.name === 'coordinator') {
        throw new Error('禁止销毁 coordinator 主会话');
      }
      if (target.name === caller.name) {
        throw new Error('禁止成员自毁（无事可做时请使用 swarm_wait 休眠）');
      }
      if (caller.name !== 'coordinator' && target.addedBy !== caller.name) {
        throw new Error(
          `权限不足：成员 "${caller.name}" 只能 kill 自己创建的子 Helper（"${target.name}" 由 "${target.addedBy || 'coordinator'}" 创建）`
        );
      }
      return target;
    }

    if (action === 'model') {
      if (target.killed) {
        throw new Error(`成员 "${target.name}" 已被永久 kill，无法切换模型`);
      }
      if (
        caller.name !== 'coordinator' &&
        target.name !== caller.name &&
        target.addedBy !== caller.name
      ) {
        throw new Error(
          `权限不足：成员 "${caller.name}" 只能切换自身或自己创建的子 Helper 的模型（"${target.name}" 由 "${target.addedBy || 'coordinator'}" 创建）`
        );
      }
      if (target.name !== caller.name && target.state === 'working') {
        throw new Error(
          `成员 "${target.name}" 当前正在执行轮次 (working)，请等其进入 waiting 休眠后再切换模型`
        );
      }
      return target;
    }

    if (action === 'channel-member') {
      if (
        caller.name !== 'coordinator' &&
        target.name !== caller.name &&
        target.addedBy !== caller.name
      ) {
        throw new Error(
          `权限不足：成员 "${caller.name}" 不能修改非自身派生成员 "${target.name}" 的频道订阅`
        );
      }
      return target;
    }

    return target;
  }

  setTitle(callerName, title) {
    this._ensureWriter();
    this.assertPermission(callerName, 'title');
    const clean = String(title ?? '').trim();
    if (!clean) {
      throw new Error('title 不能为空字符串');
    }
    this.state.title = clean.slice(0, 200);
    this._persistState();
    return { title: this.state.title };
  }

  registerMember({
    name,
    sessionId,
    addedBy = 'coordinator',
    role,
    provider = '',
    model = '',
    modelDisplay = '',
    reasoningEffort = '',
    workspace = 'inherit',
    workspaceDir = '',
    cwd = '',
    channels = [],
    delegationDepth = 0,
    agentPreset = '',
    backend = 'dsh',
    agySessionId = null,
    agyWorkerName = '',
    agyMode = '',
    agyFullAccess = false,
    agyAccessMode = '',
  }) {
    this._ensureWriter();
    const cleanName = validateMemberBaseName(name);
    if (this.getMember(cleanName)) {
      throw new Error(`集群花名册中已存在同名成员 "${cleanName}"（已 kill 的成员名称也不可复用）`);
    }
    if (!sessionId) {
      throw new Error('registerMember 需要有效的 sessionId');
    }

    const resolvedRole = role || (isMonitorRoleOrName(cleanName) ? 'monitor' : 'worker');
    const normalizedChannels = ['main'];
    for (const rawCh of channels) {
      const chName = normalizeChannelName(rawCh);
      if (!chName || chName === 'main') continue;
      let chObj = this._getChannel(chName);
      if (!chObj) {
        if (!CHANNEL_NAME_PATTERN.test(chName)) {
          throw new Error(`频道名称 "${rawCh}" 不合法`);
        }
        chObj = {
          name: chName,
          topic: '',
          archived: false,
          createdBy: addedBy || 'coordinator',
          subscribers: [],
        };
        this.state.channels.push(chObj);
      }
      if (chObj.archived) {
        throw new Error(`频道 "#${chName}" 已归档，不能将新成员加入其中`);
      }
      if (!normalizedChannels.includes(chName)) {
        normalizedChannels.push(chName);
      }
    }

    for (const chName of normalizedChannels) {
      const chObj = this._getChannel(chName);
      if (chObj && !chObj.subscribers.includes(cleanName)) {
        chObj.subscribers.push(cleanName);
      }
    }

    const wsMode = WORKSPACE_MODES.includes(workspace) ? workspace : 'inherit';
    const member = {
      name: cleanName,
      sessionId,
      role: resolvedRole,
      addedBy: addedBy || 'coordinator',
      provider: provider || '',
      model: model || '',
      modelDisplay:
        modelDisplay || (provider && model ? `${provider}/${model}` : model || provider || 'default'),
      reasoningEffort: reasoningEffort || '',
      workspace: wsMode,
      workspaceDir: workspaceDir || '',
      cwd: cwd || '',
      channels: normalizedChannels,
      // Real host delegation depth (max(header.delegationDepth, subagentDepth))
      // so a cold resume can re-seed `subagentDepth` without re-deriving it.
      delegationDepth:
        Number.isSafeInteger(delegationDepth) && delegationDepth >= 0 ? delegationDepth : 0,
      // The member's OWN preset identity, never the coordinator's.
      agentPreset: typeof agentPreset === 'string' ? agentPreset : '',
      state: 'working',
      killed: false,
      wakeMode: 'mentions',
      waitSince: this.state.head,
      waitFor: [],
      activity: '',
      lastError: '',
      lastReadSeq: 0,
      lastPostSeq: 0,
      lastPostTime: '',
      pendingWakeup: false,
      pendingModelSync: false,
      // 二期：后端与 agy-acp 外部队友字段（DSH 成员为 backend:'dsh' + 零值）。
      ...normalizeAgyMemberFields({
        backend,
        agySessionId,
        agyWorkerName,
        agyMode,
        agyFullAccess,
        agyAccessMode,
      }),
    };
    this.state.members.push(member);
    if (this.state.done && resolvedRole !== 'monitor') {
      this.state.done = false;
      const coord = this.getMember('coordinator');
      if (coord && !coord.killed && coord.state === 'stopped') {
        coord.state = 'working';
      }
    }
    this._persistState();
    return member;
  }

  markMemberKilled(callerName, targetName) {
    this._ensureWriter();
    const target = this.assertPermission(callerName, 'kill', targetName);
    if (target.killed) {
      return { member: target, alreadyKilled: true };
    }
    target.killed = true;
    target.state = 'killed';
    target.activity = '';
    // 契约 3.2：kill 是终态，瞬态阶段必须立刻消失，绝不能残留「生成中」。
    target.agyLive = null;
    target.waitFor = [];
    target.pendingWakeup = false;
    target.pendingModelSync = false;
    this._wakingMembers.delete(target.name);
    this._persistState();
    return { member: target, alreadyKilled: false };
  }

  setMemberModel(
    callerName,
    targetName,
    { provider, model, modelDisplay, reasoningEffort = '' },
    options = {}
  ) {
    this._ensureWriter();
    const target = this.assertPermission(callerName, 'model', targetName);
    const prevDisplay = target.modelDisplay;
    target.provider = provider || '';
    target.model = model || '';
    target.modelDisplay =
      modelDisplay || (provider && model ? `${provider}/${model}` : model || provider || 'default');
    target.reasoningEffort = reasoningEffort || '';
    if (options.pendingModelSync !== undefined) {
      target.pendingModelSync = Boolean(options.pendingModelSync);
    }
    this._persistState();
    return { member: target, previousModelDisplay: prevDisplay };
  }

  /** Backwards-compatible alias for older callers. */
  updateMemberModel(callerName, targetName, patch, options = {}) {
    return this.setMemberModel(callerName, targetName, patch, options);
  }

  clearPendingModelSync(targetName) {
    this._ensureWriter();
    const member = this.getMember(targetName);
    if (!member || !member.pendingModelSync) return false;
    member.pendingModelSync = false;
    this._persistState();
    return true;
  }

  markPendingWakeup(targetName) {
    this._ensureWriter();
    const member = this.getMember(targetName);
    if (!member || member.killed || member.pendingWakeup) return false;
    member.pendingWakeup = true;
    this._persistState();
    return true;
  }

  updateMemberRuntimeState(sessionId, patch) {
    if (!this.lockHeld) {
      // Read-only refresh (never touches writer.lock) so an unlocked instance
      // never short-circuits on a stale in-memory cache after another writer ran.
      this._loadIfPresent();
    }
    const precheck = this.getMemberBySessionId(sessionId);
    if (!precheck || precheck.killed) return null;
    const nextState =
      patch.state && MEMBER_STATES.includes(patch.state) && patch.state !== 'killed'
        ? patch.state
        : precheck.state;
    // 落盘 state.json 与 Typert 推流共用这两条写入通道：脱敏放在存储层兜底，
    // 任何调用方（含第三方扩展）忘记脱敏都不会把凭据写进磁盘。
    const nextActivity =
      patch.activity !== undefined
        ? redactSensitiveText(String(patch.activity || ''), { maxChars: 240 })
        : precheck.activity;
    const nextError =
      patch.lastError !== undefined
        ? redactSensitiveText(String(patch.lastError || ''), { maxChars: 400 })
        : precheck.lastError;
    const nextPendingWakeup =
      patch.pendingWakeup !== undefined
        ? Boolean(patch.pendingWakeup)
        : Boolean(precheck.pendingWakeup);
    const nextPendingModelSync =
      patch.pendingModelSync !== undefined
        ? Boolean(patch.pendingModelSync)
        : Boolean(precheck.pendingModelSync);
    if (
      nextState === precheck.state &&
      nextActivity === precheck.activity &&
      nextError === precheck.lastError &&
      nextPendingWakeup === Boolean(precheck.pendingWakeup) &&
      nextPendingModelSync === Boolean(precheck.pendingModelSync)
    ) {
      return precheck;
    }
    this._ensureWriter();
    const member = this.getMemberBySessionId(sessionId);
    if (!member || member.killed) return null;
    let changed = false;
    if (patch.state && MEMBER_STATES.includes(patch.state) && patch.state !== 'killed') {
      if (member.state !== patch.state) {
        member.state = patch.state;
        changed = true;
      }
    }
    if (patch.activity !== undefined && member.activity !== nextActivity) {
      member.activity = nextActivity;
      changed = true;
    }
    if (patch.lastError !== undefined && member.lastError !== nextError) {
      member.lastError = nextError;
      changed = true;
    }
    if (patch.pendingWakeup !== undefined && Boolean(member.pendingWakeup) !== Boolean(patch.pendingWakeup)) {
      member.pendingWakeup = Boolean(patch.pendingWakeup);
      changed = true;
    }
    if (
      patch.pendingModelSync !== undefined &&
      Boolean(member.pendingModelSync) !== Boolean(patch.pendingModelSync)
    ) {
      member.pendingModelSync = Boolean(patch.pendingModelSync);
      changed = true;
    }
    if (changed) {
      this._persistState();
    }
    return member;
  }

  /**
   * 二期：更新 agy-acp 成员的持久字段（会话续聊 ID、激活代次与熔断计数）。
   * 只接受白名单字段，绝不触碰 state / killed 等生命周期字段。
   */
  updateMemberAgyState(sessionId, patch = {}) {
    if (!this.lockHeld) this._loadIfPresent();
    const precheck = this.getMemberBySessionId(sessionId);
    if (!precheck) return null;
    this._ensureWriter();
    const member = this.getMemberBySessionId(sessionId);
    if (!member) return null;
    let changed = false;
    const assign = (key, value) => {
      if (member[key] !== value) {
        member[key] = value;
        changed = true;
      }
    };
    // 对象字段按 JSON 值比较：onProgress 高频刷新时避免每次都重写 state.json。
    const assignJson = (key, value) => {
      if (JSON.stringify(member[key] ?? null) === JSON.stringify(value ?? null)) return;
      member[key] = value;
      changed = true;
    };
    if (patch.agySessionId !== undefined) {
      assign(
        'agySessionId',
        typeof patch.agySessionId === 'string' && patch.agySessionId ? patch.agySessionId : null
      );
    }
    if (typeof patch.agyWorkerName === 'string') assign('agyWorkerName', patch.agyWorkerName);
    if (patch.agyMode !== undefined && AGY_MODES.includes(patch.agyMode)) {
      assign('agyMode', patch.agyMode);
    }
    if (patch.agyFullAccess !== undefined) assign('agyFullAccess', patch.agyFullAccess === true);
    if (typeof patch.agyAccessMode === 'string') assign('agyAccessMode', patch.agyAccessMode);
    for (const key of ['activationEpoch', 'activationCount', 'consecutivePeerWakes']) {
      if (patch[key] !== undefined) assign(key, nonNegInt(patch[key], member[key] || 0));
    }
    if (patch.circuitBreakNotified !== undefined) {
      assign('circuitBreakNotified', patch.circuitBreakNotified === true);
    }
    // 二期：实时阶段（null 表示空闲）与累计 Token 账单（整体替换为归一化后的 JSON 值）。
    if (patch.agyLive !== undefined && member.backend === 'agy-acp') {
      assignJson('agyLive', normalizeAgyLive(patch.agyLive));
    }
    if (patch.agyUsage !== undefined && member.backend === 'agy-acp') {
      assignJson('agyUsage', normalizeAgyUsage(patch.agyUsage));
    }
    if (changed) this._persistState();
    return member;
  }

  manageChannel(callerName, { channelAction, channel, topic = '', member: targetMemberName }) {
    this._ensureWriter();
    const caller = this.getMember(callerName);
    if (!caller || caller.killed) {
      throw new Error(`调用方 "${callerName}" 不在活跃集群花名册中`);
    }
    const action = String(channelAction || 'list').trim().toLowerCase();

    if (action === 'list') {
      return {
        channels: this.state.channels.map((c) => ({
          name: c.name,
          topic: c.topic,
          archived: c.archived,
          createdBy: c.createdBy,
          subscribers: [...c.subscribers],
        })),
      };
    }

    const chName = normalizeChannelName(channel);
    if (!chName || !CHANNEL_NAME_PATTERN.test(chName)) {
      throw new Error(`频道名称 "${channel ?? ''}" 不合法：须以小写字母开头，仅含小写字母、数字、_ 或 -`);
    }

    if (action === 'create') {
      if (chName === 'main') {
        throw new Error('主频道 #main 默认已存在，无需创建');
      }
      const existing = this._getChannel(chName);
      if (existing) {
        if (existing.archived) {
          if (caller.name !== 'coordinator' && existing.createdBy !== caller.name) {
            throw new Error(
              `权限不足：频道 "#${chName}" 由 "${existing.createdBy || 'coordinator'}" 创建并已归档，仅 coordinator 或原创建者可重新开启`
            );
          }
          existing.archived = false;
          if (topic) existing.topic = String(topic).trim();
          this._persistState();
          return { status: 'reopened', channel: existing };
        }
        throw new Error(`频道 "#${chName}" 已存在`);
      }
      const created = {
        name: chName,
        topic: String(topic || '').trim(),
        archived: false,
        createdBy: caller.name,
        subscribers: [caller.name],
      };
      this.state.channels.push(created);
      if (!caller.channels.includes(chName)) {
        caller.channels.push(chName);
      }
      this._persistState();
      return { status: 'created', channel: created };
    }

    const chObj = this._getChannel(chName);
    if (!chObj) {
      throw new Error(`频道 "#${chName}" 不存在`);
    }

    if (action === 'archive') {
      if (chName === 'main') {
        throw new Error('默认主频道 #main 不可归档');
      }
      if (caller.name !== 'coordinator' && chObj.createdBy !== caller.name) {
        throw new Error(`权限不足：仅 coordinator 或频道创建者 "${chObj.createdBy}" 可归档 "#${chName}"`);
      }
      chObj.archived = true;
      this._persistState();
      return { status: 'archived', channel: chObj };
    }

    const subjectName = targetMemberName ? String(targetMemberName).trim().toLowerCase() : caller.name;
    const subject = this.assertPermission(caller.name, 'channel-member', subjectName);

    if (action === 'subscribe') {
      if (chObj.archived) {
        throw new Error(`频道 "#${chName}" 已归档，无法订阅`);
      }
      if (!subject.channels.includes(chName)) subject.channels.push(chName);
      if (!chObj.subscribers.includes(subject.name)) chObj.subscribers.push(subject.name);
      this._persistState();
      return { status: 'subscribed', channel: chName, member: subject.name };
    }

    if (action === 'unsubscribe') {
      if (chName === 'main') {
        throw new Error('任何成员都不能退订默认主频道 #main');
      }
      subject.channels = subject.channels.filter((c) => c !== chName);
      chObj.subscribers = chObj.subscribers.filter((m) => m !== subject.name);
      this._persistState();
      return { status: 'unsubscribed', channel: chName, member: subject.name };
    }

    throw new Error(`未知的频道动作 "${action}"（支持 create / subscribe / unsubscribe / list / archive）`);
  }

  postMessage(authorName, text, options = {}) {
    this._ensureWriter();
    const author = this.getMember(authorName);
    if (!author || author.killed) {
      throw new Error(`发帖方 "${authorName}" 不在活跃集群花名册中`);
    }
    const body = String(text ?? '').trim();
    if (!body) {
      throw new Error('post_message 的消息内容不能为空');
    }

    const channelName = options.channel ? normalizeChannelName(options.channel) : 'main';
    const chObj = this._getChannel(channelName);
    if (!chObj) {
      throw new Error(`目标频道 "#${channelName}" 不存在（请先用 swarm{action:"channel", channel_action:"create"} 创建）`);
    }
    if (chObj.archived) {
      throw new Error(`目标频道 "#${channelName}" 已归档，禁止继续发帖`);
    }

    const doorbells = parseMessageDoorbells(body, this._membersMap(), this._channelsMap());
    const nowMs = Date.now();
    const seq = this.state.head + 1;
    const message = {
      seq,
      channel: channelName,
      agent: author.name,
      text: body,
      mentions: doorbells.mentions,
      channelMentions: doorbells.channelMentions,
      broadcast: doorbells.broadcast,
      time: formatTime(nowMs),
      timestampMs: nowMs,
    };

    const markedDone = isDonePost(author.name, channelName, body);

    // Durability first: append the record, and only then mutate in-memory state.
    // A failed append leaves memory unchanged, so no ghost message can exist.
    this._appendMessageRecord(message);

    this.state.head = seq;
    this.messages.push(message);
    author.lastPostSeq = seq;
    author.lastPostTime = message.time;
    if (author.lastReadSeq === seq - 1) {
      author.lastReadSeq = seq;
    }
    if (markedDone) {
      this.state.done = true;
      author.waitSince = seq;
      author.lastReadSeq = seq;
      author.state = 'stopped';
      author.activity = '';
      author.waitFor = [];
      for (const m of this.state.members) {
        if (m.pendingWakeup) m.pendingWakeup = false;
        if (Array.isArray(m.waitFor) && m.waitFor.length > 0) m.waitFor = [];
      }
      this._persistState();
      return {
        message,
        head: seq,
        markedDone: true,
        wakeTargets: [],
        pendingTargets: [],
      };
    }

    const { wakeTargets, pendingTargets } = this._computeWakeOutcome(message);
    this._persistState();

    return {
      message,
      head: seq,
      markedDone,
      wakeTargets,
      pendingTargets,
    };
  }

  doesMessageTriggerMember(member, message, mentionsOnly = member.wakeMode !== 'all') {
    if (!member || member.killed) return false;
    if (message.agent === member.name) return false;

    const directHit = message.mentions.includes(member.name);
    const channelDoorbellHit = message.channelMentions.some((ch) => member.channels.includes(ch));
    const broadcastHit = message.broadcast && !isMonitorRoleOrName(member.name, member.role);

    if (mentionsOnly) {
      return directHit || channelDoorbellHit || broadcastHit;
    }
    return directHit || channelDoorbellHit || broadcastHit || this.isChannelVisibleToMember(member, message.channel);
  }

  /**
   * Split doorbell hits into immediately woken members and members that are
   * busy (working or mid-delivery): the latter get a durable pendingWakeup flag
   * so the bell is never lost when their current turn ends.
   */
  _resolveWaitForTargets(caller, rawWaitFor) {
    if (rawWaitFor === undefined || rawWaitFor === null) return [];
    if (!Array.isArray(rawWaitFor)) {
      throw new Error('swarm_wait 的 wait_for 必须是成员名称字符串数组');
    }
    const resolved = new Set();
    for (const rawItem of rawWaitFor) {
      const cleaned = String(rawItem ?? '')
        .trim()
        .replace(/^@+/, '')
        .toLowerCase();
      if (!cleaned) continue;
      if (cleaned === caller.name) {
        throw new Error(`swarm_wait 的 wait_for 不能包含调用方自身 ("${caller.name}")`);
      }
      const exact = this.getMember(cleaned);
      if (exact) {
        resolved.add(exact.name);
        continue;
      }
      const groupPattern = new RegExp(`^${escapeRegExp(cleaned)}-\\d+$`);
      let matchedGroup = false;
      for (const m of this.state.members) {
        if (m.name !== caller.name && groupPattern.test(m.name)) {
          resolved.add(m.name);
          matchedGroup = true;
        }
      }
      if (!matchedGroup) {
        throw new Error(`swarm_wait 的 wait_for 包含不存在的成员或组前缀 "${String(rawItem)}"`);
      }
    }
    return [...resolved];
  }

  _evaluateWaitBarrier(caller, since, waitTargets, mentionsOnly = caller?.wakeMode !== 'all') {
    if (!Array.isArray(waitTargets) || waitTargets.length === 0) {
      return { active: false, settled: true, stalled: false, missing: [], stalledMembers: [] };
    }
    const strictMentions = mentionsOnly !== false;
    const missing = [];
    for (const targetName of waitTargets) {
      const m = this.getMember(targetName);
      const canonicalName = m ? m.name : targetName;
      // In mentionsOnly mode, a peer satisfies the barrier only when it
      // actually rings the caller's doorbell (an intermediate @other-peer
      // handoff does NOT count as reporting to this waiter). A killed peer
      // that never reported is still missing so it triggers stalled wakeup.
      const reported = this.messages.some(
        (msg) =>
          msg.seq > since &&
          msg.agent === canonicalName &&
          (strictMentions
            ? this.doesMessageTriggerMember(caller, msg, true)
            : this.isMessageVisibleToMember(caller, msg))
      );
      if (!reported) {
        missing.push(canonicalName);
      }
    }
    if (missing.length === 0) {
      return { active: true, settled: true, stalled: false, missing: [], stalledMembers: [] };
    }
    // Only STILL-MISSING targets can produce future reports; peers that already
    // reported (e.g. the author currently inside post_message before swarm_wait)
    // must not hold the barrier open for a dead/stopped missing peer.
    const anyActive = missing.some((targetName) => {
      const m = this.getMember(targetName);
      if (!m || m.killed || m.state === 'stopped') return false;
      return Boolean(
        m.state === 'working' ||
          this._wakingMembers.has(m.name) ||
          (m.state === 'waiting' && m.pendingWakeup)
      );
    });
    if (!anyActive) {
      return {
        active: true,
        settled: true,
        stalled: true,
        missing,
        stalledMembers: [...missing],
      };
    }
    return { active: true, settled: false, stalled: false, missing, stalledMembers: [] };
  }

  _computeWakeOutcome(message) {
    const wakeTargets = [];
    const pendingTargets = [];
    for (const member of this.state.members) {
      if (member.killed || member.name === message.agent) continue;
      const mentionsOnly = member.wakeMode !== 'all';
      const hasBarrier = Array.isArray(member.waitFor) && member.waitFor.length > 0;
      const cursor = Math.max(member.lastReadSeq || 0, member.waitSince || 0);
      const triggeredNow = this.doesMessageTriggerMember(member, message, mentionsOnly);
      if (!hasBarrier && !triggeredNow) continue;
      if (hasBarrier) {
        const barrierFloor = Number.isSafeInteger(member.waitSince) ? member.waitSince : cursor;
        const barrier = this._evaluateWaitBarrier(member, barrierFloor, member.waitFor, mentionsOnly);
        if (!barrier.settled) continue;
      }
      const busy = member.state === 'working' || this._wakingMembers.has(member.name);
      if (busy) {
        if (!member.pendingWakeup) member.pendingWakeup = true;
        pendingTargets.push(member);
      } else {
        wakeTargets.push(member);
      }
    }
    return { wakeTargets, pendingTargets };
  }

  /**
   * Single visibility rule shared by collectVisibleMessagesSince, readBoard and
   * prepareWait: main is public, a subscribed channel is visible, and a direct
   * @name / @#channel / @all doorbell reaches a member even outside its own
   * channels (that is attention routing, not confidentiality).
   */
  isMessageVisibleToMember(memberNameOrObj, msg) {
    if (!msg || typeof msg !== 'object') return false;
    const member =
      typeof memberNameOrObj === 'string' ? this.getMember(memberNameOrObj) : memberNameOrObj;
    const channel = msg.channel || 'main';
    if (channel === 'main') return true;
    if (!member) return false;
    if (this.isChannelVisibleToMember(member, channel)) return true;
    if (Array.isArray(msg.mentions) && msg.mentions.includes(member.name)) return true;
    if (
      Array.isArray(msg.channelMentions) &&
      msg.channelMentions.some(
        (ch) => Array.isArray(member.channels) && member.channels.includes(ch)
      )
    ) {
      return true;
    }
    return msg.broadcast === true;
  }

  collectVisibleMessagesSince(member, since) {
    const floor = Number.isSafeInteger(since) && since >= 0 ? since : 0;
    return this.messages.filter(
      (msg) => msg.seq > floor && this.isMessageVisibleToMember(member, msg)
    );
  }

  prepareWait(callerName, { since, mentionsOnly = true, waitFor } = {}) {
    this._ensureWriter();
    const caller = this.getMember(callerName);
    if (!caller || caller.killed) {
      throw new Error(`调用方 "${callerName}" 不在活跃集群花名册中`);
    }
    if (!Number.isSafeInteger(since) || since < 0) {
      throw new Error(`swarm_wait 的 since 必须是非负整数（上次实际已读的最大 #seq），收到：${String(since)}`);
    }

    const waitTargets = this._resolveWaitForTargets(caller, waitFor);
    const strictMentions = mentionsOnly !== false;
    const hasTrigger = this.messages.some(
      (msg) =>
        msg.seq > since &&
        (strictMentions
          ? this.doesMessageTriggerMember(caller, msg, true)
          : this.isMessageVisibleToMember(caller, msg))
    );
    const barrier = this._evaluateWaitBarrier(caller, since, waitTargets, strictMentions);
    const shouldWakeNow = barrier.active
      ? barrier.settled && (hasTrigger || barrier.stalled)
      : hasTrigger;

    if (shouldWakeNow) {
      const unread = this.collectVisibleMessagesSince(caller, since);
      const maxSeq = unread.length > 0 ? unread[unread.length - 1].seq : this.state.head;
      if (maxSeq > caller.lastReadSeq) {
        caller.lastReadSeq = maxSeq;
      }
      caller.state = 'working';
      caller.waitFor = [];
      caller.pendingWakeup = false;
      this._persistState();
      return {
        action: 'immediate',
        messages: unread.map(this._publicMessage),
        head: this.state.head,
        ...(barrier.stalled ? { stalled_members: barrier.stalledMembers } : {}),
      };
    }

    caller.state = 'waiting';
    caller.wakeMode = strictMentions ? 'mentions' : 'all';
    caller.waitSince = since;
    caller.waitFor = waitTargets;
    caller.pendingWakeup = false;
    caller.activity = '';
    if (since > caller.lastReadSeq) {
      caller.lastReadSeq = since;
    }
    this._persistState();
    return {
      action: 'park',
      since,
      wakeMode: caller.wakeMode,
      waitFor: waitTargets,
      head: this.state.head,
    };
  }

  /**
   * Phase 1 of a wake delivery: peek the visible batch from the member cursor
   * WITHOUT advancing it. A re-entrant wake for the same member is refused so two
   * deliveries cannot interleave. An empty batch clears the pending flag and
   * returns null without touching state or cursors (unless a wait_for barrier
   * stalled with all targets stopped).
   */
  beginWakeDelivery(memberName) {
    this._ensureWriter();
    const member = this.getMember(memberName);
    if (!member || member.killed || this.state.done) return null;
    if (this._wakingMembers.has(member.name)) return null;
    const cursor = Math.max(
      Number.isSafeInteger(member.lastReadSeq) ? member.lastReadSeq : 0,
      Number.isSafeInteger(member.waitSince) ? member.waitSince : 0
    );
    const mentionsOnly = member.wakeMode !== 'all';
    const waitTargets = Array.isArray(member.waitFor) ? member.waitFor : [];
    const barrierFloor = Number.isSafeInteger(member.waitSince) ? member.waitSince : cursor;
    const barrier = this._evaluateWaitBarrier(member, barrierFloor, waitTargets, mentionsOnly);
    if (barrier.active && !barrier.settled) {
      return null;
    }
    const hasTriggerSinceCursor =
      barrier.stalled ||
      this.messages.some((msg) =>
        msg.seq > cursor &&
        (mentionsOnly
          ? this.doesMessageTriggerMember(member, msg, true)
          : this.isMessageVisibleToMember(member, msg))
      );
    const batch = this.collectVisibleMessagesSince(member, cursor);
    if (!hasTriggerSinceCursor || (batch.length === 0 && !barrier.stalled)) {
      if (member.pendingWakeup) {
        member.pendingWakeup = false;
        this._persistState();
      }
      return null;
    }
    this._wakingMembers.add(member.name);
    member.state = 'working';
    member.wakeMode = 'mentions';
    member.activity = '';
    this._persistState();
    return {
      batch: batch.map((m) => this._publicMessage(m)),
      maxSeq: batch.length > 0 ? batch[batch.length - 1].seq : cursor,
      ...(barrier.stalled ? { stalledMembers: barrier.stalledMembers } : {}),
    };
  }

  /**
   * Phase 2 (success): the prompt was accepted into the member inbox, so the
   * cursor may advance. A newer doorbell that arrived meanwhile keeps the
   * pending flag set for a follow-up wake.
   */
  ackWakeDelivery(memberName, maxSeq) {
    this._ensureWriter();
    const member = this.getMember(memberName);
    this._wakingMembers.delete(memberName);
    if (!member) return null;
    const target = Number.isSafeInteger(maxSeq) && maxSeq > 0 ? maxSeq : 0;
    if (target > (member.lastReadSeq || 0)) member.lastReadSeq = target;
    if (target > (member.waitSince || 0)) member.waitSince = target;
    member.waitFor = [];
    const effectiveCursor = Math.max(target, member.lastReadSeq || 0, member.waitSince || 0);
    const hasNewer =
      !this.state.done &&
      this.messages.some(
        (msg) =>
          msg.seq > effectiveCursor &&
          this.doesMessageTriggerMember(member, msg, member.wakeMode !== 'all')
      );
    member.pendingWakeup = hasNewer;
    this._persistState();
    return { member, pendingWakeup: hasNewer };
  }

  /**
   * Phase 2 (failure): keep the cursors untouched and the pending flag set, so
   * the same batch is retried on the next successful delivery.
   */
  failWakeDelivery(memberName, errMsg, fallbackState = 'stopped') {
    this._ensureWriter();
    const member = this.getMember(memberName);
    this._wakingMembers.delete(memberName);
    if (!member) return null;
    member.pendingWakeup = true;
    // A kill that landed during the delivery window is terminal: a failed wake
    // must never resurrect a killed member as 'stopped'.
    if (!member.killed && MEMBER_STATES.includes(fallbackState) && fallbackState !== 'killed') {
      member.state = fallbackState;
    }
    member.activity = '';
    if (errMsg !== undefined) member.lastError = String(errMsg || '');
    this._persistState();
    return member;
  }

  /** Whether a member still has an unread doorbell past its cursor. */
  hasUnreadDoorbell(memberNameOrObj) {
    if (this.state.done) return false;
    const member =
      typeof memberNameOrObj === 'string' ? this.getMember(memberNameOrObj) : memberNameOrObj;
    if (!member || member.killed) return false;
    const cursor = Math.max(member.lastReadSeq || 0, member.waitSince || 0);
    const mentionsOnly = member.wakeMode !== 'all';
    const waitTargets = Array.isArray(member.waitFor) ? member.waitFor : [];
    if (waitTargets.length > 0) {
      const barrierFloor = Number.isSafeInteger(member.waitSince) ? member.waitSince : cursor;
      const barrier = this._evaluateWaitBarrier(member, barrierFloor, waitTargets, mentionsOnly);
      if (!barrier.settled) return false;
      if (barrier.stalled) return true;
    }
    return this.messages.some(
      (msg) =>
        msg.seq > cursor &&
        this.doesMessageTriggerMember(member, msg, member.wakeMode !== 'all')
    );
  }

  /**
   * Find parked members whose `wait_for` barrier has just become settled (or
   * stalled because every target stopped without posting).
   */
  collectUnblockedWaiters() {
    if (this.state.done) return [];
    const waiters = [];
    for (const m of this.state.members) {
      if (m.killed || m.state !== 'waiting' || this._wakingMembers.has(m.name)) continue;
      if (!Array.isArray(m.waitFor) || m.waitFor.length === 0) continue;
      if (this.hasUnreadDoorbell(m)) {
        waiters.push(m);
      }
    }
    return waiters;
  }

  _publicMessage(msg) {
    return {
      seq: msg.seq,
      channel: msg.channel,
      agent: msg.agent,
      text: msg.text,
      mentions: [...(msg.mentions || [])],
      channelMentions: [...(msg.channelMentions || [])],
      broadcast: Boolean(msg.broadcast),
      time: msg.time,
    };
  }

  readBoard(callerName, { since, limit = 20, seqs, channel, status = false } = {}) {
    this._ensureWriter();
    const caller = this.getMember(callerName);
    const effectiveLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 20;

    if (status === true) {
      return {
        head: this.state.head,
        title: this.state.title,
        done: Boolean(this.state.done),
        channels: this.state.channels.map((c) => ({
          name: c.name,
          topic: c.topic,
          archived: c.archived,
          subscribers: [...c.subscribers],
        })),
        members: this.state.members.map((m) => ({
          name: m.name,
          role: m.role,
          added_by: m.addedBy,
          model: m.modelDisplay,
          workspace: m.workspace,
          channels: [...m.channels],
          state: m.killed ? 'killed' : m.state,
          wake_mode: m.wakeMode || 'mentions',
          wait_since: m.waitSince ?? 0,
          ...(Array.isArray(m.waitFor) && m.waitFor.length > 0 ? { wait_for: [...m.waitFor] } : {}),
          last_read_seq: m.lastReadSeq ?? 0,
          last_post_seq: m.lastPostSeq ?? 0,
          last_post_time: m.lastPostTime || '',
          pending_wakeup: Boolean(m.pendingWakeup),
          pending_model_sync: Boolean(m.pendingModelSync),
          ...(m.backend === 'agy-acp'
            ? {
                backend: 'agy-acp',
                agy_mode: m.agyMode || 'plan',
                activation_count: m.activationCount || 0,
                ...(normalizeAgyLive(m.agyLive) ? { agy_live: normalizeAgyLive(m.agyLive) } : {}),
                ...(normalizeAgyUsage(m.agyUsage) ? { agy_usage: normalizeAgyUsage(m.agyUsage) } : {}),
              }
            : {}),
          ...(m.activity ? { activity: m.activity } : {}),
          ...(m.lastError ? { last_error: m.lastError } : {}),
        })),
      };
    }

    if (Array.isArray(seqs)) {
      const wanted = new Set(seqs.filter((n) => Number.isSafeInteger(n) && n > 0));
      const picked = this.messages
        .filter((m) => wanted.has(m.seq))
        .map((m) => this._publicMessage(m));
      if (caller && picked.length > 0) {
        const maxSeq = picked[picked.length - 1].seq;
        let dirty = false;
        if (maxSeq > caller.lastReadSeq) {
          caller.lastReadSeq = maxSeq;
          dirty = true;
        }
        if (caller.pendingWakeup && !this.hasUnreadDoorbell(caller)) {
          caller.pendingWakeup = false;
          dirty = true;
        }
        if (dirty) this._persistState();
      }
      return {
        messages: picked,
        head: this.state.head,
      };
    }

    const filterChannel = channel ? normalizeChannelName(channel) : null;
    if (filterChannel && !this._getChannel(filterChannel)) {
      throw new Error(`频道 "#${filterChannel}" 不存在`);
    }

    const filtered = this.messages.filter((msg) => {
      if (filterChannel) return msg.channel === filterChannel;
      if (!caller) return msg.channel === 'main';
      return this.isMessageVisibleToMember(caller, msg);
    });

    let slice;
    let hasMore = false;
    if (since !== undefined && since !== null) {
      if (!Number.isSafeInteger(since) || since < 0) {
        throw new Error(`read_board 的 since 必须是非负整数，收到：${String(since)}`);
      }
      const after = filtered.filter((m) => m.seq > since);
      hasMore = after.length > effectiveLimit;
      slice = after.slice(0, effectiveLimit);
    } else {
      slice = filtered.slice(-effectiveLimit);
    }

    if (caller) {
      const maxRead =
        slice.length > 0
          ? slice[slice.length - 1].seq
          : since !== undefined && since === this.state.head
            ? this.state.head
            : caller.lastReadSeq;
      let dirty = false;
      if (maxRead > caller.lastReadSeq) {
        caller.lastReadSeq = maxRead;
        dirty = true;
      }
      if (caller.pendingWakeup && !this.hasUnreadDoorbell(caller)) {
        caller.pendingWakeup = false;
        dirty = true;
      }
      if (dirty) this._persistState();
    }

    return {
      messages: slice.map((m) => this._publicMessage(m)),
      head: this.state.head,
      ...(hasMore ? { has_more: true } : {}),
    };
  }

  toSnapshot(resolvedFromMember = null) {
    if (!this.hasSwarm()) {
      return createEmptySnapshot(this.coordinatorSessionId, {
        resolvedFromMember,
      });
    }
    return normalizeSwarmSnapshot({
      hasSwarm: true,
      done: Boolean(this.state.done),
      coordinatorSessionId: this.coordinatorSessionId,
      resolvedFromMember,
      title: this.state.title || 'Swarm 协作集群',
      head: this.state.head,
      updatedAt: this.state.updatedAt,
      channels: this.state.channels,
      members: this.state.members,
      messages: this.messages.map((m) => this._publicMessage(m)),
    });
  }
}

class SwarmStoreManager {
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(os.homedir(), '.dsh', 'swarm');
    this.stores = new Map();
    this.memberIndex = new Map();
    this.globalListeners = new Set();
    this._scanExistingStores();
  }

  _scanExistingStores() {
    if (!fs.existsSync(this.baseDir)) return;
    let entries;
    try {
      entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateFile = path.join(this.baseDir, entry.name, 'state.json');
      if (!fs.existsSync(stateFile)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const coordId = raw?.coordinatorSessionId;
        if (!coordId || typeof coordId !== 'string') continue;
        this._indexMembersFromRawState(coordId, raw.members);
      } catch {
        // Ignore unreadable directories
      }
    }
  }

  _indexMembersFromRawState(coordinatorSessionId, members) {
    this.memberIndex.set(coordinatorSessionId, {
      coordinatorSessionId,
      memberName: 'coordinator',
    });
    if (!Array.isArray(members)) return;
    for (const m of members) {
      if (m && typeof m.sessionId === 'string' && m.sessionId) {
        this.memberIndex.set(m.sessionId, {
          coordinatorSessionId,
          memberName: m.name || 'worker',
        });
      }
    }
  }

  _bindStore(store) {
    this._indexMembersFromRawState(store.coordinatorSessionId, store.state.members);
    store.subscribe(() => {
      this._indexMembersFromRawState(store.coordinatorSessionId, store.state.members);
      for (const fn of [...this.globalListeners]) {
        try {
          fn(store.coordinatorSessionId, store);
        } catch {
          // ignore
        }
      }
    });
    return store;
  }

  subscribeAll(listener) {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  resolveSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    if (this.stores.has(sessionId)) {
      return {
        store: this.stores.get(sessionId),
        coordinatorSessionId: sessionId,
        memberName: 'coordinator',
      };
    }
    const indexed = this.memberIndex.get(sessionId);
    if (indexed) {
      const store = this.getOrLoadStore(indexed.coordinatorSessionId);
      if (store) {
        return {
          store,
          coordinatorSessionId: indexed.coordinatorSessionId,
          memberName: indexed.memberName,
        };
      }
    }
    const candidateState = path.join(this.baseDir, sanitizeDirSegment(sessionId), 'state.json');
    if (fs.existsSync(candidateState)) {
      const store = this.getOrCreateStore(sessionId);
      return {
        store,
        coordinatorSessionId: sessionId,
        memberName: 'coordinator',
      };
    }
    return null;
  }

  getOrLoadStore(coordinatorSessionId) {
    if (this.stores.has(coordinatorSessionId)) {
      return this.stores.get(coordinatorSessionId);
    }
    const stateFile = path.join(this.baseDir, sanitizeDirSegment(coordinatorSessionId), 'state.json');
    if (!fs.existsSync(stateFile)) return null;
    return this.getOrCreateStore(coordinatorSessionId);
  }

  getOrCreateStore(coordinatorSessionId) {
    let store = this.stores.get(coordinatorSessionId);
    if (!store) {
      store = new BoardStore(coordinatorSessionId, { baseDir: this.baseDir });
      this.stores.set(coordinatorSessionId, store);
      this._bindStore(store);
    }
    return store;
  }

  getSnapshotForSession(sessionId) {
    const resolved = this.resolveSession(sessionId);
    if (!resolved) {
      return createEmptySnapshot(sessionId);
    }
    const resolvedFromMember =
      resolved.memberName && resolved.memberName !== 'coordinator' ? resolved.memberName : null;
    return resolved.store.toSnapshot(resolvedFromMember);
  }

  /** Close one store and release its writer lock. */
  closeStore(coordinatorSessionId) {
    const store = this.stores.get(coordinatorSessionId);
    if (!store) return false;
    this.stores.delete(coordinatorSessionId);
    try {
      store.close();
    } catch {
      // teardown is best effort
    }
    return true;
  }

  /** Close every managed store (plugin teardown). */
  dispose() {
    for (const sessionId of [...this.stores.keys()]) {
      this.closeStore(sessionId);
    }
    this.globalListeners.clear();
    this.memberIndex.clear();
  }
}

module.exports = {
  RESERVED_NAMES,
  MEMBER_NAME_PATTERN,
  CHANNEL_NAME_PATTERN,
  sanitizeDirSegment,
  atomicWriteJsonSync,
  validateMemberBaseName,
  expandAddSpecs,
  stripCodeForDoorbells,
  parseMessageDoorbells,
  isMonitorRoleOrName,
  isDonePost,
  MEMBER_BACKENDS,
  AGY_MODES,
  normalizeAgyMemberFields,
  BoardStore,
  SwarmStoreManager,
};
