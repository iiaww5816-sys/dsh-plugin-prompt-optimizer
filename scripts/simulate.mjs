#!/usr/bin/env node
/**
 * 状态机仿真：本机开不了浏览器，所以用极简 React stub 直接驱动**真实产物** lib/client.js
 * 走完 idle → loading → done → restore，并覆盖三条错误路径（引擎抛错 / setDraft 返回 false /
 * 加载中草稿被改动）。
 *
 * 为什么驱动产物而不是源码：源码是 ESM 多文件，本身不是最终形态；只有产物能证明
 * 「引擎已内联、require 只有 react、状态机接线正确」这几件事同时成立。
 *
 * 断言口径（与任务书逐条对应）：
 *   - setDraft 调用序列；
 *   - 错误路径下 setDraft 一次都不被调用、原文一字不动；
 *   - 加载中连点不会叠加（只写回一次、只跑一次引擎）；
 *   - 还原后草稿等于原文；
 *   - 守恒兜底四种形态（strict 未补回 / lenient 已补回 / 未装载 / 抛错）都只写回一次，
 *     degraded 与 level 能从组件状态与 .dsh-po-guard 上读到。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "lib", "client.js");

/* ------------------------------------------------------------------ *
 * 1. 极简 React stub
 * ------------------------------------------------------------------ */

function createElement(type, props, ...children) {
	const merged = { ...(props || {}) };
	if (children.length === 1) merged.children = children[0];
	else if (children.length > 1) merged.children = children;
	return { type, props: merged };
}

/** 按「渲染路径」分配 hook 槽：同一类型出现多次也不会串味。 */
const hookStore = new Map();
let currentPath = null;
let rendering = false;
let dirty = false;
let effectQueue = [];
let rootComponent = null;
let rootProps = null;
let committed = null;

function withPath(path, fn) {
	const previous = currentPath;
	currentPath = path;
	let entry = hookStore.get(path);
	if (entry === undefined) {
		entry = { hooks: [], index: 0 };
		hookStore.set(path, entry);
	}
	entry.index = 0;
	try {
		return fn();
	} finally {
		currentPath = previous;
	}
}

function hook() {
	const entry = hookStore.get(currentPath);
	if (entry === undefined) throw new Error("hook 在组件外被调用（path=" + String(currentPath) + "）");
	const index = entry.index;
	entry.index += 1;
	return { entry, index };
}

function useState(initial) {
	const { entry, index } = hook();
	if (entry.hooks.length <= index) {
		entry.hooks[index] = { value: typeof initial === "function" ? initial() : initial, set: null };
	}
	const slot = entry.hooks[index];
	if (slot.set === null) {
		slot.set = (next) => {
			const value = typeof next === "function" ? next(slot.value) : next;
			if (Object.is(value, slot.value)) return;
			slot.value = value;
			scheduleRender();
		};
	}
	return [slot.value, slot.set];
}

function useRef(initial) {
	const { entry, index } = hook();
	if (entry.hooks.length <= index) entry.hooks[index] = { current: initial };
	return entry.hooks[index];
}

