// dsh-session-ref-unlimit —— 解除 DSH 原生「一条消息最多引用 3 个会话」的硬上限。
//
// 原生实现（@deepseek-ai/dsh-session-reference）把 3 写死在三个地方：
//   1. lib/types/config.js:   export const MAX_REFERENCES = 3
//   2. static Config (zod):   maxReferences: z.number().step(1).min(1).max(3).default(3)
//   3. constructor:           if (this.config.maxReferences > 3) throw SessionReferenceError(...)
//
// 但真正决定「放行还是拒绝」的是每次准备消息时的一次读取：
//   prepare() -> normalizeReferences(agent.id, references, this.config.maxReferences)
//
// 因此只要在**实例化之后**把实例上的 this.config.maxReferences 改大，
// 上面三道闸都不会再被触发，prepare() 会按新值放行。
// 本插件不改 app.asar，只在 sessionReferenceResolver 服务就绪后改写它的实例配置。
//
// 安全阀：原生每条来源的字节预算是「上下文窗口 × referenceContextFraction（默认 0.2）」，
// 3 条合计 0.6。放开条数后若不跟着收缩，总注入量会线性膨胀，直接把上下文撑爆。
// 因此本插件在提高条数的同时，按 totalContextFraction 反算单条比例，
// 保证「条数 × 单条比例 ≤ totalContextFraction」，默认 0.6 ——
// 恰好等于原生 n=3 时的 3 × 0.2，所以默认参数不改变原生行为。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-session-ref-unlimit';

const TAG = '[dsh-session-ref-unlimit]';
const STATE_FILE = 'session-ref-unlimit.json';

// 原生默认值：未配置时保持原行为，以及停用时精确还原。
const NATIVE_MAX_REFERENCES = 3;
const NATIVE_REFERENCE_CONTEXT_FRACTION = 0.2;

const DEFAULTS = {
	enabled: true,
	// 一条消息最多引用几个会话。原生硬上限 3。
	maxReferences: 8,
	// 所有来源的字节预算合计占上下文窗口的比例上限。
	// 原生 3 条时是 3 × 0.2 = 0.6，所以默认 0.6 不改变原生行为。
	totalContextFraction: 0.6,
	// 可选：显式指定单条来源的最大序列化字节数；null 表示沿用原生自动预算。
	perSourceMaxBytes: null,
};

function log(...args) {
	try {
		console.log(TAG, ...args);
	} catch {
		/* ignore */
	}
}

function warn(...args) {
	try {
		console.warn(TAG, ...args);
	} catch {
		/* ignore */
	}
}

function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === 'string' && env.trim() !== '') return path.resolve(env);
	return path.join(os.homedir(), '.dsh');
}

function configPath() {
	return path.join(dshHome(), STATE_FILE);
}

/** 读取配置；任何异常都退回默认值，绝不让配置文件坏掉拖垮宿主。 */
export function readConfig(file = configPath()) {
	const cfg = { ...DEFAULTS };
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch {
		return cfg;
	}
	try {
		const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
		if (parsed !== null && typeof parsed === 'object') {
			if (typeof parsed.enabled === 'boolean') cfg.enabled = parsed.enabled;
			if (Number.isSafeInteger(parsed.maxReferences) && parsed.maxReferences >= 1) {
				cfg.maxReferences = parsed.maxReferences;
			}
			if (typeof parsed.totalContextFraction === 'number'
				&& parsed.totalContextFraction > 0
				&& parsed.totalContextFraction <= 1) {
				cfg.totalContextFraction = parsed.totalContextFraction;
			}
			if (Number.isSafeInteger(parsed.perSourceMaxBytes) && parsed.perSourceMaxBytes > 0) {
				cfg.perSourceMaxBytes = parsed.perSourceMaxBytes;
			}
		}
	} catch (error) {
		warn('配置文件解析失败，改用默认值：', error?.message ?? error);
	}
	return cfg;
}

/** 首次运行时落一份默认配置，方便用户直接改。 */
function ensureConfigFile(file = configPath()) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
		log('已生成默认配置：', file);
	} catch {
		/* 已存在或不可写，都不影响主流程 */
	}
}

/**
 * 计算目标值（纯函数，便于单测）。
 * @param before 解析器当前的 maxReferences / referenceContextFraction
 * @param cfg 已校验配置
 */
