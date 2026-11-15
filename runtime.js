'use strict';

/**
 * 宿主依赖加载器（零依赖兜底）。
 *
 * DSH 桌面版把 @deepseek-ai/* 运行时依赖打进 app.asar，插件目录之外 require
 * 解析不到；CLI / 便携包布局又各不相同。这里用「宿主入口」当解析锚点，
 * 而不是硬编码任何安装路径：
 *
 *   1) DSH_SWARM_HOST_MODULES 指向的目录（离线单测注入用）；
 *   2) require.main / process.mainModule（宿主主进程入口）及其祖先目录；
 *   3) process.argv[1] 及其祖先目录；
 *   4) <resourcesPath>/app.asar/{dsh,lib} —— Electron 桌面版的真实依赖树
 *      （@deepseek-ai/* 全部在 app.asar/dsh/node_modules 下）；
 *   5) 插件自身目录（宿主把依赖提升到 profile 时的兜底）。
 *
 * 解析失败一律返回 null，由调用方切到手写兜底实现：纯 Node 离线单测因此
 * 零依赖也能完整跑通，且这条路径绝不抛错。
 */

const path = require('node:path');
const { createRequire } = require('node:module');

const HOST_MODULES_ENV = 'DSH_SWARM_HOST_MODULES';

/** 把某个入口文件所在目录（及其若干层祖先）加成锚点，覆盖各种宿主布局。 */
function ancestorAnchors(entry, depth = 6) {
  const anchors = [];
  if (typeof entry !== 'string' || !entry) return anchors;
  let dir;
  try {
    dir = path.dirname(path.resolve(entry));
  } catch {
    return anchors;
  }
  for (let i = 0; i < depth && dir; i += 1) {
    anchors.push(path.join(dir, 'package.json'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return anchors;
}

/** Electron 桌面版：app.asar 内部的依赖树锚点（非 Electron 返回空）。 */
function electronAnchors() {
  const roots = [];
  const resources = process.resourcesPath;
  if (typeof resources === 'string' && resources) {
    try {
      roots.push(path.resolve(resources));
    } catch {
      // ignore
    }
  }
  const anchors = [];
  for (const root of roots) {
    // dsh/ 是 @deepseek-ai/dsh-desktop-runtime，其 node_modules 才是完整依赖树；
    // 根目录的 node_modules 只有桌面壳自己用到的一小部分包。
    anchors.push(path.join(root, 'app.asar', 'dsh', 'package.json'));
    anchors.push(path.join(root, 'app.asar', 'package.json'));
    anchors.push(path.join(root, 'app.asar', 'lib', 'main.js'));
    anchors.push(path.join(root, 'app', 'package.json'));
    anchors.push(path.join(root, 'package.json'));
  }
  return anchors;
}

function hostAnchors() {
  const anchors = [];
  const root = process.env[HOST_MODULES_ENV];
  if (typeof root === 'string' && root.trim()) {
    anchors.push(path.join(root.trim(), 'anchor.cjs'));
  }
  const mainModule = (() => {
    try {
      return require.main && require.main.filename;
    } catch {
      return null;
    }
  })();
  const main = typeof mainModule === 'string' && mainModule ? mainModule : process.mainModule && process.mainModule.filename;
  if (typeof main === 'string' && main) anchors.push(...ancestorAnchors(main), main);
  if (typeof process.argv[1] === 'string' && process.argv[1]) {
    anchors.push(...ancestorAnchors(process.argv[1]), process.argv[1]);
  }
  anchors.push(...electronAnchors());
  anchors.push(path.join(__dirname, 'index.js'));
  return [...new Set(anchors)];
}

/** 从宿主锚点解析模块入口，全部失败返回 null（绝不抛错）。 */
function resolveHostModule(specifier) {
  if (typeof specifier !== 'string' || !specifier) return null;
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

/** specifier -> module | null 的加载结果缓存（含失败结果，避免重复解析）。 */
const hostModuleCache = new Map();

function loadHostModule(specifier) {
  // 1) 普通 require：宿主把依赖提升到 profile / 与插件同层时的最快路径。
  try {
    return require(specifier);
  } catch {
    // 落到宿主入口锚点
  }
  // 2) 按宿主 app.asar 入口解析，再以入口路径加载。
  const entry = resolveHostModule(specifier);
  if (!entry) return null;
  try {
    return require(entry);
  } catch {
    // ERR_REQUIRE_ESM（旧版 Node 的纯 ESM 宿主模块）、asar 读失败、包自检失败
    // 等一律视为不可用：调用方会自动退回手写兜底实现，绝不因此崩溃。
    return null;
  }
}

/**
 * 惰性加载宿主模块：先普通 require，失败再走 app.asar 锚点。
 * 解析或加载失败返回 null，调用方据此退回零依赖兜底。
 */
function requireHostModule(specifier) {
  if (typeof specifier !== 'string' || !specifier) return null;
  if (hostModuleCache.has(specifier)) return hostModuleCache.get(specifier);
  const loaded = loadHostModule(specifier);
  hostModuleCache.set(specifier, loaded);
  return loaded;
}

let schemasteryModule;
let schemasteryResolved = false;

/**
 * 惰性加载 @deepseek-ai/schemastery（CJS 入口）。
 * 解析或加载失败一律返回 null：Config 会退到手写 Standard Schema。
 */
function loadSchemastery() {
  if (schemasteryResolved) return schemasteryModule;
  const loaded = requireHostModule('@deepseek-ai/schemastery');
  const z = loaded && typeof loaded.object === 'function' ? loaded : loaded?.default;
  schemasteryModule = z && typeof z.object === 'function' ? z : null;
  schemasteryResolved = true;
  return schemasteryModule;
}

/** 测试用：清空缓存，便于验证不同的加载结果。 */
function resetHostModuleCache() {
  schemasteryModule = undefined;
  schemasteryResolved = false;
  hostModuleCache.clear();
}

module.exports = {
  HOST_MODULES_ENV,
  ancestorAnchors,
  electronAnchors,
  hostAnchors,
  resolveHostModule,
  requireHostModule,
  loadSchemastery,
  resetHostModuleCache,
};