function depsEqual(a, b) {
	if (a === undefined || b === undefined) return false;
	return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

function useMemo(factory, deps) {
	const { entry, index } = hook();
	const previous = entry.hooks[index];
	if (previous !== undefined && depsEqual(previous.deps, deps)) return previous.value;
	const value = factory();
	entry.hooks[index] = { deps, value };
	return value;
}

function useCallback(fn, deps) {
	const { entry, index } = hook();
	const previous = entry.hooks[index];
	if (previous !== undefined && depsEqual(previous.deps, deps)) return previous.value;
	entry.hooks[index] = { deps, value: fn };
	return fn;
}

function useEffect(fn, deps) {
	const { entry, index } = hook();
	const previous = entry.hooks[index];
	const hookRecord = previous !== undefined && previous.effect !== undefined ? previous : { effect: { deps: undefined, cleanup: null } };
	entry.hooks[index] = hookRecord;
	effectQueue.push({ slot: hookRecord.effect, fn, deps, fresh: previous === undefined });
}

const react = { createElement, useState, useRef, useMemo, useCallback, useEffect };

/* ------------------------------------------------------------------ *
 * 2. 假 DOM / window（供定位、Esc、点击外部这些副作用跑通）
 * ------------------------------------------------------------------ */

function fakeNode(label) {
	const rect = { top: 600, left: 40, right: 120, bottom: 628, width: 80, height: 28 };
	const node = {
		label,
		focused: 0,
		getBoundingClientRect: () => rect,
		contains: (target) => target === node,
		focus() {
			node.focused += 1;
		},
		dataset: {},
		style: {},
		setAttribute() {}
	};
	return node;
}

function listeners() {
	const map = new Map();
	return {
		add(type, handler) {
			if (!map.has(type)) map.set(type, []);
			map.get(type).push(handler);
		},
		remove(type, handler) {
			const list = map.get(type) || [];
			const at = list.indexOf(handler);
			if (at !== -1) list.splice(at, 1);
		},
		count(type) {
			return (map.get(type) || []).length;
		},
		reset() {
			map.clear();
		},
		fire(type, event) {
			for (const handler of [...(map.get(type) || [])]) handler(event);
		}
	};
}

const documentEvents = listeners();
const windowEvents = listeners();
const headChildren = [];

globalThis.document = {
	head: { appendChild: (node) => headChildren.push(node) },
	body: { appendChild() {}, removeChild() {} },
	documentElement: {},
	createElement: () => ({ dataset: {}, style: {}, textContent: "", setAttribute() {} }),
	querySelector: () => null,
	addEventListener: documentEvents.add,
	removeEventListener: documentEvents.remove,
	execCommand: () => false
};
globalThis.window = {
	innerWidth: 1280,
	innerHeight: 900,
	addEventListener: windowEvents.add,
	removeEventListener: windowEvents.remove,
	__ModuleLoader__: null
};
// 内存版 localStorage（无痕模式下的失败分支由 tests/config.test.mjs 覆盖）
const storage = new Map();
try {
	Object.defineProperty(globalThis, "localStorage", {
		value: {
			getItem: (key) => (storage.has(key) ? storage.get(key) : null),
			setItem: (key, value) => {
				storage.set(key, String(value));
			},
			removeItem: (key) => {
				storage.delete(key);
			}
		},
		configurable: true,
		writable: true
	});
} catch (error) {
	// 没有 storage 也要能跑（loadConfig / saveConfig 静默降级）
}

// Node 24 的 navigator 是只读 getter：能覆盖就覆盖（复制降级路径用），不能覆盖也无妨
try {
	Object.defineProperty(globalThis, "navigator", {
		value: { clipboard: { writeText: () => Promise.reject(new Error("denied")) } },
		configurable: true,
		writable: true
	});
} catch (error) {
	// 保持宿主 navigator
}

/* ------------------------------------------------------------------ *
 * 3. 载入真实产物
 * ------------------------------------------------------------------ */

let definition = null;
globalThis.window.__ModuleLoader__ = {
	load(def) {
		definition = def;
		return def;
	}
};

await import(pathToFileURL(BUNDLE).href);
assert.notEqual(definition, null, "产物没有调用 window.__ModuleLoader__.load");
assert.equal(definition.id, "dsh-plugin-prompt-optimizer", "loader id 必须是裸包名");

const required = [];
const mod = definition.factory((name) => {
	required.push(name);
	if (name !== "react") throw new Error("产物试图 require 本地/未授权模块：" + name);
	return react;
});
assert.deepEqual(required, ["react"], "factory 只能 require react 一次");

for (const name of ["apply", "inject", "slotEntries", "PromptOptimizerButton", "setEngine"]) {
	assert.equal(typeof mod[name] === "function" || Array.isArray(mod[name]), true, "产物缺少导出 " + name);
}

/* ------------------------------------------------------------------ *
 * 4. 渲染调度
 * ------------------------------------------------------------------ */

function flatten(list, out) {
	for (const item of list) {
		if (Array.isArray(item)) flatten(item, out);
		else out.push(item);
	}
	return out;
}

function childrenOf(props) {
	const value = props.children;
	if (value === undefined || value === null || value === false || value === true) return [];
	return flatten([value], []);
}

function expand(node, path) {
	if (node === null || node === undefined || node === false || node === true) return null;
	if (typeof node === "string" || typeof node === "number") return { type: "#text", props: {}, children: [], text: String(node) };
	const props = node.props || {};
	if (typeof node.type === "function") {
		const rendered = withPath(path, () => node.type(props));
		return expand(rendered, path + ">0");
	}
	if (props.ref !== null && typeof props.ref === "object" && "current" in props.ref) props.ref.current = fakeNode(node.type);
	const children = [];
	const kids = childrenOf(props);
	for (let i = 0; i < kids.length; i += 1) {
		const child = expand(kids[i], path + ">" + String(i));
		if (child !== null) children.push(child);
	}
	return { type: node.type, props, children };
}

function flushEffects() {
	for (const item of effectQueue) {
		const slot = item.slot;
		if (!item.fresh && depsEqual(slot.deps, item.deps)) continue;
		if (typeof slot.cleanup === "function") slot.cleanup();
		slot.deps = item.deps;
		const cleanup = item.fn();
		slot.cleanup = typeof cleanup === "function" ? cleanup : null;
	}
	effectQueue = [];
}

function render() {
	if (rendering) {
		dirty = true;
		return;
	}
	rendering = true;
	let rounds = 0;
	try {
		do {
			dirty = false;
			effectQueue = [];
			committed = expand(react.createElement(rootComponent, rootProps), "root");
			flushEffects();
			rounds += 1;
			assert.ok(rounds <= 40, "渲染没有收敛（可能存在 setState 死循环）");
		} while (dirty);
	} finally {
		rendering = false;
	}
	return committed;
}

function scheduleRender() {
	if (rendering) {
		dirty = true;
		return;
	}
	render();
}

/** 在已提交的宿主树上按属性查找节点。 */
function find(predicate) {
	const out = [];
	(function walk(node) {
		if (node === null || node === undefined) return;
		if (predicate(node)) out.push(node);
		for (const child of node.children || []) walk(child);
	})(committed);
	return out;
}

function byAttr(name) {
	return find((node) => node.props !== undefined && node.props[name] !== undefined);
}

function one(name) {
	const list = byAttr(name);
	assert.equal(list.length, 1, name + " 节点应当恰有一个，实际 " + String(list.length));
	return list[0];
}

function trigger() {
	return one("data-dsh-po-trigger");
}

function phase() {
	return trigger().props["data-dsh-po-phase"];
}

function overlayNames() {
	return byAttr("data-dsh-po-overlay").map((node) => node.props["data-dsh-po-overlay"]);
}

function overlayText() {
	const texts = [];
	(function walk(node) {
		if (node === null || node === undefined) return;
		if (node.type === "#text") texts.push(node.text);
		for (const child of node.children || []) walk(child);
	})(committed);
	return texts.join(" ");
}

function fakeEvent() {
	return { defaultPrevented: false, key: "", target: null, preventDefault() { fakeEvent.lastPrevented += 1; } };
}
fakeEvent.lastPrevented = 0;

function clickTrigger() {
	const node = trigger();
	assert.equal(node.props.disabled, false, "触发时按钮不应处于 disabled");
	node.props.onClick(fakeEvent());
}

function clickAction(action) {
	const list = byAttr("data-dsh-po-action");
	const target = list.filter((node) => node.props["data-dsh-po-action"] === action);
	assert.equal(target.length, 1, "找不到唯一的 " + action + " 动作按钮，实际 " + String(target.length));
	target[0].props.onClick(fakeEvent());
}

/** 强行点击（模拟 disabled 元素仍被程序触发）：验证「重复点击零副作用」。 */
function forceClickTrigger() {
	trigger().props.onClick(fakeEvent());
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ *
 * 4.5 可控 fetch：engine=llm 通路用它模拟 200 / 501 / 网络失败
 *     产物里的 fetch 是宿主同源路由（相对路径），这里替换全局 fetch 即可拦截。
 * ------------------------------------------------------------------ */

let fetchPlan = null; // null → 200 成功；"reject" → 网络失败；{ status, body } → 指定响应
const fetchCalls = [];

function fakeFetch(url, init) {
	fetchCalls.push({
		url,
		method: init === undefined ? "" : init.method,
		body: init === undefined ? "" : init.body
	});
	if (fetchPlan === "reject") {
		return Promise.reject(Object.assign(new Error("network down"), { name: "TypeError" }));
	}
	const status = fetchPlan === null ? 200 : fetchPlan.status;
	const body = fetchPlan === null ? { ok: true, text: "LLM 改写后的提示词" } : fetchPlan.body;
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body)
	});
}

