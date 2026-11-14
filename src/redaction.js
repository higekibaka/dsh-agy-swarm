'use strict';

/**
 * dsh-agy-swarm — 全链路敏感信息脱敏工具。
 *
 * 留言板快照、成员 `lastError`、`activity` 实时摘要与 MCP 桥的错误回包都会
 * 进入侧栏面板、事件流甚至下一次模型上下文，因此统一在写入口做一次脱敏：
 * 凭据 / Token / 授权头 / 个人主目录路径一律不外泄。
 */

const DEFAULT_MAX_CHARS = 240;

const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const PREFIX_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{16,}|ya29\.[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const CLI_FLAG_RE = /(--(?:token|access-token|refresh-token|api-key|apikey|secret|password|auth-token|auth-file|cookie)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi;
const KV_SECRET_RE = /(["']?(?:token|access_token|refresh_token|api_key|apiKey|secret|client_secret|password|authorization|cookie|auth_token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;})\]]+)/gi;
const URL_AUTH_RE = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const WIN_USER_RE = /[A-Za-z]:\\Users\\[^\\\s"']+/g;
const WIN_USER_SLASH_RE = /[A-Za-z]:\/Users\/[^\/\s"']+/g;
const MAC_USER_RE = /\/Users\/[^\/\s"']+/g;
const LINUX_USER_RE = /\/home\/[^\/\s"']+/g;

/**
 * 对任意可能被展示/推流/写入磁盘的文本做脱敏并限长。
 *
 * @param {unknown} input 原始文本（非字符串会被安全 String() 化）
 * @param {{ maxChars?: number }} [options] `maxChars` 为输出上限（默认 240）
 * @returns {string}
 */
function redactSensitiveText(input, options = {}) {
  if (input === null || input === undefined) return '';
  let text = typeof input === 'string' ? input : String(input);
  if (!text) return '';

  text = text
    .replace(URL_AUTH_RE, '$1<redacted>@')
    .replace(BEARER_RE, '$1 [REDACTED]')
    .replace(PREFIX_TOKEN_RE, '[REDACTED]')
    .replace(CLI_FLAG_RE, '$1[REDACTED]')
    .replace(KV_SECRET_RE, '$1[REDACTED]')
    .replace(WIN_USER_RE, '~')
    .replace(WIN_USER_SLASH_RE, '~')
    .replace(MAC_USER_RE, '~')
    .replace(LINUX_USER_RE, '~');

  const maxChars =
    Number.isSafeInteger(options.maxChars) && options.maxChars > 0
      ? options.maxChars
      : DEFAULT_MAX_CHARS;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 1) + '…';
  }
  return text;
}

module.exports = {
  DEFAULT_MAX_CHARS,
  redactSensitiveText,
};
