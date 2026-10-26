#!/usr/bin/env node
/**
 * 打包管线：src/client/** + src/engine/{prompts,optimize,merge}.js → lib/client.js（单文件）
 *            src/host/index.js（宿主半边）                      →  lib/index.js（原样复制）
 *
 * 约束（scripts/verify.mjs 会逐条复核）：
 *  - 产物保持 window.__ModuleLoader__.load({ id, factory }) 形态，factory 内只有一次
 *    require("react")；
 *  - 引擎必须真正内联进产物（客户端产物不能 require 本地文件）：读取源码文本、剥掉
 *    顶层 export 前缀、包进 IIFE 并返回各自的导出面，逻辑与注释原样保留；
 *  - 严禁 eval / new Function / 网络加载；
 *  - 可重复构建：同一输入必须产出同字节（无时间戳、无绝对路径、模块顺序稳定）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const ENTRY_FILE = "src/client/index.js";
const HOST_FILE = "src/host/index.js";
const OUT_CLIENT = "lib/client.js";
const OUT_HOST = "lib/index.js";

/** factory 里允许的 require 白名单（宿主只注入 react）。 */
const EXTERNALS = new Set(["react"]);
/** 除 src/client/** 与 src/shared/** 外，只允许把这三份引擎源码内联进来。 */
const ENGINE_FILES = new Set(["src/engine/optimize.js", "src/engine/prompts.js", "src/engine/merge.js"]);
/**
 * 产物里绝不允许出现的逃生口。
 *
 * fetch **不在**禁令里：客户端的 LLM 通路走的是宿主官方通道（connection.fetch 注册的
 * /api/prompt-optimizer/optimize），同源请求、不是外联第三方，也不加载任何远端代码；
 * 上游地址与密钥只留在宿主配置里。eval / new Function / 静态 import / XHR / WebSocket
 * 仍然全禁 —— 它们才意味着"绕过构建期可见性执行或加载外部代码"。
 */