globalThis.fetch = fakeFetch;

/** 收集一棵 vnode 下的全部文本。 */
function textOf(node) {
	const parts = [];
	(function walk(item) {
		if (item === null || item === undefined) return;
		if (typeof item === "string") {
			parts.push(item);
			return;
		}
		if (item.type === "#text") {
			parts.push(item.text);
			return;
		}
		for (const child of item.children || []) walk(child);
	})(node);
	return parts.join("");
}

/** 小条上的「LLM 回退」标注节点。 */
function fallbackNotes() {
	return byAttr("data-dsh-po-role").filter((node) => node.props["data-dsh-po-role"] === "llm-fallback");
}

/* ------------------------------------------------------------------ *
 * 5. 假 props
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 5.5 v0.2 配置真源 / 守恒兜底的读取口
 * ------------------------------------------------------------------ */

const MODELS_KEY = "dsh-plugin-prompt-optimizer/models";
const CONFIG_KEY = "dsh-plugin-prompt-optimizer/config";
const SEED_MODEL_ID = "7f3d2c10-1a2b-4c3d-8e4f-5566778899aa";

/** 往 v0.2 的配置真源里种一条默认模型 + 四键设置（engine=llm 必须有自己的默认模型才不回退本地）。 */
function seedModels(overrides) {
	const settings = { strength: "standard", locale: "zh", engine: "local", mergeMode: "strict" };
	Object.assign(settings, overrides || {});
	storage.set(
		MODELS_KEY,
		JSON.stringify({
			schemaVersion: 2,
			models: [
				{
					id: SEED_MODEL_ID,
					name: "仿真模型",
					endpoint: "https://api.example.com/v1/chat/completions",
					apiKey: "sk-sim-0000",
					model: "sim-chat",
					isDefault: true
				}
			],
			settings
		})
	);
}

/** 组件状态里的兜底结果（result.conservation）：产物没导出 applyGuard，只能从状态里读。 */
function guardStates() {
	const out = [];
	for (const entry of hookStore.values()) {
		for (const slot of entry.hooks) {
			const value = slot !== null && typeof slot === "object" ? slot.value : undefined;
			if (value !== null && typeof value === "object" && value.conservation !== undefined) out.push(value.conservation);
		}
	}
	return out;
}

