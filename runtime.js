'use strict';

/**
 * 宿主依赖加载器（零依赖兜底）。
 *
 * DSH 桌面版把 @deepseek-ai/schemastery 之类运行时依赖放在 app.asar 内，
 * 桌面插件目录之外 require 解析不到。这里按可选扩展 dsh-agy-acp 的
 * `runtime.js` 思路，用宿主入口作为解析锚点；插件自己绝不硬依赖该包：
 *
 *   1) DSH_SWARM_HOST_MODULES 指向的目录（离线单测用）；
 *   2) require.main.filename（宿主主进程入口）；
 *   3) process.argv[1]；
 *   4) 插件自身目录（宿主把依赖提升到 profile 时的兜底）。
 *
 * 与 agy-acp 不同的是：这里找不到时返回 null，由调用方切到手写的
 * Standard Schema 兜底，保证插件在纯 Node 离线单测里也能正常挂载。
 */

const path = require('node:path');
const { createRequire } = require('node:module');

const HOST_MODULES_ENV = 'DSH_SWARM_HOST_MODULES';

function hostAnchors() {
  const anchors = [];
  const root = process.env[HOST_MODULES_ENV];
  if (typeof root === 'string' && root.trim()) {
    anchors.push(path.join(root.trim(), 'anchor.cjs'));
  }
  try {
    const main = require.main && require.main.filename;
    if (typeof main === 'string' && main) anchors.push(main);
  } catch {
    // ignore
  }
  if (typeof process.argv[1] === 'string' && process.argv[1]) anchors.push(process.argv[1]);
  anchors.push(path.join(__dirname, 'index.js'));
  return [...new Set(anchors)];
}

/** 从宿主锚点解析模块入口，全部失败返回 null（绝不抛错）。 */
function resolveHostModule(specifier) {
  for (const anchor of hostAnchors()) {
    try {
      return createRequire(anchor).resolve(specifier);
    } catch {
      // try next anchor
    }
  }
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

let schemasteryModule;
let schemasteryResolved = false;

/**
 * 惰性加载 @deepseek-ai/schemastery（CJS 入口）。
 * 解析或加载失败一律返回 null：Config 会退到手写 Standard Schema。
 */
function loadSchemastery() {
  if (schemasteryResolved) return schemasteryModule;
  const entry = resolveHostModule('@deepseek-ai/schemastery');
  if (!entry) {
    schemasteryResolved = true;
    schemasteryModule = null;
    return null;
  }
  let loaded;
  try {
    loaded = require(entry);
  } catch {
    schemasteryResolved = true;
    schemasteryModule = null;
    return null;
  }
  const z = loaded && typeof loaded.object === 'function' ? loaded : loaded?.default;
  schemasteryModule = z && typeof z.object === 'function' ? z : null;
  schemasteryResolved = true;
  return schemasteryModule;
}

/** 测试用：清空缓存，便于验证不同的加载结果。 */
function resetHostModuleCache() {
  schemasteryModule = undefined;
  schemasteryResolved = false;
}

module.exports = {
  HOST_MODULES_ENV,
  hostAnchors,
  resolveHostModule,
  loadSchemastery,
  resetHostModuleCache,
};
