/**
 * dsh-agy-swarm 主测试套件的「契约级 ACP 后端替身」。
 *
 * 这里刻意只实现 swarm 真正调用的最小接口，不复制 dsh-agy-acp 的实现细节：
 *   config / normalizeModelSpec / peekModels / listModels / runDirectTurn
 *   stopWorker / registry
 *
 * 模型目录使用与任何厂商无关的占位模型名，避免把第三方包的私有模型清单
 * 固化进本仓库的测试。真实 ACP 进程链的验证放在可选集成套件里。
 */

export const STUB_DEFAULT_MODEL = 'stub-model-alpha';

/** 替身模型目录：`efforts` 为空表示不接受任何思考档位，`lockedEffort` 表示锁定单档。 */
export const STUB_MODELS = Object.freeze([
  Object.freeze({ value: 'stub-model-alpha', name: 'Stub Alpha', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }),
  Object.freeze({ value: 'stub-model-beta', name: 'Stub Beta', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }),
  Object.freeze({ value: 'stub-model-flat', name: 'Stub Flat', efforts: [], defaultEffort: '' }),
  Object.freeze({ value: 'stub-model-locked', name: 'Stub Locked', efforts: ['medium'], defaultEffort: 'medium', lockedEffort: 'medium' }),
]);

const MODEL_VALUES = STUB_MODELS.map((m) => m.value).join('、');

function finishSpec(model, effective) {
  if (model.efforts.length === 0) {
    if (effective) throw new Error(`模型 ${model.value} 不接受任何思考档位`);
    return { model: model.value, effort: '' };
  }
  if (model.lockedEffort && effective && effective !== model.lockedEffort) {
    throw new Error(`模型 ${model.value} 固定思考档位为 ${model.lockedEffort}`);
  }
  if (effective && !model.efforts.includes(effective)) {
    throw new Error(`模型 ${model.value} 不支持思考档位 "${effective}"（可用：${model.efforts.join('|')}）`);
  }
  return { model: model.value, effort: effective || model.defaultEffort };
}

/**
 * 契约级 `normalizeModelSpec`：<model> 或 <model>-<effort>，未知模型列出可用清单。
 * @param {string} raw
 */
export function stubNormalizeModelSpec(raw) {
  const spec = String(raw ?? '').trim().replace(/^agy-acp\//i, '').replace(/^agy\//i, '');
  if (!spec || spec === 'default') return finishSpec(STUB_MODELS[0], '');
  const sorted = [...STUB_MODELS].sort((a, b) => b.value.length - a.value.length);
  for (const model of sorted) {
    if (spec === model.value) return finishSpec(model, '');
    if (spec.startsWith(model.value + '-')) {
      return finishSpec(model, spec.slice(model.value.length + 1));
    }
  }
  throw new Error(`未知模型 "${spec}"；可用模型：${MODEL_VALUES}`);
}

/** 单轮结果的默认形状（可被脚本字段覆盖）。 */
export function stubTurnResult(extra = {}) {
  return {
    status: 'completed',
    detail: '完成',
    outputText: '',
    agySessionId: 'stub-session',
    toolCalls: [],
    deniedActions: [],
    warnings: [],
    ...extra,
  };
}

export class AgyServiceStub {
  /**
   * @param {{ stateDir?: string, config?: Record<string, unknown>, models?: typeof STUB_MODELS }} [options]
   */
  constructor(options = {}) {
    const { stateDir = '', config = {}, models = STUB_MODELS } = options;
    this.config = {
      stateDir,
      defaultModel: STUB_DEFAULT_MODEL,
      graceMs: 100,
      cancelGraceMs: 100,
      shutdownGraceMs: 20,
      requestTimeoutMs: 5000,
      ...config,
    };
    this.models = models;
    this.turns = [];
    this.stopCalls = [];
    this.removed = [];
    this.registry = {
      remove: (parent, name) => {
        this.removed.push({ parent, name });
        return true;
      },
      list: () => [],
    };
  }

  /** @returns {{ models: Array<{value: string, name: string}>, efforts: string[] }} */
  peekModels() {
    return {
      models: this.models.map((m) => ({ value: m.value, name: m.name })),
      efforts: ['low', 'medium', 'high', 'xhigh'],
    };
  }

  /** 真实探测替身：默认返回同一份目录，被测试覆盖时可用。 */
  async listModels() {
    return { models: this.models.map((m) => ({ value: m.value, name: m.name })) };
  }

  normalizeModelSpec(raw) {
    return stubNormalizeModelSpec(raw);
  }

  /** 默认实现：记录入参并立即返回一个空成功轮次。 */
  async runDirectTurn(input) {
    this.turns.push(input);
    return stubTurnResult();
  }

  stopWorker(parent, name) {
    this.stopCalls.push({ parent, name });
    return { stopped: true, confirmed: true };
  }

  /** agy-acp 的 ACP 会话快照（可选集成套件之外只用作占位）。 */
  getAcpSnapshot() {
    return null;
  }
}

export default AgyServiceStub;