/** 带守恒等级标记的节点（小条 data-dsh-po-level / 面板 data-dsh-po-level）。 */
function levelNodes(level) {
	return byAttr("data-dsh-po-level").filter((node) => node.props["data-dsh-po-level"] === level);
}

/** 守恒报告区块：ComparePanel 里的 .dsh-po-guard（按类名整词匹配，子元素 dsh-po-guard-* 不算）。 */
function guardBlocks() {
	return find((node) => typeof node.props.className === "string" && node.props.className.split(/\s+/).indexOf("dsh-po-guard") !== -1);
}


const host = {
	draft: "",
	writes: [],
	reject: false,
	actions: {
		setDraft(next) {
			host.writes.push(next);
			if (host.reject === true) return false;
			host.draft = next;
			render();
			return true;
		}
	}
};

const useInput = (selector) => selector({ draft: host.draft });

function mount(draft) {
	host.draft = draft;
	host.writes = [];
	host.reject = false;
	hookStore.clear();
	documentEvents.reset(); // 相当于卸载：上一轮挂的宿主监听全部撤掉
	windowEvents.reset();
	rootComponent = mod.PromptOptimizerButton;
	rootProps = {
		sessionId: "sim",
		useInput,
		inputActions: host.actions,
		locked: false,
		onActiveChange: null,
		t: (key) => key
	};
	render();
}

const ORIGINAL = "帮我写个脚本";
const checkpoints = [];
function ok(label, extra) {
	checkpoints.push(label);
	console.log("  ok   " + label + (extra === undefined ? "" : "  → " + extra));
}

/* ------------------------------------------------------------------ *
 * 6. 场景
 * ------------------------------------------------------------------ */

// 6.0 插件装配：apply 只注册一个槽位
const injected = [];
const registered = [];
mod.apply({
	slots: {
		inject(name, factory) {
			injected.push(name);
			return factory();
		},
		register(options, component) {
			registered.push({ options, component });
			return options;
		}
	}
});
assert.deepEqual(injected, ["conversation.input.activity"], "只注入 conversation.input.activity");
assert.equal(registered.length, 1, "只注册一个槽位（single 槽不叠第二个）");
assert.equal(registered[0].component, mod.PromptOptimizerButton, "注册的组件就是 PromptOptimizerButton");
assert.deepEqual(mod.inject, ["slots"], "inject 必须是 ['slots']");
assert.equal(headChildren.length, 1, "ensureStyle 只注入一份样式表");
ok("apply 只注册 conversation.input.activity 一个槽位，样式表注入一次");

// 6.1 idle
mount(ORIGINAL);
assert.equal(phase(), "idle");
assert.equal(trigger().props.disabled, false);
assert.deepEqual(overlayNames(), []);
assert.equal(overlayText().includes("优化提示词"), true);
ok("idle：草稿非空则可点，按钮文案「优化提示词」");

// 6.2 空草稿不可点
mount("   ");
assert.equal(phase(), "idle");
assert.equal(trigger().props.disabled, true);
forceClickTrigger();
await sleep(10);
assert.deepEqual(host.writes, []);
assert.deepEqual(overlayNames(), ["error"]);
ok("idle：草稿只有空白则 disabled，强行点击不产生任何写回");

// 6.3 主链路 idle → loading → done
mount(ORIGINAL);
clickTrigger();
assert.equal(phase(), "loading", "点击后必须**立即**进入 loading");
assert.equal(trigger().props.disabled, true, "loading 期间按钮 disabled");
assert.equal(overlayText().includes("优化中"), true);
assert.deepEqual(host.writes, [], "loading 期间尚未写回");
const escapeHandlers = documentEvents.count("keydown");
assert.equal(escapeHandlers, 0, "loading 期间不该挂 Esc 监听（浮层还没出现）");

// 加载中连点两次：完全无副作用
forceClickTrigger();
forceClickTrigger();
assert.equal(phase(), "loading", "连点不得改变状态");
assert.deepEqual(host.writes, [], "连点不得触发写回");

await sleep(10);
assert.equal(phase(), "done", "异步结算后进入 done");
assert.equal(host.writes.length, 1, "只写回一次");
const optimized = host.writes[0];
assert.notEqual(optimized, ORIGINAL, "写回内容必须是优化后的文本");
assert.equal(host.draft, optimized, "宿主草稿被替换为优化结果");
assert.deepEqual(overlayNames(), ["toast"]);
assert.equal(overlayText().includes("已优化"), true);
assert.equal(overlayText().includes("查看对比"), true);
assert.equal(overlayText().includes("还原原文"), true);
assert.equal(trigger().props["aria-label"], "还原原文");
ok("idle → loading → done：立即进入 loading、连点无副作用、只写回一次", "写回 " + String(host.writes.length) + " 次");

