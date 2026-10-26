#!/usr/bin/env node
/**
 * 静态校验：产物一致性 + 构建管线 + 状态机契约 + DSH 装载契约。
 * 只读文件，不跑网络、不碰 DSH 安装目录、不写任何文件。全部通过时打印 PASS 并以 0 退出。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dsh-plugin-prompt-optimizer";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const passes = [];
const fails = [];

function check(ok, label, detail) {
	if (ok) passes.push(label);
	else fails.push(detail === undefined ? label : label + "  [" + detail + "]");
}
function read(rel) {
	return readFileSync(join(root, rel), "utf8");
}
function indexOfOrDie(haystack, needle) {
	return haystack.indexOf(needle);
}

// 1. 文件齐全（脚本入口已迁到 scripts/build.mjs，不再是根目录的纯拷贝脚本）
const required = [
	"package.json",
	"cordis.patch.yml",
	"README.md",
	"scripts/build.mjs",
	"scripts/simulate.mjs",
	"scripts/verify.mjs",
	"src/host/index.js",
	"src/client/index.js",
	"src/client/llm.js",
	"src/client/button.js",
	"src/client/overlays.js",
	"src/client/dom.js",
	"src/client/style.js",
	"src/client/engine.js",
	"src/shared/config.js",
	"src/engine/optimize.js",
	"src/engine/prompts.js",
	"lib/index.js",
	"lib/client.js"
];
for (const rel of required) check(existsSync(join(root, rel)), "文件存在 " + rel, "缺失");

// 2. package.json 关键字段
let pkg = null;
try {
	pkg = JSON.parse(read("package.json"));
	check(pkg !== null, "package.json 合法 JSON");
} catch (error) {
	check(false, "package.json 合法 JSON", String(error.message));
}
if (pkg !== null) {
	check(pkg.name === PKG, "package.json name = " + PKG, String(pkg.name));
	check(pkg.version === "0.4.1", "package.json version = 0.4.1", String(pkg.version));
	check(pkg.type === "module", "package.json type = module", String(pkg.type));
	check(pkg.main === "lib/index.js", "package.json main = lib/index.js", String(pkg.main));
	const exportsMap = pkg.exports ?? {};
	check(exportsMap["."] === "./lib/index.js", 'exports["."] = ./lib/index.js', JSON.stringify(exportsMap["."]));
	check(exportsMap["./client"] === "./lib/client.js", 'exports["./client"] = ./lib/client.js', JSON.stringify(exportsMap["./client"]));
	check(exportsMap["./package.json"] === "./package.json", 'exports["./package.json"]', JSON.stringify(exportsMap["./package.json"]));
	check(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch = ./cordis.patch.yml", JSON.stringify(pkg.dsh?.bundle));
	check(pkg.dsh?.client?.platform === "web", 'dsh.client.platform = "web"', String(pkg.dsh?.client?.platform));
	const inject = pkg.dsh?.client?.inject;
	const needInject = [
		"@deepseek-ai/dsh-client-ui-conversation",
		"@deepseek-ai/dsh-client-ui-renderer",
		"@deepseek-ai/dsh-client-ui-primitives"
	];
	check(Array.isArray(inject) && needInject.every((name) => inject.includes(name)), "dsh.client.inject 三条齐备", JSON.stringify(inject));
	const needFiles = ["lib", "cordis.patch.yml", "README.md"];
	check(Array.isArray(pkg.files) && needFiles.every((name) => pkg.files.includes(name)), "files 三条齐备", JSON.stringify(pkg.files));
}

// 3. 客户端产物形态
const client = read("lib/client.js").replace(/^\uFEFF/, "");
const clientSrc = read("src/client/index.js").replace(/^\uFEFF/, "");
check(client !== clientSrc, "lib/client.js 是构建产物而不是源码拷贝");
check(client.includes("由 scripts/build.mjs 生成"), "产物自带生成标记（不是手写文件）");

const head = client.trimStart();
check(head.startsWith("window.__ModuleLoader__.load("), "lib/client.js 以 window.__ModuleLoader__.load( 开头", JSON.stringify(head.slice(0, 40)));

const idMatch = head.match(/\bid:\s*["']([^"']+)["']/);
const loaderId = idMatch === null ? "" : idMatch[1];
check(loaderId === PKG, "loader id = 裸包名 " + PKG, JSON.stringify(loaderId));
check(!loaderId.includes("/") && !loaderId.startsWith("@"), "loader id 不含 / 与 @", JSON.stringify(loaderId));

const requires = [...client.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
const allowedRequire = new Set(["react", "@deepseek-ai/dsh-client-store"]);
const badRequire = [...new Set(requires)].filter((name) => !allowedRequire.has(name));
check(requires.length > 0 && badRequire.length === 0, "只 require react / dsh-client-store", badRequire.join(", "));
check(requires.length === 1 && requires[0] === "react", "整份产物只加载一次 react（单文件、无本地 require）", requires.join(","));
check(!/^\s*import\s/m.test(client), "client 无 ESM import 语句");
check(!/\bfrom\s+["']\.\.?\//.test(client), "client 无未解析的相对 import（源码 import 已在构建期消解）");
check(client.includes("createElement"), "client 使用 React.createElement");
check(!client.includes("jsx-runtime") && !client.includes("jsxDEV"), "client 不含 JSX 运行时");

// 4. 打包管线：模块图 + 引擎内联 + 无逃生口
const provenance = [
	"// src/client/index.js",
	"// src/client/button.js",
	"// src/client/overlays.js",
	"// src/client/dom.js",
	"// src/client/style.js",
	"// src/client/engine.js",
	"// src/client/llm.js",
	"// src/shared/config.js",
	"// src/engine/prompts.js（引擎内联）",
	"// src/engine/optimize.js（引擎内联）"
];
const missingProvenance = provenance.filter((line) => !client.includes(line));
check(missingProvenance.length === 0, "产物逐模块可溯源（含两份引擎源码）", missingProvenance.join(" | "));
check(/var __m0 = \(function \(\) \{/.test(client), "每个源码模块各自包进独立 IIFE（避免作用域串味）");
check(client.includes("function optimize(rawText, options)"), "引擎 optimize 实现被真正内联进产物");
check(client.includes("const STRENGTHS = [\"light\", \"standard\", \"deep\"]") || client.includes("const STRENGTHS = ['light', 'standard', 'deep']"), "引擎 STRENGTHS 常量被真正内联进产物");
check(client.includes("MAX_LENGTH = 8000"), "引擎 prompts.js 的数据表被真正内联进产物");
check(client.includes("return { STRENGTHS: STRENGTHS, optimize: optimize, __default__: __default__ }"), "引擎 IIFE 返回 { optimize, STRENGTHS }");
check(client.includes("var __engine") === false && client.includes("__m6") && client.includes("__m7"), "引擎按模块编号接线（prompts → optimize）");
check(!/\beval\s*\(/.test(client), "产物无 eval");
check(!/\bnew\s+Function\s*\(/.test(client), "产物无 new Function");
check(!/import\.meta/.test(client), "产物无 import.meta");
check(!/\bXMLHttpRequest\b/.test(client) && !/\bWebSocket\b/.test(client), "产物无 XHR / WebSocket（同源 fetch 走宿主官方通道，属允许项）");
check((client.match(/\bfetch\s*\(/g) || []).length === 1, "产物里只有一处 fetch：LLM 同源通路");
check(client.includes("optimizeViaRemote") && client.includes("const FAILURE_TEXT = {"), "llm.js 也被真正内联进产物");

// 4.5 v0.2 契约：归并引擎内联 + 四键设置真源 + 守恒兜底接线（P4a/P4b）
// 守的是「产物里跑的就是 src/engine/merge.js 与 src/client/engine.js 的那份实现」，不是别处的副本。
check(client.includes("// src/engine/merge.js"), "产物可溯源到 src/engine/merge.js（归并引擎在构建期内联）");
check(client.includes("function verifyConservation(originalText, resultText)"), "守恒校验实现被真正内联进产物（两参纯函数形态）");
check(client.includes("const SECTION_ORDER = ["), "段序常量 SECTION_ORDER 被内联（归并与校验共用同一份段序）");
check(client.includes("function applyGuard(originalText, resultText, mode)"), "兜底入口 applyGuard(originalText, resultText, mode) 在产物里（mergeMode 三参形态）");
// 兜底必须发生在唯一写回点 writeResult 内：漏接这一处，strict/lenient 就只是死字段
check(client.includes("applyGuard(token.source"), "applyGuard 在 writeResult 内被调用（守恒兜底只跑一次）");
// v0.2 的配置真源：旧键 CONFIG_KEY 只读保留，写盘一律落在 models 键
check(client.includes("const MODELS_KEY = \"dsh-plugin-prompt-optimizer/models\";"), "配置真源键 = dsh-plugin-prompt-optimizer/models");
const configFn = client.slice(indexOfOrDie(client, "function normalizeConfig(raw)"), indexOfOrDie(client, "function serializeConfig(config)"));
const missingSettingsKey = ["strength", "locale", "engine", "mergeMode"].filter((key) => !configFn.includes(key + ": pick("));
check(configFn !== "" && missingSettingsKey.length === 0, "设置保持四键（strength / locale / engine / mergeMode）", missingSettingsKey.join(" | "));
check(client.includes("function ConservationBlock({ conservation })") && client.includes("\"data-dsh-po-role\": \"conservation\""), "守恒报告区块 ConservationBlock 内联且带 data-dsh-po-role=conservation");
check(/\.dsh-po-guard(?:[\s:{.,]|$)/.test(client), "样式表里有 .dsh-po-guard 区块（守恒报告样式限定在 dsh-po- 前缀内）");
check(client.includes("\"data-dsh-po-level\""), "守恒等级挂在 data-dsh-po-level 上（warning / info 可被样式与断言读到）");
// 这条与第 4 节的产物断言配成一对：源头也只有一处 fetch，产物才可能只剩一处
const llmSrc = read("src/client/llm.js");
check((llmSrc.match(/\bfetch\s*\(/g) || []).length === 1, "src/client/llm.js 只有一处真 fetch（注释里不出现 fetch( 字样）");
check(!/#fff\b/i.test(client), "产物里没有写死 #fff（颜色全部走 --dsw-alias 变量，主题切换不失真）");

// 5. 组件契约
const flat = client.replace(/\s+/g, " ");
const signature = "function PromptOptimizerButton({ sessionId, useInput, inputActions, locked, onActiveChange, t })";
check(flat.includes(signature), "组件签名与约定一致", signature);

check(flat.includes("useInput((state) => state && state.draft)"), "草稿判空走 useInput(s => s && s.draft) 形态");
check(client.includes("conversation.input.activity"), "注册槽位 conversation.input.activity");
check(client.includes("ctx.slots.inject(") && client.includes("ctx.slots.register("), "用 ctx.slots.inject + ctx.slots.register 注册");
check((client.match(/slots\.register\(/g) || []).length === 1, "只注册一个槽位（single 槽不叠第二个，浮层全在同一组件里）");
check(/exports\.apply\s*=/.test(client) && /exports\.inject\s*=/.test(client), "client 导出 apply / inject");
check(/exports\.PromptOptimizerButton\s*=/.test(client), "client 导出 PromptOptimizerButton");
check(client.includes("exports.inject = __entry.inject") && client.includes("const inject = [\"slots\"]"), "inject = ['slots']");

// 6. 状态机（idle / loading / done / error）
check(client.includes("const [phase, setPhase] = react.useState(IDLE);"), "状态机只有一个 phase 状态（不叠布尔）");
check(client.includes("const IDLE = \"idle\";") && client.includes("const LOADING = \"loading\";") && client.includes("const DONE = \"done\";") && client.includes("const ERROR = \"error\";"), "四态常量齐备");
const startFn = client.slice(indexOfOrDie(client, "function startOptimize()"), indexOfOrDie(client, "function settle("));
check(startFn.includes("setPhase(LOADING)"), "startOptimize 里同步 setPhase(LOADING)");
check(startFn.indexOf("setPhase(LOADING)") < startFn.indexOf("setTimeout("), "进入 loading 早于任何计算（setPhase 在 setTimeout 之前）");
check(startFn.indexOf("runRef.current = token") < startFn.indexOf("setPhase(LOADING)"), "加载前先占令牌（重入闸门先于状态广播）");
check(client.includes("if (runRef.current !== null) return; // 加载中重复点击：零副作用"), "加载中重复点击直接返回（无副作用）");
const settleFn = client.slice(indexOfOrDie(client, "function settle("), indexOfOrDie(client, "function restoreOriginal()"));
check(settleFn.includes('resolveEngine(configRef.current, stateRef.current.models).effective === "llm"') && settleFn.includes("runRemote(token)"), "有效引擎为 llm 时 settle 分流到宿主通路（auto 有默认模型也走 llm）");
check(settleFn.includes("function writeResult(token, text, extra)"), "两条分支共用一个写回点 writeResult");
check(settleFn.includes("async function runRemote(token)") && settleFn.includes("runLocal(token, reason)"), "LLM 失败自动回退本地引擎（runLocal）");
check(client.includes("LLM 不可用，已回退本地：") && client.includes("if (runRef.current !== token) return; // 还原 / 新一轮 / 卸载：迟到的结果直接丢弃"), "LLM 迟到的结果被令牌丢弃，且回退有明确文案");
check(settleFn.indexOf("runRef.current !== token") !== -1 && settleFn.indexOf("runRef.current !== token") < settleFn.indexOf("write.call("), "令牌失效的迟到结果不会写回草稿");
const guardAt = settleFn.indexOf("latest !== token.source");
check(guardAt !== -1 && guardAt < settleFn.indexOf("write.call("), "草稿被改动时在写回之前放弃（原文一字不动）");
check((settleFn.match(/fail\(/g) || []).length >= 5, "settle 的每条错误路径都收口到 fail()（清数据、绝不动草稿）");
check((client.match(/write\.call\(inputActions/g) || []).length === 2, "只有两处写回草稿：优化成功 + 还原原文");
check(settleFn.indexOf("write.call(") < settleFn.indexOf("setPhase(DONE)"), "setDraft 成功之后才进入 done");
check(client.includes("original: token.source"), "done 态保存 original 原文快照（不依赖 Ctrl+Z）");
check(client.includes("if (done) {") && client.includes("restoreOriginal();"), "done 态点击按钮走还原，而不是再次优化（重复点击不叠加）");
check(client.includes("const label = done ? \"还原原文\" : busy ? \"优化中…\" : \"优化提示词\";"), "按钮文案随状态切换：优化提示词 / 优化中… / 还原原文");
check(client.includes("disabled,"), "loading 与空草稿时按钮 disabled");
check(client.includes("已优化") && client.includes("查看对比") && client.includes("还原原文"), "成功小条：已优化 · 查看对比 · 还原原文");
check(client.includes("const CONFIG_KEY = \"dsh-plugin-prompt-optimizer/config\";"), "配置持久化键 = dsh-plugin-prompt-optimizer/config");
check(client.includes("function normalizeConfig(raw)"), "配置归一化是纯函数 normalizeConfig(raw)");
check(client.includes("const DEFAULT_CONFIG = Object.freeze({"), "DEFAULT_CONFIG 存在且冻结");
check(client.includes("LLM 走宿主通路"), "engine=llm 时标注走宿主通路、失败自动回退本地");
check(client.includes("fallback: llmFailure !== null"), "回退本地时标记 fallback（只有真回退才标）");
check(client.includes("if (written === false)"), "setDraft 返回 false 走错误路径");
check(client.includes("草稿在优化期间被改动"), "加载期间草稿被改动 → 明确错误提示");

// 7. 可访问性 / 浮层
check(client.includes("\"aria-label\"") && client.includes("role: \"status\"") && client.includes("role: \"alert\"") && client.includes("role: \"dialog\""), "aria-label / role 齐备");
check(client.includes("\"aria-busy\": busy") && client.includes("\"aria-live\": \"polite\""), "loading 有 aria-busy 与 aria-live 播报");
check((client.match(/onMouseDown: preventFocusSteal/g) || []).length >= 4, "内部按钮 mousedown 全部 preventDefault 保焦点");
check(client.includes("getBoundingClientRect"), "浮层按 getBoundingClientRect() 定位");
check(client.includes("position:fixed"), "浮层 position:fixed");
check(client.includes("\"Escape\""), "Esc 关闭浮层");
check(client.includes("addEventListener(\"mousedown\", onPointerDown, true)"), "点击外部关闭浮层");
check(client.includes("board.writeText(value)") && client.includes("function fallbackCopy(value)") && client.includes("if (document.execCommand") === false, "复制优先 navigator.clipboard，失败降级 execCommand（永不 reject）");
// minmax(0,1fr) 而非 1fr：1fr 的最小尺寸是 auto，长文本会把栏撑宽导致两栏不等宽
check(client.includes("dsh-po-cols") && client.includes("grid-template-columns:repeat(2,minmax(0,1fr))"), "对比面板左右等宽分栏");
check(client.includes("width:min(620px") && client.includes("max-height:min(52vh,440px)"), "面板尺寸上限受控");
check(client.includes("ui-monospace") && client.includes("white-space:pre-wrap"), "对比面板等宽字体 + 可滚动换行");

// 8. 样式：全部限定 .dsh-po- 前缀
check(client.includes("dsh-po-button"), "样式前缀 dsh-po- 存在");
check(client.includes("--dsw-alias-"), "样式只用 dsw-alias CSS 变量");
const styleBlock = client.match(/const CSS = \[([\s\S]*?)\]\.join/);
const cssText = styleBlock === null ? "" : [...styleBlock[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
check(cssText.includes(".dsh-po-button"), "样式段可解析且含 .dsh-po-button", JSON.stringify(cssText.slice(0, 32)));
const selectorTokens = [...cssText.matchAll(/(?:^|[},])\s*([^{}@;]+?)\s*\{/g)].map((m) => m[1]);
const globalSelector = selectorTokens.filter((sel) => !sel.split(",").every((part) => /^\.dsh-po-[\w-]+(?:[:.][^{}\s]*)?$/.test(part.trim())));
check(selectorTokens.length > 0 && globalSelector.length === 0, "样式选择器全部限定在 .dsh-po- 前缀内（无全局/后代选择器）", globalSelector.join(" | "));
check(cssText.includes(":focus-visible"), "样式含 :focus-visible");
check(/@keyframes dsh-po-spin/.test(client) && !/@keyframes/.test(cssText), "@keyframes 带前缀且不在被解析的 CSS 数组内");

// 9. 宿主产物
const host = read("lib/index.js").replace(/^\uFEFF/, "");
check(!/^\s*import\s/m.test(host), "lib/index.js 零 import");
check(!host.includes("require("), "lib/index.js 零 require");
check(host.includes("export const ROUTE_PATH = \"/api/prompt-optimizer/optimize\""), "lib/index.js 声明 ROUTE_PATH");
check(client.includes("/api/prompt-optimizer/optimize"), "客户端与宿主同源同一条路径");
check(/export function apply\(/.test(host) && host.includes("export const inject = []"), "lib/index.js 导出 apply / inject");
check(host.includes("export const Config = {") && host.includes("export function registerOptimizeRoute("), "lib/index.js 导出 Config / registerOptimizeRoute");
check(!host.includes("eval(") && !/\bnew\s+Function\s*\(/.test(host), "lib/index.js 无 eval / new Function");
// P3 引入模型表后，「未配置」的判据从 endpoint === "" 变成 upstream === void 0（查表失败）；
// 守的东西没变：没有可用上游时返回 501 而不是抛错，装载不被阻断。
check(host.includes("if (upstream === void 0) return jsonResponse({ error: \"llm endpoint not configured\" }, 501);"), "缺 llmEndpoint 时返回 501（不阻断装载）");

// 10. cordis.patch.yml
const patchLines = read("cordis.patch.yml").split(/\r?\n/);
const insertLines = patchLines.filter((line) => /^\s*-\s*insert:\s*$/.test(line));
check(insertLines.length === 1, "patch 恰有一条 insert 装载行", "实际 " + insertLines.length);

const nameLines = patchLines.filter((line) => /^\s*(?:-\s*)?name:\s*\S/.test(line));
check(nameLines.length === 1, "patch 恰有一条 name", "实际 " + nameLines.length + ": " + nameLines.join(" | ").trim());
const nameValue = nameLines.length === 0 ? "" : nameLines[0].replace(/^\s*(?:-\s*)?name:\s*/, "").trim().replace(/^["']|["']$/g, "");
check(nameValue === PKG, "patch name = 裸包名 " + PKG, JSON.stringify(nameValue));
check(!nameValue.includes("/"), "patch name 不含 /", JSON.stringify(nameValue));

const idLines = patchLines.filter((line) => /^\s*(?:-\s*)?id:\s*\S/.test(line));
check(idLines.length === 1, "patch 恰有一条 id", "实际 " + idLines.length);
const idValue = idLines.length === 0 ? "" : idLines[0].replace(/^\s*(?:-\s*)?id:\s*/, "").trim().replace(/^["']|["']$/g, "");
check(idValue === PKG, "patch id = 裸包名 " + PKG, JSON.stringify(idValue));

const patchText = read("cordis.patch.yml");
for (const field of ["llmEndpoint", "llmApiKey", "llmModel", "llmTemperature", "llmTimeoutMs"]) {
	check(patchText.includes("#   " + field + ":"), "patch 注释里给了 config 示例字段 " + field);
}
check(patchText.includes("# config:") && patchText.includes("会被 loader"), "patch 注明 config 要写在该层之下（写错层不生效）");
check(patchText.includes("501"), "patch 注明缺 llmEndpoint 不阻断装载（返回 501、自动回退本地）");

// 11. 客户端 setter 自检：每个 setXxx 调用都必须有声明或导入
// 事故来源：button.js 的 startAdd() 里调用了从未定义的 setPanelNotice，抛错被 React 事件处理器吞掉，
// 表现为「点 + 添加模型完全没反应」——静态校验必须能在提交前抓住这类未定义标识符。
const clientDir = join(root, "src", "client");
const undeclaredSetters = [];
for (const file of readdirSync(clientDir).filter((name) => name.endsWith(".js"))) {
	const text = readFileSync(join(clientDir, file), "utf8");
	// 先剥注释：文档注释里写 setDraft(...) 是说明，不是调用
	const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const known = new Set();
	for (const m of code.matchAll(/(?:function|const|let|var)\s+(set[A-Z]\w*)/g)) known.add(m[1]);
	for (const m of code.matchAll(/const\s*\[[^\]]*?,\s*(set[A-Z]\w*)/g)) known.add(m[1]);
	for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
		for (const part of m[1].split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop();
			if (name) known.add(name);
		}
	}
	const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);
	for (const m of code.matchAll(/(?<!\.)\b(set[A-Z]\w*)\s*\(/g)) {
		if (TIMERS.has(m[1])) continue; // 宿主/运行时全局，不需要本地声明
		if (!known.has(m[1])) undeclaredSetters.push(file + ": " + m[1]);
	}
}
check(
	undeclaredSetters.length === 0,
	"客户端每个 setXxx 调用都有声明或导入（防未定义 setter 静默吞掉点击）",
	undeclaredSetters.join(" | ")
);

// 12. 构建自检护栏：盘符绝对路径规则必须「抓得到 C:\、抓不到 https://」
// 事故来源：build 的这条自检没有前置否定，把 https://api.example.com 里的 s://a 当成 C:/ 同形，
// 逼得 overlays.js 把端点示例写成 "https:" + "//…" 拼接形态。正则抽成具名常量后，这里从
// build.mjs 的同一行字面量用 new RegExp 重建一遍，护栏与自检同源，永不漂移。
const buildSource = read("scripts/build.mjs");
const absDecl = buildSource.match(/^const ABSOLUTE_PATH_PATTERN = (\/.*\/[a-z]*);$/m);
check(absDecl !== null, "build.mjs 把盘符规则抽成具名常量 ABSOLUTE_PATH_PATTERN", "未找到常量声明");
if (absDecl !== null) {
	const literal = absDecl[1];
	const lastSlash = literal.lastIndexOf("/");
	let absPattern = null;
	try {
		absPattern = new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1));
	} catch (error) {
		check(false, "盘符规则字面量可重建为 RegExp", String(error.message));
	}
	if (absPattern !== null) {
		const mustCatch = ["C:\\Users\\x", "D:/work", "\"E:\\a\""];
		const mustMiss = ["https://api.example.com/v1/chat/completions", "https://x"];
		const missed = mustCatch.filter((sample) => !absPattern.test(sample));
		check(
			missed.length === 0,
			"盘符规则仍拦截绝对路径（C:\\Users\\x / D:/work / \"E:\\a\"）",
			missed.join(" | ") + " 未被拦截"
		);
		const falseHits = mustMiss.filter((sample) => absPattern.test(sample));
		check(
			falseHits.length === 0,
			"盘符规则不再误伤协议头（https://api.example.com/v1/chat/completions / https://x 不被拦截）",
			falseHits.join(" | ") + " 被误判"
		);
	}
}

// 13. 汇报
for (const line of passes) console.log("  ok   " + line);
for (const line of fails) console.log("  FAIL " + line);
console.log("");
if (fails.length === 0) {
	console.log("PASS  " + passes.length + " 项静态校验全部通过");
	process.exit(0);
}
console.log("FAILED  " + fails.length + " 项未通过 / 共 " + (passes.length + fails.length) + " 项");
process.exit(1);
