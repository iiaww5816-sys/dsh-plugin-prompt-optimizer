window.__ModuleLoader__.load({
	id: "dsh-plugin-prompt-optimizer",
	factory: (require) => {
		// 由 scripts/build.mjs 生成，请勿手改；引擎源码来自 src/engine/{prompts,optimize,merge}.js。
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");

		// src/client/engine.js
		var __m0 = (function () {
			/**
			 * 引擎注入点。
			 *
			 * 打包产物启动时把内联引擎（构建期由 src/engine/{prompts,optimize}.js 合成）接进来；
			 * 仿真/测试可以用 setEngine() 换成假引擎，从而覆盖「引擎抛错」这类错误路径。
			 * 源码这里不 import 引擎 —— 客户端产物不允许 require 本地文件。
			 */

			let engineImpl = null;

			/** @param next 引擎对象（需提供 optimize）；传 null 表示卸载 */
			function setEngine(next) {
				engineImpl = next !== null && typeof next === "object" ? next : null;
			}

			/** @returns 当前引擎（未装载时为 null，调用方必须自己判空） */
			function getEngine() {
				return engineImpl;
			}

			/** 远端（宿主 LLM 通路）实现：{ optimizeViaRemote, FAILURE_TEXT }。 */
			let remoteImpl = null;

			/** @param next 远端实现；传 null 表示卸载（此时 engine=llm 直接回退本地） */
			function setRemote(next) {
				remoteImpl = next !== null && typeof next === "object" ? next : null;
			}

			/** @returns 当前远端实现（未装载时为 null） */
			function getRemote() {
				return remoteImpl;
			}
			/* ------------------------------------------------------------------ *
			 * 守恒校验兜底（merge 引擎注入点）
			 * ------------------------------------------------------------------ */

			/**
			 * 为什么与 setEngine 分开注入：优化引擎缺失是硬失败（必须报错），合并引擎缺失只是
			 * 「不校验、原样展示」—— 两者混在同一个对象里，每个调用点都得先拆字段才能分辨；
			 * 分开之后降级路径就是一次 null 判断，setEngine 的既有契约 { optimize, STRENGTHS }
			 * 也不用改，老的仿真/测试调用点继续有效。
			 */

			let mergeImpl = null;

			/** @param next merge 模块对象；传 null 表示卸载（兜底降级为不校验） */
			function setMerge(next) {
				mergeImpl = next !== null && typeof next === "object" ? next : null;
			}

			/** @returns 当前 merge 模块（未装载时为 null） */
			function getMerge() {
				return mergeImpl;
			}

			const GUARD_TITLE = "校验未通过";
			const GUARD_SECTION_FALLBACK = "其他";

			/** 兜底报告的固定形状：字段恒存在、类型恒正确，UI 可以无条件读。 */
			function emptyReport() {
				return {
					ok: true,
					dropped: [],
					lostTokens: [],
					sectionValid: true,
					details: [],
					uncategorized: 0,
					reassigned: [],
					compensated: 0,
					recheckOk: null
				};
			}

			function stringsOf(value) {
				if (!Array.isArray(value)) return [];
				return value.filter((item) => typeof item === "string");
			}

			/** 「未归类」条数 = 文本里带兜底标记的行数（标记只出现在「其他」栏的补回行上）。 */
			function countUncategorized(text, merge) {
				const note = typeof merge.OTHER_NOTE === "string" ? merge.OTHER_NOTE : "";
				if (note === "" || typeof text !== "string") return 0;
				let count = 0;
				for (const line of text.split("\n")) {
					if (line.indexOf(note) !== -1) count += 1;
				}
				return count;
			}

			/** 改判记录直接复用 merge 的判定（from/to 已在 classifySentence 之上算好）。 */
			function reassignedOf(text, merge) {
				if (typeof merge.mergeSections !== "function" || typeof text !== "string") return [];
				const outcome = merge.mergeSections(text);
				const list = outcome !== null && typeof outcome === "object" ? outcome.reassigned : null;
				if (!Array.isArray(list)) return [];
				const out = [];
				for (const item of list) {
					if (item === null || typeof item !== "object") continue;
					if (typeof item.from !== "string" || typeof item.to !== "string" || typeof item.text !== "string") continue;
					out.push({ from: item.from, to: item.to, text: item.text });
				}
				return out;
			}

			function guardNotice(report, applied, merge) {
				if (report.ok === true) return { level: "none", notice: "" };
				const titles = merge.SECTION_TITLE;
				const title = titles !== null && typeof titles === "object" && typeof titles.other === "string" ? titles.other : GUARD_SECTION_FALLBACK;
				// 只有真的补回了句子才算 info：段头兜底会改文本但不恢复任何内容，不能谎报「已补回 0 句」。
				const compensated = typeof report.compensated === "number" && report.compensated > 0 ? report.compensated : 0;
				if (applied === true && compensated > 0) return { level: "info", notice: "已补回 " + String(report.dropped.length) + " 句到「" + title + "」栏" };
				const backfilled = Array.isArray(report.backfilled) ? report.backfilled : [];
				const tail = backfilled.length > 0 ? "；已补齐缺失段头：" + backfilled.join("、") : "";
				return {
					level: "warning",
					notice: GUARD_TITLE + " · 丢失 " + String(report.dropped.length) + " 句 / 缺少 " + String(report.lostTokens.length) + " 个关键项，已保留原样结果" + tail
				};
			}

			/** 降级：不校验、原样展示；原因留在返回值里（traceable 字段），既不吞掉也不炸 UI。 */
			function degrade(text, mode, reason) {
				return { text, mode, applied: false, degraded: true, error: reason, report: emptyReport(), level: "none", notice: "" };
			}

			/**
			 * 守恒兜底：按 mergeMode 校验/补回优化结果。**永不抛错**。
			 *
			 * 只该在「首次成功结果」上调用一次：button.js 的 writeResult 是唯一写回点，重复点击与
			 * 撤回都被 runRef 令牌挡住，所以补回不会叠加。
			 *
			 * @param {string} originalText 用户原文快照
			 * @param {string} resultText 引擎 / LLM 返回文本
			 * @param {'strict'|'lenient'} mode
			 * @returns {{ text: string, mode: string, applied: boolean, degraded: boolean, error: string, report: object, level: 'none'|'info'|'warning', notice: string }}
			 */
			function applyGuard(originalText, resultText, mode) {
				const original = typeof originalText === "string" ? originalText : "";
				const result = typeof resultText === "string" ? resultText : "";
				const chosen = mode === "lenient" ? "lenient" : "strict";
				const merge = getMerge();
				if (merge === null) return degrade(result, chosen, "merge 引擎未装载");
				try {
					let text = result;
					let applied = false;
					let raw = null;
					if (typeof merge.applyConservation === "function") {
						const outcome = merge.applyConservation(original, result, chosen);
						const safe = outcome !== null && typeof outcome === "object" ? outcome : {};
						if (typeof safe.text === "string") text = safe.text;
						applied = safe.applied === true;
						raw = safe.report;
					} else if (typeof merge.verifyConservation === "function") {
						// 只有校验能力时依旧给出报告，但绝不改写文本
						raw = merge.verifyConservation(original, result);
					}
					const source = raw !== null && typeof raw === "object" ? raw : {};
					const report = {
						ok: source.ok === true,
						dropped: stringsOf(source.dropped),
						lostTokens: stringsOf(source.lostTokens),
						sectionValid: source.sectionValid !== false,
						details: stringsOf(source.details),
						uncategorized: countUncategorized(text, merge),
						reassigned: reassignedOf(text, merge),
						compensated: typeof source.compensated === "number" ? source.compensated : 0,
						recheckOk: typeof source.recheckOk === "boolean" ? source.recheckOk : null
					};
					const flagged = guardNotice(report, applied, merge);
					return { text, mode: chosen, applied, degraded: false, error: "", report, level: flagged.level, notice: flagged.notice };
				} catch (cause) {
					return degrade(result, chosen, cause instanceof Error ? cause.message : String(cause));
				}
			}


			return { setEngine: setEngine, getEngine: getEngine, setRemote: setRemote, getRemote: getRemote, setMerge: setMerge, getMerge: getMerge, applyGuard: applyGuard };
		})();

		// src/client/dom.js
		var __m1 = (function () {
			/**
			 * 浏览器侧小工具：浮层定位、焦点保护、剪贴板。
			 * 能力缺失或宿主环境异常时一律静默降级 —— 不抛错、不打断用户操作。
			 */

			/** 阻止 mousedown 抢走编辑器焦点（内部所有按钮共用）。 */
			function preventFocusSteal(event) {
				if (event !== null && event !== undefined && typeof event.preventDefault === "function") event.preventDefault();
			}

			/** 视口尺寸；非浏览器环境给保守默认值，保证定位计算永远能算出数。 */
			function viewport() {
				const width = typeof window !== "undefined" && typeof window.innerWidth === "number" ? window.innerWidth : 1024;
				const height = typeof window !== "undefined" && typeof window.innerHeight === "number" ? window.innerHeight : 768;
				return { width, height };
			}

			const EDGE = 8;   // 距视口四边的最小留白
			const GAP = 6;    // 浮层与按钮之间的间距
			const MIN_HEIGHT = 160; // 再挤也要留出这么高，否则宁可内部滚动
			const MAX_HEIGHT = 440; // 面板类浮层的高度上限，与 CSS 的 min(52vh,440px) 对齐（内联优先，CSS 只是无 JS 兜底）

			/**
			 * 只采集锚点的**原始**几何量与视口尺寸，不做任何夹取。
			 * 为什么不在这一步夹：夹左边界需要知道浮层的实际宽度，而宽度由调用方按浮层类型决定
			 * （对比面板宽、小条窄）。早先版本在这里按固定 320 夹边界、面板却有 760 宽，
			 * 结果右半边整体跑到屏幕外被裁掉 —— 夹取必须和宽度一起算，见 fixedStyle。
			 * @param node 作为锚点的元素（通常是按钮外壳）
			 */
			function anchorOf(node) {
				if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return null;
				const rect = node.getBoundingClientRect();
				if (rect === null || typeof rect !== "object") return null;
				const box = viewport();
				const top = typeof rect.top === "number" ? rect.top : 0;
				const left = typeof rect.left === "number" ? rect.left : 0;
				const bottom = typeof rect.bottom === "number" ? rect.bottom : top;
				return {
					// 输入框在页面底部，按钮上方空间通常充足；窗口很矮时改用比例判断，避免永远翻错方向
					placement: top > Math.min(260, box.height * 0.5) ? "above" : "below",
					left,
					top,
					bottom,
					viewportWidth: box.width,
					viewportHeight: box.height
				};
			}

			/**
			 * anchor + 浮层期望宽度上限 → 内联样式（position:fixed 写在 .dsh-po-panel / .dsh-po-toast / .dsh-po-error 里）。
			 *
			 * 三条硬保证，缺一条就会出现「面板一直到头、后面的字看不见」：
			 *   1. 宽度不超过 maxWidth 也不超过视口，且给了宽度就**写进内联 style**，与夹取用的宽度是同一个数；
			 *   2. left 按「视口宽 - 实际宽度」夹，右边缘永不出界；
			 *   3. 同时给出 maxHeight = 浮层到视口边界的剩余空间，上/下都不出界，超出部分由面板内部滚动。
			 * @param anchor anchorOf() 的结果
			 * @param maxWidth 浮层宽度上限；不传则不写 width（小条/错误条靠 CSS 的 max-width 自适应）
			 */
			function fixedStyle(anchor, maxWidth) {
				const cap = typeof maxWidth === "number" && maxWidth > 0 ? maxWidth : 0;
				if (anchor === null || typeof anchor !== "object") {
					const base = { left: EDGE, bottom: EDGE };
					if (cap > 0) base.width = cap;
					return base;
				}
				const vw = typeof anchor.viewportWidth === "number" ? anchor.viewportWidth : 1024;
				const vh = typeof anchor.viewportHeight === "number" ? anchor.viewportHeight : 768;
				// 夹取与渲染用同一个宽度：没给上限时按小条的 CSS max-width 估一个，保证 left 不会把它推出右边
				const width = cap > 0 ? Math.max(240, Math.min(cap, vw - EDGE * 2)) : Math.min(420, vw - EDGE * 2);
				const left = Math.max(EDGE, Math.min(anchor.left, vw - width - EDGE));
				const style = { left };
				if (cap > 0) style.width = width;
				if (anchor.placement === "above") {
					const bottom = Math.max(EDGE, vh - anchor.top + GAP);
					style.bottom = bottom;
					style.maxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, vh - bottom - EDGE));
				} else {
					const top = Math.max(EDGE, Math.min(anchor.bottom + GAP, vh - MIN_HEIGHT));
					style.top = top;
					style.maxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, vh - top - EDGE));
				}
				return style;
			}

			/** execCommand 兜底：老浏览器/无剪贴板权限时用，失败返回 false。 */
			function fallbackCopy(value) {
				try {
					if (typeof document === "undefined" || document === null || typeof document.execCommand !== "function") return false;
					if (document.body === null || typeof document.body.appendChild !== "function") return false;
					const area = document.createElement("textarea");
					area.value = value;
					area.setAttribute("readonly", "");
					area.style.position = "fixed";
					area.style.top = "-9999px";
					area.style.opacity = "0";
					document.body.appendChild(area);
					if (typeof area.select === "function") area.select();
					const ok = document.execCommand("copy") === true;
					document.body.removeChild(area);
					return ok;
				} catch (error) {
					return false;
				}
			}

			/**
			 * 复制文本：clipboard API 优先，失败静默降级到 execCommand，再失败返回 false。
			 * 永不 reject —— 调用方不必写 catch。
			 * @param text 待复制文本
			 * @returns {Promise<boolean>}
			 */
			function copyText(text) {
				const value = typeof text === "string" ? text : "";
				return new Promise(function (resolve) {
					try {
						const box = typeof navigator === "undefined" ? null : navigator;
						const board = box === null ? null : box.clipboard;
						if (board !== null && board !== undefined && typeof board.writeText === "function") {
							board.writeText(value).then(function () {
								resolve(true);
							}, function () {
								resolve(fallbackCopy(value));
							});
							return;
						}
					} catch (error) {
						// clipboard 访问抛错：落到下面的兜底
					}
					resolve(fallbackCopy(value));
				});
			}

			return { preventFocusSteal: preventFocusSteal, anchorOf: anchorOf, fixedStyle: fixedStyle, copyText: copyText };
		})();

		// src/shared/config.js
		var __m2 = (function () {
			/**
			 * 插件配置：常量 + 纯函数。
			 *
			 * 这里不订阅任何东西、不抛错：
			 * - normalizeConfig(raw) / normalizeModel(input) 对任意输入（null / 数组 / 字符串 / 缺字段）都返回合法值；
			 * - loadConfig / loadModels / saveModels 在 storage 缺失、抛错、内容不是合法 JSON 时静默降级
			 *   （无痕模式下访问 localStorage 会抛错，不能把界面带崩）；
			 * - 密钥永不明文回显，统一走 maskApiKey（design 假设 5）。
			 *
			 * v0.2 结构见 docs/design-v0.2.md 第 1 节：models[]（每条一个 API）+ settings。
			 */

			/** localStorage 键：v0.1 全局设置（v0.2 起保留只读，见 design 2.3）。 */
			const CONFIG_KEY = "dsh-plugin-prompt-optimizer/config";

			/** localStorage 键：v0.2 多模型配置（{ schemaVersion, models, settings }）。 */
			const MODELS_KEY = "dsh-plugin-prompt-optimizer/models";

			/** 模型条目上限（design 假设 3）。 */
			const MODEL_LIMIT = 20;

			/** 配置结构版本，用于旧配置迁移。 */
			const SCHEMA_VERSION = 2;

			const STRENGTH_OPTIONS = ["light", "standard", "deep"];
			const LOCALE_OPTIONS = ["zh", "en"];
			const ENGINE_OPTIONS = ["local", "llm", "auto"];
			const MERGE_MODE_OPTIONS = ["strict", "lenient"];

			/** 内容守恒校验模式兜底值（design 4.3）。 */
			const DEFAULT_MERGE_MODE = "strict";

			/**
			 * 默认配置：标准强度 + 中文 + auto 引擎。
			 * auto 语义（由客户端消费）：有可用默认模型就走 LLM，没有就本地 —— 装上就能用，不必先配模型。
			 */
			const DEFAULT_CONFIG = Object.freeze({
				strength: "standard",
				locale: "zh",
				engine: "auto",
				mergeMode: DEFAULT_MERGE_MODE
			});

			/** 模型条目的数值边界：越界按边界截断（design 1.1）。 */
			const TEMPERATURE_RANGE = Object.freeze({ min: 0, max: 2, fallback: 0.2 });
			const TIMEOUT_RANGE = Object.freeze({ min: 5000, max: 120000, fallback: 30000 });

			/** 模型条目字符串字段的长度上限（design 1.1）。 */
			const NAME_MAX = 40;
			const API_KEY_MAX = 512;
			const MODEL_MAX = 120;

			/** uuid v4 字面量（版本位 4、变体位 8/9/a/b）。 */
			const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

			/** 损坏内容备份键后缀：MODELS_KEY + ".corrupt"（design 2.3）。 */
			const CORRUPT_SUFFIX = ".corrupt";

			/**
			 * 单字段归一化：只接受白名单内的字符串（大小写与首尾空白容错），其余一律退回默认值。
			 * @param value 原始值（可能是任何类型）
			 * @param allowed 白名单
			 * @param fallback 兜底值
			 */
			function pick(value, allowed, fallback) {
				const text = typeof value === "string" ? value.trim().toLowerCase() : "";
				return allowed.indexOf(text) === -1 ? fallback : text;
			}

			/**
			 * 把任意输入归一化成一份合法设置；永不抛错。
			 * @param raw 反序列化后的任意值
			 * @returns {{ strength: string, locale: string, engine: string, mergeMode: string }}
			 */
			function normalizeConfig(raw) {
				const source = raw !== null && typeof raw === "object" ? raw : {};
				return {
					strength: pick(source.strength, STRENGTH_OPTIONS, DEFAULT_CONFIG.strength),
					locale: pick(source.locale, LOCALE_OPTIONS, DEFAULT_CONFIG.locale),
					engine: pick(source.engine, ENGINE_OPTIONS, DEFAULT_CONFIG.engine),
					mergeMode: pick(source.mergeMode, MERGE_MODE_OPTIONS, DEFAULT_MERGE_MODE)
				};
			}

			/** 序列化（先归一化，保证写进去的永远是合法值）。 */
			function serializeConfig(config) {
				return JSON.stringify(normalizeConfig(config));
			}

			/** 解析 storage：显式传入优先，其次 globalThis.localStorage；取不到/抛错都返回 null。 */
			function resolveStorage(storage) {
				if (storage !== undefined && storage !== null) return storage;
				try {
					return typeof localStorage === "undefined" ? null : localStorage;
				} catch (error) {
					return null;
				}
			}

			/**
			 * 读配置：任何异常（无痕模式、JSON 损坏、配额报错）都退回默认值。
			 * @param storage 可选的 storage 替身（单测注入）
			 */
			function loadConfig(storage) {
				try {
					const box = resolveStorage(storage);
					if (box === null || typeof box.getItem !== "function") return { ...DEFAULT_CONFIG };
					const text = box.getItem(CONFIG_KEY);
					if (typeof text !== "string" || text === "") return { ...DEFAULT_CONFIG };
					return normalizeConfig(JSON.parse(text));
				} catch (error) {
					return { ...DEFAULT_CONFIG };
				}
			}

			/**
			 * 写配置：失败返回 false（调用方忽略即可，界面继续用内存里的值）。
			 * @param storage 可选的 storage 替身（单测注入）
			 * @param config 待写入配置
			 */
			function saveConfig(storage, config) {
				try {
					const box = resolveStorage(storage);
					if (box === null || typeof box.setItem !== "function") return false;
					box.setItem(CONFIG_KEY, serializeConfig(config));
					return true;
				} catch (error) {
					return false;
				}
			}

			/** 生成 uuid v4：优先宿主 crypto，缺失时降级到 Math.random 拼接（不引入依赖）。 */
			function createId() {
				try {
					const webCrypto = typeof globalThis === "undefined" ? null : globalThis.crypto;
					if (webCrypto && typeof webCrypto.randomUUID === "function") {
						const generated = webCrypto.randomUUID();
						if (UUID_V4.test(generated)) return generated;
					}
				} catch (error) {
					// 宿主禁用 crypto 时走下面的手工拼接
				}
				const hex = "0123456789abcdef";
				let text = "";
				for (let index = 0; index < 36; index += 1) {
					if (index === 8 || index === 13 || index === 18 || index === 23) text += "-";
					else if (index === 14) text += "4";
					else if (index === 19) text += hex[(Math.floor(Math.random() * 4) + 8)];
					else text += hex[Math.floor(Math.random() * 16)];
				}
				return text;
			}

			/** 数值字段归一化：非法值取 fallback，越界按边界截断（design 1.1）。 */
			function clampNumber(value, range) {
				let number = NaN;
				if (typeof value === "number") number = value;
				else if (typeof value === "string" && value.trim() !== "") number = Number(value);
				if (!Number.isFinite(number)) return range.fallback;
				if (number < range.min) return range.min;
				if (number > range.max) return range.max;
				return number;
			}

			/** 时间戳归一化：非正数/非数字一律取 fallback。 */
			function pickTimestamp(value, fallback) {
				return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
			}

			/**
			 * API 地址校验：绝对 URL、只允许 http/https、不含凭据、不含 fragment。
			 * query 参数**允许**（Azure OpenAI 等接口必须带 ?api-version=）。
			 * 不做任何自动拼接（design 1.1「完整到 /chat/completions，不自动拼接」）。
			 * @param value 原始值
			 * @returns {{ ok: boolean, value?: string, message?: string }}
			 */
			function readEndpoint(value) {
				const text = typeof value === "string" ? value.trim() : "";
				if (text === "") return { ok: false, message: "请填写 API 地址" };
				let url = null;
				try {
					url = new URL(text);
				} catch (error) {
					return { ok: false, message: "地址不是合法的绝对 URL" };
				}
				if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "只支持 http / https 地址" };
				if (url.username !== "" || url.password !== "") return { ok: false, message: "地址不能包含用户名或密码" };
				if (url.hash !== "") return { ok: false, message: "地址不能包含 fragment" };
				if (url.hostname === "") return { ok: false, message: "地址缺少主机名" };
				return { ok: true, value: text };
			}

			/**
			 * 单条模型条目归一化 + 校验（内部实现，validateModel / normalizeModel 共用）。
			 * @param input 原始条目
			 * @param options 可含 now（注入时间戳，单测用）
			 * @returns {{ value: object, errors: Array<{ field: string, message: string }> }}
			 */
			function buildModel(input, options) {
				const source = input !== null && typeof input === "object" ? input : {};
				const injected = options !== null && typeof options === "object" && Number.isFinite(options.now) ? options.now : null;
				const now = injected === null ? Date.now() : injected;
				const errors = [];

				const rawId = typeof source.id === "string" ? source.id.trim().toLowerCase() : "";
				let id = rawId;
				if (rawId === "") id = createId();
				else if (!UUID_V4.test(rawId)) {
					id = createId();
					errors.push({ field: "id", message: "id 必须是 uuid v4，已重新生成" });
				}

				const model = typeof source.model === "string" ? source.model.trim() : "";
				if (model === "") errors.push({ field: "model", message: "请填写模型名" });
				else if (model.length > MODEL_MAX) errors.push({ field: "model", message: "模型名最多 " + MODEL_MAX + " 个字符" });

				const rawName = typeof source.name === "string" ? source.name.trim() : "";
				const resolvedName = rawName === "" ? model : rawName;
				if (resolvedName === "") errors.push({ field: "name", message: "显示名不能为空" });
				else if (rawName.length > NAME_MAX) errors.push({ field: "name", message: "显示名最多 " + NAME_MAX + " 个字符" });

				const endpoint = readEndpoint(source.endpoint);
				if (!endpoint.ok) errors.push({ field: "endpoint", message: endpoint.message });

				// 空密钥合法：本地 Ollama / LM Studio / 内网反代都不需要密钥，只卡长度上限。
				const apiKey = typeof source.apiKey === "string" ? source.apiKey.trim() : "";
				if (apiKey.length > API_KEY_MAX) errors.push({ field: "apiKey", message: "密钥最多 " + API_KEY_MAX + " 个字符" });

				return {
					value: {
						id,
						name: resolvedName,
						endpoint: endpoint.ok ? endpoint.value : typeof source.endpoint === "string" ? source.endpoint.trim() : "",
						apiKey,
						model,
						temperature: clampNumber(source.temperature, TEMPERATURE_RANGE),
						timeoutMs: clampNumber(source.timeoutMs, TIMEOUT_RANGE),
						isDefault: source.isDefault === true,
						createdAt: pickTimestamp(source.createdAt, now),
						updatedAt: pickTimestamp(source.updatedAt, now)
					},
					errors
				};
			}

			/**
			 * 校验单条模型条目（UI 失焦校验用）。
			 * @param input 原始条目
			 * @returns {{ ok: boolean, errors: Array<{ field: string, message: string }>, value: object }}
			 */
			function validateModel(input) {
				const built = buildModel(input);
				return { ok: built.errors.length === 0, errors: built.errors, value: built.value };
			}

			/**
			 * 归一化单条模型条目；永不抛错，必填缺失时给空串而不是抛异常（配合 validateModel 判定合法性）。
			 * @param input 原始条目
			 * @param options 可含 now（注入时间戳，单测用）
			 */
			function normalizeModel(input, options) {
				return buildModel(input, options).value;
			}

			/**
			 * 归一化整个模型列表：丢弃非法条目、纠正重复 id、截断到 MODEL_LIMIT、保证默认模型唯一。
			 * @param input 原始数组（任何类型都接受）
			 * @returns {{ models: Array, errors: Array<{ field: string, message: string }> }}
			 */
			function normalizeModelList(input) {
				const errors = [];
				const source = Array.isArray(input) ? input : [];
				if (input !== null && input !== undefined && !Array.isArray(input)) {
					errors.push({ field: "models", message: "models 必须是数组，已按空列表处理" });
				}
				const models = [];
				const seen = new Set();
				let hasDefault = false;
				for (let index = 0; index < source.length; index += 1) {
					if (models.length >= MODEL_LIMIT) {
						errors.push({ field: "models", message: "最多 " + MODEL_LIMIT + " 个模型，多余条目已截断" });
						break;
					}
					const built = buildModel(source[index]);
					if (built.errors.length > 0) {
						for (const error of built.errors) {
							errors.push({ field: "models[" + index + "]." + error.field, message: error.message });
						}
						continue;
					}
					const entry = built.value;
					if (seen.has(entry.id)) {
						entry.id = createId();
						errors.push({ field: "models[" + index + "].id", message: "id 与前面的条目重复，已重新生成" });
					}
					if (entry.isDefault) {
						if (hasDefault) {
							entry.isDefault = false;
							errors.push({ field: "models[" + index + "].isDefault", message: "已有默认模型，本条已降级为普通模型" });
						} else {
							hasDefault = true;
						}
					}
					seen.add(entry.id);
					models.push(entry);
				}
				return { models, errors };
			}

			/**
			 * 密钥掩码：只露末 4 位（design 假设 5）；长度小于等于 8 时整体掩码为「…」。
			 * @param key 原始密钥
			 * @returns {string} 形如 sk-…a1b2
			 */
			function maskApiKey(key) {
				const text = typeof key === "string" ? key : "";
				if (text.length <= 8) return "…";
				return text.slice(0, 3) + "…" + text.slice(-4);
			}

			/** 空的多模型状态（读取失败/无 storage 时的兜底）。 */
			function emptyModelState() {
				return {
					schemaVersion: SCHEMA_VERSION,
					models: [],
					settings: normalizeConfig(null),
					migrated: false,
					corrupt: false
				};
			}

			/** 把损坏内容原样挪到 MODELS_KEY + ".corrupt"：不静默丢弃（design 2.3）。 */
			function backupCorrupt(box, text) {
				try {
					if (typeof box.setItem === "function") box.setItem(MODELS_KEY + CORRUPT_SUFFIX, text);
				} catch (error) {
					// 备份也写不进去时只能放弃，界面继续用默认值
				}
			}

			/** 把一次解析结果收成 loadModels 的返回结构。 */
			function adopt(parsed, migrated) {
				return {
					schemaVersion: SCHEMA_VERSION,
					models: parsed.models,
					settings: parsed.settings,
					migrated,
					corrupt: false
				};
			}

			/**
			 * 读多模型配置：无 storage / 读取抛错 / JSON 损坏 / 结构不符 都退回默认值；永不抛错。
			 * 已存 schemaVersion 不等于 2 时按旧结构迁移（design 2.3）。
			 * 新键为空时，尝试把 v0.1 的 CONFIG_KEY（strength/locale/engine）迁移进 settings（旧键只读保留）。
			 * @param storage 可选的 storage 替身（单测注入）
			 * @returns {{ schemaVersion: number, models: Array, settings: object, migrated: boolean, corrupt: boolean }}
			 */
			function loadModels(storage) {
				try {
					const box = resolveStorage(storage);
					if (box === null || typeof box.getItem !== "function") return emptyModelState();

					const text = box.getItem(MODELS_KEY);
					if (typeof text === "string" && text !== "") {
						let parsed = null;
						try {
							parsed = JSON.parse(text);
						} catch (error) {
							backupCorrupt(box, text);
							return { ...emptyModelState(), corrupt: true };
						}
						if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
							backupCorrupt(box, text);
							return { ...emptyModelState(), corrupt: true };
						}
						if (parsed.schemaVersion === SCHEMA_VERSION) {
							const list = normalizeModelList(parsed.models);
							return adopt({ models: list.models, settings: normalizeConfig(parsed.settings) }, false);
						}
						const legacy = migrateConfig(parsed);
						return adopt({ models: legacy.models, settings: legacy.settings }, true);
					}

					const legacyText = box.getItem(CONFIG_KEY);
					if (typeof legacyText === "string" && legacyText !== "") {
						let legacy = null;
						try {
							legacy = JSON.parse(legacyText);
						} catch (error) {
							legacy = null;
						}
						if (legacy !== null && typeof legacy === "object" && !Array.isArray(legacy)) {
							const migrated = migrateConfig(legacy);
							return adopt({ models: migrated.models, settings: migrated.settings }, true);
						}
					}
					return emptyModelState();
				} catch (error) {
					return emptyModelState();
				}
			}

			/**
			 * 写多模型配置：先归一化再落盘；写失败返回 { ok: false, reason }，永不抛错。
			 * @param payload { schemaVersion?, models?, settings? }
			 * @param storage 可选的 storage 替身（单测注入）
			 * @returns {{ ok: boolean, reason?: string }}
			 */
			function saveModels(payload, storage) {
				try {
					const box = resolveStorage(storage);
					if (box === null || typeof box.setItem !== "function") {
						return { ok: false, reason: "storage 不可用：没有可写的 localStorage" };
					}
					const source = payload !== null && typeof payload === "object" ? payload : {};
					box.setItem(
						MODELS_KEY,
						JSON.stringify({
							schemaVersion: SCHEMA_VERSION,
							models: normalizeModelList(source.models).models,
							settings: normalizeConfig(source.settings)
						})
					);
					return { ok: true };
				} catch (error) {
					const reason = error && error.message ? error.message : String(error);
					return { ok: false, reason: "写入失败：" + reason };
				}
			}

			/**
			 * 旧配置迁移（design 假设 7）：llmEndpoint / llmApiKey / llmModel / llmTemperature / llmTimeoutMs
			 * 转成一条 isDefault 的模型条目；字段不全则跳过并在 errors 里记录。
			 * 也接住「有 models 数组但缺 schemaVersion」的半成品结构。
			 * @param oldConfig 旧单份配置（任何类型都接受）
			 * @returns {{ schemaVersion: number, models: Array, settings: object, errors: Array }}
			 */
			function migrateConfig(oldConfig) {
				const source = oldConfig !== null && typeof oldConfig === "object" ? oldConfig : {};
				const settings = normalizeConfig(source);
				const models = [];
				const errors = [];

				const endpoint = typeof source.llmEndpoint === "string" ? source.llmEndpoint.trim() : "";
				const apiKey = typeof source.llmApiKey === "string" ? source.llmApiKey.trim() : "";
				const model = typeof source.llmModel === "string" ? source.llmModel.trim() : "";
				if (endpoint !== "" || apiKey !== "" || model !== "") {
					const built = buildModel({
						endpoint,
						apiKey,
						model,
						temperature: source.llmTemperature,
						timeoutMs: source.llmTimeoutMs,
						isDefault: true
					});
					if (built.errors.length === 0) models.push(built.value);
					else for (const error of built.errors) errors.push({ field: "llm." + error.field, message: error.message });
				}

				if (models.length === 0 && Array.isArray(source.models)) {
					const list = normalizeModelList(source.models);
					for (const entry of list.models) models.push(entry);
					for (const error of list.errors) errors.push(error);
				}

				return { schemaVersion: SCHEMA_VERSION, models, settings, errors };
			}

			/**
			 * 新增或更新一条模型条目（design 2.2「添加」：无默认模型时自动设为默认）。
			 * 已达 MODEL_LIMIT 且不是更新时原样返回（调用方按长度变化判断是否被拒）。
			 * @param list 现有列表
			 * @param model 待写入条目
			 * @returns {Array} 新数组
			 */
			function upsertModel(list, model) {
				let next = normalizeModelList(list).models;
				const candidate = buildModel(model);
				if (candidate.errors.length > 0) return next;
				const entry = candidate.value;
				const index = next.findIndex((item) => item.id === entry.id);
				if (index === -1) {
					if (next.length >= MODEL_LIMIT) return next;
					next = next.concat([entry]);
				} else {
					const replaced = { ...entry, createdAt: next[index].createdAt, updatedAt: Date.now() };
					next = next.map((item, position) => (position === index ? replaced : item));
				}
				if (next.some((item) => item.id === entry.id && item.isDefault)) {
					return next.map((item) => ({ ...item, isDefault: item.id === entry.id }));
				}
				if (!next.some((item) => item.isDefault)) {
					return next.map((item, position) => ({ ...item, isDefault: position === 0 }));
				}
				return next;
			}

			/**
			 * 删除一条模型条目（design 2.2「删除」：删掉默认模型时自动把首条设为默认）。
			 * @param list 现有列表
			 * @param id 待删除条目 id
			 * @returns {Array} 新数组
			 */
			function removeModel(list, id) {
				const normalized = normalizeModelList(list).models;
				const kept = normalized.filter((item) => item.id !== id);
				if (kept.length === normalized.length) return normalized;
				if (kept.length === 0) return kept;
				if (kept.some((item) => item.isDefault)) return kept;
				return kept.map((item, position) => ({ ...item, isDefault: position === 0 }));
			}

			/**
			 * 切换默认模型：命中项置 true，其余一律 false；id 不存在时原样返回。
			 * @param list 现有列表
			 * @param id 目标条目 id
			 * @returns {Array} 新数组
			 */
			function setDefaultModel(list, id) {
				const normalized = normalizeModelList(list).models;
				if (!normalized.some((item) => item.id === id)) return normalized;
				return normalized.map((item) => ({ ...item, isDefault: item.id === id }));
			}

			return { CONFIG_KEY: CONFIG_KEY, MODELS_KEY: MODELS_KEY, MODEL_LIMIT: MODEL_LIMIT, SCHEMA_VERSION: SCHEMA_VERSION, STRENGTH_OPTIONS: STRENGTH_OPTIONS, LOCALE_OPTIONS: LOCALE_OPTIONS, ENGINE_OPTIONS: ENGINE_OPTIONS, MERGE_MODE_OPTIONS: MERGE_MODE_OPTIONS, DEFAULT_MERGE_MODE: DEFAULT_MERGE_MODE, DEFAULT_CONFIG: DEFAULT_CONFIG, normalizeConfig: normalizeConfig, serializeConfig: serializeConfig, loadConfig: loadConfig, saveConfig: saveConfig, validateModel: validateModel, normalizeModel: normalizeModel, normalizeModelList: normalizeModelList, maskApiKey: maskApiKey, loadModels: loadModels, saveModels: saveModels, migrateConfig: migrateConfig, upsertModel: upsertModel, removeModel: removeModel, setDefaultModel: setDefaultModel };
		})();

		// src/client/settings.js
		var __m3 = (function (MODEL_LIMIT, normalizeConfig, normalizeModelList, validateModel, upsertModel, removeModel, setDefaultModel, maskApiKey, migrateConfig) {
			/**
			 * 设置面板的纯逻辑层：表单校验、行数据装配、删除与默认迁移、提示判定、测试结果文案。
			 *
			 * 为什么单独成文件：这些规则必须能被 node:test 直接测（不依赖 DOM / storage / 网络），
			 * overlays.js 只负责把它们画出来，button.js 只负责编排副作用。
			 * 依赖方向单向：settings.js → shared/config.js，不反向依赖 client 其它文件。
			 */

			/** 表单里真实存在的字段（顺序即渲染顺序）。 */
			const FORM_FIELDS = ["name", "endpoint", "apiKey", "model", "temperature", "timeoutMs"];

			/** 表单字段 → 中文显示名（错误汇总文案用；表里没有的字段原样显示 key）。 */
			const FORM_FIELD_LABELS = {
				name: "显示名",
				endpoint: "地址",
				apiKey: "密钥",
				model: "模型名",
				temperature: "温度",
				timeoutMs: "超时"
			};

			/**
			 * 客户端引擎白名单：比 shared/config.js 的 ENGINE_OPTIONS 多一档 auto。
			 * 为什么不复用 shared 那份：配置层由另一侧并行补 auto，客户端不重复它的规则也不被它阻塞。
			 */
			const ENGINE_OPTIONS_CLIENT = ["auto", "local", "llm"];

			/** 引擎分段控件的三档文案（顺序即渲染顺序，auto 排首位因为它是默认档）。 */
			const ENGINE_LABELS_CLIENT = {
				auto: "自动（推荐，有可用模型时走 LLM）",
				local: "本地规则（不调网络，省 token）",
				llm: "LLM 改写（需配置模型）"
			};

			/** 密钥留空时的显示文案（绝不显示明文）。 */
			const NO_KEY_TEXT = "未设密钥";

			/** 旧配置里代表「一条模型」的三个字段（design 假设 7）。 */
			const LEGACY_MODEL_FIELDS = ["llmEndpoint", "llmApiKey", "llmModel"];

			/** 空表单：数值字段用字符串承载（输入框只能给字符串，校验交给 validateModel 截断）。 */
			function emptyForm() {
				return { id: "", name: "", endpoint: "", apiKey: "", model: "", temperature: "0.2", timeoutMs: "30000" };
			}

			/**
			 * 模型条目 → 表单初值。密钥**不回填**：编辑态留空即沿用原值（design 2.2「编辑」第 2 条）。
			 * @param model 模型条目
			 * @returns 表单初值
			 */
			function formFromModel(model) {
				const source = model !== null && typeof model === "object" ? model : {};
				return {
					id: typeof source.id === "string" ? source.id : "",
					name: typeof source.name === "string" ? source.name : "",
					endpoint: typeof source.endpoint === "string" ? source.endpoint : "",
					apiKey: "",
					model: typeof source.model === "string" ? source.model : "",
					temperature: String(typeof source.temperature === "number" ? source.temperature : 0.2),
					timeoutMs: String(typeof source.timeoutMs === "number" ? source.timeoutMs : 30000)
				};
			}

			/** 改一个字段：返回新表单（错误不落进状态，渲染期由 validateForm 现算）。 */
			function formWithField(form, field, value) {
				const source = form !== null && typeof form === "object" ? form : emptyForm();
				return { ...source, [field]: typeof value === "string" ? value : String(value) };
			}

			/**
			 * 本次要提交的密钥：输入框有内容就用输入框的，留空则沿用原条目的密钥。
			 * @param form 表单
			 * @param baseModel 编辑态的原条目（新增态传 null）
			 * @returns 密钥明文（只在内存里流转，不写日志、不进对比面板）
			 */
			function resolvedFormKey(form, baseModel) {
				const typed = form !== null && typeof form === "object" && typeof form.apiKey === "string" ? form.apiKey.trim() : "";
				if (typed !== "") return typed;
				const kept = baseModel !== null && typeof baseModel === "object" && typeof baseModel.apiKey === "string" ? baseModel.apiKey : "";
				return kept;
			}

			/**
			 * 表单 → 待校验条目（不含 id 时由 validateModel 生成，编辑态保留原 id / createdAt / isDefault）。
			 * @param form 表单
			 * @param baseModel 编辑态原条目，新增态传 null
			 * @returns 待校验对象
			 */
			function formCandidate(form, baseModel) {
				const source = form !== null && typeof form === "object" ? form : emptyForm();
				const base = baseModel !== null && typeof baseModel === "object" ? baseModel : null;
				const candidate = {
					name: typeof source.name === "string" ? source.name : "",
					endpoint: typeof source.endpoint === "string" ? source.endpoint : "",
					apiKey: resolvedFormKey(source, base),
					model: typeof source.model === "string" ? source.model : "",
					temperature: source.temperature,
					timeoutMs: source.timeoutMs
				};
				if (typeof source.id === "string" && source.id !== "") candidate.id = source.id;
				if (base !== null) {
					candidate.createdAt = base.createdAt;
					candidate.isDefault = base.isDefault === true;
				}
				return candidate;
			}

			/**
			 * 表单 → 合法条目。校验不通过时 ok=false，errors 仍是原始的 [{field,message}]。
			 * @param form 表单
			 * @param baseModel 编辑态原条目，新增态传 null
			 * @param options 可含 now（注入时间戳，单测用）
			 * @returns {{ ok: boolean, errors: Array<{ field: string, message: string }>, model: object }}
			 */
			function modelFromForm(form, baseModel, options) {
				const built = validateModel(formCandidate(form, baseModel));
				const injected = options !== null && typeof options === "object" && Number.isFinite(options.now) ? options.now : null;
				const now = injected === null ? Date.now() : injected;
				const model = { ...built.value };
				if (baseModel !== null && typeof baseModel === "object") {
					model.updatedAt = now;
					if (typeof baseModel.createdAt === "number" && Number.isFinite(baseModel.createdAt)) model.createdAt = baseModel.createdAt;
					model.isDefault = baseModel.isDefault === true;
				}
				return { ok: built.errors.length === 0, errors: built.errors, model };
			}

			/**
			 * 表单校验：把错误按字段摊平，供字段下方红字直接取用（design 3「校验错误」）。
			 * @param form 表单
			 * @param baseModel 编辑态原条目，新增态传 null
			 * @param options 可含 now
			 * @returns {{ ok: boolean, errors: object, list: Array, model: object }}
			 */
			function validateForm(form, baseModel, options) {
				const built = modelFromForm(form, baseModel, options);
				const errors = {};
				for (const item of built.errors) {
					if (errors[item.field] === undefined) errors[item.field] = item.message;
				}
				return { ok: built.ok, errors, list: built.errors, model: built.model };
			}

			/**
			 * 校验结果 → 可读的错误条目：同一字段只留第一条，字段名换成中文显示名。
			 * 入参既可以是 modelFromForm 的 [{field,message}]，也可以是 validateForm 摊平后的 {field: message}。
			 * @returns {Array<{ field: string, label: string, message: string }>}
			 */
			function formErrorEntries(errors) {
				const items = [];
				if (Array.isArray(errors)) {
					for (const item of errors) {
						if (item !== null && typeof item === "object" && typeof item.field === "string") {
							items.push({ field: item.field, message: typeof item.message === "string" ? item.message : "" });
						}
					}
				} else if (errors !== null && typeof errors === "object") {
					for (const field of Object.keys(errors)) {
						const message = errors[field];
						items.push({ field, message: typeof message === "string" ? message : "" });
					}
				}
				const seen = new Set();
				const entries = [];
				for (const item of items) {
					if (seen.has(item.field)) continue;
					seen.add(item.field);
					entries.push({
						field: item.field,
						label: Object.prototype.hasOwnProperty.call(FORM_FIELD_LABELS, item.field) ? FORM_FIELD_LABELS[item.field] : item.field,
						message: item.message
					});
				}
				return entries;
			}

			/**
			 * 校验结果 → 一句人话（提交失败时写进提示条）。
			 * 形如「还差 2 项：地址（不是合法的绝对 URL）、密钥（请填写 API 密钥）」；没有错误时返回空串。
			 * @returns {string}
			 */
			function formErrorSummaryText(errors) {
				const entries = formErrorEntries(errors);
				if (entries.length === 0) return "";
				return "还差 " + String(entries.length) + " 项：" + entries.map((item) => item.label + "（" + item.message + "）").join("、");
			}

			/** 校验是否放行（保存按钮不再靠它禁用，只作为「现在能不能直接提交」的判定）。 */
			function canSaveForm(form, baseModel, options) {
				return validateForm(form, baseModel, options).ok === true;
			}

			/** 密钥显示：只露末 4 位；没有密钥时给固定文案。 */
			function displayApiKey(model) {
				const key = model !== null && typeof model === "object" && typeof model.apiKey === "string" ? model.apiKey : "";
				if (key.trim() === "") return NO_KEY_TEXT;
				return maskApiKey(key);
			}

			/** 补零到两位。 */
			function pad2(value) {
				return value < 10 ? "0" + String(value) : String(value);
			}

			/**
			 * 「最近修改」文案。
			 * @param timestamp 毫秒时间戳
			 * @param date 可选注入的 Date（单测用，保证跨时区可复现）
			 * @returns 形如「最近修改 10-21 16:30」；时间戳缺失时为「最近修改 —」
			 */
			function formatUpdatedAt(timestamp, date) {
				const value = typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
				if (value === 0) return "最近修改 —";
				const moment = date instanceof Date ? date : new Date(value);
				if (Number.isNaN(moment.getTime())) return "最近修改 —";
				return "最近修改 " + pad2(moment.getMonth() + 1) + "-" + pad2(moment.getDate()) + " " + pad2(moment.getHours()) + ":" + pad2(moment.getMinutes());
			}

			/** 默认标记：● 默认 / ○ 非默认（design 2.1 列表区）。 */
			function defaultMarker(model) {
				return model !== null && typeof model === "object" && model.isDefault === true ? "\u25cf" : "\u25cb";
			}

			/** 默认标记的无障碍文案。 */
			function markerLabel(model) {
				return model !== null && typeof model === "object" && model.isDefault === true ? "当前默认模型" : "设为默认模型";
			}

			/**
			 * 行数据装配：列表区一行要显示的全部文本（不在渲染里现算，便于单测）。
			 * @param model 模型条目
			 * @returns {{ id, marker, markerLabel, name, model, key, endpoint, updated, meta }}
			 */
			function rowSummary(model) {
				const source = model !== null && typeof model === "object" ? model : {};
				const name = typeof source.name === "string" && source.name !== "" ? source.name : "未命名模型";
				const key = displayApiKey(source);
				const endpoint = typeof source.endpoint === "string" ? source.endpoint : "";
				const updated = formatUpdatedAt(source.updatedAt);
				const parts = [key];
				if (key === NO_KEY_TEXT && endpoint !== "") parts.push(endpoint);
				parts.push(updated);
				return {
					id: typeof source.id === "string" ? source.id : "",
					marker: defaultMarker(source),
					markerLabel: markerLabel(source),
					name,
					model: typeof source.model === "string" ? source.model : "",
					key,
					endpoint,
					updated,
					meta: parts.join(" \u00b7 ")
				};
			}

			/** 计数文案：共 N 条 / 上限 20（design 2.1）。 */
			function countText(count) {
				const size = typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
				return "共 " + size + " 条 / 上限 " + MODEL_LIMIT;
			}

			/** 还能不能再加一条。 */
			function canAddModel(models) {
				const list = Array.isArray(models) ? models : [];
				return list.length < MODEL_LIMIT;
			}

			/** 不能加时的原因文案（能加时为空串）。 */
			function limitReason(models) {
				return canAddModel(models) ? "" : "最多 " + MODEL_LIMIT + " 个模型";
			}

			/**
			 * 找出内容完全相同的条目（同样的地址 + 密钥 + 模型名）。
			 * 重复提交的幂等判定就落在这里：同内容不产生第二条（design 2.2 无重复条目）。
			 * @param models 现有列表
			 * @param model 待加入条目
			 * @returns 命中的条目或 null
			 */
			function findSameModel(models, model) {
				const list = Array.isArray(models) ? models : [];
				const source = model !== null && typeof model === "object" ? model : {};
				const endpoint = typeof source.endpoint === "string" ? source.endpoint : "";
				const apiKey = typeof source.apiKey === "string" ? source.apiKey : "";
				const name = typeof source.model === "string" ? source.model : "";
				// 密钥可为空（本地 Ollama / LM Studio），空串照常参与比较，但不再作为参与去重的前提。
				if (endpoint === "" || name === "") return null;
				for (const item of list) {
					if (item === null || typeof item !== "object") continue;
					if (item.endpoint === endpoint && item.apiKey === apiKey && item.model === name) return item;
				}
				return null;
			}

			/**
			 * 追加一条模型（幂等 + 上限 + 无默认时自动设为默认，全部由 upsertModel 兜底）。
			 * @param models 现有列表
			 * @param model 待加入条目
			 * @returns {{ models: Array, added: boolean, reason: string, id: string }}
			 *          reason: "" 成功 / "duplicate" 同内容已存在 / "limit" 已达上限 / "invalid" 校验未通过
			 */
			function addModelToList(models, model) {
				const list = normalizeModelList(models).models;
				if (list.length >= MODEL_LIMIT) return { models: list, added: false, reason: "limit", id: "" };
				const same = findSameModel(list, model);
				if (same !== null) return { models: list, added: false, reason: "duplicate", id: same.id };
				const next = upsertModel(list, model);
				const added = next.length > list.length;
				if (!added) return { models: next, added: false, reason: "invalid", id: "" };
				const entry = next[next.length - 1];
				return { models: next, added: true, reason: "", id: entry.id };
			}

			/**
			 * 原位更新一条模型（id 不在列表里就什么都不改）。
			 * @param models 现有列表
			 * @param model 新条目
			 * @param options 可含 now（注入时间戳）
			 * @returns {{ models: Array, updated: boolean }}
			 */
			function updateModelInList(models, model, options) {
				const list = normalizeModelList(models).models;
				const source = model !== null && typeof model === "object" ? model : {};
				const exists = list.some((item) => item.id === source.id);
				if (!exists) return { models: list, updated: false };
				const injected = options !== null && typeof options === "object" && Number.isFinite(options.now) ? options.now : null;
				const now = injected === null ? Date.now() : injected;
				return { models: upsertModel(list, { ...source, updatedAt: now }), updated: true };
			}

			/**
			 * 删除一条模型：删掉默认模型时默认迁移到首条；删空时引擎回落本地（design 2.2「删除」）。
			 * @param models 现有列表
			 * @param settings 当前设置
			 * @param id 待删除条目 id
			 * @returns {{ models: Array, settings: object, notices: string[], removed: boolean }}
			 */
			function deleteModelFromList(models, settings, id) {
				const list = normalizeModelList(models).models;
				let nextSettings = normalizeConfig(settings);
				const removed = list.find((item) => item.id === id) || null;
				if (removed === null) return { models: list, settings: nextSettings, notices: [], removed: false };
				const kept = removeModel(list, id);
				if (kept.length === 0) {
					nextSettings = normalizeConfig({ ...nextSettings, engine: "local" });
					return { models: kept, settings: nextSettings, notices: ["已删除全部模型，引擎已回落到本地"], removed: true };
				}
				const notices = [];
				if (removed.isDefault === true) {
					const successor = kept.find((item) => item.isDefault === true) || kept[0];
					notices.push("默认模型已切换为 " + successor.name);
				}
				return { models: kept, settings: nextSettings, notices, removed: true };
			}

			/**
			 * 切换默认模型：命中项为 true，其余一律 false。
			 * @param models 现有列表
			 * @param id 目标条目 id
			 * @returns {{ models: Array, changed: boolean }}
			 */
			function chooseDefaultModel(models, id) {
				const list = normalizeModelList(models).models;
				const next = setDefaultModel(list, id);
				const changed = next.some((item) => item.id === id && item.isDefault === true);
				return { models: next, changed };
			}

			/**
			 * 改一个行为设置：非法取值退回默认值（不会写进 localStorage）。
			 * @param settings 当前设置
			 * @param key strength / locale / engine / mergeMode
			 * @param value 新取值
			 * @returns 新的四键设置
			 */
			function applySetting(settings, key, value) {
				const current = normalizeConfig(settings);
				const merged = normalizeConfig({ ...current, [key]: value });
				if (key !== "engine") return merged;
				// engine 多一档 auto：normalizeConfig 还没认识它时也必须留住，不能悄悄退回默认值
				if (ENGINE_OPTIONS_CLIENT.indexOf(value) >= 0 && merged.engine !== value) return { ...merged, engine: value };
				return merged;
			}

			/**
			 * 引擎解析：auto 按「有没有默认模型」当场定档（不给提示），llm 缺模型回落本地并给提示文案。
			 * auto 要读原始入参：normalizeConfig 未必认识这一档（配置层并行补白名单），读它才不会误判成 local。
			 * @param settings 当前设置
			 * @param models 现有列表
			 * @returns {{ settings: object, notice: string }}
			 */
			function resolveEngine(settings, models) {
				const current = normalizeConfig(settings);
				const list = Array.isArray(models) ? models : [];
				const hasDefault = list.some((item) => item !== null && typeof item === "object" && item.isDefault === true);
				const raw = settings !== null && typeof settings === "object" && typeof settings.engine === "string" ? settings.engine : "";
				const engine = raw === "auto" ? "auto" : current.engine;
				if (engine === "auto") {
					// auto 是用户选定的档位，必须原样留存 —— 把它折成 local/llm 会让三档控件点回原处（选了 auto 界面仍停在 local）。
					return { settings: { ...current, engine: "auto" }, effective: hasDefault ? "llm" : "local", notice: "" };
				}
				if (engine === "llm" && !hasDefault) {
					return { settings: normalizeConfig({ ...current, engine: "local" }), effective: "local", notice: "未选择默认模型，已回退本地引擎" };
				}
				return { settings: current, effective: engine === "llm" ? "llm" : "local", notice: "" };
			}

			/** 当前默认模型的 id（优化请求体的 providerId；没有默认模型时为空串）。 */
			function providerIdOf(models) {
				const list = Array.isArray(models) ? models : [];
				const found = list.find((item) => item !== null && typeof item === "object" && item.isDefault === true);
				if (found === undefined) return "";
				return typeof found.id === "string" ? found.id : "";
			}

			/**
			 * 旧配置导入判定（design 2.3）：旧键有内容、能迁出一条合法模型、且列表里还没有同一条时才提示。
			 * @param legacyText localStorage 里 CONFIG_KEY 的原文
			 * @param models 现有列表
			 * @returns {{ show: boolean, canImport: boolean, text: string, entry: object|null }}
			 */
			function legacyConfigPrompt(legacyText, models) {
				const hidden = { show: false, canImport: false, text: "", entry: null };
				if (typeof legacyText !== "string" || legacyText.trim() === "") return hidden;
				let parsed = null;
				try {
					parsed = JSON.parse(legacyText);
				} catch (error) {
					return hidden;
				}
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return hidden;
				const hasModel = LEGACY_MODEL_FIELDS.some((field) => typeof parsed[field] === "string" && parsed[field].trim() !== "");
				if (!hasModel) return hidden;
				const migrated = migrateConfig(parsed);
				if (migrated.models.length === 0) return hidden;
				const entry = migrated.models[0];
				const list = normalizeModelList(models).models;
				if (findSameModel(list, entry) !== null) return hidden;
				if (list.length >= MODEL_LIMIT) {
					return { show: true, canImport: false, text: "检测到旧版配置，但已达 " + MODEL_LIMIT + " 条上限，请先删除一条", entry };
				}
				return { show: true, canImport: true, text: "检测到旧版配置，是否导入为一个模型条目？", entry };
			}

			/**
			 * 旧配置能迁出的模型条目（[导入] 按钮用；walk 的仍是 migrateConfig，不重复实现迁移规则）。
			 * @param legacyText localStorage 里 CONFIG_KEY 的原文
			 * @returns 模型条目数组（迁不出来时为空数组）
			 */
			function legacyModels(legacyText) {
				if (typeof legacyText !== "string" || legacyText.trim() === "") return [];
				let parsed = null;
				try {
					parsed = JSON.parse(legacyText);
				} catch (error) {
					return [];
				}
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
				return migrateConfig(parsed).models;
			}

			/** 读取损坏提示：loadModels 返回 corrupt=true 时（design 2.3）。 */
			function corruptNotice(state) {
				const corrupt = state !== null && typeof state === "object" && state.corrupt === true;
				return { show: corrupt, text: corrupt ? "检测到损坏的旧配置，已备份" : "" };
			}

			/** 迁移完成提示：loadModels 返回 migrated=true 时。 */
			function migratedNotice(state) {
				const migrated = state !== null && typeof state === "object" && state.migrated === true;
				return { show: migrated, text: migrated ? "已从旧版配置迁移到多模型配置" : "" };
			}

			/**
			 * 落盘失败提示（无痕模式 / 配额满）：内存值继续可用（design 2.3）。
			 * @param result saveModels 的返回
			 * @returns {{ show: boolean, text: string }}
			 */
			function storageNotice(result) {
				const failed = result === null || result === undefined || typeof result !== "object" ? true : result.ok !== true;
				return { show: failed, text: failed ? "配置未能保存，关闭后将丢失" : "" };
			}

			/**
			 * 宿主模型接口缺失提示：GET 探测失败时面板降级为只读展示（不因路由缺失而消失/抛错）。
			 * @param status "unknown" / "ready" / "missing"
			 * @returns {{ show: boolean, text: string }}
			 */
			function hostNotice(status) {
				if (status === "missing") {
					return { show: true, text: "宿主未提供模型接口，当前使用 patch 配置的单一地址（面板只读展示）" };
				}
				return { show: false, text: "" };
			}

			/** 从宿主错误文案里抽出上游真实状态码（宿主把上游非 2xx 包成 502 + 「上游返回 401」）。 */
			function upstreamStatusOf(errorText) {
				if (typeof errorText !== "string") return 0;
				const matched = /\u4e0a\u6e38\u8fd4\u56de\s*(\d{3})/.exec(errorText);
				if (matched === null) return 0;
				const code = Number(matched[1]);
				return Number.isFinite(code) ? code : 0;
			}

			/**
			 * 测试连接失败 → 原因分类文案（地址不可达 / 401 密钥无效 / 404 路径不对 / 超时）。
			 * 只看状态码与网络错误类别，永远不碰密钥。
			 * @param outcome probeConnection 的返回（{ ok, status, error, kind }）
			 * @returns {{ code: string, text: string }}
			 */
			function classifyTestFailure(outcome) {
				const source = outcome !== null && typeof outcome === "object" ? outcome : {};
				const kind = typeof source.kind === "string" ? source.kind : "";
				if (kind === "timeout") return { code: "timeout", text: "超时" };
				if (kind === "network") return { code: "network", text: "地址不可达" };
				const status = typeof source.status === "number" && Number.isFinite(source.status) ? source.status : 0;
				if (status === 0) return { code: "network", text: "地址不可达" };
				const upstream = upstreamStatusOf(source.error);
				const code = upstream === 0 ? status : upstream;
				if (code === 401 || code === 403) return { code: "unauthorized", text: code + " 密钥无效" };
				if (code === 404) return { code: "notfound", text: "404 路径不对" };
				if (code === 408 || code === 504) return { code: "timeout", text: "超时" };
				if (status === 501) return { code: "unregistered", text: "宿主未登记该模型，请先保存后再测" };
				return { code: "upstream", text: code + " 上游返回异常" };
			}

			/**
			 * 测试连接结果 → 行内文案（成功绿字带耗时，失败红字带状态码与分类）。
			 * @param outcome probeConnection 的返回
			 * @returns {{ tone: "ok"|"error", text: string }}
			 */
			function summarizeTest(outcome) {
				const source = outcome !== null && typeof outcome === "object" ? outcome : {};
				if (source.ok === true) {
					const duration = typeof source.durationMs === "number" && Number.isFinite(source.durationMs) ? Math.round(source.durationMs) : 0;
					return { tone: "ok", text: "连接正常 \u00b7 " + duration + "ms" };
				}
				return { tone: "error", text: "连接失败 \u00b7 " + classifyTestFailure(source).text };
			}

			/** 空态文案（design 3「空态」）。 */
			function emptyModelsText() {
				return "还没有配置模型。默认使用本地引擎，无需配置即可用。";
			}

			return { FORM_FIELDS: FORM_FIELDS, FORM_FIELD_LABELS: FORM_FIELD_LABELS, ENGINE_OPTIONS_CLIENT: ENGINE_OPTIONS_CLIENT, ENGINE_LABELS_CLIENT: ENGINE_LABELS_CLIENT, NO_KEY_TEXT: NO_KEY_TEXT, emptyForm: emptyForm, formFromModel: formFromModel, formWithField: formWithField, resolvedFormKey: resolvedFormKey, formCandidate: formCandidate, modelFromForm: modelFromForm, validateForm: validateForm, formErrorEntries: formErrorEntries, formErrorSummaryText: formErrorSummaryText, canSaveForm: canSaveForm, displayApiKey: displayApiKey, formatUpdatedAt: formatUpdatedAt, defaultMarker: defaultMarker, markerLabel: markerLabel, rowSummary: rowSummary, countText: countText, canAddModel: canAddModel, limitReason: limitReason, findSameModel: findSameModel, addModelToList: addModelToList, updateModelInList: updateModelInList, deleteModelFromList: deleteModelFromList, chooseDefaultModel: chooseDefaultModel, applySetting: applySetting, resolveEngine: resolveEngine, providerIdOf: providerIdOf, legacyConfigPrompt: legacyConfigPrompt, legacyModels: legacyModels, corruptNotice: corruptNotice, migratedNotice: migratedNotice, storageNotice: storageNotice, hostNotice: hostNotice, upstreamStatusOf: upstreamStatusOf, classifyTestFailure: classifyTestFailure, summarizeTest: summarizeTest, emptyModelsText: emptyModelsText };
		})(__m2.MODEL_LIMIT, __m2.normalizeConfig, __m2.normalizeModelList, __m2.validateModel, __m2.upsertModel, __m2.removeModel, __m2.setDefaultModel, __m2.maskApiKey, __m2.migrateConfig);

		// src/client/overlays.js
		var __m4 = (function (preventFocusSteal, copyText, STRENGTH_OPTIONS, LOCALE_OPTIONS, MERGE_MODE_OPTIONS, canAddModel, limitReason, emptyModelsText, rowSummary, formErrorEntries, ENGINE_OPTIONS_CLIENT, ENGINE_LABELS_CLIENT) {
			/**
			 * 浮层渲染：小条 / 对比面板 / 设置面板 / 错误提示。
			 *
			 * 硬约定（为什么都塞进同一个组件）：conversation.input.activity 是 single 槽，
			 * 再注册第二个槽会互相遮蔽，所以浮层不新增槽位 —— 它们全部由入口组件自己渲染，
			 * 用 position:fixed（类名里已声明）+ 按钮的 getBoundingClientRect() 定位。
			 *
			 * 这里只放无状态渲染；状态机、落盘与网络副作用都在 button.js，纯规则在 settings.js。
			 */

			const STRENGTH_LABELS = { light: "轻", standard: "标准", deep: "深度" };
			const LOCALE_LABELS = { zh: "中文", en: "English" };
			const MERGE_LABELS = { strict: "严格", lenient: "宽松" };

			const PANEL_TITLE = "提示词优化";

			/** 编辑器关心的按键：不许冒泡到宿主输入框（Enter 会触发发送，Backspace/方向键会穿透过去改草稿）。 */
			function stopHostKeys(event) {
				if (event === null || event === undefined) return;
				const key = typeof event.key === "string" ? event.key : "";
				if (key === "Escape") return; // Esc 仍归浮层自己的关闭逻辑
				if (key === "Enter") {
					if (typeof event.preventDefault === "function") event.preventDefault();
					if (typeof event.stopPropagation === "function") event.stopPropagation();
					return;
				}
				if (key === "Backspace" || key === "Delete" || key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
					if (typeof event.stopPropagation === "function") event.stopPropagation();
				}
			}

			/** 复制按钮：复制成功/失败只改自己的文案，不弹窗、不 throw。 */
			function CopyButton({ text, label, action }) {
				const [status, setStatus] = react.useState("idle");
				const onClick = (event) => {
					preventFocusSteal(event);
					copyText(text).then((ok) => {
						setStatus(ok === true ? "copied" : "failed");
					});
				};
				return react.createElement("button", {
					type: "button",
					className: "dsh-po-link",
					"data-dsh-po-action": action,
					"aria-label": label,
					onMouseDown: preventFocusSteal,
					onClick
				}, status === "copied" ? "已复制" : status === "failed" ? "复制失败" : label);
			}

			function closeButton(action, label, onClose) {
				return react.createElement("button", {
					key: "close",
					type: "button",
					className: "dsh-po-close",
					"data-dsh-po-action": action,
					"aria-label": label,
					onMouseDown: preventFocusSteal,
					onClick: onClose
				}, "\u00d7");
			}

			/**
			 * 优化成功小条：已优化 · 查看对比 · 还原原文。
			 * @param props.onCompare 打开对比面板
			 * @param props.onRestore 还原原文
			 * @param props.onDismiss 关闭小条
			 * @param props.note engine=llm 回退本地时的具体原因（空串 = 没有回退）
			 */
			function StatusToast({ style, note, guard, onCompare, onRestore, onDismiss }) {
				const fallbackNote = typeof note === "string" && note !== "";
				const guardText = guard !== null && guard !== undefined && typeof guard.notice === "string" ? guard.notice : "";
				const guardLevel = guard !== null && guard !== undefined && typeof guard.level === "string" ? guard.level : "none";
				const guardClass = guardLevel === "warning" ? "dsh-po-note dsh-po-note-warn" : "dsh-po-note";
				return react.createElement("div", {
					className: fallbackNote ? "dsh-po-toast dsh-po-toast-wrap" : "dsh-po-toast",
					"data-dsh-po-overlay": "toast",
					role: "status",
					style
				}, [
					react.createElement("span", {
						key: "msg",
						className: "dsh-po-msg"
					}, "已优化"),
					fallbackNote
						? react.createElement("span", { key: "note", className: "dsh-po-note", "data-dsh-po-role": "llm-fallback" }, note)
						: null,
					guardText === ""
						? null
						: react.createElement("span", {
							key: "guard",
							className: guardClass,
							"data-dsh-po-role": "conservation",
							"data-dsh-po-level": guardLevel
						}, guardText),
					react.createElement("button", {
						key: "compare",
						type: "button",
						className: "dsh-po-link",
						"data-dsh-po-action": "compare",
						onMouseDown: preventFocusSteal,
						onClick: onCompare
					}, "查看对比"),
					react.createElement("span", { key: "dot", className: "dsh-po-hint", "aria-hidden": true }, "\u00b7"),
					react.createElement("button", {
						key: "restore",
						type: "button",
						className: "dsh-po-link",
						"data-dsh-po-action": "restore",
						onMouseDown: preventFocusSteal,
						onClick: onRestore
					}, "还原原文"),
					closeButton("dismiss-toast", "关闭优化提示", onDismiss)
				]);
			}

			function compareColumn(key, title, text, role, copyAction, copyLabel) {
				return react.createElement("div", { key, className: "dsh-po-col" }, [
					react.createElement("div", { key: "head", className: "dsh-po-colhead" }, [
						react.createElement("span", { key: "title", className: "dsh-po-title" }, title),
						react.createElement(CopyButton, { key: "copy", text, label: copyLabel, action: copyAction })
					]),
					react.createElement("pre", {
						key: "body",
						className: "dsh-po-pre",
						"data-dsh-po-role": role
					}, text)
				]);
			}

			/**
			 * 守恒校验区：lostTokens / dropped 条数（可展开列原句）/ uncategorized / reassigned。
			 * 报告为空或 ok=true 时返回 null —— 这块不占空间。
			 */
			function ConservationBlock({ conservation }) {
				const report = conservation !== null && conservation !== undefined && typeof conservation.report === "object" && conservation.report !== null ? conservation.report : null;
				if (report === null || report.ok === true) return null;
				const dropped = Array.isArray(report.dropped) ? report.dropped : [];
				const lostTokens = Array.isArray(report.lostTokens) ? report.lostTokens : [];
				const reassigned = Array.isArray(report.reassigned) ? report.reassigned : [];
				const uncategorized = typeof report.uncategorized === "number" ? report.uncategorized : 0;
				const rows = [react.createElement("div", { key: "head", className: "dsh-po-guard-head" }, [
					react.createElement("span", { key: "title", className: "dsh-po-guard-title" }, "守恒校验未通过"),
					react.createElement("span", { key: "tag", className: "dsh-po-guard-tag" }, conservation.applied === true ? "已补回" : "已保留原样")
				])];
				if (dropped.length > 0) {
					rows.push(react.createElement("details", { key: "dropped", className: "dsh-po-guard-row" }, [
						react.createElement("summary", { key: "sum", className: "dsh-po-guard-sum" }, "丢失 " + String(dropped.length) + " 句"),
						react.createElement("ul", { key: "list", className: "dsh-po-guard-list" }, dropped.map((text, index) => react.createElement("li", {
							key: "d-" + String(index),
							className: "dsh-po-guard-item"
						}, text)))
					]));
				}
				if (lostTokens.length > 0) {
					const tokenNodes = [react.createElement("span", { key: "label", className: "dsh-po-guard-label" }, "缺失关键项 " + String(lostTokens.length) + " 个")];
					lostTokens.forEach((token, index) => {
						tokenNodes.push(react.createElement("span", { key: "t-" + String(index), className: "dsh-po-guard-tag" }, token));
					});
					rows.push(react.createElement("div", { key: "tokens", className: "dsh-po-guard-row" }, tokenNodes));
				}
				rows.push(react.createElement("div", { key: "counts", className: "dsh-po-guard-row" }, [
					react.createElement("span", { key: "uncat", className: "dsh-po-guard-label" }, "未归类 " + String(uncategorized) + " 条"),
					react.createElement("span", { key: "re", className: "dsh-po-guard-label" }, "改判 " + String(reassigned.length) + " 条")
				]));
				return react.createElement("div", {
					className: "dsh-po-guard",
					"data-dsh-po-role": "conservation",
					"data-dsh-po-level": typeof conservation.level === "string" ? conservation.level : "none"
				}, rows);
			}

			/**
			 * 对比面板：左右分栏 原文 / 优化后，等宽字体、可滚动、可分别复制。
			 * @param props.meta 一行业务摘要（强度 · 语言 · 字数变化）
			 * @param props.conservation 守恒校验兜底结果（engine.js applyGuard 的返回值；空 = 没有报告）
			 */
			function ComparePanel({ style, panelRef, meta, original, optimized, conservation, onClose }) {
				return react.createElement("div", {
					className: "dsh-po-panel",
					"data-dsh-po-overlay": "compare",
					role: "dialog",
					"aria-modal": false,
					"aria-label": PANEL_TITLE + "对比",
					style,
					ref: panelRef,
					tabIndex: -1
				}, [
					react.createElement("div", { key: "head", className: "dsh-po-head" }, [
						react.createElement("span", { key: "title", className: "dsh-po-title" }, "优化对比" + (typeof meta === "string" && meta !== "" ? " \u00b7 " + meta : "")),
						closeButton("close-compare", "关闭对比面板", onClose)
					]),
					react.createElement("div", { key: "cols", className: "dsh-po-cols" }, [
						compareColumn("original", "原文", original, "original", "copy-original", "复制原文"),
						compareColumn("optimized", "优化后", optimized, "optimized", "copy-optimized", "复制优化后")
					]),
					ConservationBlock({ conservation })
				]);
			}

			function optionRow(key, label, options, labels, current, onChange) {
				return react.createElement("div", { key, className: "dsh-po-row" }, [
					react.createElement("span", { key: "label", className: "dsh-po-rowlabel" }, label),
					react.createElement("div", { key: "seg", className: "dsh-po-seg", role: "group", "aria-label": label }, options.map((value) => {
						const active = value === current;
						return react.createElement("button", {
							key: value,
							type: "button",
							className: active ? "dsh-po-segbtn dsh-po-segbtn-on" : "dsh-po-segbtn",
							"aria-pressed": active,
							"data-dsh-po-config": key + "=" + value,
							onMouseDown: preventFocusSteal,
							onClick: (event) => {
								preventFocusSteal(event);
								onChange(key, value);
							}
						}, labels[value]);
					}))
				]);
			}

			/** 行内小按钮（测试 / 编辑 / 删除 / 取消 / 确认）。 */
			function miniButton(key, label, action, onClick, options) {
				const extra = options !== null && typeof options === "object" ? options : {};
				const className = extra.danger === true ? "dsh-po-mini dsh-po-mini-danger" : extra.strong === true ? "dsh-po-mini dsh-po-mini-strong" : "dsh-po-mini";
				return react.createElement("button", {
					key,
					type: "button",
					className,
					"data-dsh-po-action": action,
					"aria-label": typeof extra.title === "string" ? extra.title : label,
					title: typeof extra.title === "string" ? extra.title : label,
					disabled: extra.disabled === true,
					onMouseDown: preventFocusSteal,
					onClick: (event) => {
						preventFocusSteal(event);
						onClick();
					}
				}, label);
			}

			/** 顶部提示条：[动作] 最多两个。 */
			function barNode(key, tone, text, primary, secondary) {
				const children = [react.createElement("span", { key: "msg", className: "dsh-po-msg" }, text)];
				if (primary !== null && primary !== undefined) {
					children.push(miniButton("primary", primary.label, primary.action, primary.onClick, { strong: true }));
				}
				if (secondary !== null && secondary !== undefined) {
					children.push(miniButton("secondary", secondary.label, secondary.action, secondary.onClick, {}));
				}
				return react.createElement("div", {
					key,
					className: tone === "warn" ? "dsh-po-bar dsh-po-bar-warn" : "dsh-po-bar dsh-po-bar-info",
					role: "status",
					"data-dsh-po-bar": key
				}, children);
			}

			/** 表单字段：label 包住 input，字段错误就地显示在下方红字。 */
			function formField(field, label, placeholder, view, actions, wide) {
				const form = view.form !== null && typeof view.form === "object" ? view.form : {};
				const value = typeof form[field] === "string" ? form[field] : "";
				const problem = view.errors !== null && typeof view.errors === "object" ? view.errors[field] : undefined;
				const children = [
					react.createElement("span", { key: "label", className: "dsh-po-label" }, label),
					react.createElement("input", {
						key: "input",
						type: "text",
						className: "dsh-po-input",
						value,
						placeholder,
						"aria-label": label,
						"aria-invalid": problem !== undefined,
						"data-dsh-po-field": field,
						onChange: (event) => actions.changeField(field, event.target.value),
						onKeyDown: stopHostKeys
					})
				];
				if (problem !== undefined) children.push(react.createElement("span", { key: "problem", className: "dsh-po-bad" }, problem));
				return react.createElement("label", {
					key: field,
					className: wide === true ? "dsh-po-field dsh-po-field-wide" : "dsh-po-field"
				}, children);
			}

			/** 端点占位符：build 的「盘符绝对路径」自检带前置否定，协议头不会被误判，照完整字面量写。 */
			const ENDPOINT_PLACEHOLDER = "https://api.example.com/v1/chat/completions";

			/** 表单内常驻错误汇总：全部错误按「字段中文名：原因」逐行列出，无错误时整块不渲染（零占位）。 */
			function formSummaryNode(errors) {
				const entries = formErrorEntries(errors);
				if (entries.length === 0) return null;
				const rows = entries.map((item, index) => react.createElement("div", {
					key: "e-" + String(index),
					className: "dsh-po-formsummary-line",
					"data-dsh-po-field-error": item.field
				}, item.label + "：" + item.message));
				return react.createElement("div", {
					key: "summary",
					className: "dsh-po-formsummary dsh-po-field-wide",
					"data-dsh-po-role": "form-summary",
					role: "alert",
					"aria-live": "polite"
				}, [react.createElement("div", { key: "head", className: "dsh-po-formsummary-head" }, "还差 " + String(entries.length) + " 项，请检查以下字段")].concat(rows));
			}

			/** 添加/编辑表单（两列网格，长字段跨列）。 */
			function modelForm(view, actions, mode) {
				const adding = mode === "add";
				const fields = [
					formField("name", "显示名", "例如 公司网关 GPT", view, actions, true),
					formField("endpoint", "地址", ENDPOINT_PLACEHOLDER, view, actions, true),
					formField("apiKey", "密钥", adding ? "sk-..." : "留空则沿用原密钥（只显示掩码）", view, actions, true),
					formField("model", "模型名", "gpt-4o-mini", view, actions, false),
					formField("temperature", "温度", "0.2", view, actions, false),
					formField("timeoutMs", "超时(毫秒)", "30000", view, actions, true)
				];
				const foot = [
					// 保存永远可点：点不通时由 submitForm 把全部错误汇总成一句提示（禁用按钮等于点下去毫无反应）
					miniButton("save", adding ? "添加" : "保存", "submit-form", actions.submitForm, { strong: true }),
					miniButton("cancel", "取消", "cancel-form", actions.cancelForm, {}),
					react.createElement("span", { key: "hint", className: "dsh-po-hint" }, "密钥只以掩码显示；保存后立即生效，无需重启。")
				];
				const nodes = fields.slice();
				const summary = formSummaryNode(view.errors);
				if (summary !== null) nodes.push(summary);
				nodes.push(react.createElement("div", { key: "foot", className: "dsh-po-formfoot dsh-po-field-wide" }, foot));
				return react.createElement("div", { key: "form", className: "dsh-po-form" }, nodes);
			}

			/** 一条模型：●/○ + 显示名 + 模型名 / 掩码密钥 · 最近修改，行内 [测试][编辑][删除]。 */
			function modelItem(model, view, actions) {
				const summary = rowSummary(model);
				const testing = view.test !== null && typeof view.test === "object" && view.test.id === summary.id;
				const running = testing && view.test.status === "running";
				const editing = view.form !== null && typeof view.form === "object" && view.form.id === summary.id;
				const confirming = view.confirmDelete === summary.id;
				const rowChildren = [
					react.createElement("button", {
						key: "dot",
						type: "button",
						className: "dsh-po-dot",
						"data-dsh-po-action": "set-default",
						"aria-pressed": model.isDefault === true,
						"aria-label": summary.markerLabel,
						title: summary.markerLabel,
						disabled: model.isDefault === true,
						onMouseDown: preventFocusSteal,
						onClick: (event) => {
							preventFocusSteal(event);
							actions.chooseDefault(summary.id);
						}
					}, summary.marker),
					react.createElement("div", { key: "main", className: "dsh-po-itemmain" }, [
						react.createElement("div", { key: "line", className: "dsh-po-itemline" }, [
							react.createElement("span", { key: "name", className: "dsh-po-itemname", title: summary.name }, summary.name),
							react.createElement("span", { key: "tag", className: "dsh-po-itemtag", title: summary.model }, summary.model)
						]),
						react.createElement("div", { key: "meta", className: "dsh-po-itemmeta", title: summary.meta }, summary.meta)
					]),
					react.createElement("div", { key: "actions", className: "dsh-po-itemactions" }, [
						react.createElement("button", {
							key: "test",
							type: "button",
							className: "dsh-po-mini",
							"data-dsh-po-action": "test",
							"aria-label": running ? "取消连接测试" : "测试连接",
							"aria-busy": running,
							title: running ? "再次点击取消测试" : "发一条最小请求，确认地址与密钥可用",
							onMouseDown: preventFocusSteal,
							onClick: (event) => {
								preventFocusSteal(event);
								actions.test(model);
							}
						}, running
							? [react.createElement("span", { key: "spin", className: "dsh-po-spin", "aria-hidden": true }), react.createElement("span", { key: "t" }, "取消")]
							: "测试"),
						miniButton("edit", "编辑", editing ? "cancel-form" : "edit-model", () => (editing ? actions.cancelForm() : actions.startEdit(model)), { title: editing ? "收起表单" : "编辑这条模型" }),
						miniButton("delete", "删除", "delete-model", () => actions.requestDelete(summary.id), { title: "删除这条模型" })
					])
				];
				const extraChildren = [];
				if (confirming) {
					extraChildren.push(react.createElement("div", { key: "confirm", className: "dsh-po-confirm", role: "alert" }, [
						react.createElement("span", { key: "text", className: "dsh-po-msg" }, "删除后不可恢复，确认删除「" + summary.name + "」？"),
						miniButton("cancel", "取消", "cancel-delete", actions.cancelDelete, {}),
						miniButton("ok", "确认删除", "confirm-delete", actions.confirmDelete, { danger: true, strong: true })
					]));
				}
				if (testing && typeof view.test.text === "string" && view.test.text !== "") {
					extraChildren.push(react.createElement("div", {
						key: "status",
						className: view.test.status === "ok" ? "dsh-po-status dsh-po-ok" : "dsh-po-status dsh-po-bad",
						role: "status",
						"data-dsh-po-test": view.test.status
					}, view.test.text));
				}
				if (editing) extraChildren.push(modelForm(view, actions, "edit"));
				return react.createElement("div", { key: summary.id, className: "dsh-po-item", "data-dsh-po-model": summary.id }, [
					react.createElement("div", { key: "row", className: "dsh-po-itemrow" }, rowChildren)
				].concat(extraChildren));
			}

			/**
			 * 设置面板：模型 API 列表（增删改 / 切默认 / 测试连接）+ 优化行为四组。
			 * @param props.view 纯数据快照（模型、设置、表单、错误、提示条……）
			 * @param props.actions 回调集合（全部在 button.js）
			 */
			function SettingsPanel({ style, panelRef, view, actions }) {
				const models = Array.isArray(view.models) ? view.models : [];
				const bars = [];
				if (view.host !== null && typeof view.host === "object" && view.host.show === true) {
					bars.push(barNode("host", "warn", view.host.text, null, null));
				}
				if (view.storage !== null && typeof view.storage === "object" && view.storage.show === true) {
					bars.push(barNode("storage", "warn", view.storage.text, null, null));
				}
				if (view.corrupt !== null && typeof view.corrupt === "object" && view.corrupt.show === true) {
					bars.push(barNode("corrupt", "warn", view.corrupt.text, null, null));
				}
				if (view.migrated !== null && typeof view.migrated === "object" && view.migrated.show === true) {
					bars.push(barNode("migrated", "info", view.migrated.text, null, null));
				}
				if (view.legacy !== null && typeof view.legacy === "object" && view.legacy.show === true) {
					const primary = view.legacy.canImport === true ? { label: "导入", action: "import-legacy", onClick: actions.importLegacy } : null;
					bars.push(barNode("legacy", "info", view.legacy.text, primary, { label: "忽略", action: "dismiss-legacy", onClick: actions.dismissLegacy }));
				}
				if (view.enginePrompt === true) {
					bars.push(barNode("engine", "info", "已设默认模型，是否切换到 LLM 引擎？", {
						label: "切换到 LLM",
						action: "switch-engine",
						onClick: actions.switchEngine
					}, { label: "忽略", action: "dismiss-engine-prompt", onClick: actions.dismissEnginePrompt }));
				}
				if (typeof view.notice === "string" && view.notice !== "") {
					bars.push(barNode("notice", "info", view.notice, null, { label: "知道了", action: "dismiss-notice", onClick: actions.dismissNotice }));
				}

				const listNode = models.length === 0
					? react.createElement("div", { key: "empty", className: "dsh-po-empty", "data-dsh-po-role": "empty-models" }, emptyModelsText())
					: react.createElement("div", { key: "list", className: "dsh-po-list" }, models.map((model) => modelItem(model, view, actions)));

				const canAdd = canAddModel(models);
				const addRow = react.createElement("div", { key: "add", className: "dsh-po-foot" }, [
					miniButton("add", "+ 添加模型", "add-model", actions.startAdd, { strong: true, disabled: !canAdd, title: canAdd ? "新增一条模型配置" : limitReason(models) }),
					canAdd ? null : react.createElement("span", { key: "limit", className: "dsh-po-hint", "data-dsh-po-role": "model-limit" }, limitReason(models))
				]);

				const settingsNode = react.createElement("div", { key: "settings", className: "dsh-po-section" }, [
					react.createElement("div", { key: "head", className: "dsh-po-sectionhead" }, [
						react.createElement("span", { key: "title", className: "dsh-po-title" }, "优化行为"),
						react.createElement("span", { key: "hint", className: "dsh-po-count" }, "改动即时生效")
					]),
					react.createElement("div", { key: "rows", className: "dsh-po-rows" }, [
						optionRow("strength", "强度", STRENGTH_OPTIONS, STRENGTH_LABELS, view.settings.strength, actions.changeSetting),
						optionRow("locale", "语言", LOCALE_OPTIONS, LOCALE_LABELS, view.settings.locale, actions.changeSetting),
						optionRow("engine", "引擎", ENGINE_OPTIONS_CLIENT, ENGINE_LABELS_CLIENT, view.settings.engine, actions.changeSetting),
						optionRow("mergeMode", "校验", MERGE_MODE_OPTIONS, MERGE_LABELS, view.settings.mergeMode, actions.changeSetting)
					]),
					react.createElement("div", { key: "hint", className: "dsh-po-hint", "data-dsh-po-hint": view.settings.engine === "llm" ? "llm-fallback" : "local" },
						view.settings.engine === "llm"
							? "LLM 走宿主通路（/api/prompt-optimizer/optimize），按默认模型转发；未配置或调用失败时自动回退本地。"
							: "本地引擎：纯本地规则，不发任何网络请求。")
				]);

				return react.createElement("div", {
					className: "dsh-po-panel",
					"data-dsh-po-overlay": "settings",
					role: "dialog",
					"aria-modal": false,
					"aria-label": PANEL_TITLE + " · 设置",
					style,
					ref: panelRef,
					tabIndex: -1
				}, [
					react.createElement("div", { key: "head", className: "dsh-po-head" }, [
						react.createElement("span", { key: "title", className: "dsh-po-title" }, "提示词优化 · 设置"),
						view.saved === true ? react.createElement("span", { key: "saved", className: "dsh-po-hint dsh-po-saved", role: "status" }, "已保存") : null,
						closeButton("close-settings", "关闭设置面板", actions.close)
					]),
					bars.length === 0 ? null : react.createElement("div", { key: "bars", className: "dsh-po-bars" }, bars),
					react.createElement("div", { key: "body", className: "dsh-po-body" }, [
						react.createElement("div", { key: "models", className: "dsh-po-section" }, [
							react.createElement("div", { key: "head", className: "dsh-po-sectionhead" }, [
								react.createElement("span", { key: "title", className: "dsh-po-title" }, "模型 API"),
								react.createElement("span", { key: "count", className: "dsh-po-count", "data-dsh-po-role": "model-count" }, view.countLabel)
							]),
							listNode,
							view.form !== null && typeof view.form === "object" && view.form.mode === "add" ? modelForm(view, actions, "add") : null,
							addRow
						]),
						settingsNode
					])
				]);
			}

			/**
			 * 错误提示：可关闭；原文一字不动的情况下把原因说清楚。
			 */
			function ErrorBanner({ style, message, onClose }) {
				return react.createElement("div", {
					className: "dsh-po-error",
					"data-dsh-po-overlay": "error",
					role: "alert",
					style
				}, [
					react.createElement("span", { key: "msg", className: "dsh-po-msg", "data-dsh-po-role": "error-message" }, message),
					closeButton("dismiss-error", "关闭错误提示", onClose)
				]);
			}

			return { StatusToast: StatusToast, ComparePanel: ComparePanel, SettingsPanel: SettingsPanel, ErrorBanner: ErrorBanner };
		})(__m1.preventFocusSteal, __m1.copyText, __m2.STRENGTH_OPTIONS, __m2.LOCALE_OPTIONS, __m2.MERGE_MODE_OPTIONS, __m3.canAddModel, __m3.limitReason, __m3.emptyModelsText, __m3.rowSummary, __m3.formErrorEntries, __m3.ENGINE_OPTIONS_CLIENT, __m3.ENGINE_LABELS_CLIENT);

		// src/client/llm.js
		var __m5 = (function () {
			/**
			 * 客户端 → 宿主 HTTP 通路的唯一入口（纯函数，无 UI、无副作用）。
			 *
			 * 约束（本文件会被内联进 lib/client.js）：
			 *  - 纯 ESM，只依赖 fetch / AbortSignal / JSON —— 不 require 任何包；不读不写 localStorage；
			 *  - 永不抛异常：所有失败都归一成 { ok: false, ... }，error 是可以直接显示给用户的中文短句；
			 *  - 全文件只有一处 fetch：优化、模型表读写、连接测试都收敛到下面的 requestJson
			 *    （scripts/verify.mjs 断言产物里 fetch 调用恰好出现一次）。
			 */

			/** 宿主侧注册的同源路由（必须与 src/host/index.js 的 ROUTE_PATH 一致）。 */
			const ROUTE_PATH = '/api/prompt-optimizer/optimize';

			/** 宿主侧的模型表路由（必须与 src/host/index.js 的 MODELS_ROUTE_PATH 一致）。 */
			const MODELS_ROUTE_PATH = '/api/prompt-optimizer/models';

			/** 宿主侧单次上游超时是 30 秒，这里的兜底比它长，让宿主先报超时。 */
			const DEFAULT_TIMEOUT_MS = 70000;

			/** 连接测试只想知道通不通，等 60 秒足够，且可被用户取消。 */
			const PROBE_TIMEOUT_MS = 60000;

			/** 与宿主同口径的原文长度上限（字符数）。 */
			const MAX_TEXT_LENGTH = 20000;

			/** 失败文案：短句、可直显，且不含任何服务端细节。 */
			const FAILURE_TEXT = {
			  empty: '原文为空，无法优化',
			  tooLong: '原文过长（超过 20000 字符），请先精简',
			  notConfigured: '未配置 LLM 地址',
			  timeout: '服务超时，请重试',
			  network: '无法连接优化服务，请检查网络',
			  badResponse: '服务返回异常',
			  invalid: '请求无效，请重试',
			  cancelled: '已取消',
			};

			function failure(error) {
			  return { ok: false, error };
			}

			/** 只取 name：DOMException / Error 都覆盖，不依赖 instanceof。 */
			function errorName(error) {
			  return error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : '';
			}

			/** 异常 → 一行可显示文案（保留原始 message，便于宿主日志对账）。 */
			function messageOf(error) {
			  if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
			  return String(error);
			}

			function isTimeout(error) {
			  const name = errorName(error);
			  return name === 'TimeoutError' || name === 'AbortError';
			}

			/** 调用方传入的取消信号（没有就是 undefined）。 */
			function callerSignal(options) {
			  if (options === null || typeof options !== 'object') return undefined;
			  const signal = options.signal;
			  return signal === null || signal === undefined ? undefined : signal;
			}

			/** 本轮的有效信号：调用方的优先，否则按超时兜底。 */
			function resolveSignal(options, timeoutMs) {
			  const given = callerSignal(options);
			  if (given !== undefined) return given;
			  try {
			    return AbortSignal.timeout(timeoutMs);
			  } catch (error) {
			    return undefined;
			  }
			}

			/** HTTP 状态码 → 给用户看的短句。 */
			function statusError(status) {
			  if (status === 501) return FAILURE_TEXT.notConfigured;
			  if (status === 504) return FAILURE_TEXT.timeout;
			  if (status === 400) return FAILURE_TEXT.invalid;
			  return FAILURE_TEXT.badResponse;
			}

			/** 请求体：只放宿主认识的字段（绝不带 endpoint / apiKey / model，那些在宿主侧查表）。 */
			function requestPayload(rawText, options) {
			  const payload = { text: rawText };
			  const strength = options?.strength;
			  const locale = options?.locale;
			  const providerId = options?.providerId;
			  if (typeof strength === 'string' && strength !== '') payload.strength = strength;
			  if (typeof locale === 'string' && locale !== '') payload.locale = locale;
			  if (typeof providerId === 'string' && providerId !== '') payload.providerId = providerId;
			  return payload;
			}

			/**
			 * 唯一 fetch 调用点：payload 为 null 时发 GET，否则 POST JSON。
			 * 网络异常向外抛（由各调用方归类），HTTP 非 2xx 与解析失败都作为结果返回。
			 * @returns {Promise<{ ok: boolean, status: number, body: any }>}
			 */
			async function requestJson(path, payload, signal) {
			  const init = { method: payload === null ? 'GET' : 'POST' };
			  if (signal !== undefined) init.signal = signal;
			  if (payload !== null) {
			    init.headers = { 'Content-Type': 'application/json' };
			    init.body = JSON.stringify(payload);
			  }
			  const response = await fetch(path, init);
			  let body = null;
			  try {
			    body = await response.json();
			  } catch (error) {
			    body = null;
			  }
			  return {
			    ok: response.ok === true,
			    status: typeof response.status === 'number' ? response.status : 0,
			    body,
			  };
			}

			/** 路由不存在 / 宿主未挂载该接口的判定：404、405，或压根连不上宿主。 */
			function routeMissingFrom(status, thrown) {
			  if (thrown === true) return true;
			  return status === 404 || status === 405;
			}

			/**
			 * 通过宿主通路优化一段原文。
			 * @param rawText 待优化的原文
			 * @param options { strength?, locale?, providerId?, signal? }
			 * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string }>} 永不 reject
			 */
			async function optimizeViaRemote(rawText, options) {
			  try {
			    if (typeof rawText !== 'string' || rawText.trim() === '') return failure(FAILURE_TEXT.empty);
			    if (rawText.length > MAX_TEXT_LENGTH) return failure(FAILURE_TEXT.tooLong);
			    const signal = resolveSignal(options, DEFAULT_TIMEOUT_MS);
			    let outcome = null;
			    try {
			      outcome = await requestJson(ROUTE_PATH, requestPayload(rawText, options), signal);
			    } catch (error) {
			      if (signal !== undefined && signal.aborted === true && callerSignal(options) !== undefined) return failure(FAILURE_TEXT.cancelled);
			      return failure(isTimeout(error) ? FAILURE_TEXT.timeout : FAILURE_TEXT.network);
			    }
			    if (outcome.ok !== true) return failure(statusError(outcome.status));
			    const text = outcome.body !== null && typeof outcome.body === 'object' ? outcome.body.text : undefined;
			    if (typeof text !== 'string' || text.trim() === '') return failure(FAILURE_TEXT.badResponse);
			    return { ok: true, text };
			  } catch (error) {
			    return failure(FAILURE_TEXT.badResponse);
			  }
			}

			/**
			 * GET 模型表：只作为「宿主是否提供模型接口」的能力探测，**不作为权威列表**
			 * （宿主 GET 返回的 apiKey 是掩码，回传会把真密钥写坏；localStorage 才是唯一真源）。
			 * @param options { signal? }
			 * @returns {Promise<{ ok: boolean, routeMissing: boolean, status: number, schemaVersion: number, source: string, models: Array, settings: object, error: string }>} 永不 reject
			 */
			async function fetchModelTable(options) {
			  const empty = { ok: false, routeMissing: true, status: 0, schemaVersion: 0, source: '', models: [], settings: null, error: '' };
			  try {
			    const outcome = await requestJson(MODELS_ROUTE_PATH, null, resolveSignal(options, PROBE_TIMEOUT_MS));
			    if (outcome.ok !== true) {
			      const error = outcome.body !== null && typeof outcome.body === 'object' && typeof outcome.body.error === 'string' ? outcome.body.error : '';
			      return {
			        ok: false,
			        routeMissing: routeMissingFrom(outcome.status, false),
			        status: outcome.status,
			        schemaVersion: 0,
			        source: '',
			        models: [],
			        settings: null,
			        error,
			      };
			    }
			    const body = outcome.body !== null && typeof outcome.body === 'object' ? outcome.body : {};
			    return {
			      ok: true,
			      routeMissing: false,
			      status: outcome.status,
			      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 0,
			      source: typeof body.source === 'string' ? body.source : '',
			      models: Array.isArray(body.models) ? body.models : [],
			      settings: body.settings !== null && typeof body.settings === 'object' ? body.settings : null,
			      error: '',
			    };
			  } catch (error) {
			    return { ...empty, error: messageOf(error) };
			  }
			}

			/**
			 * POST 模型表：把 localStorage 里的权威列表整体推给宿主（宿主原子落盘并重新校验）。
			 * settings 只带宿主认识的四个键，多一个都会被 400 拒掉。
			 * @param payload { schemaVersion, models, settings }
			 * @param options { signal? }
			 * @returns {Promise<{ ok: boolean, routeMissing: boolean, status: number, count: number, notices: string[], error: string, code: string }>} 永不 reject
			 */
			async function saveModelTable(payload, options) {
			  const failed = { ok: false, routeMissing: true, status: 0, count: 0, notices: [], error: '', code: '' };
			  const source = payload !== null && typeof payload === 'object' ? payload : {};
			  const settings = source.settings !== null && typeof source.settings === 'object' ? source.settings : {};
			  const body = {
			    schemaVersion: typeof source.schemaVersion === 'number' ? source.schemaVersion : 2,
			    models: Array.isArray(source.models) ? source.models : [],
			    settings: {
			      strength: settings.strength,
			      locale: settings.locale,
			      engine: settings.engine,
			      mergeMode: settings.mergeMode,
			    },
			  };
			  try {
			    const outcome = await requestJson(MODELS_ROUTE_PATH, body, resolveSignal(options, PROBE_TIMEOUT_MS));
			    const parsed = outcome.body !== null && typeof outcome.body === 'object' ? outcome.body : {};
			    if (outcome.ok !== true) {
			      return {
			        ok: false,
			        routeMissing: routeMissingFrom(outcome.status, false),
			        status: outcome.status,
			        count: 0,
			        notices: [],
			        error: typeof parsed.error === 'string' ? parsed.error : '',
			        code: typeof parsed.code === 'string' ? parsed.code : '',
			      };
			    }
			    return {
			      ok: true,
			      routeMissing: false,
			      status: outcome.status,
			      count: typeof parsed.count === 'number' ? parsed.count : body.models.length,
			      notices: Array.isArray(parsed.notices) ? parsed.notices : [],
			      error: '',
			      code: '',
			    };
			  } catch (error) {
			    return { ...failed, error: messageOf(error) };
			  }
			}

			/**
			 * 连接测试：走真实的优化通路发一条最小请求（原文 ping），只看通不通。
			 * 宿主自己构造上游 messages / max_tokens，客户端无法指定 —— 这是「最小请求」在此架构下的落点。
			 * @param providerId 目标模型 id（留空则宿主回落到 config.llmEndpoint）
			 * @param options { signal? }
			 * @returns {Promise<{ ok: boolean, status: number, error: string, kind: string, durationMs: number }>} 永不 reject
			 */
			async function probeConnection(providerId, options) {
			  const started = Date.now();
			  const payload = { text: 'ping', strength: 'standard', locale: 'zh' };
			  if (typeof providerId === 'string' && providerId !== '') payload.providerId = providerId;
			  try {
			    const outcome = await requestJson(ROUTE_PATH, payload, resolveSignal(options, PROBE_TIMEOUT_MS));
			    const durationMs = Date.now() - started;
			    const body = outcome.body !== null && typeof outcome.body === 'object' ? outcome.body : {};
			    if (outcome.ok === true && typeof body.text === 'string') {
			      return { ok: true, status: outcome.status, error: '', kind: '', durationMs };
			    }
			    return {
			      ok: false,
			      status: outcome.status,
			      error: typeof body.error === 'string' ? body.error : '',
			      kind: '',
			      durationMs,
			    };
			  } catch (error) {
			    return {
			      ok: false,
			      status: 0,
			      error: messageOf(error),
			      kind: isTimeout(error) ? 'timeout' : 'network',
			      durationMs: Date.now() - started,
			    };
			  }
			}

			return { MODELS_ROUTE_PATH: MODELS_ROUTE_PATH, FAILURE_TEXT: FAILURE_TEXT, optimizeViaRemote: optimizeViaRemote, fetchModelTable: fetchModelTable, saveModelTable: saveModelTable, probeConnection: probeConnection };
		})();

		// src/client/button.js
		var __m6 = (function (getEngine, getRemote, applyGuard, anchorOf, fixedStyle, preventFocusSteal, CONFIG_KEY, SCHEMA_VERSION, loadModels, saveModels, StatusToast, ComparePanel, SettingsPanel, ErrorBanner, emptyForm, formFromModel, formWithField, validateForm, modelFromForm, countText, addModelToList, updateModelInList, deleteModelFromList, chooseDefaultModel, applySetting, resolveEngine, providerIdOf, legacyConfigPrompt, legacyModels, summarizeTest, corruptNotice, migratedNotice, storageNotice, hostNotice, formErrorSummaryText, fetchModelTable, saveModelTable, probeConnection) {
			/**
			 * 一键提示词优化 —— 入口组件与状态机。
			 *
			 * 状态机（单一 phase，不叠布尔）：
			 *   idle    -- 草稿 trim 非空才可点；按钮 ✦ 优化提示词
			 *   loading -- 点击后**同步**进入（setPhase 早于任何计算）；按钮转圈 + disabled
			 *   done    -- setDraft(优化结果) 成功后进入；按钮变 ↺ 还原原文，浮出小条
			 *   error   -- 任何异常 / ok:false / setDraft 返回 false / 草稿在加载期间被改动
			 *              一律**不调用 setDraft**，原文一字不动，给出可关闭的错误提示
			 *
			 * 「重复点击不叠加」由两条迁移保证：
			 *   loading --(重复点击)--> loading（runRef 令牌非空，直接 return，零副作用）
			 *   done    --(点击按钮)--> idle（按钮在 done 态已经不是「优化」而是「还原」）
			 *
			 * 设置面板（v0.2）：模型表以 localStorage 为唯一真源，改动即时落盘并顺手推给宿主
			 * （宿主是上游请求的实际转发方，它必须认识 providerId）；宿主没提供模型路由时面板
			 * 降级为只读展示，不抛错、不隐藏按钮。
			 *
			 * react 由构建产物在 factory 作用域注入（整个产物只对外部依赖 react 做一次加载），
			 * 所以本文件只声明 import react，构建器把它统一接到 factory 作用域的那个绑定上。
			 */

			const IDLE = "idle";
			const LOADING = "loading";
			const DONE = "done";
			const ERROR = "error";

			const PANEL_WIDTH = 620; // 对比/设置面板的宽度上限，定位夹取与 CSS 兜底用同一个数
			const STRENGTH_TEXT = { light: "轻", standard: "标准", deep: "深度" };
			const LOCALE_TEXT = { zh: "中文", en: "English" };
			const REASON_TEXT = { empty: "草稿为空", unsupported: "输入不是文本" };

			const SAVED_FLASH_MS = 2000; // 「已保存」只亮 2 秒（design 3「已保存」）

			/** 异常 → 一行人类可读信息（不吞掉原始 message）。 */
			function describe(cause) {
				if (cause !== null && cause !== undefined && typeof cause.message === "string" && cause.message !== "") return cause.message;
				return String(cause);
			}

			/** 拿写回动作：编辑器没有 setDraft 时返回 null（调用方据此走错误路径）。 */
			function writerOf(inputActions) {
				if (inputActions === null || inputActions === undefined) return null;
				if (typeof inputActions.setDraft !== "function") return null;
				return inputActions.setDraft;
			}

			/** 一轮的取消器：没有 AbortController 时返回 null（LLM 调用退化为不可取消）。 */
			function newAbort() {
				if (typeof AbortController !== "function") return null;
				try {
					return new AbortController();
				} catch (cause) {
					return null;
				}
			}

			/** 对比面板标题行：强度 · 语言 · 字数变化。 */
			function resultMeta(result) {
				if (result === null || typeof result !== "object") return "";
				const strength = STRENGTH_TEXT[result.strength] || String(result.strength);
				const locale = LOCALE_TEXT[result.locale] || String(result.locale);
				return strength + " · " + locale + " · " + result.originalLength + " → " + result.optimizedLength + " 字";
			}

			/** 旧键 CONFIG_KEY 的原文（只读；用来判断要不要提示「旧版配置」）。 */
			function legacyTextFromStorage() {
				try {
					if (typeof localStorage === "undefined" || localStorage === null) return "";
					const text = localStorage.getItem(CONFIG_KEY);
					return typeof text === "string" ? text : "";
				} catch (cause) {
					return "";
				}
			}

			/** 初始设置面板状态：一次读出模型表 + 设置，并把引擎兜底/旧配置提示算好。 */
			function initialModelState() {
				const loaded = loadModels();
				const engine = resolveEngine(loaded.settings, loaded.models);
				const legacyText = legacyTextFromStorage();
				return {
					models: loaded.models,
					settings: engine.settings,
					corrupt: loaded.corrupt === true,
					migrated: loaded.migrated === true,
					writeFailed: false,
					legacyText,
					legacy: legacyConfigPrompt(legacyText, loaded.models),
					hostStatus: "unknown",
					notice: engine.notice,
					enginePrompt: false
				};
			}

			/**
			 * 提示词优化入口按钮（conversation.input.activity 的唯一占用者）。
			 *
			 * 草稿只通过 useInput 读原始值（不在这里 trim 出新字符串，避免每次 store 更新都
			 * 造出新引用把按钮带走重渲染）；判空在渲染期现算。
			 *
			 * @param props.sessionId 会话标识（仅用于日志语义，不参与状态迁移）
			 * @param props.useInput 宿主的草稿选择器
			 * @param props.inputActions 宿主写回动作（setDraft）
			 * @param props.locked 会话锁定态
			 * @param props.onActiveChange 宿主激活回调（本组件不改变宿主激活态，故不调用）
			 * @param props.t 宿主翻译函数（本插件未声明 locale 座位，故不使用）
			 * @returns 按钮 + 至多一个浮层
			 */
			function PromptOptimizerButton({ sessionId, useInput, inputActions, locked, onActiveChange, t }) {
				const draft = useInput((state) => state && state.draft);

				const [phase, setPhase] = react.useState(IDLE);
				const [result, setResult] = react.useState(null);
				const [error, setError] = react.useState("");
				const [panel, setPanel] = react.useState("none");
				const [toastOpen, setToastOpen] = react.useState(true);
				const [modelState, setModelState] = react.useState(initialModelState);
				const [form, setForm] = react.useState(null); // null | { mode: "add"|"edit", modelId, values }
				const [confirmDelete, setConfirmDelete] = react.useState("");
				const [testState, setTestState] = react.useState({ id: "", status: "idle", text: "" });
				const [saved, setSaved] = react.useState(false);
				const [anchor, setAnchor] = react.useState(null);

				// 渲染期同步的镜像：异步续体（setTimeout / await 之后）只能从这里读到最新值
				const draftRef = react.useRef(draft);
				draftRef.current = draft;
				const stateRef = react.useRef(modelState);
				stateRef.current = modelState;
				const configRef = react.useRef(modelState.settings);
				configRef.current = modelState.settings;
				const runRef = react.useRef(null); // 正在跑的一轮令牌；null = 空闲。既是重入闸门也是结果凭据
				const timerRef = react.useRef(null);
				const flashRef = react.useRef(null);
				const testRef = react.useRef(""); // 正在测试的模型 id；空串 = 没有测试在跑
				const testAbortRef = react.useRef(null);
				const rootRef = react.useRef(null);
				const panelRef = react.useRef(null);

				const refreshAnchor = react.useCallback(() => {
					setAnchor(anchorOf(rootRef.current));
				}, []);

				// 同一时刻最多一个浮层：面板 > 错误 > 小条
				const overlay = panel !== "none" ? panel : error !== "" ? "error" : phase === DONE && toastOpen ? "toast" : "none";
				// 面板类浮层自带宽度上限（左侧夹取要用它），小条/错误条交给 CSS 自适应
				const overlayStyle = react.useMemo(
					() => fixedStyle(anchor, overlay === "compare" || overlay === "settings" ? PANEL_WIDTH : 0),
					[anchor, overlay]
				);

				react.useEffect(() => {
					if (overlay === "none") {
						setAnchor(null);
						return undefined;
					}
					refreshAnchor();
					if (typeof window === "undefined" || window === null || typeof window.addEventListener !== "function") return undefined;
					const onViewportChange = () => refreshAnchor();
					window.addEventListener("resize", onViewportChange);
					window.addEventListener("scroll", onViewportChange, true);
					return () => {
						window.removeEventListener("resize", onViewportChange);
						window.removeEventListener("scroll", onViewportChange, true);
					};
				}, [overlay, refreshAnchor]);

				react.useEffect(() => {
					if (overlay === "none") return undefined;
					if (panelRef.current !== null && typeof panelRef.current.focus === "function") panelRef.current.focus();
					if (typeof document === "undefined" || document === null || typeof document.addEventListener !== "function") return undefined;
					// Esc 只关掉当前这一层浮层（面板 → 错误 → 小条），不连带清空别的状态
					const onKeyDown = (event) => {
						if (event === null || event === undefined || event.key !== "Escape") return;
						preventFocusSteal(event);
						if (overlay === "compare" || overlay === "settings") setPanel("none");
						else if (overlay === "error") setError("");
						else setToastOpen(false);
					};
					const onPointerDown = (event) => {
						const node = rootRef.current;
						const target = event === null || event === undefined ? null : event.target;
						if (node !== null && node !== undefined && typeof node.contains === "function" && target !== null && node.contains(target)) return;
						setPanel("none");
					};
					document.addEventListener("keydown", onKeyDown);
					document.addEventListener("mousedown", onPointerDown, true);
					return () => {
						document.removeEventListener("keydown", onKeyDown);
						document.removeEventListener("mousedown", onPointerDown, true);
					};
				}, [overlay]);

				// 卸载时撤销未完成的定时器与令牌：迟到的续体不会再碰宿主
				react.useEffect(() => () => {
					if (timerRef.current !== null) {
						clearTimeout(timerRef.current);
						timerRef.current = null;
					}
					if (flashRef.current !== null) {
						clearTimeout(flashRef.current);
						flashRef.current = null;
					}
					testRef.current = "";
					testAbortRef.current = null;
					abandon();
				}, []);

				function closePanel() {
					setPanel("none");
				}

				/** 放弃在途的一轮：作废令牌 + 取消 LLM 请求（迟到的结果会被令牌挡掉）。 */
				function abandon() {
					const current = runRef.current;
					runRef.current = null;
					if (current === null || current.controller === null || typeof current.controller.abort !== "function") return;
					try {
						current.controller.abort();
					} catch (cause) {
						// 取消失败不影响状态：令牌已经作废
					}
				}

				/** 错误收口：清掉 done 数据、绝不动草稿。 */
				function fail(message) {
					runRef.current = null;
					setResult(null);
					setToastOpen(false);
					setError(message);
					setPhase(ERROR);
				}

				/** 进入 loading：快照原文 + 同步 setState，全部早于任何计算。 */
				function startOptimize() {
					if (locked === true) return;
					if (runRef.current !== null) return; // 加载中重复点击：零副作用
					const source = typeof draftRef.current === "string" ? draftRef.current : "";
					if (source.trim() === "") {
						setToastOpen(false);
						setError("草稿为空：先写点内容再优化。");
						setPhase(ERROR);
						return;
					}
					const token = { source, controller: newAbort() };
					runRef.current = token; // 同步占坑：令牌非空即是「加载中」
					setError("");
					setResult(null);
					setToastOpen(true);
					setPhase(LOADING); // 先进入 loading，再排计算
					timerRef.current = setTimeout(() => {
						timerRef.current = null;
						settle(token);
					}, 0);
				}

				/**
				 * 调度：有效引擎为 llm 时先走宿主 LLM 通路（异步），否则直接本地引擎。
				 * 有效引擎由 resolveEngine 现算：auto 有默认模型即 llm，无默认模型即 local。
				 * 两条分支的写回都收口到 writeResult —— 「原文一字不动」的判断只在那一处发生一次。
				 */
				function settle(token) {
					if (runRef.current !== token) return; // 已被还原或新一轮接管，结果直接丢弃
					if (resolveEngine(configRef.current, stateRef.current.models).effective === "llm") {
						runRemote(token);
						return;
					}
					runLocal(token, null);
				}

				/** 写回前的草稿守卫：加载期间草稿被用户改过就返回错误文案（调用方据此放弃写回）。 */
				function draftGuard(token) {
					const latest = typeof draftRef.current === "string" ? draftRef.current : null;
					if (latest !== token.source) return "草稿在优化期间被改动：已放弃写回，原文保持不变。";
					return null;
				}

				/**
				 * 宿主 LLM 通路。永不写原文以外的内容：
				 *   - 成功（ok + 非空 text）→ 用返回文本写回；
				 *   - 任何失败 / 超时 / 未装载 → 自动回退本地引擎，并在小条上标注「已回退本地」+ 具体文案。
				 * 请求体只带 providerId（默认模型 id），endpoint / apiKey / model 一律留在宿主侧查表。
				 */
				async function runRemote(token) {
					const remote = getRemote();
					const call = remote === null || remote === undefined ? null : remote.optimizeViaRemote;
					if (typeof call !== "function") {
						runLocal(token, "LLM 通路未装载");
						return;
					}
					const config = configRef.current;
					const signal = token.controller === null ? undefined : token.controller.signal;
					let response = null;
					try {
						response = await call(token.source, {
							strength: config.strength,
							locale: config.locale,
							providerId: providerIdOf(stateRef.current.models),
							signal
						});
					} catch (cause) {
						response = { ok: false, error: describe(cause) };
					}
					if (runRef.current !== token) return; // 还原 / 新一轮 / 卸载：迟到的结果直接丢弃
					if (response !== null && typeof response === "object" && response.ok === true && typeof response.text === "string" && response.text.trim() !== "") {
						writeResult(token, response.text, { segments: [], engine: "llm", fallback: false, note: "" });
						return;
					}
					const reason = response !== null && typeof response === "object" && typeof response.error === "string" && response.error !== "" ? response.error : "LLM 不可用";
					runLocal(token, reason);
				}

				/** 本地引擎。llmFailure 非空 = LLM 失败后回退：成功写回并标注回退原因。 */
				function runLocal(token, llmFailure) {
					let output = null;
					try {
						const engine = getEngine();
						if (engine === null || typeof engine.optimize !== "function") throw new Error("优化引擎未装载");
						output = engine.optimize(token.source, { strength: configRef.current.strength, locale: configRef.current.locale });
					} catch (cause) {
						fail("优化失败：" + describe(cause) + (llmFailure === null ? "（原文未改动）" : "；LLM 也不可用：" + llmFailure + "（原文未改动）"));
						return;
					}
					if (output === null || typeof output !== "object") {
						fail("优化引擎没有返回结果（原文未改动）");
						return;
					}
					if (output.ok !== true) {
						const reason = REASON_TEXT[output.reason] || String(output.reason === undefined ? "引擎拒绝" : output.reason);
						fail("未能优化：" + reason + (llmFailure === null ? "（原文未改动）" : "；LLM 也不可用：" + llmFailure + "（原文未改动）"));
						return;
					}
					if (typeof output.text !== "string" || output.text.trim() === "") {
						fail("优化结果为空（原文未改动）");
						return;
					}
					writeResult(token, output.text, {
						segments: output.segments,
						engine: output.meta !== null && output.meta !== undefined && typeof output.meta.engine === "string" ? output.meta.engine : "local",
						fallback: llmFailure !== null,
						note: llmFailure === null ? "" : "LLM 不可用，已回退本地：" + llmFailure
					});
				}

				/**
				 * 唯一写回点：令牌 → 草稿守卫 → 守恒兜底 → setDraft → 成功才进 done。
				 * 两条通路（本地引擎 / LLM）都只从这里写回，所以兜底只跑一次，重复点击与撤回都不会叠加。
				 */
				function writeResult(token, text, extra) {
					if (runRef.current !== token) return; // 已被还原或新一轮接管
					const problem = draftGuard(token);
					if (problem !== null) {
						fail(problem);
						return;
					}
					const write = writerOf(inputActions);
					if (write === null) {
						fail("当前编辑器不支持写回草稿（原文未改动）");
						return;
					}
					// 守恒校验兜底：strict 失败不改写、只给非阻塞警示；lenient 用补回后的文本写回；
					// 兜底自身绝不抛错（异常已在 applyGuard 内降级为「不校验、原样展示」）。
					const guard = applyGuard(token.source, text, configRef.current.mergeMode);
					const finalText = typeof guard.text === "string" ? guard.text : text;
					let written;
					try {
						written = write.call(inputActions, finalText);
					} catch (cause) {
						fail("写回草稿失败：" + describe(cause) + "（原文未改动）");
						return;
					}
					if (written === false) {
						fail("写回草稿被拒绝（编辑器可能只读）：原文保持原样。");
						return;
					}
					runRef.current = null;
					setResult({
						original: token.source,
						text: finalText,
						// 校验报告留在 state 里（可追溯字段），对比面板与 Done 小条据此渲染
						conservation: guard,
						segments: extra === null || extra.segments === undefined ? [] : extra.segments,
						strength: configRef.current.strength,
						locale: configRef.current.locale,
						engine: extra === null || extra === undefined || typeof extra.engine !== "string" ? "local" : extra.engine,
						fallback: extra !== null && extra !== undefined && extra.fallback === true,
						note: extra === null || extra === undefined || typeof extra.note !== "string" ? "" : extra.note,
						originalLength: token.source.length,
						optimizedLength: finalText.length
					});
					setPhase(DONE);
				}

				/** done → idle：写回原文快照（不依赖 Ctrl+Z，setDraft 会把优化结果并进撤销历史）。 */
				function restoreOriginal() {
					const original = result === null || typeof result.original !== "string" ? (typeof draftRef.current === "string" ? draftRef.current : "") : result.original;
					const write = writerOf(inputActions);
					if (write === null) {
						setError("当前编辑器不支持写回草稿。");
						return;
					}
					let written;
					try {
						written = write.call(inputActions, original);
					} catch (cause) {
						setError("还原失败：" + describe(cause));
						return;
					}
					if (written === false) {
						setError("还原被拒绝（编辑器可能只读）。");
						return;
					}
					abandon();
					setResult(null);
					setError("");
					setPanel("none");
					setToastOpen(true);
					setPhase(IDLE);
				}

				function dismissError() {
					setError("");
					if (phase === ERROR) setPhase(IDLE);
				}

				/* ------------------------------------------------------------------ *
				 * 设置面板：模型表 + 优化行为（下面全部是面板侧副作用，与草稿写回无关）
				 * ------------------------------------------------------------------ */

				/** 合并式更新面板状态（异步续体里也安全：只按字段合并）。 */
				function patchModelState(partial) {
					setModelState((current) => ({ ...current, ...partial }));
				}

				/** 「已保存」闪一下：重复保存只重置计时器，不会叠出多个定时器。 */
				function flashSaved() {
					setSaved(true);
					if (flashRef.current !== null) clearTimeout(flashRef.current);
					flashRef.current = setTimeout(() => {
						flashRef.current = null;
						setSaved(false);
					}, SAVED_FLASH_MS);
				}

				/**
				 * 落盘 + 推给宿主。写失败（无痕/配额满）只置黄条，内存值继续可用。
				 * @returns 是否写盘成功
				 */
				function persist(nextModels, nextSettings, extra) {
					const outcome = saveModels({ schemaVersion: SCHEMA_VERSION, models: nextModels, settings: nextSettings });
					const failed = outcome === null || typeof outcome !== "object" || outcome.ok !== true;
					const patch = { models: nextModels, settings: nextSettings, writeFailed: failed };
					if (extra !== null && typeof extra === "object") Object.assign(patch, extra);
					patchModelState(patch);
					if (!failed) {
						pushHostTable(nextModels, nextSettings);
						flashSaved();
					}
					return !failed;
				}

				/** 把权威模型表推给宿主（宿主是上游请求的实际转发方）。失败不影响本地可用性。 */
				async function pushHostTable(nextModels, nextSettings) {
					if (stateRef.current.hostStatus === "missing") return;
					let outcome = null;
					try {
						outcome = await saveModelTable({ schemaVersion: SCHEMA_VERSION, models: nextModels, settings: nextSettings });
					} catch (cause) {
						outcome = null;
					}
					if (outcome === null || typeof outcome !== "object") return;
					if (outcome.ok === true) {
						if (stateRef.current.hostStatus !== "ready") patchModelState({ hostStatus: "ready" });
						return;
					}
					if (outcome.routeMissing === true) patchModelState({ hostStatus: "missing" });
				}

				/** 宿主能力探测（只做一次）：路由缺失就降级为只读展示，绝不隐藏按钮或抛错。 */
				async function ensureHostReady() {
					if (stateRef.current.hostStatus !== "unknown") return;
					let outcome = null;
					try {
						outcome = await fetchModelTable();
					} catch (cause) {
						outcome = null;
					}
					patchModelState({ hostStatus: outcome !== null && typeof outcome === "object" && outcome.ok === true ? "ready" : "missing" });
				}

				/** 行为设置改动：非法值由 applySetting 归一，engine=llm 且无默认模型时自动回退本地。 */
				function changeSetting(key, value) {
					const current = stateRef.current;
					const guarded = resolveEngine(applySetting(current.settings, key, value), current.models);
					persist(current.models, guarded.settings, {
						notice: guarded.notice,
						enginePrompt: guarded.notice === "" ? current.enginePrompt === true : false
					});
				}

				/** 一键把引擎切到 LLM（切换默认模型后的一键确认）。 */
				function switchEngine() {
					const current = stateRef.current;
					persist(current.models, applySetting(current.settings, "engine", "llm"), { enginePrompt: false, notice: "" });
				}

				function dismissEnginePrompt() {
					patchModelState({ enginePrompt: false });
				}

				function dismissNotice() {
					patchModelState({ notice: "" });
				}

				/** 切换默认模型：点行首圆点立即生效，engine=local 时给一键切到 LLM 的提示。 */
				function chooseDefault(id) {
					const current = stateRef.current;
					const outcome = chooseDefaultModel(current.models, id);
					if (outcome.changed !== true) return;
					const guarded = resolveEngine(current.settings, outcome.models);
					persist(outcome.models, guarded.settings, {
						notice: guarded.notice,
						enginePrompt: current.settings.engine === "local" && guarded.notice === ""
					});
				}

				/** 打开添加表单（已达上限时只提示，不进入表单）。 */
				function startAdd() {
					const current = stateRef.current;
					if (addModelToList(current.models, { endpoint: "x", apiKey: "x", model: "x" }).reason === "limit") {
						patchModelState({ notice: "最多 " + 20 + " 个模型" });
						return;
					}
					setConfirmDelete("");
					patchModelState({ notice: "" });
					setForm({ mode: "add", modelId: "", values: emptyForm() });
				}

				/** 行原位展开编辑表单：密钥不回填（留空即沿用原值）。 */
				function startEdit(model) {
					if (model === null || typeof model !== "object") return;
					setConfirmDelete("");
					patchModelState({ notice: "" });
					setForm({ mode: "edit", modelId: model.id, values: formFromModel(model) });
				}

				function cancelForm() {
					setForm(null);
				}

				function changeField(field, value) {
					setForm((current) => (current === null ? current : { ...current, values: formWithField(current.values, field, value) }));
				}

				/** 提交添加/编辑：校验不通过不写任何东西，但先把所有错误汇总成一句人话放进提示条。 */
				function submitForm() {
					const current = stateRef.current;
					if (form === null) return;
					const base = form.mode === "edit" ? current.models.find((item) => item.id === form.modelId) || null : null;
					const built = modelFromForm(form.values, base);
					if (built.ok !== true) {
						const summary = formErrorSummaryText(built.errors);
						patchModelState({ notice: summary === "" ? "还有字段未通过校验，请检查表单" : summary });
						return;
					}
					if (form.mode === "edit") {
						const outcome = updateModelInList(current.models, built.model);
						if (outcome.updated !== true) {
							patchModelState({ notice: "要编辑的模型已不存在，请重新打开" });
							setForm(null);
							return;
						}
						persist(outcome.models, current.settings, { notice: "" });
					} else {
						const outcome = addModelToList(current.models, built.model);
						if (outcome.added !== true) {
							patchModelState({ notice: outcome.reason === "duplicate" ? "这条模型已经存在，未重复添加" : "模型信息未通过校验" });
							if (outcome.reason === "duplicate") setForm(null);
							return;
						}
						persist(outcome.models, current.settings, { notice: "" });
					}
					setForm(null);
				}

				/** 删除需要行内二次确认；删默认模型自动迁移，删空回落本地引擎。 */
				function confirmDeleteNow() {
					const current = stateRef.current;
					const id = confirmDelete;
					setConfirmDelete("");
					const outcome = deleteModelFromList(current.models, current.settings, id);
					if (outcome.removed !== true) return;
					if (form !== null && form.modelId === id) setForm(null);
					if (testRef.current === id) cancelTest();
					persist(outcome.models, outcome.settings, { notice: outcome.notices.join("；"), enginePrompt: false });
				}

				/** 测试连接：同一按钮第二次点击 = 取消。 */
				function toggleTest(model) {
					if (model === null || typeof model !== "object") return;
					if (testRef.current === model.id) {
						cancelTest();
						return;
					}
					runTest(model);
				}

				function cancelTest() {
					const controller = testAbortRef.current;
					testAbortRef.current = null;
					testRef.current = "";
					if (controller !== null && controller !== undefined && typeof controller.abort === "function") {
						try {
							controller.abort();
						} catch (cause) {
							// 取消失败不影响状态：令牌已作废
						}
					}
					setTestState({ id: "", status: "idle", text: "" });
				}

				/**
				 * 走真实通路发一条最小请求。宿主没提供模型接口时直接给不可用提示，
				 * 成功/失败都只改这一行的行内文字（不带任何密钥）。
				 */
				async function runTest(model) {
					const controller = newAbort();
					testAbortRef.current = controller;
					testRef.current = model.id;
					setTestState({ id: model.id, status: "running", text: "" });
					await ensureHostReady();
					if (testRef.current !== model.id) return;
					if (stateRef.current.hostStatus === "missing") {
						testRef.current = "";
						testAbortRef.current = null;
						setTestState({ id: model.id, status: "error", text: "连接失败 · 宿主未提供模型接口" });
						return;
					}
					const current = stateRef.current;
					const signal = controller === null ? undefined : controller.signal;
					let pushed = null;
					try {
						pushed = await saveModelTable({ schemaVersion: SCHEMA_VERSION, models: current.models, settings: current.settings }, { signal });
					} catch (cause) {
						pushed = null;
					}
					if (testRef.current !== model.id) return;
					if (pushed !== null && typeof pushed === "object" && pushed.ok !== true && pushed.routeMissing === true) {
						testRef.current = "";
						testAbortRef.current = null;
						patchModelState({ hostStatus: "missing" });
						setTestState({ id: model.id, status: "error", text: "连接失败 · 宿主未提供模型接口" });
						return;
					}
					const outcome = await probeConnection(model.id, { signal });
					if (testRef.current !== model.id) return;
					testRef.current = "";
					testAbortRef.current = null;
					const summary = summarizeTest(outcome);
					setTestState({ id: model.id, status: summary.tone, text: summary.text });
				}

				/** 旧配置导入：走 migrateConfig 的迁移结果，重复条目由 addModelToList 幂等挡掉。 */
				function importLegacy() {
					const current = stateRef.current;
					const entries = legacyModels(current.legacyText);
					let nextModels = current.models;
					let imported = 0;
					for (const entry of entries) {
						const outcome = addModelToList(nextModels, entry);
						if (outcome.added === true) {
							nextModels = outcome.models;
							imported += 1;
						}
					}
					persist(nextModels, current.settings, {
						notice: imported === 0 ? "旧版配置里没有可导入的模型信息" : "已导入 " + imported + " 条模型",
						legacy: { show: false, canImport: false, text: "", entry: null }
					});
				}

				function dismissLegacy() {
					patchModelState({ legacy: { show: false, canImport: false, text: "", entry: null } });
				}

				// 表单校验在渲染期现算：错误跟着输入即时消失，不进 state 也就不会出现「陈旧的错误」
				const editingBase = form !== null && form.mode === "edit" ? stateRef.current.models.find((item) => item.id === form.modelId) || null : null;
				const checked = form === null ? { ok: false, errors: {} } : validateForm(form.values, editingBase);

				const panelView = {
					models: modelState.models,
					settings: modelState.settings,
					countLabel: countText(modelState.models.length),
					form: form === null ? null : { ...form.values, mode: form.mode },
					errors: checked.errors,
					canSave: checked.ok,
					confirmDelete,
					test: testState,
					saved,
					notice: modelState.notice,
					legacy: modelState.legacy,
					corrupt: corruptNotice(modelState),
					migrated: migratedNotice(modelState),
					storage: storageNotice({ ok: modelState.writeFailed !== true }),
					host: hostNotice(modelState.hostStatus),
					enginePrompt: modelState.enginePrompt === true
				};

				const panelActions = {
					close: closePanel,
					changeSetting,
					startAdd,
					startEdit,
					cancelForm,
					submitForm,
					changeField,
					requestDelete: setConfirmDelete,
					confirmDelete: confirmDeleteNow,
					cancelDelete: () => setConfirmDelete(""),
					chooseDefault,
					test: toggleTest,
					importLegacy,
					dismissLegacy,
					switchEngine,
					dismissEnginePrompt,
					dismissNotice
				};

				const busy = phase === LOADING;
				const done = phase === DONE;
				const draftEmpty = typeof draft !== "string" || draft.trim() === "";
				const disabled = locked === true || busy || (!done && draftEmpty);
				const label = done ? "还原原文" : busy ? "优化中…" : "优化提示词";

				function onTriggerClick(event) {
					preventFocusSteal(event);
					if (busy) return;
					if (done) {
						restoreOriginal();
						return;
					}
					startOptimize();
				}

				function onGearClick(event) {
					preventFocusSteal(event);
					if (locked === true) return;
					const open = panel !== "settings";
					setPanel(open ? "settings" : "none");
					if (open) {
						setConfirmDelete("");
						ensureHostReady();
					}
				}

				function overlayNode() {
					if (overlay === "compare") {
						return react.createElement(ComparePanel, {
							key: "compare",
							style: overlayStyle,
							panelRef,
							meta: resultMeta(result),
							original: result === null ? "" : result.original,
							optimized: result === null ? "" : result.text,
							conservation: result === null || typeof result.conservation !== "object" ? null : result.conservation,
							onClose: closePanel
						});
					}
					if (overlay === "settings") {
						return react.createElement(SettingsPanel, {
							key: "settings",
							style: overlayStyle,
							panelRef,
							view: panelView,
							actions: panelActions
						});
					}
					if (overlay === "error") {
						return react.createElement(ErrorBanner, {
							key: "error",
							style: overlayStyle,
							message: error,
							onClose: dismissError
						});
					}
					if (overlay === "toast") {
						return react.createElement(StatusToast, {
							key: "toast",
							style: overlayStyle,
							note: result === null || typeof result.note !== "string" ? "" : result.note,
							guard: result === null || typeof result.conservation !== "object" ? null : result.conservation,
							onCompare: () => setPanel("compare"),
							onRestore: restoreOriginal,
							onDismiss: () => setToastOpen(false)
						});
					}
					return null;
				}

				return react.createElement("span", {
					className: "dsh-po-wrap",
					"data-dsh-po-root": "",
					ref: rootRef
				}, [
					react.createElement("button", {
						key: "trigger",
						type: "button",
						className: "dsh-po-button",
						"data-dsh-po-trigger": "",
						"data-dsh-po-phase": phase,
						"aria-label": label,
						"aria-busy": busy,
						title: label,
						disabled,
						onMouseDown: preventFocusSteal,
						onClick: onTriggerClick
					}, [
						busy
							? react.createElement("span", { key: "spin", className: "dsh-po-spin", "aria-hidden": true })
							: react.createElement("span", { key: "glyph", className: "dsh-po-glyph", "aria-hidden": true }, done ? "↺" : "✦"),
						react.createElement("span", { key: "label", className: "dsh-po-text" }, label),
						react.createElement("span", { key: "sr", className: "dsh-po-sr", role: "status", "aria-live": "polite" }, busy ? "正在优化提示词" : "")
					]),
					react.createElement("button", {
						key: "gear",
						type: "button",
						className: "dsh-po-gear",
						"data-dsh-po-gear": "",
						"aria-label": "提示词优化设置",
						"aria-expanded": panel === "settings",
						title: "优化设置",
						disabled: locked === true,
						onMouseDown: preventFocusSteal,
						onClick: onGearClick
					}, "⚙"),
					overlayNode()
				]);
			}

			return { PromptOptimizerButton: PromptOptimizerButton };
		})(__m0.getEngine, __m0.getRemote, __m0.applyGuard, __m1.anchorOf, __m1.fixedStyle, __m1.preventFocusSteal, __m2.CONFIG_KEY, __m2.SCHEMA_VERSION, __m2.loadModels, __m2.saveModels, __m4.StatusToast, __m4.ComparePanel, __m4.SettingsPanel, __m4.ErrorBanner, __m3.emptyForm, __m3.formFromModel, __m3.formWithField, __m3.validateForm, __m3.modelFromForm, __m3.countText, __m3.addModelToList, __m3.updateModelInList, __m3.deleteModelFromList, __m3.chooseDefaultModel, __m3.applySetting, __m3.resolveEngine, __m3.providerIdOf, __m3.legacyConfigPrompt, __m3.legacyModels, __m3.summarizeTest, __m3.corruptNotice, __m3.migratedNotice, __m3.storageNotice, __m3.hostNotice, __m3.formErrorSummaryText, __m5.fetchModelTable, __m5.saveModelTable, __m5.probeConnection);

		// src/client/style.js
		var __m7 = (function () {
			/**
			 * 唯一一份样式：所有选择器都限定在 .dsh-po- 前缀内，不写全局选择器、不覆盖宿主样式。
			 * 配色只用宿主真实存在的 --dsw-alias-* 变量（bg-module-platform / label-* / border-l* /
			 * state-* 等），并用 CSS 系统色 Canvas/CanvasText 作配对兜底 —— 背景与前景必须成对
			 * 取值，否则深色主题下会出现白底白字（宿主不定义 --dsw-alias-bg-elevated）。
			 *
			 * 注意：CSS 数组保持「双引号字符串数组 + join("")」的形状，scripts/verify.mjs 会解析它。
			 */
			const STYLE_ID = "dsh-plugin-prompt-optimizer/style";

			const CSS = [
				".dsh-po-wrap{display:inline-flex;align-items:center;gap:2px;position:relative}",
				".dsh-po-button{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:1px solid transparent;border-radius:6px;background-color:transparent;color:var(--dsw-alias-label-secondary,inherit);font-family:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease;white-space:nowrap}",
				".dsh-po-button:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));border-color:var(--dsw-alias-border-l1,transparent);color:var(--dsw-alias-label-primary,inherit)}",
				".dsh-po-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-button:disabled{opacity:.4;cursor:not-allowed}",
				".dsh-po-glyph{font-size:14px;line-height:1;pointer-events:none}",
				".dsh-po-text{pointer-events:none}",
				".dsh-po-spin{display:inline-block;width:11px;height:11px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dsh-po-spin .8s linear infinite;pointer-events:none}",
				".dsh-po-gear{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:1px solid transparent;border-radius:5px;background-color:transparent;color:var(--dsw-alias-label-secondary,inherit);font-family:inherit;font-size:12px;line-height:1;cursor:pointer}",
				".dsh-po-gear:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));border-color:var(--dsw-alias-border-l1,transparent);color:var(--dsw-alias-label-primary,inherit)}",
				".dsh-po-gear:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-gear:disabled{opacity:.4;cursor:not-allowed}",
				".dsh-po-toast{position:fixed;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;max-width:min(420px,calc(100vw - 24px));padding:6px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:8px;background-color:var(--dsw-alias-bg-module-platform,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:0 6px 24px rgba(0,0,0,.16);font-size:12px;line-height:1.4;color-scheme:light dark}",
				".dsh-po-panel{position:fixed;z-index:2147483001;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;width:min(620px,calc(100vw - 24px));max-width:100%;max-height:min(52vh,440px);padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:10px;background-color:var(--dsw-alias-bg-module-platform,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:0 12px 40px rgba(0,0,0,.22);font-size:12px;line-height:1.5;outline:none;color-scheme:light dark}",
				".dsh-po-panel:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-head{display:flex;align-items:center;gap:8px;font-weight:600}",
				".dsh-po-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dsh-po-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;min-height:0;overflow:auto;overscroll-behavior:contain}",
				".dsh-po-col{display:flex;flex-direction:column;gap:4px;min-width:0}",
				".dsh-po-colhead{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,inherit);font-size:11px}",
				".dsh-po-pre{margin:0;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:6px;background-color:rgba(128,128,128,.10);color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:min(40vh,340px);tab-size:2;min-width:0}",
				".dsh-po-link{padding:0;border:0;background:none;color:var(--dsw-alias-state-business-primary,inherit);font-family:inherit;font-size:11px;line-height:1.5;cursor:pointer}",
				".dsh-po-link:hover{text-decoration:underline}",
				".dsh-po-link:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-rows{display:flex;flex-direction:column;gap:6px}",
				".dsh-po-row{display:flex;align-items:center;gap:8px}",
				".dsh-po-rowlabel{flex:0 0 52px;color:var(--dsw-alias-label-secondary,inherit);font-size:11px}",
				".dsh-po-seg{display:inline-flex;gap:4px}",
				".dsh-po-segbtn{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:5px;background-color:transparent;color:inherit;font-family:inherit;font-size:11px;line-height:1.5;cursor:pointer}",
				".dsh-po-segbtn:hover{border-color:var(--dsw-alias-state-business-primary,currentColor)}",
				".dsh-po-segbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-segbtn-on{border-color:var(--dsw-alias-state-business-primary,currentColor);background-color:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));font-weight:600}",
				".dsh-po-body{display:flex;flex:1 1 auto;flex-direction:column;gap:10px;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain}",
				".dsh-po-section{display:flex;flex-direction:column;gap:6px;min-width:0}",
				".dsh-po-sectionhead{display:flex;align-items:center;gap:8px;min-width:0;font-weight:600}",
				".dsh-po-count{flex:0 0 auto;color:var(--dsw-alias-label-secondary,inherit);font-size:11px;font-weight:400;white-space:nowrap}",
				".dsh-po-bars{display:flex;flex-direction:column;gap:4px;min-width:0;max-height:min(18vh,132px);overflow:auto;overscroll-behavior:contain}",
				".dsh-po-bar{display:flex;align-items:center;gap:8px;box-sizing:border-box;min-width:0;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-left-width:3px;border-radius:6px;background-color:var(--dsw-alias-bg-module-platform,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font-size:11.5px;line-height:1.45}",
				".dsh-po-bar-warn{border-left-color:var(--dsw-alias-state-warning-primary,#d9a400)}",
				".dsh-po-bar-info{border-left-color:var(--dsw-alias-state-business-primary,#4b7bec)}",
				".dsh-po-list{display:flex;flex-direction:column;gap:6px;min-width:0}",
				".dsh-po-item{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:8px;background-color:rgba(128,128,128,.06);color:var(--dsw-alias-label-primary,CanvasText)}",
				".dsh-po-itemrow{display:flex;align-items:center;gap:8px;min-width:0}",
				".dsh-po-dot{flex:0 0 auto;width:18px;height:18px;padding:0;border:1px solid transparent;border-radius:50%;background-color:transparent;color:var(--dsw-alias-label-secondary,inherit);font-family:inherit;font-size:11px;line-height:1;cursor:pointer}",
				".dsh-po-dot:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,currentColor);color:var(--dsw-alias-state-business-primary,currentColor)}",
				".dsh-po-dot:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-dot:disabled{cursor:default;color:var(--dsw-alias-state-business-primary,currentColor)}",
				".dsh-po-itemmain{display:flex;flex:1 1 auto;flex-direction:column;gap:2px;min-width:0}",
				".dsh-po-itemline{display:flex;align-items:baseline;gap:6px;min-width:0}",
				".dsh-po-itemname{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}",
				".dsh-po-itemtag{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit);font-size:11px}",
				".dsh-po-itemmeta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit);font-size:11px}",
				".dsh-po-itemactions{display:flex;flex:0 0 auto;align-items:center;gap:4px}",
				".dsh-po-mini{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:5px;background-color:transparent;color:inherit;font-family:inherit;font-size:11px;line-height:1.5;white-space:nowrap;cursor:pointer}",
				".dsh-po-mini:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,currentColor)}",
				".dsh-po-mini:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-mini:disabled{opacity:.45;cursor:not-allowed}",
				".dsh-po-mini-strong{border-color:var(--dsw-alias-state-business-primary,currentColor);font-weight:600}",
				".dsh-po-mini-danger{border-color:var(--dsw-alias-state-error-primary,rgba(220,80,80,.6));color:var(--dsw-alias-state-error-primary,#c53)}",
				".dsh-po-confirm{display:flex;align-items:center;gap:6px;min-width:0;padding:4px 6px;border:1px solid var(--dsw-alias-state-error-primary,rgba(220,80,80,.6));border-radius:6px;background-color:var(--dsw-alias-bg-module-platform,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font-size:11.5px}",
				".dsh-po-status{min-width:0;overflow-wrap:anywhere;font-size:11.5px}",
				".dsh-po-ok{color:var(--dsw-alias-state-success-primary,#2e9e5b)}",
				".dsh-po-bad{color:var(--dsw-alias-state-error-primary,#c53)}",
				".dsh-po-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;box-sizing:border-box;min-width:0;padding:8px;border:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.4));border-radius:8px}",
				".dsh-po-field{display:flex;flex-direction:column;gap:3px;min-width:0}",
				".dsh-po-field-wide{grid-column:1 / -1}",
				".dsh-po-label{color:var(--dsw-alias-label-secondary,inherit);font-size:11px}",
				".dsh-po-input{box-sizing:border-box;min-width:0;width:100%;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.32));border-radius:5px;background-color:var(--dsw-alias-bg-module-platform,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font-family:inherit;font-size:11.5px;line-height:1.5;color-scheme:light dark}",
				".dsh-po-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-formfoot{display:flex;align-items:center;gap:8px;min-width:0}",
				".dsh-po-formsummary{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-state-error-primary,rgba(220,80,80,.55));border-radius:6px;background-color:var(--dsw-alias-bg-module-platform,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font-size:11px;line-height:1.5;overflow-wrap:anywhere}",
				".dsh-po-formsummary-head{font-weight:600;color:var(--dsw-alias-state-error-primary,#c53)}",
				".dsh-po-formsummary-line{padding-left:8px}",
				".dsh-po-foot{display:flex;align-items:center;gap:8px;min-width:0}",
				".dsh-po-empty{padding:10px 8px;border:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.4));border-radius:8px;color:var(--dsw-alias-label-secondary,inherit);font-size:11.5px;text-align:center}",
				".dsh-po-saved{color:var(--dsw-alias-state-success-primary,#2e9e5b);white-space:nowrap}",
				".dsh-po-hint{color:var(--dsw-alias-label-secondary,inherit);font-size:11px}",
				".dsh-po-error{position:fixed;z-index:2147483001;display:flex;align-items:center;gap:8px;box-sizing:border-box;max-width:min(420px,calc(100vw - 24px));padding:6px 10px;border:1px solid var(--dsw-alias-state-error-primary,rgba(220,80,80,.6));border-radius:8px;background-color:var(--dsw-alias-bg-module-platform,Canvas);color:var(--dsw-alias-state-error-primary,#c53);color-scheme:light dark;box-shadow:0 6px 24px rgba(0,0,0,.16);font-size:12px;line-height:1.4}",
				".dsh-po-msg{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}",
				".dsh-po-note{flex:1 1 100%;min-width:0;color:var(--dsw-alias-label-secondary,inherit);font-size:11px;overflow-wrap:anywhere}",
				".dsh-po-close{padding:0;border:0;background:none;color:inherit;font-family:inherit;font-size:13px;line-height:1;cursor:pointer;opacity:.72}",
				".dsh-po-close:hover{opacity:1}",
				".dsh-po-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
				".dsh-po-note-warn{color:var(--dsw-alias-state-warning-primary,#b26a00)}",
				".dsh-po-guard{display:flex;flex-direction:column;gap:4px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));color:var(--dsw-alias-label-primary,CanvasText);font-size:11px;line-height:1.4}",
				".dsh-po-guard-head{display:flex;align-items:center;gap:6px;min-width:0}",
				".dsh-po-guard-title{color:var(--dsw-alias-state-warning-primary,#b26a00);font-weight:600}",
				".dsh-po-guard-tag{display:inline-flex;align-items:center;max-width:100%;padding:0 5px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:4px;color:var(--dsw-alias-label-secondary,inherit);font-size:10px;line-height:1.6;overflow-wrap:anywhere}",
				".dsh-po-guard-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 6px;min-width:0}",
				".dsh-po-guard-label{color:var(--dsw-alias-label-secondary,inherit)}",
				".dsh-po-guard-sum{cursor:pointer;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}",
				".dsh-po-guard-sum:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}",
				".dsh-po-guard-list{margin:2px 0 0;padding-left:16px;max-height:96px;overflow:auto;color:var(--dsw-alias-label-primary,CanvasText);overflow-wrap:anywhere}",
				".dsh-po-guard-item{margin:0}"
			].join("");

			/** 加载态旋转动画（@keyframes 不进 CSS 数组，名字同样带 dsh-po- 前缀）。 */
			const SPIN_CSS = "@keyframes dsh-po-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}";

			/**
			 * 注入样式表：按 data-plugin-css 去重，热重载/重复激活都不会叠出多份。
			 */
			function ensureStyle() {
				if (typeof document === "undefined" || document === null) return;
				if (document.head === null || document.head === undefined) return;
				if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-plugin-prompt-optimizer";
				tag.dataset.pluginCss = STYLE_ID;
				tag.textContent = CSS + SPIN_CSS;
				document.head.appendChild(tag);
			}

			return { ensureStyle: ensureStyle };
		})();

		// src/engine/prompts.js（引擎内联）
		var __m8 = (function () {
			/**
			 * 本地提示词优化引擎 —— 静态资源表
			 * 纯数据 + 纯字符串常量：无副作用、无第三方依赖、无网络、无时钟。
			 */

			/** 五段固定顺序（zh/en 共用） */
			const ORDER = ['role', 'task', 'context', 'output', 'constraints'];

			/**
			 * 单行归类的判定优先级：先命中先归位。
			 * role 最先（"你是…"句式最独特），output 次之（"输出/格式/json"），
			 * constraints 再次（"不得/禁止/must"），context 再次（"背景/参考/URL/@引用"），
			 * 其余全部落到 task（默认桶，保证零丢失）。
			 */
			const CLASSIFY_ORDER = ['role', 'output', 'constraints', 'context', 'task'];

			/** 原文长度上限；超出后保留前 N 字符（围栏安全） */
			const MAX_LENGTH = 8000;

			const LOCALES = {
			  zh: {
			    code: 'zh',
			    titles: {
			      role: '角色',
			      task: '任务',
			      context: '上下文',
			      output: '输出要求',
			      constraints: '约束',
			    },
			    truncatedNote: '> （原文过长已截断）',
			    placeholders: {
			      role: '（原文未指定角色，以下为默认设定）',
			      task: '（原始需求见上下文中的原文片段）',
			      context: '（原文未提供额外上下文）',
			      output: '（原文未指定输出格式）',
			      constraints: '（原文未显式声明约束）',
			    },
			    defaultRole: '你是一名严谨、专业的助手：只依据已给出的信息作答，结论明确、可直接执行。',
			    outputLines: [
			      '直接给出结果，不重复题目与要求。',
			      '使用与原文一致的语言作答。',
			      '信息不足时先列出需要补充的关键信息，不要臆测。',
			    ],
			    acceptance: [
			      '验收：输出中出现的所有数字、专有名词、链接与原文完全一致。',
			      '验收：原文中每一条否定/禁止类约束都被遵守，无一例外。',
			      '验收：按上述五段结构作答，五段齐备且顺序不变。',
			    ],
			  },
			  en: {
			    code: 'en',
			    titles: {
			      role: 'Role',
			      task: 'Task',
			      context: 'Context',
			      output: 'Output',
			      constraints: 'Constraints',
			    },
			    truncatedNote: '> (truncated)',
			    placeholders: {
			      role: '(no role was specified in the source; default used)',
			      task: '(the request is carried by the source fragment in Context)',
			      context: '(the source provides no extra context)',
			      output: '(the source specifies no output shape)',
			      constraints: '(the source declares no explicit constraints)',
			    },
			    defaultRole: 'You are a rigorous, professional assistant: answer only from the given information, and make the result concrete and directly usable.',
			    outputLines: [
			      'Return the result directly; do not restate the prompt.',
			      'Answer in the same language as the source.',
			      'If information is missing, list what is needed instead of guessing.',
			    ],
			    acceptance: [
			      'Acceptance: every number, proper noun, and link matches the source exactly.',
			      'Acceptance: every negative constraint from the source is honored without exception.',
			      'Acceptance: answer in the five sections above, in the given order, without omitting any.',
			    ],
			  },
			};

			/** 角色启发式：按关键词命中挑选领域人设；都不命中时用 locale 的 defaultRole */
			const ROLE_PRESETS = [
			  {
			    match: ['代码', '编程', '函数', '脚本', '重构', '单元测试', 'code', 'function', 'script', 'refactor', 'bug', 'api'],
			    zh: '你是一名资深软件工程师，熟悉多语言与工程实践：回答直接、结论明确、可直接落地。',
			    en: 'You are a senior software engineer with broad language and engineering experience: direct, decisive, and directly applicable.',
			  },
			  {
			    match: ['数据', '分析', '统计', '报表', '指标', '口径', 'data', 'analysis', 'analytics', 'metric', 'sql'],
			    zh: '你是一名资深数据分析师：先给结论，再给依据与口径，数字必须与原文一致。',
			    en: 'You are a senior data analyst: conclusion first, then evidence and definitions; numbers must match the source.',
			  },
			  {
			    match: ['文案', '写作', '润色', '营销', '标题', '种草', 'copy', 'writing', 'rewrite', 'tone', 'slogan'],
			    zh: '你是一名资深中文文案编辑：语言干净、结构清晰、避免套话与空泛表达。',
			    en: 'You are a seasoned copy editor: clean wording, clear structure, no filler or vague claims.',
			  },
			  {
			    match: ['翻译', 'translate', 'translation', 'localize', '本地化'],
			    zh: '你是一名严谨的双语译者：忠实原意，术语统一，不增删信息。',
			    en: 'You are a rigorous bilingual translator: faithful to the meaning, consistent terminology, no added or dropped information.',
			  },
			  {
			    match: ['设计', '界面', '排版', '配色', '交互', 'design', 'ui', 'ux', 'layout'],
			    zh: '你是一名资深产品设计师：兼顾信息层级、可用性与实现成本。',
			    en: 'You are a senior product designer: balance hierarchy, usability, and implementation cost.',
			  },
			  {
			    match: ['论文', '研究', '文献', '综述', '实验', 'research', 'paper', 'literature', 'study'],
			    zh: '你是一名严谨的研究助理：结论需有依据，不臆造事实与引用。',
			    en: 'You are a rigorous research assistant: conclusions must be grounded; never invent facts or citations.',
			  },
			];

			/** 单行归类的关键词表；en 关键词用小写比对 */
			const KEYWORDS = {
			  role: [
			    '你是', '您将扮演', '扮演', '作为一名', '作为一位', '你的身份', '角色是',
			    'act as', 'you are', 'you will act', 'your role', 'persona',
			  ],
			  output: [
			    '输出', '返回', '格式', '字段', '表格', '列出', '分点', '要点', '列点', '字数',
			    'json', 'markdown', 'yaml', 'xml', 'csv', 'output', 'return', 'format', 'table',
			    'bullet', 'field', 'list',
			  ],
			  constraints: [
			    '不得', '不要', '不能', '不可', '禁止', '严禁', '勿', '必须', '务必', '只能',
			    '一律', '至少', '至多', '不超过', '限定', '仅限', '不允许', '保持',
			    'must', 'never', 'do not', "don't", 'only', 'at most', 'no more than', 'avoid',
			    'keep', 'without changing',
			  ],
			  context: [
			    '背景', '上下文', '参考', '已知', '现状', '前提', '资料', '素材', '原文如下',
			    'http://', 'https://', '@',
			    'background', 'context', 'reference', 'given', 'existing',
			  ],
			  task: [
			    '请', '帮我', '生成', '写', '分析', '总结', '改写', '优化', '实现', '修复',
			    '翻译', '解释', '评审', '审查', '梳理', '整理',
			    'create', 'write', 'generate', 'analyze', 'analyse', 'summarise', 'summarize',
			    'build', 'implement', 'fix', 'translate', 'explain', 'review', 'refactor', 'draft',
			  ],
			};

			return { ORDER: ORDER, CLASSIFY_ORDER: CLASSIFY_ORDER, MAX_LENGTH: MAX_LENGTH, LOCALES: LOCALES, ROLE_PRESETS: ROLE_PRESETS, KEYWORDS: KEYWORDS };
		})();

		// src/engine/optimize.js（引擎内联）
		var __m9 = (function (ORDER, CLASSIFY_ORDER, MAX_LENGTH, LOCALES, KEYWORDS, ROLE_PRESETS) {
			/**
			 * 一键提示词优化 —— 本地优化引擎（纯函数）
			 *
			 * 约束：无第三方依赖、无网络、无随机数、不读时钟 —— 同一输入永远得到同一输出。
			 * 核心不变量（fidelity / 忠于原意）：原文按"行/围栏代码块"切分成原子单元，
			 * 每个单元要么原样落到某个分段，要么被 repairFidelity() 兜底追回，一个字符都不丢。
			 */

			/** 支持的强度档位（顺序即由弱到强） */
			const STRENGTHS = ['light', 'standard', 'deep'];

			/** 反引号：用转义写法避免源码里出现裸围栏字符，便于本文件被内联进客户端产物 */
			const TICK = '\u0060';

			/**
			 * @param {string} rawText 用户草稿原文
			 * @param {{ strength?: 'light'|'standard'|'deep', locale?: 'zh'|'en' }} [options]
			 * @returns {{ ok: boolean, reason?: string, text: string, segments: Array<{key:string,title:string,body:string}>, meta: object }}
			 */
			function optimize(rawText, options) {
			  const opts = options !== null && typeof options === 'object' ? options : {};
			  const strength = normalizeStrength(opts.strength);
			  const locale = normalizeLocale(opts.locale);
			  const dict = LOCALES[locale];

			  if (typeof rawText !== 'string') return fail('unsupported', strength, locale, '');
			  if (rawText.trim() === '') return fail('empty', strength, locale, rawText);

			  // 幂等闸门：输入已经是本引擎（同形）产物时，原样返回，绝不叠加标题。
			  const already = parseOptimized(rawText);
			  if (already) {
			    return {
			      ok: true,
			      text: rawText,
			      segments: already,
			      meta: buildMeta(strength, locale, rawText, rawText, false),
			    };
			  }

			  const clipped = clip(rawText, MAX_LENGTH);
			  const built = assemble(strength, clipped.text, dict, locale);
			  const text = clipped.truncated ? dict.truncatedNote + '\n\n' + built.text : built.text;

			  return {
			    ok: true,
			    text,
			    segments: built.segments,
			    meta: buildMeta(strength, locale, rawText, text, clipped.truncated),
			  };
			}

			const __default__ = optimize;

			/* ------------------------------------------------------------------ meta -- */

			function buildMeta(strength, locale, original, output, truncated) {
			  return {
			    strength,
			    locale,
			    engine: 'local',
			    originalLength: original.length,
			    optimizedLength: output.length,
			    changed: output !== original,
			    truncated: Boolean(truncated),
			  };
			}

			function fail(reason, strength, locale, rawText) {
			  return {
			    ok: false,
			    reason,
			    text: '',
			    segments: [],
			    meta: {
			      strength,
			      locale,
			      engine: 'local',
			      originalLength: rawText.length,
			      optimizedLength: 0,
			      changed: false,
			      truncated: false,
			    },
			  };
			}

			function normalizeStrength(value) {
			  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
			  return STRENGTHS.indexOf(s) !== -1 ? s : 'standard';
			}

			function normalizeLocale(value) {
			  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
			  return s.indexOf('en') === 0 ? 'en' : 'zh';
			}

			/* -------------------------------------------------------------- assembly -- */

			function assemble(strength, sourceText, dict, locale) {
			  const units = splitUnits(sourceText);

			  if (strength === 'light') {
			    // light 只补「角色」与「输出要求」两段；原文整段作为主体追加，永不重复进这两段。
			    const segments = [
			      { key: 'role', title: dict.titles.role, body: deriveRole(sourceText, dict) },
			      { key: 'output', title: dict.titles.output, body: deriveOutput(dict) },
			    ];
			    const text = render(segments) + '\n\n---\n\n' + sourceText;
			    return { segments, text };
			  }

			  const buckets = classify(units);
			  const segments = ORDER.map((key) => ({
			    key,
			    title: dict.titles[key],
			    body: bodyFor(key, buckets, strength, dict, sourceText),
			  }));

			  const repaired = repairFidelity(segments, units);
			  return { segments: repaired, text: render(repaired) };
			}

			function bodyFor(key, buckets, strength, dict, sourceText) {
			  const list = buckets[key] || [];
			  const deep = strength === 'deep';
			  const out = [];

			  if (list.length > 0) {
			    for (const unit of list) {
			      if (unit.type === 'code') out.push(unit.text); // 代码块整体保留，内部一个字符不改
			      else out.push(deep ? '- ' + unit.text.trim() : unit.text);
			    }
			  } else {
			    const derived =
			      key === 'role'
			        ? deriveRole(sourceText, dict)
			        : key === 'output'
			          ? deriveOutput(dict)
			          : dict.placeholders[key];
			    for (const line of derived.split('\n')) {
			      out.push(deep && !isBullet(line) ? '- ' + line.trim() : line);
			    }
			  }

			  if (deep && key === 'constraints') {
			    for (const item of dict.acceptance) out.push('- ' + item);
			  }

			  return out.join('\n');
			}

			function render(segments) {
			  return segments
			    .map((s) => '### ' + s.title + '\n' + s.body.trim())
			    .join('\n\n');
			}

			function deriveRole(sourceText, dict) {
			  const hay = sourceText.toLowerCase();
			  for (const preset of ROLE_PRESETS) {
			    for (const word of preset.match) {
			      if (hay.indexOf(word.toLowerCase()) !== -1) return preset[dict.code];
			    }
			  }
			  return dict.defaultRole;
			}

			function deriveOutput(dict) {
			  return dict.outputLines.map((line) => '- ' + line).join('\n');
			}

			function isBullet(line) {
			  const t = line.trim();
			  return t.indexOf('- ') === 0 || t.indexOf('* ') === 0 || /^\d+[.)]\s/.test(t);
			}

			/* --------------------------------------------------------------- fidelity -- */

			/**
			 * 兜底校验：把原文单元逐个回查输出的拼接体，凡未原样出现的单元立即补回 task 段。
			 * 这是"不删减任何显式约束"的运行时保证，而不是靠构造函数自觉。
			 */
			function repairFidelity(segments, units) {
			  const hay = segments.map((s) => s.body).join('\n');
			  const missing = units.filter((u) => u.needle !== '' && hay.indexOf(u.needle) === -1);
			  if (missing.length === 0) return segments;

			  const extra = missing
			    .map((u) => (u.type === 'code' ? u.text : u.text.trim()))
			    .join('\n');
			  const target = Math.max(0, segments.findIndex((s) => s.key === 'task'));
			  const next = segments.slice();
			  next[target] = { ...next[target], body: next[target].body + '\n' + extra };
			  return next;
			}

			/* ------------------------------------------------------------- unit split -- */

			function stripCr(line) {
			  return line.length > 0 && line.charAt(line.length - 1) === '\r' ? line.slice(0, -1) : line;
			}

			/**
			 * 围栏探测：返回 { char, len, bare } 或 null。
			 * bare=true 表示这一行只有围栏本身（可作为闭合行），带语言标注只可能是开围栏。
			 */
			function fenceOf(line) {
			  const t = line.trim();
			  let char = '';
			  if (t.indexOf(TICK + TICK + TICK) === 0) char = TICK;
			  else if (t.indexOf('~~~') === 0) char = '~';
			  else return null;

			  let len = 0;
			  while (t.charAt(len) === char) len += 1;
			  const rest = t.slice(len).trim();
			  return { char, len, bare: rest === '' };
			}

			/** 把原文切成原子单元：围栏代码块整体一个 code 单元，其余每行一个 line 单元 */
			function splitUnits(text) {
			  const lines = text.split('\n');
			  const units = [];
			  let buffer = null;
			  let open = null;

			  for (const raw of lines) {
			    const line = stripCr(raw);
			    if (open) {
			      buffer.push(line);
			      const f = fenceOf(line);
			      if (f && f.char === open.char && f.len >= open.len && f.bare) {
			        units.push(codeUnit(buffer));
			        buffer = null;
			        open = null;
			      }
			      continue;
			    }
			    const f = fenceOf(line);
			    if (f) {
			      open = f;
			      buffer = [line];
			      continue;
			    }
			    units.push(lineUnit(line));
			  }
			  if (buffer) units.push(codeUnit(buffer));
			  return units;
			}

			function lineUnit(line) {
			  const needle = line.trim();
			  return { type: needle === '' ? 'blank' : 'line', text: line, needle };
			}

			function codeUnit(buffer) {
			  const text = buffer.join('\n');
			  return { type: 'code', text, needle: text.trim() };
			}

			/* ------------------------------------------------------------ classifying -- */

			function classify(units) {
			  const buckets = { role: [], task: [], context: [], output: [], constraints: [] };
			  for (const unit of units) {
			    if (unit.type === 'blank') continue;
			    const key = unit.type === 'code' ? 'context' : classifyLine(unit.text);
			    buckets[key].push(unit);
			  }
			  return buckets;
			}

			function classifyLine(line) {
			  const lower = line.toLowerCase();
			  for (const key of CLASSIFY_ORDER) {
			    const words = KEYWORDS[key] || [];
			    for (const word of words) {
			      if (lower.indexOf(word.toLowerCase()) !== -1) return key;
			    }
			  }
			  return 'task';
			}

			/* -------------------------------------------------------------- truncation -- */

			/** 超长裁剪；若截断点落在围栏内部，则回退到该围栏起始处，绝不产出半截代码块 */
			function clip(text, limit) {
			  if (text.length <= limit) return { text, truncated: false };
			  const cut = text.slice(0, limit);
			  const openAt = lastOpenFenceStart(cut);
			  const safeEnd = openAt >= 0 ? openAt : cut.length;
			  const safe = cut.slice(0, safeEnd).trimEnd();
			  return { text: safe, truncated: true };
			}

			function lastOpenFenceStart(src) {
			  const lines = src.split('\n');
			  let offset = 0;
			  let open = null;
			  for (const raw of lines) {
			    const f = fenceOf(stripCr(raw));
			    if (f) {
			      if (!open) open = { offset, char: f.char, len: f.len };
			      else if (f.char === open.char && f.len >= open.len && f.bare) open = null;
			    }
			    offset += raw.length + 1;
			  }
			  return open ? open.offset : -1;
			}

			/* -------------------------------------------------------------- idempotency -- */

			/**
			 * 识别"已经是本引擎产物"的输入：五个标题齐备且顺序正确，或 light 形态（角色 + 输出要求）。
			 * 命中即原样返回（changed:false），因此重复优化不会叠加标题。
			 */
			function parseOptimized(text) {
			  const inverse = {};
			  for (const code of Object.keys(LOCALES)) {
			    const titles = LOCALES[code].titles;
			    for (const key of ORDER) inverse[titles[key]] = key;
			  }

			  const lines = text.split('\n');
			  const seen = [];
			  const bodies = {};
			  const titleOf = {};
			  let current = null;

			  for (const raw of lines) {
			    const line = stripCr(raw);
			    const head = line.indexOf('### ') === 0 ? line.slice(4).trim() : '';
			    const key = head !== '' && Object.prototype.hasOwnProperty.call(inverse, head) ? inverse[head] : null;
			    if (key) {
			      current = key;
			      if (!bodies[key]) {
			        bodies[key] = [];
			        seen.push(key);
			        titleOf[key] = head;
			      }
			      continue;
			    }
			    if (current) bodies[current].push(line);
			  }

			  const full = ORDER.every((k) => seen.indexOf(k) !== -1);
			  const lightForm = seen.length === 2 && seen.indexOf('role') !== -1 && seen.indexOf('output') !== -1;
			  if (!full && !lightForm) return null;

			  if (full) {
			    let last = -1;
			    for (const key of ORDER) {
			      const at = seen.indexOf(key);
			      if (at <= last) return null;
			      last = at;
			    }
			  }

			  return seen.map((key) => ({
			    key,
			    title: titleOf[key],
			    body: (bodies[key] || []).join('\n').trim(),
			  }));
			}

			return { STRENGTHS: STRENGTHS, optimize: optimize, __default__: __default__ };
		})(__m8.ORDER, __m8.CLASSIFY_ORDER, __m8.MAX_LENGTH, __m8.LOCALES, __m8.KEYWORDS, __m8.ROLE_PRESETS);

		// src/engine/merge.js（引擎内联）
		var __m10 = (function () {
			/**
			 * 归并引擎（P4a）：纯函数、无副作用、无 IO、无网络、无 DOM、无时钟、无第三方依赖。
			 *
			 * 职责：把一段自由文本按「角色 / 任务 / 上下文 / 输出要求 / 约束」五栏归并，
			 * 未命中任何信号的句子落到兜底栏「其他」，并提供三道内容守恒校验
			 * （句子守恒 / 硬 Token 守恒 / 栏目合法性）与两种失败处理策略（strict / lenient）。
			 *
			 * 硬性不变量：mergeSections 归入各栏的句子总数严格等于 splitSentences(text) 的条数，
			 * 一条不多、一条不少 —— 任何句子都必须落到某一栏（含 other），不得丢弃、不得重复。
			 */

			/** 五个固定栏目及其顺序（§4.2：段名与顺序固定） */
			const SECTION_ORDER = ['role', 'task', 'context', 'output', 'constraint'];

			/** 栏目中文名；other 为兜底栏，仅在有未归类句时才出现在渲染结果里 */
			const SECTION_TITLE = {
			  role: '角色',
			  task: '任务',
			  context: '上下文',
			  output: '输出要求',
			  constraint: '约束',
			  other: '其他',
			};

			/** 兜底栏标记（§4.2「未归类，请确认」，UI 直接展示） */
			const OTHER_NOTE = '(未归类，请确认)';

			/** 空栏占位：恒输出五个段头，空段写 - （无） */
			const EMPTY_PLACEHOLDER = '- （无）';

			const FENCE = String.fromCharCode(96, 96, 96);
			const BACKTICK = String.fromCharCode(96);
			const TERMINATORS = ['。', '！', '？', '；'];

			/** §4.1 角色信号（高置信：人称 + 身份） */
			const ROLE_SIGNALS = [
			  '你是', '您是', '您将扮演', '扮演', '作为一名', '作为一位', '作为角色', '你的身份',
			  '角色是', '身份是', 'act as', 'you are', 'your role', 'persona',
			];

			/** §4.1 任务信号（请求 / 动宾开头） */
			const TASK_SIGNALS = [
			  '请', '帮我', '麻烦', '给我', '实现', '生成', '分析', '写一个', '写一份', '改造', '创建',
			  '构建', '修复', '优化', '审查', '评审', '总结', '翻译', '解释', '梳理', '整理', '设计',
			  'create', 'write', 'generate', 'analyze', 'analyse', 'build', 'implement', 'fix',
			  'translate', 'explain', 'review', 'refactor', 'draft', 'summarize', 'summarise',
			];

			/** 祈使句首动词（§4.1 低置信信号：动宾结构开头） */
			const IMPERATIVE_HEADS = [
			  '请', '帮我', '麻烦', '给我', '实现', '生成', '分析', '写', '改造', '创建', '构建',
			  '修复', '优化', '审查', '评审', '总结', '翻译', '解释', '梳理', '整理', '设计',
			  '对比', '补充', '说明', '给出', '列出', '输出', '返回',
			];

			/** §4.1 约束信号（否定 / 上下限 / 原样保留） */
			const CONSTRAINT_SIGNALS = [
			  '必须', '不得', '禁止', '严禁', '切勿', '只能', '不要', '不能', '不可', '务必',
			  '仅限', '限定', '最多', '最少', '至少', '至多', '不超过', '不允许', '一律', '保留',
			  '原样', '保持', '勿',
			  'must', 'never', 'do not', "don't", 'only', 'at most', 'no more than', 'avoid',
			  'without changing', 'keep',
			];

			/** §4.1 输出要求信号（格式 / 篇幅 / 结构化产出物） */
			const OUTPUT_SIGNALS = [
			  '格式', '字数', '长度', '语言', '表格', '分点', '列点', '要点', '字段', '返回结构',
			  '列出', '输出', '返回',
			  'json', 'markdown', 'yaml', 'xml', 'csv', 'output', 'format', 'table', 'bullet', 'field',
			];

			/** §4.1 上下文信号（背景 / 材料 / 引用） */
			const CONTEXT_SIGNALS = [
			  '背景', '上下文', '已知', '材料', '参考', '根据', '输入是', '用户是', '当前', '前提',
			  '现状', '资料', '素材', '原文如下', 'http://', 'https://', '@',
			  'background', 'context', 'reference', 'given', 'existing',
			];

			/** 收窄为字符串数组 */
			function toList(value) {
			  if (!Array.isArray(value)) return [];
			  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
			}

			function isLineStart(text, index) {
			  if (index === 0) return true;
			  const prev = text[index - 1];
			  return prev === '\n' || prev === '\r';
			}

			/**
			 * 按 。！？；与换行切句。
			 * 行内代码（反引号内容）与代码围栏（三反引号块）内的内容不得被切碎：
			 * 围栏整块算作一句，围栏内的换行不触发切分。
			 * @param {string} text
			 * @returns {string[]} 已去除首尾空白、丢弃空句的句子数组
			 */
			function splitSentences(text) {
			  const src = typeof text === 'string' ? text : '';
			  const out = [];
			  let buf = '';
			  let index = 0;
			  let inFence = false;

			  const flush = () => {
			    const trimmed = buf.trim();
			    if (trimmed !== '') out.push(trimmed);
			    buf = '';
			  };

			  while (index < src.length) {
			    const ch = src[index];

			    if (inFence) {
			      if (ch === '\n' && src.startsWith(FENCE, index + 1)) {
			        buf += '\n' + FENCE;
			        index += 1 + FENCE.length;
			        inFence = false;
			        continue;
			      }
			      buf += ch;
			      index += 1;
			      continue;
			    }

			    if (ch === BACKTICK && src.startsWith(FENCE, index) && isLineStart(src, index)) {
			      inFence = true;
			      buf += FENCE;
			      index += FENCE.length;
			      continue;
			    }

			    if (ch === BACKTICK) {
			      let run = 1;
			      while (src[index + run] === BACKTICK) run += 1;
			      const marker = BACKTICK.repeat(run);
			      const close = src.indexOf(marker, index + run);
			      const stop = close === -1 ? src.length : close + run;
			      buf += src.slice(index, stop);
			      index = stop;
			      continue;
			    }

			    if (ch === '\n' || ch === '\r') {
			      flush();
			      index += 1;
			      continue;
			    }

			    if (TERMINATORS.indexOf(ch) !== -1) {
			      buf += ch;
			      flush();
			      index += 1;
			      continue;
			    }

			    buf += ch;
			    index += 1;
			  }

			  flush();
			  return out;
			}

			function hits(text, signals) {
			  return signals.some((signal) => text.indexOf(signal) !== -1);
			}

			/** 命中集合：角色与任务由人称与句法独立判定，不参与 约束>输出要求>上下文 的优先级竞争 */
			function analyzeSentence(sentence) {
			  const raw = typeof sentence === 'string' ? sentence : '';
			  const text = raw.trim().toLowerCase();
			  const hit = { role: false, task: false, context: false, output: false, constraint: false };
			  if (text === '') return hit;

			  // 代码围栏整块不是可归类的自然语言句，保持原样落「其他」
			  if (text.startsWith(FENCE)) return hit;

			  const taskDeclared = /你的任务|任务是|task is/.test(text);
			  hit.role = !taskDeclared && hits(text, ROLE_SIGNALS);
			  hit.task = taskDeclared || hits(text, TASK_SIGNALS) || hits(text, IMPERATIVE_HEADS.slice(0, 5)) ||
			    IMPERATIVE_HEADS.some((head) => text.startsWith(head));
			  hit.constraint = hits(text, CONSTRAINT_SIGNALS);
			  hit.output = hits(text, OUTPUT_SIGNALS);
			  hit.context = hits(text, CONTEXT_SIGNALS);
			  return hit;
			}

			/**
			 * 单句归栏（§4.1 信号表 + §4.2 优先级）。
			 * 判定顺序：角色（人称/身份）→ 约束 > 输出要求 > 上下文 → 任务（祈使句）→ other。
			 * 角色/任务不参与优先级竞争；同时命中多栏时按 §4.2「约束 > 输出要求 > 上下文」取首个。
			 * @param {string} sentence
			 * @returns {'role'|'task'|'context'|'output'|'constraint'|'other'}
			 */
			function classifySentence(sentence) {
			  const hit = analyzeSentence(sentence);
			  return pickSection(hit);
			}

			function pickSection(hit) {
			  if (hit.role) return 'role';
			  if (hit.constraint) return 'constraint';
			  if (hit.output) return 'output';
			  if (hit.context) return 'context';
			  if (hit.task) return 'task';
			  return 'other';
			}

			/**
			 * 整段归并。不变量：各栏条目总数 === splitSentences(text).length。
			 * @param {string} text
			 * @returns {{ sections: { role: string[], task: string[], context: string[], output: string[], constraint: string[], other: string[] }, reassigned: Array<{ from: string, to: string, text: string }> }}
			 *   reassigned：句子命中多栏且被优先级改判时记录（from = 按 SECTION_ORDER 的首个命中栏，to = 实际归入栏）
			 */
			function mergeSections(text) {
			  const sections = { role: [], task: [], context: [], output: [], constraint: [], other: [] };
			  const reassigned = [];

			  for (const sentence of splitSentences(text)) {
			    const hit = analyzeSentence(sentence);
			    const target = pickSection(hit);
			    sections[target].push(sentence);

			    const candidates = SECTION_ORDER.filter((key) => hit[key]);
			    if (candidates.length > 1 && candidates[0] !== target) {
			      reassigned.push({ from: candidates[0], to: target, text: sentence });
			    }
			  }

			  return { sections, reassigned };
			}

			function renderBlock(title, items, note) {
			  const lines = ['### ' + title];
			  const body = toList(items);
			  if (body.length === 0) {
			    lines.push(EMPTY_PLACEHOLDER);
			    return lines.join('\n');
			  }
			  for (const item of body) {
			    lines.push(note ? '- ' + item + ' ' + note : '- ' + item);
			  }
			  return lines.join('\n');
			}

			/**
			 * 排版：五个固定段头恒输出（空段写 - （无））；other 非空时追加「### 其他」并给条目加兜底标记。
			 * 只做排版，不改写、不合并、不省略任何原句。
			 * @param {{ role?: string[], task?: string[], context?: string[], output?: string[], constraint?: string[], other?: string[] }} sections
			 * @returns {string}
			 */
			function renderSections(sections) {
			  const src = sections && typeof sections === 'object' ? sections : {};
			  const blocks = SECTION_ORDER.map((key) => renderBlock(SECTION_TITLE[key], src[key], null));
			  const other = toList(src.other);
			  if (other.length > 0) blocks.push(renderBlock(SECTION_TITLE.other, other, OTHER_NOTE));
			  return blocks.join('\n\n');
			}

			function normalize(text) {
			  return String(text == null ? '' : text).replace(/\s+/g, '');
			}

			/** 提取行内代码内容，并把代码区域从待比对文本中遮蔽掉（避免重复计数） */
			function scanCode(text) {
			  const contents = [];
			  const masked = text
			    .replace(/\x60{3}[\s\S]*?\x60{3}/g, ' ')
			    .replace(/\x60+([^\x60\n]+?)\x60+/g, (_full, body) => {
			      const trimmed = String(body).trim();
			      if (trimmed !== '') contents.push(trimmed);
			      return ' ';
			    });
			  return { masked, contents };
			}

			/**
			 * 提取硬 Token：数字（含小数与千分位）、URL、@引用、行内代码、连续全大写标识符（长度 >= 2）
			 * @param {string} text
			 * @returns {string[]}
			 */
			function extractHardTokens(text) {
			  const src = typeof text === 'string' ? text : '';
			  const { masked, contents } = scanCode(src);
			  const tokens = [];

			  for (const match of masked.match(/(?:\d+(?:[.,]\d+)*)/g) || []) tokens.push(match);

			  for (const match of masked.match(/https?:\/\/[^\s)）】,，。；;]+/g) || []) {
			    tokens.push(match.replace(/[.,;:!?]+$/, ''));
			  }

			  for (const match of masked.match(/@[A-Za-z0-9_.\-]+/g) || []) tokens.push(match);

			  for (const match of masked.match(/\b[A-Z][A-Z0-9_]{1,}\b/g) || []) tokens.push(match);

			  for (const content of contents) tokens.push(content);

			  return tokens;
			}

			function countTokens(text) {
			  const counts = new Map();
			  for (const token of extractHardTokens(text)) counts.set(token, (counts.get(token) || 0) + 1);
			  return counts;
			}

			function diffTokens(originalText, resultText) {
			  const want = countTokens(originalText);
			  const have = countTokens(resultText);
			  const lost = [];
			  for (const [token, expected] of want) {
			    const actual = have.get(token) || 0;
			    for (let index = actual; index < expected; index += 1) lost.push(token);
			  }
			  return lost;
			}

			/* ---------- 软守恒：关键片段覆盖率 ---------- */

			/** 关键片段长度区间：2–4 个实义字符 */
			const SOFT_PIECE_MIN = 2;
			const SOFT_PIECE_MAX = 4;

			/** 覆盖率阈值：低于它才判该句丢失（0.6 = 原句实义片段至少六成仍以原文形态出现） */
			const SOFT_COVERAGE_THRESHOLD = 0.6;

			/** 多字虚词：先整体剔除，避免虚词把实义片段粘成假片段 */
			const SOFT_STOP_WORDS = [
			  '还是', '或者', '但是', '因为', '所以', '如果', '可以', '这个', '那个', '我们', '你们',
			  '他们', '怎么', '什么', '怎样', '如何', '已经', '非常', '觉得', '一个', '一些', '这种',
			  '那样', '这样', '然后', '而且', '以及', '的话', '是不是', '有没有',
			];

			/** 单字虚词：逐字剔除（不含否定字「不 / 没 / 无 / 未」，否定走硬守恒层） */
			const SOFT_STOP_CHARS = '的地得了着是在我你他她它这那有和与及也都就还很太要会能可把被让给对从向于么怎呢吗吧啊呀嘛请帮们之其而且则若';

			const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff]/;
			const ASCII_WORD_CHAR = /[0-9a-z]/;

			/** 把一段实义串切成关键片段：2–4 字整串算一个，更长的串取全部 2/3/4 字子串 */
			function pushRunPieces(run, pieces) {
			  if (run.length < SOFT_PIECE_MIN) return;
			  if (run.length <= SOFT_PIECE_MAX) {
			    pieces.push(run);
			    return;
			  }
			  for (let size = SOFT_PIECE_MIN; size <= SOFT_PIECE_MAX; size += 1) {
			    for (let start = 0; start + size <= run.length; start += 1) pieces.push(run.slice(start, start + size));
			  }
			}

			/**
			 * 切关键片段：剔除虚词后按标点 / 空白切出实义串，再切 2–4 字片段。
			 * 片段是原句的实义切片：重写会打散它，但不会让原句没有的片段凭空出现，
			 * 所以片段覆盖率能区分「换了说法」与「丢了内容」。
			 * @param {string} text
			 * @returns {string[]} 去重后的片段
			 */
			function softPieces(text) {
			  const src = typeof text === 'string' ? text.toLowerCase() : '';
			  let staged = src;
			  for (const word of SOFT_STOP_WORDS) staged = staged.split(word).join(' ');
			  const pieces = [];
			  let run = '';
			  let word = '';
			  const flushRun = () => {
			    if (run !== '') {
			      pushRunPieces(run, pieces);
			      run = '';
			    }
			  };
			  const flushWord = () => {
			    if (word !== '') {
			      if (word.length >= SOFT_PIECE_MIN) pieces.push(word);
			      word = '';
			    }
			  };
			  for (const ch of staged) {
			    if (CJK_CHAR.test(ch)) {
			      flushWord();
			      if (SOFT_STOP_CHARS.indexOf(ch) === -1) run += ch;
			      else flushRun();
			      continue;
			    }
			    if (ASCII_WORD_CHAR.test(ch)) {
			      flushRun();
			      word += ch;
			      continue;
			    }
			    flushRun();
			    flushWord();
			  }
			  flushRun();
			  flushWord();
			  return Array.from(new Set(pieces));
			}

			/** 覆盖率 = 命中片段数 / 片段总数；切不出片段时返回 null（交回字面判定） */
			function coverageOf(sentence, flat) {
			  const pieces = softPieces(sentence);
			  if (pieces.length === 0) return null;
			  let hit = 0;
			  for (const piece of pieces) if (flat.indexOf(piece) !== -1) hit += 1;
			  return hit / pieces.length;
			}

			/**
			 * 反义极性轴：同一条轴上的两个方向，组内同义同向（提高 / 提升），组间互为反义（提高 / 降低）。
			 * 覆盖率只数「片段还在不在」—— 提高→降低 时除「提高」外的片段全命中，覆盖率仍高于阈值，
			 * 所以方向被翻转必须由这一层单独守。
			 */
			const SOFT_POLARITY_AXES = [
			  ['增减', ['提高', '增加', '上升', '提升', '增强', '扩大', '加快'], ['降低', '减少', '下降', '削弱', '缩小', '减慢', '减弱']],
			  ['许可', ['允许', '启用', '开启', '支持'], ['禁止', '禁用', '关闭', '反对']],
			  ['极值', ['最大'], ['最小']],
			  ['频次', ['总是', '始终'], ['从不', '绝不']],
			  ['时序', ['before'], ['after']],
			  ['增减-en', ['increase', 'raise', 'boost'], ['decrease', 'reduce', 'lower']],
			  ['许可-en', ['allow', 'enable', 'permit'], ['forbid', 'disable', 'deny']],
			];

			/** 极性词紧邻的否定字 / 词：不允许、不提高、not increase 是反向表达，不能按本方向计数 */
			const POLARITY_NEG_CHARS = '不没未别无莫';
			const POLARITY_NEG_WORDS = ['not', 'no', 'never', 'nor'];
			const POLARITY_ASCII_WORD = /^[a-z0-9']+$/;

			/**
			 * 计一个极性词的有效次数：CJK 按字面、ASCII 按词边界（allow 不命中 allowlist），
			 * 紧邻否定的匹配不计入本方向。
			 * @param {string} text
			 * @param {string} word
			 * @returns {number}
			 */
			function polarityHits(text, word) {
			  const hay = typeof text === 'string' ? text.toLowerCase() : '';
			  const needle = typeof word === 'string' ? word.toLowerCase() : '';
			  if (hay === '' || needle === '') return 0;
			  const ascii = POLARITY_ASCII_WORD.test(needle);
			  let hits = 0;
			  let from = hay.indexOf(needle);
			  while (from !== -1) {
			    const lead = from > 0 ? hay.charAt(from - 1) : '';
			    const tail = hay.charAt(from + needle.length);
			    const boundaryBad = ascii && (/[a-z0-9]/.test(lead) || /[a-z0-9]/.test(tail));
			    const leadWord = from === 0 ? '' : (hay.slice(0, from).match(/[a-z']+\s*$/) || [''])[0].trim();
			    const negated =
			      (lead !== '' && POLARITY_NEG_CHARS.indexOf(lead) !== -1) ||
			      (ascii && POLARITY_NEG_WORDS.indexOf(leadWord) !== -1);
			    if (!boundaryBad && !negated) hits += 1;
			    from = hay.indexOf(needle, from + needle.length);
			  }
			  return hits;
			}

			/**
			 * 该方向全部词的有效次数之和。同时给出原文（保留空白，ASCII 靠词边界计）与归一化文本
			 * （去空白，CJK 被换行拆开时也能命中），每个词取两者较大值，避免一种形态漏计。
			 * @param {string[]} texts
			 * @param {string[]} words
			 * @returns {number}
			 */
			function polarityCount(texts, words) {
			  let total = 0;
			  for (const word of words) {
			    let best = 0;
			    for (const text of texts) best = Math.max(best, polarityHits(text, word));
			    total += best;
			  }
			  return total;
			}

			/** 该方向里第一个真正出现的词（供 details 文案用），没有则返回空串 */
			function firstPolarityWord(texts, words) {
			  for (const word of words) {
			    for (const text of texts) if (polarityHits(text, word) > 0) return word;
			  }
			  return '';
			}

			/**
			 * 反义极性冲突：原句用了某方向的极性词，结果里该方向整体缺失、却出现同轴反向词。
			 * 同向同义（提高 / 提升）不冲突；反向词也没出现时不算冲突，仍归覆盖率判定。
			 * @param {string} sentence 原句
			 * @param {string} result 结果全文（原文形态 + 归一化形态一起看）
			 * @param {string} flat 归一化并小写后的结果全文
			 * @returns {string} 冲突说明（空串 = 无冲突）
			 */
			function polarityConflictOf(sentence, result, flat) {
			  const mineTexts = [sentence];
			  const hayTexts = [result, flat];
			  for (const [label, forward, backward] of SOFT_POLARITY_AXES) {
			    for (const [mine, opposite] of [[forward, backward], [backward, forward]]) {
			      if (polarityCount(mineTexts, mine) === 0) continue;
			      // 原方向还在结果里：方向没被翻转
			      if (polarityCount(hayTexts, mine) > 0) continue;
			      // 反向词也没出现：属覆盖率范畴，不在这一层判
			      if (polarityCount(hayTexts, opposite) === 0) continue;
			      return label + '「' + firstPolarityWord(mineTexts, mine) + '」被改成「' + firstPolarityWord(hayTexts, opposite) + '」';
			    }
			  }
			  return '';
			}

			/**
			 * 硬守恒层的否定词族：守的是「否定语义没丢」，不是「否定词字节没丢」。
			 * 同族内任一写法命中即视为该族满足（不要 ⇄ 请勿 这类极性替换不算丢），但族内总出现
			 * 次数不得减少 —— 次数是信息量，仍按零容忍处理。
			 */
			const HARD_NEGATION_FAMILIES = [
			  ['不要', '不许', '不得', '禁止', '严禁', '切勿', '请勿', '不能', '不可'],
			  ['never', 'do not', "don't", 'must not'],
			];

			/** 复合词排除：命中位置前一个字若在此表里，它只是「能不能 / 可不可以 / 是不是 / 会不会 / 不得不」里的片段，不算否定 */
			const NEGATION_LEAD_EXCLUDE = ['能', '可', '是', '否', '会', '不', '得'];

			/** 只有以「能 / 可 / 得」结尾的否定词才会被复合词吞掉，才需要看相邻的字 */
			const NEGATION_TAIL_CHARS = '能可得';

			/**
			 * 计次：ASCII 词按词边界比对（never 不命中 whenever）；CJK 词按字面计次，但剔除复合词片段。
			 * @param {string} text
			 * @param {string} word
			 * @returns {number}
			 */
			function countWord(text, word) {
			  const needle = typeof word === 'string' ? word.toLowerCase() : '';
			  if (needle === '') return 0;
			  const hay = typeof text === 'string' ? text.toLowerCase() : '';
			  if (/^[a-z0-9' ]+$/.test(needle)) {
			    const padded = ' ' + hay.replace(/[^a-z0-9']+/g, ' ').replace(/ +/g, ' ').trim() + ' ';
			    return padded.split(' ' + needle + ' ').length - 1;
			  }
			  const guardLead = NEGATION_TAIL_CHARS.indexOf(needle.charAt(needle.length - 1)) !== -1;
			  let count = 0;
			  let from = hay.indexOf(needle);
			  while (from !== -1) {
			    const lead = from > 0 ? hay.charAt(from - 1) : '';
			    const next = hay.charAt(from + needle.length);
			    // 前一个字构成复合词（能不能 / 可不可以 / 是不是 / 会不会）或是「不得不 / 不能不」这类双重否定表肯定，都不算否定
			    const compound = guardLead && NEGATION_LEAD_EXCLUDE.indexOf(lead) !== -1;
			    const doubleNegative = guardLead && next === '不';
			    if (!compound && !doubleNegative) count += 1;
			    from = hay.indexOf(needle, from + needle.length);
			  }
			  return count;
			}

			/** 族计数：族内各写法的有效次数之和 */
			function familyCount(text, family) {
			  let total = 0;
			  for (const word of family) total += countWord(text, word);
			  return total;
			}

			/**
			 * 否定语义守恒：按族比较原文与结果的计数，差的次数以族标签（族内首个词）推入 lostTokens，
			 * 保证 lostTokens 仍是 string[] 且可直接显示。
			 */
			function diffNegations(originalText, resultText) {
			  const lost = [];
			  for (const family of HARD_NEGATION_FAMILIES) {
			    const want = familyCount(originalText, family);
			    if (want === 0) continue;
			    const have = familyCount(resultText, family);
			    for (let index = have; index < want; index += 1) lost.push(family[0]);
			  }
			  return lost;
			}

			function checkSections(resultText) {
			  const details = [];
			  const expected = SECTION_ORDER.map((key) => SECTION_TITLE[key]);
			  const heads = [];
			  for (const match of resultText.match(/^###\s+(.+)$/gm) || []) heads.push(match.replace(/^###\s+/, '').trim());

			  const real = heads.filter((title) => title !== SECTION_TITLE.other);
			  let ok = true;

			  if (real.length !== expected.length) {
			    ok = false;
			    details.push('段头数量应为 ' + expected.length + ' 个，实际 ' + real.length + ' 个');
			  }
			  for (let index = 0; index < expected.length; index += 1) {
			    if (real[index] !== expected[index]) {
			      ok = false;
			      details.push('第 ' + (index + 1) + ' 段应为「' + expected[index] + '」，实际「' + (real[index] || '缺失') + '」');
			    }
			  }
			  const otherCount = heads.length - real.length;
			  if (otherCount > 1) {
			    ok = false;
			    details.push('「' + SECTION_TITLE.other + '」段重复出现 ' + otherCount + ' 次');
			  }
			  if (otherCount === 1 && heads[heads.length - 1] !== SECTION_TITLE.other) {
			    ok = false;
			    details.push('「' + SECTION_TITLE.other + '」段必须位于五段之后');
			  }
			  return { ok, details };
			}

			/**
			 * 三道内容守恒校验（§4.3）：硬 Token 零容忍 + 句子关键片段覆盖率 + 栏目合法性。
			 * 软守恒口径：原句不再要求字面复现，只要求关键片段覆盖率不低于 SOFT_COVERAGE_THRESHOLD ——
			 * 表达被重写但原意保住时 dropped 为空，真正丢信息时才判 dropped。
			 * 极性口径：软守恒通过后再判一次反义冲突 —— 原句的极性方向在结果里消失、却出现同轴反向词
			 * （提高 → 降低）时，覆盖率照样合格，同样判该句丢内容。
			 * 硬守恒口径不变：extractHardTokens 的 token 与否定词必须逐个出现，缺一个就 ok=false。
			 * @param {string} originalText 原文
			 * @param {string} resultText 结果
			 * @returns {{ ok: boolean, dropped: string[], lostTokens: string[], sectionValid: boolean, details: string[] }}
			 *   dropped/lostTokens 均为原文原文（便于 UI 直接显示）
			 */
			function verifyConservation(originalText, resultText) {
			  const original = typeof originalText === 'string' ? originalText : '';
			  const result = typeof resultText === 'string' ? resultText : '';
			  const details = [];
			  try {
			    const flat = normalize(result).toLowerCase();
			    const dropped = [];
			    const polarityConflicts = [];
			    for (const sentence of splitSentences(original)) {
			      if (flat.indexOf(normalize(sentence).toLowerCase()) !== -1) continue;
			      // 代码围栏整块按字面守恒：程序片段不允许被「重写」
			      if (sentence.indexOf(FENCE) === 0) {
			        dropped.push(sentence);
			        continue;
			      }
			      const coverage = coverageOf(sentence, flat);
			      if (coverage === null || coverage < SOFT_COVERAGE_THRESHOLD) {
			        dropped.push(sentence);
			        continue;
			      }
			      // 覆盖率只数片段在不在：提高→降低 时其余片段全命中，通过后必须再判一次极性方向
			      const conflict = polarityConflictOf(sentence, result, flat);
			      if (conflict !== '') {
			        dropped.push(sentence);
			        polarityConflicts.push(conflict);
			      }
			    }

			    const lostTokens = diffTokens(original, result).concat(diffNegations(original, result));
			    const checked = checkSections(result);

			    if (dropped.length > 0) details.push('有 ' + dropped.length + ' 处内容未能保真（原句关键片段覆盖率低于 ' + SOFT_COVERAGE_THRESHOLD + '，或极性方向被翻转）');
			    if (polarityConflicts.length > 0) details.push('有 ' + polarityConflicts.length + ' 处反义极性冲突：' + polarityConflicts.join('；'));
			    if (lostTokens.length > 0) details.push('有 ' + lostTokens.length + ' 处硬 Token 丢失：' + lostTokens.join('、'));
			    for (const line of checked.details) details.push(line);

			    const ok = dropped.length === 0 && lostTokens.length === 0 && checked.ok;
			    return { ok, dropped, lostTokens, sectionValid: checked.ok, details };
			  } catch (error) {
			    return {
			      ok: false,
			      dropped: [],
			      lostTokens: [],
			      sectionValid: false,
			      details: ['守恒校验异常：' + (error instanceof Error ? error.message : String(error))],
			    };
			  }
			}

			function appendToOther(text, lines) {
			  const src = typeof text === 'string' ? text : '';
			  const rows = src.split(/\r?\n/);
			  const header = '### ' + SECTION_TITLE.other;
			  const headerIndex = rows.findIndex((row) => row.trim() === header);

			  if (headerIndex === -1) {
			    const parts = [];
			    const trimmed = src.replace(/\s+$/, '');
			    if (trimmed !== '') parts.push(trimmed, '');
			    parts.push(header);
			    for (const line of lines) parts.push(line);
			    return parts.join('\n');
			  }

			  let end = rows.length;
			  for (let index = headerIndex + 1; index < rows.length; index += 1) {
			    if (/^###\s+/.test(rows[index])) {
			      end = index;
			      break;
			    }
			  }

			  let insertAt = end;
			  while (insertAt > headerIndex + 1 && rows[insertAt - 1].trim() === '') insertAt -= 1;

			  const existing = rows.slice(headerIndex + 1, insertAt);
			  const hasContent = existing.some((row) => row.trim() !== '' && row.trim() !== EMPTY_PLACEHOLDER);
			  const body = hasContent ? existing : [];

			  return [...rows.slice(0, headerIndex + 1), ...body, ...lines, ...rows.slice(insertAt)].join('\n');
			}

			/** 段头行号：只认整行就是「### 段名」的行 */
			function findSectionHead(rows, title) {
			  const header = '### ' + title;
			  for (let index = 0; index < rows.length; index += 1) {
			    if (rows[index].trim() === header) return index;
			  }
			  return -1;
			}

			/**
			 * 段头兜底：按 SECTION_ORDER 补齐缺失段头，缺的段写一行空段占位（与 renderSections 同语义）。
			 * 只修结构，不动任何已有内容；插入点取「顺序上后一个已存在的段头」之前，「其他」之前次之，末尾兜底。
			 * @param {string} text
			 * @returns {{ text: string, added: string[] }} added = 被补齐的段名（有则说明文本被改写过）
			 */
			function backfillSections(text) {
			  const src = typeof text === 'string' ? text : '';
			  const expected = SECTION_ORDER.map((key) => SECTION_TITLE[key]);
			  const added = [];
			  let rows = src.split(/\r?\n/);
			  // 一条段头都没有的结果不是「缺段头」而是「没按格式产出」：凭空补五段空壳只会盖掉用户输入，交回 strict/lenient 原有内容口径处理
			  if (!rows.some((row) => /^###\s+/.test(row.trim()))) return { text: src, added };

			  for (let index = 0; index < expected.length; index += 1) {
			    const title = expected[index];
			    if (findSectionHead(rows, title) !== -1) continue;

			    let at = -1;
			    for (let next = index + 1; next < expected.length && at === -1; next += 1) {
			      at = findSectionHead(rows, expected[next]);
			    }
			    if (at === -1) at = findSectionHead(rows, SECTION_TITLE.other);

			    if (at === -1) {
			      while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
			      rows = rows.concat(['', '### ' + title, EMPTY_PLACEHOLDER]);
			    } else {
			      rows = [...rows.slice(0, at), '', '### ' + title, EMPTY_PLACEHOLDER, '', ...rows.slice(at)];
			    }
			    added.push(title);
			  }

			  if (added.length === 0) return { text: src, added };
			  return { text: rows.join('\n').replace(/^\n+/, ''), added };
			}

			/**
			 * 按 mergeMode 处理校验失败（§4.3）。
			 * 顺序：先做结构兜底（缺段头按 SECTION_ORDER 补齐并写进 report.details），再按模式处理内容。
			 * strict：内容原样返回、不补回任何句子，applied 只在真的补过段头时为 true。
			 * lenient：把 dropped 句与 lostTokens 补进「### 其他」并标注，applied=true。
			 * 永不抛错：任何异常都降级为「原文内容未补偿」的 strict 形状。
			 * @param {string} originalText
			 * @param {string} resultText
			 * @param {'strict'|'lenient'} mode
			 * @returns {{ text: string, mode: string, applied: boolean, report: object }}
			 */
			function applyConservation(originalText, resultText, mode) {
			  const result = typeof resultText === 'string' ? resultText : '';
			  const chosen = mode === 'lenient' ? 'lenient' : 'strict';

			  try {
			    const repaired = backfillSections(result);
			    const base = repaired.text;
			    // backfilled：给上层区分「只补了段头」与「补回了句子」用（engine.js 的提示文案依赖它），无补齐时为 []
			    const report = { ...verifyConservation(originalText, base), backfilled: repaired.added };
			    if (repaired.added.length > 0) {
			      report.details.unshift('段头缺失已兜底：补齐 ' + repaired.added.length + ' 个段头（' + repaired.added.join('、') + '），各写一行 ' + EMPTY_PLACEHOLDER + ' 占位');
			    }
			    // applied 的口径：返回值相对入参是否被改写过（段头兜底与内容补回都算改写）
			    const applied = base !== result;

			    if (report.ok) return { text: base, mode: chosen, applied, report };
			    if (chosen === 'strict') return { text: base, mode: 'strict', applied, report };

			    const additions = [];
			    for (const sentence of report.dropped) additions.push('- ' + sentence + ' ' + OTHER_NOTE);

			    // 补回原句通常已经带回了其中的数字 / URL / 否定词，只对仍然缺失的 token 追加标注，避免重复
			    const projected = base + '\n' + report.dropped.join('\n');
			    const stillLost = diffTokens(originalText, projected).concat(diffNegations(originalText, projected));
			    for (const token of stillLost) additions.push('- 丢失的原文 token：' + token + ' ' + OTHER_NOTE);

			    if (additions.length === 0) {
			      for (const key of SECTION_ORDER) {
			        if (base.indexOf('### ' + SECTION_TITLE[key]) === -1) {
			          additions.push('- 缺失栏目：' + SECTION_TITLE[key] + ' ' + OTHER_NOTE);
			        }
			      }
			    }
			    // 没有任何可补内容时不得凭空造一个空「其他」栏
			    if (additions.length === 0) {
			      return { text: base, mode: 'lenient', applied, report: { ...report, compensated: 0, recheckOk: report.ok } };
			    }

			    const patched = appendToOther(base, additions);
			    const recheck = verifyConservation(originalText, patched);
			    return {
			      text: patched,
			      mode: 'lenient',
			      applied: true,
			      report: { ...report, compensated: additions.length, recheckOk: recheck.ok },
			    };
			  } catch (error) {
			    return {
			      text: result,
			      mode: chosen,
			      applied: false,
			      report: {
			        ok: false,
			        dropped: [],
			        lostTokens: [],
			        sectionValid: false,
			        backfilled: [],
			        details: ['守恒兜底异常：' + (error instanceof Error ? error.message : String(error))],
			      },
			    };
			  }
			}

			return { SECTION_ORDER: SECTION_ORDER, SECTION_TITLE: SECTION_TITLE, OTHER_NOTE: OTHER_NOTE, EMPTY_PLACEHOLDER: EMPTY_PLACEHOLDER, splitSentences: splitSentences, classifySentence: classifySentence, mergeSections: mergeSections, renderSections: renderSections, extractHardTokens: extractHardTokens, verifyConservation: verifyConservation, applyConservation: applyConservation };
		})();

		// src/client/index.js
		var __m11 = (function (PromptOptimizerButton, ensureStyle, setEngine, setRemote, setMerge, optimize, STRENGTHS, verifyConservation, applyConservation, mergeSections, SECTION_ORDER, SECTION_TITLE, OTHER_NOTE, optimizeViaRemote, FAILURE_TEXT) {
			/**
			 * 槽位装配 + 引擎接线。
			 *
			 * conversation.input.activity 是 single 槽：只注册一条，浮层全部由组件自己渲染。
			 * 引擎在构建期被内联成同一个 factory 作用域里的模块，这里把它接进 engine.js 的
			 * 注入点 —— 客户端产物因此不需要 require 任何本地文件。
			 */

			// 内联引擎接线（构建产物里 optimize/STRENGTHS 就是 src/engine 的那份实现）
			setEngine({ optimize, STRENGTHS });
			// LLM 通路接线：同源 fetch 到宿主注册的 /api/prompt-optimizer/optimize；失败即回退上面的本地引擎
			setRemote({ optimizeViaRemote, FAILURE_TEXT });
			// 守恒校验兜底接线：单独注入（未装载时兜底降级为「不校验、原样展示」，不影响优化通路本身）
			setMerge({ verifyConservation, applyConservation, mergeSections, SECTION_ORDER, SECTION_TITLE, OTHER_NOTE });

			/**
			 * 槽位注册清单。
			 * registerOptions 是空集，所以只需要 name：useInput / inputActions 等是渲染器
			 * 无条件注入的标准 props，不靠 store 座位。
			 */
			function slotEntries() {
				return [{
					name: "conversation.input.activity",
					options: { name: "conversation.input.activity" },
					component: PromptOptimizerButton
				}];
			}

			/**
			 * 客户端插件主体：注入样式表（一次）+ 注册槽位。
			 * @param ctx Web Client 根上下文
			 */
			function apply(ctx) {
				ensureStyle();
				for (const entry of slotEntries()) ctx.slots.inject(entry.name, () => ctx.slots.register(entry.options, entry.component));
			}

			const inject = ["slots"];

			/** 供状态机仿真替换引擎/远端实现（默认即上面内联的那两份）。 */

			/** 组件也对外导出，便于宿主/仿真直接挂载。 */

			return { slotEntries: slotEntries, apply: apply, inject: inject, setEngine: setEngine, setRemote: setRemote, setMerge: setMerge, PromptOptimizerButton: PromptOptimizerButton };
		})(__m6.PromptOptimizerButton, __m7.ensureStyle, __m0.setEngine, __m0.setRemote, __m0.setMerge, __m9.optimize, __m9.STRENGTHS, __m10.verifyConservation, __m10.applyConservation, __m10.mergeSections, __m10.SECTION_ORDER, __m10.SECTION_TITLE, __m10.OTHER_NOTE, __m5.optimizeViaRemote, __m5.FAILURE_TEXT);

		var __entry = __m11;
		exports.slotEntries = __entry.slotEntries;
		exports.apply = __entry.apply;
		exports.inject = __entry.inject;
		exports.setEngine = __entry.setEngine;
		exports.setRemote = __entry.setRemote;
		exports.setMerge = __entry.setMerge;
		exports.PromptOptimizerButton = __entry.PromptOptimizerButton;
		return module.exports;
	}
});