// 6.4 done：对比面板显示原文 / 优化后
clickAction("compare");
assert.deepEqual(overlayNames(), ["compare"]);
const originalPane = find((node) => node.props["data-dsh-po-role"] === "original");
const optimizedPane = find((node) => node.props["data-dsh-po-role"] === "optimized");
assert.equal(originalPane.length, 1);
assert.equal(optimizedPane.length, 1);
assert.equal(originalPane[0].children[0].text, ORIGINAL, "对比面板左侧必须是原文（来自 loading 时的快照）");
assert.equal(optimizedPane[0].children[0].text, optimized);
assert.equal(originalPane[0].props.className, "dsh-po-pre", "对比面板用等宽 pre 显示");
assert.equal(documentEvents.count("keydown") > 0, true, "浮层打开后挂了 Esc 监听");
documentEvents.fire("keydown", { key: "Escape" });
assert.deepEqual(overlayNames(), ["toast"], "Esc 关闭对比面板");
ok("done：对比面板左右分栏显示原文 / 优化后，Esc 可关闭");

// 6.5 点击外部关闭浮层
clickAction("compare");
assert.deepEqual(overlayNames(), ["compare"]);
documentEvents.fire("mousedown", { target: { id: "outside" } });
assert.deepEqual(overlayNames(), ["toast"], "点击外部关闭浮层");
ok("点击外部关闭浮层");

// 6.6 done → 点击按钮 = 还原原文（重复点击不叠加）
clickTrigger();
assert.equal(phase(), "idle");
assert.equal(host.writes.length, 2, "还原只多一次写回");
assert.equal(host.writes[1], ORIGINAL, "还原写回的就是原文快照");
assert.equal(host.draft, ORIGINAL, "还原后草稿等于原文");
assert.deepEqual(overlayNames(), []);
assert.equal(trigger().props["aria-label"], "优化提示词");
ok("done → restore：写回原文快照，草稿与原文逐字相同，回到 idle");

// 6.7 再点一次是「优化」，不是叠加
clickTrigger();
assert.equal(phase(), "loading");
await sleep(10);
assert.equal(host.writes.length, 3, "第三次点击又开始一轮完整优化");
assert.equal(phase(), "done");
ok("还原后再次点击进入新一轮优化（状态不叠加）");

// 6.8 错误路径 A：引擎抛错
mount(ORIGINAL);
mod.setEngine({ optimize() { throw new Error("engine boom"); } });
clickTrigger();
await sleep(10);
assert.equal(phase(), "error");
assert.deepEqual(host.writes, [], "引擎抛错时 setDraft 一次都不能被调用");
assert.equal(host.draft, ORIGINAL, "原文一字不动");
assert.deepEqual(overlayNames(), ["error"]);
assert.equal(overlayText().includes("engine boom"), true, "错误提示要带上引擎原因");
clickAction("dismiss-error");
assert.equal(phase(), "idle", "错误提示可关闭并回到 idle");
assert.equal(host.draft, ORIGINAL);
ok("错误路径 A（引擎抛错）：setDraft 0 次，原文不变，提示可关闭");

// 6.9 错误路径 B：引擎返回 ok:false
mount("   ");
mod.setEngine({ optimize: () => ({ ok: false, reason: "empty", text: "", segments: [], meta: {} }) });
forceClickTrigger(); // 空草稿直接报错，engine 都不会被调用
await sleep(10);
assert.equal(phase(), "error");
assert.deepEqual(host.writes, []);

mount(ORIGINAL);
mod.setEngine({ optimize: () => ({ ok: false, reason: "unsupported", text: "", segments: [], meta: {} }) });
clickTrigger();
await sleep(10);
assert.equal(phase(), "error", "ok:false 必须走错误态");
assert.deepEqual(host.writes, [], "ok:false 时绝不能 setDraft");
assert.equal(host.draft, ORIGINAL);
assert.equal(overlayText().includes("原文未改动"), true);
ok("错误路径 B（ok:false）：绝不 setDraft，原文一字不动");

// 6.10 错误路径 C：setDraft 返回 false
mount(ORIGINAL);
mod.setEngine({ optimize: (text) => ({ ok: true, text: text + "（优化过）", segments: [], meta: { engine: "local" } }) });
host.reject = true;
clickTrigger();
await sleep(10);
assert.equal(phase(), "error");
assert.equal(host.writes.length, 1, "setDraft 被调用了一次（返回 false）");
assert.equal(host.writes[0], ORIGINAL + "（优化过）");
assert.equal(host.draft, ORIGINAL, "setDraft 返回 false 时正文不得进入 done 态");
assert.deepEqual(overlayNames(), ["error"]);
assert.equal(overlayText().includes("被拒绝"), true);
ok("错误路径 C（setDraft 返回 false）：进入错误态，草稿保持原文");

