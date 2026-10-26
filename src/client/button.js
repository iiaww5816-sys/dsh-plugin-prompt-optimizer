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
import react from "react";
import { getEngine, getRemote, applyGuard } from "./engine.js";
import { anchorOf, fixedStyle, preventFocusSteal } from "./dom.js";
import { CONFIG_KEY, SCHEMA_VERSION, loadModels, saveModels } from "../shared/config.js";
import { StatusToast, ComparePanel, SettingsPanel, ErrorBanner } from "./overlays.js";
import {
	emptyForm,
	formFromModel,
	formWithField,
	validateForm,
	modelFromForm,
	countText,
	addModelToList,
	updateModelInList,
	deleteModelFromList,
	chooseDefaultModel,
	applySetting,
	resolveEngine,
	providerIdOf,
	legacyConfigPrompt,
	legacyModels,
	summarizeTest,
	corruptNotice,
	migratedNotice,
	storageNotice,
	hostNotice,
	formErrorSummaryText
} from "./settings.js";
import { fetchModelTable, saveModelTable, probeConnection } from "./llm.js";

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
export function PromptOptimizerButton({ sessionId, useInput, inputActions, locked, onActiveChange, t }) {
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