export function computeTarget(before, cfg) {
	const nativeMax = Number.isSafeInteger(before?.maxReferences) && before.maxReferences >= 1
		? before.maxReferences
		: NATIVE_MAX_REFERENCES;
	const nativeFraction = typeof before?.referenceContextFraction === 'number'
		? before.referenceContextFraction
		: NATIVE_REFERENCE_CONTEXT_FRACTION;

	if (cfg.enabled === false) {
		return { maxReferences: nativeMax, referenceContextFraction: nativeFraction };
	}

	const maxReferences = Math.max(cfg.maxReferences, nativeMax);
	// 总预算守门：条数变多就等比收缩单条比例，保证合计不超 totalContextFraction。
	const allowed = cfg.totalContextFraction / maxReferences;
	return {
		maxReferences,
		referenceContextFraction: Math.min(nativeFraction, allowed),
	};
}

/**
 * 把配置写进解析器实例，并返回还原函数。
 * @param resolver sessionReferenceResolver 实例
 * @param cfg 已校验配置
 */
export function applyOverride(resolver, cfg) {
	if (resolver === null || typeof resolver !== 'object') return null;
	const live = resolver.config;
	if (live === null || typeof live !== 'object') {
		warn('解析器没有 config 对象，宿主版本可能已变，本次跳过。');
		return null;
	}

	const before = {
		maxReferences: live.maxReferences,
		referenceContextFraction: live.referenceContextFraction,
		maxReferenceBytes: live.maxReferenceBytes,
	};
	const target = computeTarget(before, cfg);

	live.maxReferences = target.maxReferences;
	live.referenceContextFraction = target.referenceContextFraction;

	const explicitBytes = cfg.enabled !== false && cfg.perSourceMaxBytes !== null;
	if (explicitBytes) live.maxReferenceBytes = cfg.perSourceMaxBytes;

	return {
		effective: {
			maxReferences: target.maxReferences,
			referenceContextFraction: target.referenceContextFraction,
			maxReferenceBytes: live.maxReferenceBytes,
		},
		restore() {
			// 只还原「当前值仍是我们写进去的」字段，
			// 避免覆盖别家插件（如 dsh-mention-tuner）后来改的值。
			if (live.maxReferences === target.maxReferences) {
				live.maxReferences = before.maxReferences;
			}
			if (live.referenceContextFraction === target.referenceContextFraction) {
				live.referenceContextFraction = before.referenceContextFraction;
			}
			if (explicitBytes && live.maxReferenceBytes === cfg.perSourceMaxBytes) {
				live.maxReferenceBytes = before.maxReferenceBytes;
			}
		},
	};
}

export function apply(ctx) {
	ensureConfigFile();

	let applied = null;
	let resolver = null;
	let disposed = false;

	const release = () => {
		if (applied !== null) {
			applied.restore();
			applied = null;
		}
	};

	const install = () => {
		if (disposed || resolver === null) return;
		release();
		const cfg = readConfig();
		applied = applyOverride(resolver, cfg);
		if (applied === null) return;
		const e = applied.effective;
		log(
			`已接管引用上限：maxReferences=${e.maxReferences}（原生 ${NATIVE_MAX_REFERENCES}），`
			+ `单条上下文比例 ${e.referenceContextFraction}，`
			+ `合计上限 ${(e.maxReferences * e.referenceContextFraction).toFixed(2)} 个上下文窗口`,
		);
		if (cfg.enabled === false) log('配置为 enabled=false，按原生上限运行。');
	};

	// 只注册一次：等服务就绪后记下实例，之后的热重载都复用它，
	// 避免重复 ctx.inject 累积回调。
	ctx.inject(['sessionReferenceResolver'], (sctx) => {
		resolver = sctx.sessionReferenceResolver;
		install();
	});

	const file = configPath();
	let watcher = null;

	// 用 ctx.effect 显式登记清理逻辑：fiber 释放时 Cordis 必定调用返回的函数，
	// 比依赖 apply() 的返回值可靠。
	ctx.effect(() => {
		// 配置热生效：改完 JSON 不用重启宿主，最多约 1 秒后重新应用。
		try {
			watcher = (curr, prev) => {
				if (curr.mtimeMs === prev.mtimeMs) return;
				log('检测到配置变更，重新应用。');
				install();
			};
			fs.watchFile(file, { interval: 1000, persistent: false }, watcher);
		} catch (error) {
			warn('配置热加载未启用：', error?.message ?? error);
		}

		return () => {
			disposed = true;
			if (watcher !== null) {
				try {
					fs.unwatchFile(file, watcher);
				} catch {
					/* ignore */
				}
				watcher = null;
			}
			release();
			log('插件已卸载，还原原生上限。');
		};
	}, 'dsh-session-ref-unlimit');
}