// 6.11 错误路径 D：加载期间草稿被改动
mount(ORIGINAL);
mod.setEngine({ optimize: (text) => ({ ok: true, text: text + "（优化过）", segments: [], meta: { engine: "local" } }) });
clickTrigger();
assert.equal(phase(), "loading");
host.draft = ORIGINAL + " 用户又补了一句";
render();
await sleep(10);
assert.equal(phase(), "error", "草稿被改动 → 放弃写回");
assert.deepEqual(host.writes, [], "草稿在加载期间被改动时，一次都不能 setDraft");
assert.equal(host.draft, ORIGINAL + " 用户又补了一句", "用户新输入不被覆盖");
assert.equal(overlayText().includes("改动"), true);
ok("错误路径 D（加载中草稿被改）：放弃写回，用户新输入不被覆盖");

// 6.12 设置面板：engine=llm 标注兜底 + 配置持久化
// v0.2 起配置真源换成 MODELS_KEY（{schemaVersion:2, models, settings} 四键），旧 CONFIG_KEY 只读。
// 先种一条 isDefault 模型：没有默认模型时 resolveEngine 会把 engine=llm 回退成本地，面板就看不到提示。
seedModels();
mount(ORIGINAL);
one("data-dsh-po-gear").props.onClick(fakeEvent());
assert.deepEqual(overlayNames(), ["settings"]);
assert.equal(overlayText().includes("LLM 走宿主通路"), false, "默认 engine=local 时不显示 LLM 通路提示");
const llm = byAttr("data-dsh-po-config").filter((node) => node.props["data-dsh-po-config"] === "engine=llm");
assert.equal(llm.length, 1);
llm[0].props.onClick(fakeEvent());
assert.equal(overlayText().includes("LLM 走宿主通路"), true, "engine=llm 必须标注走宿主通路、失败自动回退本地");
const strength = byAttr("data-dsh-po-config").filter((node) => node.props["data-dsh-po-config"] === "strength=deep");
strength[0].props.onClick(fakeEvent());
const persistedModels = JSON.parse(storage.get(MODELS_KEY));
assert.deepEqual(persistedModels.settings, { strength: "deep", locale: "zh", engine: "llm", mergeMode: "strict" }, "四键设置必须持久化到 dsh-plugin-prompt-optimizer/models");
assert.equal(persistedModels.schemaVersion, 2, "落盘载荷必须带 schemaVersion 2");
assert.deepEqual(persistedModels.models.map((item) => item.id), [SEED_MODEL_ID], "改设置不得丢掉已有模型条目");
assert.equal(storage.has(CONFIG_KEY), false, "v0.2 不再往旧键 dsh-plugin-prompt-optimizer/config 写配置");
ok("设置面板：四键选项可切换并持久化到 models 键，engine=llm 标注走宿主通路 / 失败自动回退本地");

// 6.13 engine=llm：宿主同源通路成功（200）→ 直接用远端文本，小条不标回退
mod.setEngine(undefined);
clickAction("close-settings");
assert.deepEqual(overlayNames(), []);
render();
fetchPlan = null;
fetchCalls.length = 0;
clickTrigger();
assert.equal(phase(), "loading", "engine=llm 点击后同样**立即**进入 loading");
await sleep(30);
assert.equal(phase(), "done");
assert.equal(host.writes.length, 1, "远端成功只写回一次");
assert.equal(host.draft, "LLM 改写后的提示词", "写回的是宿主通路返回的文本");
assert.equal(fetchCalls.length, 1, "只发一次请求");
assert.equal(fetchCalls[0].url, "/api/prompt-optimizer/optimize", "请求打在宿主注册的同源路由上（相对路径，非第三方域名）");
assert.equal(fetchCalls[0].method, "POST");
assert.equal(fallbackNotes().length, 0, "成功时小条不出现回退标注");
ok("engine=llm：走宿主同源通路，成功后直接用远端文本");

// 6.14 engine=llm：网络失败 → 自动回退本地引擎，小条带具体文案
mount(ORIGINAL);
mod.setEngine({ optimize: (text) => ({ ok: true, text: text + "（本地兜底）", segments: [], meta: { engine: "local" } }) });
fetchPlan = "reject";
fetchCalls.length = 0;
clickTrigger();
await sleep(30);
assert.equal(phase(), "done", "远端失败后由本地引擎完成优化（不是错误态）");
assert.equal(host.writes.length, 1, "回退路径也只写回一次");
assert.equal(host.writes[0], ORIGINAL + "（本地兜底）", "写回的是本地引擎的结果");
assert.equal(fallbackNotes().length, 1, "小条必须标注 LLM 回退");
const networkNote = textOf(fallbackNotes()[0]);
assert.equal(networkNote.includes("LLM 不可用，已回退本地"), true, "标注「LLM 不可用，已回退本地」");
assert.equal(networkNote.includes("无法连接优化服务，请检查网络"), true, "标注具体失败文案（FAILURE_TEXT.network）");
ok("engine=llm：网络失败自动回退本地引擎，小条给出具体文案", networkNote);