const FORBIDDEN = [
	/\beval\s*\(/,
	/\bnew\s+Function\s*\(/,
	/^\s*import\s/m,
	/jsx-runtime/,
	/jsxDEV/,
	/import\.meta/,
	/\brequire\s*\(\s*["'](?!react["'])/,
	/\bXMLHttpRequest/,
	/\bWebSocket\b/
];

class BuildError extends Error {}

function fail(message) {
	throw new BuildError(message);
}

function toPosix(path) {
	return path.split("\\").join("/");
}

function readText(file) {
	try {
		return readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
	} catch (cause) {
		fail("读取失败 " + file + "：" + cause.message);
	}
}

function resolveSpecifier(fromFile, spec) {
	if (typeof spec !== "string" || spec === "") fail(fromFile + " 里出现空 import 说明符");
	if (!spec.startsWith(".")) return { external: spec };
	return { file: posix.normalize(posix.join(posix.dirname(fromFile), spec)) };
}

function parseNamed(clause, where) {
	const inner = clause.slice(1, clause.lastIndexOf("}"));
	const out = [];
	for (const part of inner.split(",")) {
		const text = part.trim();
		if (text === "") continue;
		const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(text);
		if (!m) fail(where + " 无法解析命名导入：" + text);
		out.push({ imported: m[1], local: m[2] || m[1] });
	}
	return out;
}

function parseImportClause(clause, where) {
	const text = clause.trim();
	if (text === "") return [];
	if (text.startsWith("{")) return parseNamed(text, where);
	const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(text);
	if (ns !== null) return [{ imported: "*", local: ns[1] }];
	const combo = /^([A-Za-z_$][\w$]*)\s*,\s*(\{[\s\S]*\})$/.exec(text);
	if (combo !== null) return [{ imported: "default", local: combo[1] }].concat(parseNamed(combo[2], where));
	if (/^[A-Za-z_$][\w$]*$/.test(text)) return [{ imported: "default", local: text }];
	fail(where + " 无法解析 import 子句：" + text);
}

/**
 * 解析一个源码文件：抽出 import（DAG 边）、剥掉顶层 export 前缀、记录导出名。
 * @returns {{ file: string, source: string, imports: Array, exports: string[], body: string[] }}
 */
function parseModule(file) {
	const source = readText(file);
	const lines = source.split("\n");
	const imports = [];
	const exports = [];
	const body = [];

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const trimmed = line.trim();
		const where = file + ":" + String(i + 1);

		if (/^import\b/.test(trimmed)) {
			// 允许跨行 import（引擎源码是多行写法）：拼到能匹配为止
			let statement = trimmed;
			let m = /^import\s+(?:([\s\S]+?)\s+from\s+)?["']([^"']+)["'];?$/.exec(statement);
			while (m === null && i + 1 < lines.length) {
				i += 1;
				statement += " " + lines[i].trim();
				m = /^import\s+(?:([\s\S]+?)\s+from\s+)?["']([^"']+)["'];?$/.exec(statement);
			}
			if (m === null) fail(where + " 无法解析 import：" + statement);
			imports.push({ spec: m[2], bindings: parseImportClause(m[1] === undefined ? "" : m[1], where), line: i + 1 });
			continue;
		}

		if (/^export\s+default\b/.test(trimmed)) {
			const expr = trimmed.replace(/^export\s+default\s+/, "");
			exports.push("default");
			body.push("const __default__ = " + (expr.endsWith(";") ? expr : expr + ";"));
			continue;
		}

		if (/^export\s*\{/.test(trimmed)) {
			const list = /^export\s*\{([\s\S]*)\}\s*;?$/.exec(trimmed);
			if (list === null) fail(where + " 无法解析 export 列表：" + trimmed);
			for (const part of list[1].split(",")) {
				const name = part.trim();
				if (name === "") continue;
				if (!/^[A-Za-z_$][\w$]*$/.test(name)) fail(where + " 不支持 export 重命名：" + name);
				exports.push(name);
			}
			continue;
		}

		if (/^export\b/.test(trimmed)) {
			const decl = /^export\s+(?:async\s+)?(function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
			if (decl === null) fail(where + " 只支持 export 声明（function/const/let/var/class），无法解析：" + trimmed);
			exports.push(decl[2]);
			body.push(line.replace(/^(\s*)export\s+/, "$1"));
			continue;
		}

		body.push(line);
	}

	if (exports.length === 0) fail(file + " 没有任何导出");
	return { file, source, imports, exports, body };
}

/** 从入口做 DFS：依赖先于使用者，顺序完全由源码出现顺序决定（保证可重复）。 */
function buildOrder(entry) {
	const modules = new Map();
	const order = [];
	const visiting = new Set();
	const loaded = new Set();

	function load(file) {
		if (modules.has(file)) return modules.get(file);
		const parsed = parseModule(file);
		modules.set(file, parsed);
		for (const dep of parsed.imports) {
			const resolved = resolveSpecifier(file, dep.spec);
			if (resolved.external !== undefined) {
				if (!EXTERNALS.has(resolved.external)) fail(file + " 引入了未授权的外部模块：" + resolved.external);
				continue;
			}
			const target = resolved.file;
			const allowed = target.startsWith("src/client/") || target.startsWith("src/shared/") || ENGINE_FILES.has(target);
			if (!allowed) fail(file + " 引入了不在打包范围内的文件：" + target);
			load(target);
		}
		return parsed;
	}

	function visit(file) {
		if (loaded.has(file)) return;
		if (visiting.has(file)) fail("检测到循环依赖：" + file);
		visiting.add(file);
		const parsed = load(file);
		for (const dep of parsed.imports) {
			const resolved = resolveSpecifier(file, dep.spec);
			if (resolved.external === undefined) visit(resolved.file);
		}
		visiting.delete(file);
		loaded.add(file);
		order.push(file);
	}

	visit(entry);
	return { modules, order };
}

function moduleVar(index) {
	return "__m" + String(index);
}

/** 组装单文件产物。 */
function emitBundle(pkgName, entryFile, modules, order) {
	const indexOf = new Map();
	order.forEach((file, i) => indexOf.set(file, i));

	const out = [];
	out.push("window.__ModuleLoader__.load({");
	out.push("\tid: " + JSON.stringify(pkgName) + ",");
	out.push("\tfactory: (require) => {");
	out.push("\t\t// 由 scripts/build.mjs 生成，请勿手改；引擎源码来自 src/engine/{prompts,optimize,merge}.js。");
	out.push("\t\tvar module = { exports: {} };");
	out.push("\t\tvar exports = module.exports;");
	out.push("\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: \"Module\" });");
	out.push("");
	out.push("\t\tvar react = require(\"react\");");
	out.push("");

	order.forEach((file, i) => {
		const mod = modules.get(file);
		const params = [];
		const args = [];
		for (const dep of mod.imports) {
			const resolved = resolveSpecifier(file, dep.spec);
			if (resolved.external !== undefined) continue; // react 走 factory 作用域
			const target = modules.get(resolved.file);
			if (target === undefined) fail(file + " 依赖未被解析：" + resolved.file);
			const depVar = moduleVar(indexOf.get(resolved.file));
			for (const binding of dep.bindings) {
				if (binding.imported !== "*" && target.exports.indexOf(binding.imported) === -1) {
					fail(file + " 从 " + resolved.file + " 导入了不存在的 " + binding.imported);
				}
				params.push(binding.local);
				args.push(binding.imported === "*" ? depVar : depVar + "." + binding.imported);
			}
		}

		out.push("\t\t// " + file + (ENGINE_FILES.has(file) ? "（引擎内联）" : ""));
		out.push("\t\tvar " + moduleVar(i) + " = (function (" + params.join(", ") + ") {");
		for (const line of mod.body) out.push(line === "" ? "" : "\t\t\t" + line);
		const returned = mod.exports.map((name) => (name === "default" ? "__default__: __default__" : name + ": " + name));
		out.push("\t\t\treturn { " + returned.join(", ") + " };");
		out.push("\t\t})(" + args.join(", ") + ");");
		out.push("");
	});

	const entry = modules.get(entryFile);
	out.push("\t\tvar __entry = " + moduleVar(indexOf.get(entryFile)) + ";");
	for (const name of entry.exports) {
		if (name === "default") continue;
		out.push("\t\texports." + name + " = __entry." + name + ";");
	}
	out.push("\t\treturn module.exports;");
	out.push("\t}");
	out.push("});");
	return out.join("\n") + "\n";
}

/**
 * 盘符绝对路径特征（防产物泄漏构建机的本机路径）。
 *
 * 前置否定 (?<![A-Za-z0-9_]) 是必须的：没有它，协议头 https://api.example.com 里的
 * s://a 与 C:/x 同形会被误判，端点示例就不得不写成拆开拼接的形态。加了前置否定后，
 * 冒号前的字母必须不接在标识符/单词之后才算盘符（"C:\\Users\\x" 前是引号，照样抓）。
 */
const ABSOLUTE_PATH_PATTERN = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_]/;

/** 产物自检：逃生口、外部依赖、绝对路径、CRLF 全部不许出现。 */
function inspect(bundle, sourceFiles) {
	for (const pattern of FORBIDDEN) {
		if (pattern.test(bundle)) fail("产物命中禁止模式 " + String(pattern));
	}
	if (bundle.indexOf(ROOT) !== -1) fail("产物里出现了构建机的绝对路径");
	if (ABSOLUTE_PATH_PATTERN.test(bundle)) fail("产物里出现盘符绝对路径");
	if (bundle.indexOf("\r") !== -1) fail("产物必须是 LF 换行");
	if (!bundle.startsWith("window.__ModuleLoader__.load(")) fail("产物必须以 window.__ModuleLoader__.load( 开头");
	const requires = bundle.match(/require\(\s*["']([^"']+)["']\s*\)/g) || [];
	if (requires.length !== 1) fail("产物必须恰好一次 require，实际 " + String(requires.length) + " 次");
	if (requires[0].indexOf("\"react\"") === -1) fail("唯一一次 require 必须是 react");
	// 引擎内联证据：三份引擎源码里独有的实现细节必须出现在产物里
	for (const marker of ["function optimize(rawText, options)", "const STRENGTHS = [", "function verifyConservation(originalText, resultText)", "const SECTION_ORDER = ["]) {
		if (bundle.indexOf(marker) === -1) fail("产物缺少引擎实现标记：" + marker);
	}
	if (bundle.indexOf("eval(") !== -1) fail("产物包含 eval");
	for (const file of sourceFiles) {
		if (bundle.indexOf("// " + file) === -1) fail("产物缺少源码出处注释：" + file);
	}
}

/** 宿主产物自检：零 import / 零 require，导出面齐全（它是被 loader 直接装载的 host 半边）。 */
function inspectHost(host) {
	if (/^\s*import\s/m.test(host)) fail("lib/index.js 必须是零 import 的产物");
	if (host.indexOf("require(") !== -1) fail("lib/index.js 不允许 require");
	if (host.indexOf("\r") !== -1) fail("lib/index.js 必须是 LF 换行");
	if (host.indexOf("eval(") !== -1) fail("lib/index.js 不允许 eval");
	for (const marker of ["export const inject = []", "export const ROUTE_PATH = \"/api/prompt-optimizer/optimize\"", "export const Config = {", "export function registerOptimizeRoute(", "export function apply("]) {
		if (host.indexOf(marker) === -1) fail("宿主产物缺少导出标记：" + marker);
	}
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function main() {
	const pkg = JSON.parse(readText("package.json"));
	const { modules, order } = buildOrder(ENTRY_FILE);
	const bundle = emitBundle(pkg.name, ENTRY_FILE, modules, order);
	inspect(bundle, order);

	const host = readText(HOST_FILE);
	inspectHost(host);

	mkdirSync(join(ROOT, "lib"), { recursive: true });
	writeFileSync(join(ROOT, OUT_CLIENT), bundle, "utf8");
	writeFileSync(join(ROOT, OUT_HOST), host, "utf8");
	const engineCount = order.filter((file) => ENGINE_FILES.has(file)).length;
	console.log("[build] " + OUT_CLIENT + "  " + String(Buffer.byteLength(bundle)) + " bytes  sha256=" + sha256(bundle));
	console.log("[build] " + OUT_HOST + "   " + String(Buffer.byteLength(host)) + " bytes（宿主半边，原样复制）");
	console.log("[build] 模块 " + String(order.length) + " 个（其中引擎内联 " + String(engineCount) + " 个）：" + order.join(", "));
	console.log("[build] require 白名单：react；逃生口（eval / new Function / XHR / WebSocket）0 处；fetch 仅限宿主同源通路");
}

try {
	main();
} catch (cause) {
	if (cause instanceof BuildError) {
		console.error("[build] FAILED " + cause.message);
		process.exit(1);
	}
	throw cause;
}