// 6.15 engine=llm：宿主 501（未配置 llmEndpoint）→ 同样回退本地
mount(ORIGINAL);
mod.setEngine({ optimize: (text) => ({ ok: true, text: text + "（本地兜底）", segments: [], meta: { engine: "local" } }) });
fetchPlan = { status: 501, body: { error: "llm endpoint not configured" } };
fetchCalls.length = 0;
clickTrigger();
await sleep(30);
assert.equal(phase(), "done");
assert.equal(host.writes.length, 1);
assert.equal(host.writes[0], ORIGINAL + "（本地兜底）");
assert.equal(textOf(fallbackNotes()[0]).includes("未配置 LLM 地址"), true, "501 → 文案「未配置 LLM 地址」");
ok("engine=llm：宿主 501（未配置）时回退本地，插件不报错");

// 6.16 engine=llm：远端结果迟到且草稿已被改 → 绝不写回
mount(ORIGINAL);
mod.setEngine({ optimize: (text) => ({ ok: true, text: text + "（本地兜底）", segments: [], meta: { engine: "local" } }) });
fetchPlan = { status: 200, body: { ok: true, text: "LLM 改写后的提示词" } };
clickTrigger();
assert.equal(phase(), "loading");
host.draft = ORIGINAL + " 补充";
render();
await sleep(30);
assert.equal(phase(), "error", "LLM 结果回来时草稿已被改 → 放弃写回");
assert.deepEqual(host.writes, [], "此时一次都不能 setDraft");
assert.equal(host.draft, ORIGINAL + " 补充", "用户新输入不被覆盖");
ok("engine=llm：加载中草稿被改时，远端结果也不得写回");

// 6.17 恢复真实引擎后跑一遍真实优化（引擎确实内联在产物里）
mount("帮我写个周报，要正式一点");
mod.setEngine(undefined);
render();
assert.equal(mod.slotEntries().length, 1);
assert.equal(mod.slotEntries()[0].name, "conversation.input.activity");

/* ------------------------------------------------------------------ *
 * 6.18-6.22 守恒兜底（P4b 接线）：strict / lenient / 未装载 / 抛错 / 幂等
 * 真实 merge 由 index.js 在构建期接线，这里用 setMerge 注入假实现，逐个形态驱动 writeResult。
 * ------------------------------------------------------------------ */

const ENGINE_TEXT = "引擎结果：帮我写个脚本，2024 年交付";
const fakeEngine = () => ({ optimize: () => ({ ok: true, text: ENGINE_TEXT, segments: [], meta: { engine: "local" } }) });

// 6.18 strict：校验不通过且没有补回 → 原样写回引擎结果 + warning 级报告
seedModels({ mergeMode: "strict" });
mount(ORIGINAL);
mod.setEngine(fakeEngine());
const strictCalls = [];
mod.setMerge({
	applyConservation(original, result, mode) {
		strictCalls.push({ original, result, mode });
		return {
			text: result,
			applied: false,
			report: { ok: false, dropped: ["丢了一句"], lostTokens: ["2024"], sectionValid: true, details: ["丢了一句"] }
		};
	}
});
clickTrigger();
await sleep(10);
assert.equal(phase(), "done");
assert.equal(host.writes.length, 1);
assert.equal(host.writes[0], ENGINE_TEXT, "strict 未补回时写回的必须是引擎原文（不含补回文本）");
assert.deepEqual(strictCalls, [{ original: ORIGINAL, result: ENGINE_TEXT, mode: "strict" }], "applyConservation 收到 (原文, 引擎结果, strict)");
const strictGuard = guardStates()[0];
assert.equal(strictGuard.level, "warning", "校验未通过且未补回 → warning 级");
assert.equal(strictGuard.applied, false);
assert.equal(strictGuard.degraded, false, "正常校验不算降级");
assert.equal(strictGuard.report.ok, false);
assert.equal(strictGuard.report.dropped.length, 1);
assert.equal(strictGuard.report.lostTokens[0], "2024");
assert.equal(levelNodes("warning").length, 1, "小条上出现 warning 级守恒报告");
clickAction("compare");
const strictBlocks = guardBlocks();
assert.equal(strictBlocks.length, 1, "对比面板出现 .dsh-po-guard");
assert.equal(strictBlocks[0].props["data-dsh-po-level"], "warning");
assert.equal(textOf(strictBlocks[0]).includes("丢了一句"), true, "报告点名丢失的句子");
documentEvents.fire("keydown", { key: "Escape" });
ok("守恒兜底 strict：校验未通过 → 原样写回引擎结果，.dsh-po-guard 标 warning");

// 6.19 lenient：已补回 → 写回补回后的文本 + info 级提示
seedModels({ mergeMode: "lenient" });
mount(ORIGINAL);
mod.setEngine(fakeEngine());
const lenientCalls = [];
mod.setMerge({
	applyConservation(original, result, mode) {
		lenientCalls.push(mode);
		return {
			text: "补回后的文本",
			applied: true,
			report: { ok: false, dropped: ["丢了一句"], lostTokens: [], sectionValid: true, details: [], compensated: 1, recheckOk: true }
		};
	}
});
clickTrigger();
await sleep(10);
assert.equal(phase(), "done");
assert.equal(host.writes.length, 1);
assert.equal(host.writes[0], "补回后的文本", "lenient 已补回时写回补回后的文本");
assert.deepEqual(lenientCalls, ["lenient"], "mergeMode 透传到 applyConservation");
const lenientGuard = guardStates()[0];
assert.equal(lenientGuard.level, "info");
assert.equal(lenientGuard.applied, true);
assert.equal(lenientGuard.report.compensated, 1);
assert.equal(lenientGuard.report.recheckOk, true);
assert.equal(lenientGuard.notice.includes("已补回 1 句"), true, "小条文案给出补回句数");
clickAction("compare");
const lenientBlocks = guardBlocks();
assert.equal(lenientBlocks.length, 1);
assert.equal(lenientBlocks[0].props["data-dsh-po-level"], "info");
documentEvents.fire("keydown", { key: "Escape" });
ok("守恒兜底 lenient：已补回 → 写回补回后的文本，.dsh-po-guard 标 info");

// 6.20 merge 未装载：不校验、原样写回、不抛错、不出现守恒面板
seedModels({ mergeMode: "strict" });
mount(ORIGINAL);
mod.setEngine(fakeEngine());
mod.setMerge(null);
clickTrigger();
await sleep(10);
assert.equal(phase(), "done", "merge 未装载也要正常走完");
assert.equal(host.writes.length, 1);
assert.equal(host.writes[0], ENGINE_TEXT, "不校验 → 原样写回引擎结果");
const nullGuard = guardStates()[0];
assert.equal(nullGuard.degraded, true);
assert.equal(nullGuard.applied, false);
assert.equal(nullGuard.error, "merge 引擎未装载");
assert.deepEqual(overlayNames(), ["toast"], "不冒错误浮层");
assert.equal(byAttr("data-dsh-po-level").length, 0, "降级时小条不出现守恒等级节点");
clickAction("compare");
assert.equal(guardBlocks().length, 0, "降级时对比面板不出现 .dsh-po-guard");
documentEvents.fire("keydown", { key: "Escape" });
ok("merge 未装载：不校验、原样写回、UI 不炸（degraded=true 写在状态里）");

// 6.21 merge 内部抛错：一样原样写回，异常被兜底吞掉
mount(ORIGINAL);
mod.setEngine(fakeEngine());
mod.setMerge({
	applyConservation() {
		throw new Error("merge 内部炸了");
	}
});
clickTrigger();
await sleep(10);
assert.equal(phase(), "done", "merge 抛错不得把 UI 带进错误态");
assert.equal(host.writes.length, 1);
assert.equal(host.writes[0], ENGINE_TEXT, "抛错 → 原样写回引擎结果");
const throwGuard = guardStates()[0];
assert.equal(throwGuard.degraded, true, "抛错 → degraded=true 可从状态读到");
assert.equal(throwGuard.error, "merge 内部炸了");
assert.equal(throwGuard.report.ok, true, "降级报告给空报告（字段恒存在）");
clickAction("compare");
assert.equal(guardBlocks().length, 0);
documentEvents.fire("keydown", { key: "Escape" });
ok("merge 抛错：兜底吞掉异常原样写回，degraded=true 可从状态读到");

// 6.22 幂等：一次点击只补回一次，连点不叠加，还原不重跑兜底
seedModels({ mergeMode: "lenient" });
mount(ORIGINAL);
mod.setEngine(fakeEngine());
let guardCalls = 0;
mod.setMerge({
	applyConservation(original, result) {
		guardCalls += 1;
		return {
			text: result + "［补回一句］",
			applied: true,
			report: { ok: false, dropped: ["丢了一句"], lostTokens: [], sectionValid: true, details: [] }
		};
	}
});
clickTrigger();
assert.equal(phase(), "loading");
forceClickTrigger();
forceClickTrigger();
await sleep(10);
assert.equal(host.writes.length, 1, "同一轮只写回一次（host.writes.length === 1）");
assert.equal(guardCalls, 1, "兜底只跑一次：连点不重复补回");
assert.equal(host.writes[0], ENGINE_TEXT + "［补回一句］");
assert.equal(host.writes[0].split("［补回一句］").length - 1, 1, "写回文本里补回标记只出现一次");
forceClickTrigger();
await sleep(10);
assert.equal(host.writes.length, 2);
assert.equal(host.writes[1], ORIGINAL, "done 后再点是还原原文");
assert.equal(guardCalls, 1, "还原不经过守恒兜底");
ok("守恒兜底幂等：一次点击只补回一次，连点不叠加，还原不重跑兜底");

console.log("");
console.log("PASS  " + String(checkpoints.length) + " 组状态机断言全部通过");
console.log("      setDraft 调用序列（主链路）：[" + ["原文", "优化后", "还原原文"].join(" → ") + "] 共 3 次，逐次见 6.3/6.6/6.7");
console.log("      产物字节数：" + String(readFileSync(BUNDLE).length));
