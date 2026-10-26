/**
 * 宿主半边：把「LLM 优化」通路与「模型表」通路注册成两条同源 exact route。
 *
 * 为什么必须由宿主代发：客户端不能直连第三方 LLM —— CORS 不可控，而且密钥会落到浏览器里。
 * 宿主侧是 Node，裸 fetch 由 dsh-http-proxy 统一走代理策略（所以这里**不传** dispatcher /
 * Agent，传了会静默绕过代理），密钥也只留在宿主自己持有的模型表与 patch config 里。
 *
 * 安全边界（每条都有 tests/host-route.test.mjs 的断言守着）：
 *  1. 上游地址只来自**宿主自己持有的两处**：宿主模型表（pluginDataDir()/models.json，或装载行
 *     config.models）与装载行 config.llmEndpoint。请求体只提供 providerId（表内 id 查表），
 *     请求体里的 endpoint / apiKey / model 一律忽略、并在响应里回 ignoredFields 便于排查 ——
 *     否则这条路由就是一个任意 URL 代理（SSRF）；
 *  2. 上游响应体**不透传**：只取 choices[0].message.content，并校验为非空字符串；
 *  3. 错误 body 只由固定文案 + 数字状态码拼成：不含上游 body、不含 URL、不含密钥；
 *     捕获到的异常只看 error.name，不看 error.message（后者可能带出地址）；
 *  4. GET /api/prompt-optimizer/models 只回掩码后的密钥（末 4 位），明文密钥永不离开宿主。
 *
 * 会话期与请求期分开：没填 llmEndpoint、模型表为空都不是装载期错误（默认引擎是本地，插件必须
 * 即插即用），注册照做，请求进来返回 501，客户端据此提示"未配置 LLM 地址"并留在本地引擎。
 *
 * **静态 import 必须保持为零**：宿主由 DSH 直接加载源码，没有解析依赖的步骤，所以这里只用内置
 * 能力（URL / Response / fetch / AbortSignal / process）。唯一的模块解析发生在真正落盘时 ——
 * pluginDataDir / readModelsFile / writeModelsFile 里对 node:fs、node:path、node:os 的
 * **动态** import()，只在用户真的读写模型表时执行，装载期不碰。
 */

/** host 侧不需要任何硬依赖（connection 走 ctx.inject）。 */
export const inject = [];

/** 优化通路的绝对路径（ConnectionFetchRoute.path 必须以 /api 开头）。 */
export const ROUTE_PATH = "/api/prompt-optimizer/optimize";

/** 模型表通路的绝对路径（GET 读、POST 整表覆盖写）。 */
export const MODELS_ROUTE_PATH = "/api/prompt-optimizer/models";

/** 配置里允许出现的字段（只做扩容：新增 models 与 settings 两栏）。 */
const CONFIG_FIELDS = ["llmEndpoint", "llmApiKey", "llmModel", "llmTemperature", "llmTimeoutMs", "models", "settings"];

const DEFAULT_TEMPERATURE = 0.2;
const MAX_TEMPERATURE = 2;
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 120000;
/** 单次优化的原文长度上限（字符数，按 UTF-16 码元计，与客户端同口径）。 */
const MAX_TEXT_LENGTH = 20000;

/** 模型表上限与各字段长度上限（docs/design-v0.2.md 第 1.1 节）。 */
const MODEL_LIMIT = 20;
const NAME_MAX = 40;
const API_KEY_MAX = 512;
const MODEL_MAX = 120;
const ID_MAX = 64;

/** 配置结构版本（design 1.2：固定 2，用于旧配置迁移）。 */
const SCHEMA_VERSION = 2;

const STRENGTH_OPTIONS = ["light", "standard", "deep"];
const LOCALE_OPTIONS = ["zh", "en"];
const ENGINE_OPTIONS = ["local", "llm", "auto"];
const MERGE_MODE_OPTIONS = ["strict", "lenient"];
const DEFAULT_STRENGTH = "standard";
const DEFAULT_LOCALE = "zh";

/** settings 的字段白名单（design 1.2）。 */
const SETTINGS_FIELDS = ["strength", "locale", "engine", "mergeMode", "schemaVersion"];

/** 全局设置兜底值（与 src/shared/config.js 的 DEFAULT_CONFIG 同口径，但不 import 它）。 */
const DEFAULT_SETTINGS = Object.freeze({
	strength: DEFAULT_STRENGTH,
	locale: DEFAULT_LOCALE,
	engine: "auto",
	mergeMode: "strict",
	schemaVersion: SCHEMA_VERSION
});

/** 五段段头：固定中文段名（客户端内容守恒校验按这五个字面量比对，两种语种都不许翻译）。 */
const SECTION_HEADERS = ["### 角色", "### 任务", "### 上下文", "### 输出要求", "### 约束"];

/** 优化请求体里允许出现、但一律不采信的关键字段（命中就回 ignoredFields）。 */
const IGNORED_BODY_FIELDS = ["endpoint", "apiKey", "model"];

/** 模型表落盘位置：$DSH_HOME/prompt-optimizer/models.json（与 dsh-our-free-model 的约定同形）。 */
const DATA_DIR_NAME = "prompt-optimizer";
const MODELS_FILE_NAME = "models.json";

const TEMPERATURE_RANGE = Object.freeze({ min: 0, max: MAX_TEMPERATURE, fallback: DEFAULT_TEMPERATURE });
const TIMEOUT_RANGE = Object.freeze({ min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS, fallback: DEFAULT_TIMEOUT_MS });

/** 中文强度段：三档各自的正向质量目标与补全额度（不再是「禁止清单」加长版）。 */
const STRENGTH_BLOCK_ZH = {
	light: [
		"本次强度：轻（light）。保留原文句式与段落顺序，只做口语转书面、补标点、修明显病句；把原文揉在一起的话拆到对应段时不要改写其表述。",
		"禁止改动句式结构，禁止增删原文任何信息；补全额度限于验收标准与「（待确认）」标注，不得替用户拍板。",
		"轻档同样要做四道自检：增益信息若只能来自推断，就写进带「（待确认）」的标注行。"
	],
	standard: [
		"本次强度：标准（standard）。在轻档之上，允许把原文按五段重排，并把模糊表述具体化为可执行、可验收的表述。",
		"禁止删减用户已给出的信息；凡是新增的请求，必须是原文意图的显式化，且能在原文里指出依据。",
		"补全按需定量：背景与示例各补 1 条以内，验收标准至少 1 条。"
	],
	deep: [
		"本次强度：深度（deep）。在标准档之上，允许补全隐含前提、缺失字段、示例与边界条件，把原文没说透的部分补足。",
		"推断补出的一律逐条标注「（待确认）」，不得混同用户原话；仍守五段上限，不开第六段。",
		"补全要成体系：背景、验收标准、示例、边界条件四项尽量齐全。"
	]
};

/** 英文强度段（与中文逐条对应，供 locale=en 使用）。 */
const STRENGTH_BLOCK_EN = {
	light: [
		"Strength: light. Keep the original sentence structure and paragraph order; only turn spoken wording into written wording, add punctuation and fix obvious grammar.",
		"Never restructure a sentence and never add or remove information the original contains; completion is limited to acceptance criteria and \"（待确认）\" marks, and you never decide anything on the user's behalf.",
		"Light runs the same four self-checks: when the only gain available is an inference, put it on a marked line."
	],
	standard: [
		"Strength: standard. On top of light, you may reorder the original into the five sections and turn vague wording into concrete, checkable wording.",
		"Never drop information the user already supplied; any request you add must make the original intent explicit and must be traceable to a line in the original.",
		"Additions are rationed: at most one background item and one example, and at least one acceptance criterion."
	],
	deep: [
		"Strength: deep. On top of standard, you may fill in implied premises, missing fields, examples and boundary conditions.",
		"Every inference must be marked \"（待确认）\" line by line and never blended into the user's own wording; still keep the five-section ceiling and never open a sixth section.",
		"Additions should be systematic: cover background, acceptance criteria, example and boundary conditions as fully as the input allows."
	]
};

/**
 * 按强度与语种拼系统提示词（修 v0.1 的「强度只对本地引擎生效」，见 design 0.1 事实 1）。
 *
 * 结构：五段说明 → 意图守恒 / 任务类型分流 / 输出前自检 / 示例 → 三档强度段 → 硬规则尾。
 * 三档的差别在补全额度与改写尺度；四道自检三档都要做，尾部硬规则三档完全相同：三类必须守恒、
 * 数字/URL/@引用/字段名/代码块/否定词原样保留、只输出五段正文、不要代码围栏、五个 ### 段头必须
 * 出现（无内容写「- （无）」）。段头两种语种都保持固定中文，因为客户端的内容守恒校验按字面量
 * 比对段名（design 4.3 栏目合法性）。
 * @param strength - 'light' | 'standard' | 'deep'；其它值按 standard。
 * @param locale - 'zh' | 'en'；其它值按 zh。
 * @returns 系统提示词。
 */
export function buildSystemPrompt(strength, locale) {
	const level = STRENGTH_OPTIONS.indexOf(typeof strength === "string" ? strength.trim().toLowerCase() : "") === -1
		? DEFAULT_STRENGTH
		: strength.trim().toLowerCase();
	const language = LOCALE_OPTIONS.indexOf(typeof locale === "string" ? locale.trim().toLowerCase() : "") === -1
		? DEFAULT_LOCALE
		: locale.trim().toLowerCase();
	if (language === "en") return [...enPromptHead(), ...enPromptBody(), ...STRENGTH_BLOCK_EN[level], ...enPromptTail()].join("\n");
	return [...zhPromptHead(), ...zhPromptBody(), ...STRENGTH_BLOCK_ZH[level], ...zhPromptTail()].join("\n");
}

/** 中文模板的头（角色定位 + 五段说明）。 */
function zhPromptHead() {
	return [
		"你是一名提示词工程专家。请把用户给出的原始提示词改写为信息更完整、可直接交付执行的提示词。",
		"",
		"必须严格输出以下五段，顺序固定，每段以「### 」加段名开头：",
		SECTION_HEADERS[0] + " —— 让模型知道自己是谁；",
		SECTION_HEADERS[1] + " —— 明确要完成的事；含糊动词要拆成可验收的交付物；",
		SECTION_HEADERS[2] + " —— 下游模型开工真正需要的背景、材料与指代关系，不是原文的复述；",
		SECTION_HEADERS[3] + " —— 交付物形态、格式、长度、语言与验收标准；",
		SECTION_HEADERS[4] + " —— 硬约束、禁止项、必须保留项与边界条件。",
		""
	];
}

/** 中文模板的中段：意图守恒（三守恒 + 三补全）、任务类型分流、四道自检、一对示例。 */
function zhPromptBody() {
	return [
		"【意图守恒：三类必须守恒】用户目标、硬约束（数字、字段名、URL、@引用、代码块、否定词如「不要」「别」「必须」）、用户已给出的事实前提——这三类一个字都不许改，不得新增、删改或臆测。",
		"【意图守恒：三类必须补全】原文缺失的背景、质量与验收要求、示例——必须主动补全；凡是推断补出的一律显式标注「（以下为推断，请确认）」或「（待确认）」，禁止伪装成用户原话。",
		"",
		"【任务类型分流】原文含疑问词（怎么／如何／为什么／是否）且没有祈使动词 → 提问类：" + SECTION_HEADERS[1] + " 写成「回答以下问题并给出可执行方案」，" + SECTION_HEADERS[3] + " 指定回答深度与结构（结论／依据／步骤／风险）。否则 → 指令类：" + SECTION_HEADERS[3] + " 必须含交付物形态与验收标准。",
		"",
		"【输出前自检：四条全过才算完成】",
		"① 增益检查：至少含 1 条原文读者拿不到的信息（背景／验收标准／示例／边界条件之一），一条都没有必须补。",
		"② 空转检查：" + SECTION_HEADERS[2] + " 里禁止出现「原文说的是…」「原文原句为…」这类复述；没有真实背景就写「- （待补充：本任务的背景是 __ ）」留空给人填。",
		"③ 可执行检查：把结果单独交给另一个模型，它不需要追问就能开工。",
		"④ 完整性检查：五个 ### 段头必须全部出现，无内容用「- （无）」占位。",
		"",
		"【示例（下面是示例，不是本次输入；只学方法，不要照抄内容）】",
		"原文：帮我把这段代码改好点",
		SECTION_HEADERS[0], "资深代码评审工程师",
		SECTION_HEADERS[1], "在不改变现有行为的前提下改进代码：①列出可维护性问题清单（每条附文件与行号）；②给出逐处修改后的代码；③给出可运行的回归验证方式。",
		SECTION_HEADERS[2], "代码片段已给出；目标语言与版本（待确认）；是否允许引入新依赖（待确认）。",
		SECTION_HEADERS[3], "先问题清单、后改后代码，按文件分块；每条修改说明动机与对应问题编号。",
		SECTION_HEADERS[4], "不引入新依赖；对外接口与既有测试语义保持不变。",
		""
	];
}

/** 中文模板的尾（与强度无关的硬规则）。 */
function zhPromptTail() {
	return [
		"",
		"忠于原意：数字、专有名词、URL、@引用、字段名、代码块与否定词必须原样保留。",
		"只输出这五段正文，不要解释改写过程，也不要用代码围栏包裹整段输出。",
		"用中文写正文。"
	];
}

/** 英文模板的头。 */
function enPromptHead() {
	return [
		"You are a prompt-engineering expert. Rewrite the raw prompt given by the user into a more complete prompt that another model can execute without follow-up questions.",
		"",
		"Output exactly the following five sections, in this fixed order, each starting with \"### \" plus the section name. The section names stay in Chinese on purpose — downstream validation matches them literally:",
		SECTION_HEADERS[0] + " — who the model is;",
		SECTION_HEADERS[1] + " — what must be done; break vague verbs into checkable deliverables;",
		SECTION_HEADERS[2] + " — the background, materials and references the downstream model actually needs, not a restatement of the original;",
		SECTION_HEADERS[3] + " — deliverable shape, format, length, language and acceptance criteria;",
		SECTION_HEADERS[4] + " — hard constraints, prohibitions, items that must be kept and boundary conditions.",
		""
	];
}

/** 英文模板的中段（与中文逐条对应）。 */
function enPromptBody() {
	return [
		"Fidelity — three things that must be preserved: the user's goal, the hard constraints (numbers, field names, URLs, @mentions, code blocks, negations such as 「不要」「别」「必须」), and the facts the user already supplied. Not one character of these three may change: never add, delete or invent in them.",
		"Fidelity — three things that must be completed: missing background, quality and acceptance requirements, and examples. Fill them in proactively; anything you infer must be marked \"（以下为推断，请确认）\" or \"（待确认）\" and never passed off as the user's own words.",
		"",
		"Task-type routing: if the original contains an interrogative (怎么／如何／为什么／是否) and no imperative verb, it is a question — write " + SECTION_HEADERS[1] + " as \"answer the following question and give an actionable plan\", and make " + SECTION_HEADERS[3] + " specify answer depth and structure (conclusion / evidence / steps / risks). Otherwise it is an instruction — " + SECTION_HEADERS[3] + " must state the deliverable shape and the acceptance criteria.",
		"",
		"Self-check before you answer — all four must pass:",
		"1. Gain: the result carries at least one piece of information the original reader could not get (background / acceptance criteria / example / boundary condition); add one if it carries none.",
		"2. No empty restatement: " + SECTION_HEADERS[2] + " must never echo the original (no \"the original says…\" and no quoting the whole sentence back); with no real background write \"- （待补充：本任务的背景是 __ ）\" and leave it for a human to fill.",
		"3. Executability: another model given only your output can start work without asking a follow-up question.",
		"4. Completeness: all five ### section headers appear; write \"- （无）\" where a section has nothing.",
		"",
		"Example — this is an example, not the input; copy the method, never the content:",
		"Original: make this bit of code better please",
		SECTION_HEADERS[0], "Senior code-review engineer",
		SECTION_HEADERS[1], "Improve the code without changing its behaviour: (1) list maintainability problems with file and line; (2) give the changed code for each point; (3) give a runnable regression check.",
		SECTION_HEADERS[2], "The snippet is supplied; target language and version (待确认); whether new dependencies are allowed (待确认).",
		SECTION_HEADERS[3], "Problem list first, changed code after, grouped by file; each change states its motive and the issue it fixes.",
		SECTION_HEADERS[4], "No new dependencies; the public interface and existing test semantics stay unchanged.",
		""
	];
}

/** 英文模板的尾。 */
function enPromptTail() {
	return [
		"",
		"Fidelity: numbers, proper nouns, URLs, @mentions, field names, code blocks and negations must be \"原样保留\" (kept verbatim).",
		"Output only those five sections as plain text: no explanation of the rewrite, and never wrap the whole output in a code fence.",
		"Write the section bodies in English."
	];
}

/**
 * 解析一个绝对 URL。
 * @param value - 待解析的字符串。
 * @returns URL；解析失败时为 undefined。
 */
function parseAbsoluteUrl(value) {
	try {
		return new URL(value);
	} catch {
		return;
	}
}

/**
 * 上游地址的问题说明。
 *
 * 用 new URL 判而不是正则：「https://」拼不出地址，「https://host@evil.example」的 origin
 * 其实在 evil.example，带 fragment 的写法会静默被丢掉 —— 这些笔误在装载期就该报出来。
 * query 参数**允许**（Azure OpenAI 等接口必须带 ?api-version=），它不影响 origin 与路径。
 * @param value - 去空白后的地址。
 * @param label - 报错时用的字段名（config.llmEndpoint / endpoint / models[0].endpoint）。
 * @returns 问题说明；合法时为 undefined。
 */
function endpointProblem(value, label) {
	const parsed = parseAbsoluteUrl(value);
	if (parsed === void 0) return label + " must be a valid absolute URL";
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return label + " must use http:// or https://";
	if (parsed.username !== "" || parsed.password !== "") return label + " must not carry credentials";
	if (parsed.hostname === "") return label + " must include a host";
	if (parsed.hash !== "") return label + " must not carry a fragment";
	return;
}

/**
 * 枚举字段归一化：大小写与首尾空白容错，不在白名单内一律退回兜底值。
 * @param value - 原始值。
 * @param allowed - 白名单。
 * @param fallback - 兜底值。
 * @returns 白名单内的值。
 */
function pickOption(value, allowed, fallback) {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	return allowed.indexOf(text) === -1 ? fallback : text;
}

/**
 * 数值字段归一化：非法值取 fallback，越界按边界截断（design 1.1）。
 * @param value - 原始值。
 * @param range - { min, max, fallback }。
 * @returns 已截断的数值。
 */
function clampNumber(value, range) {
	let number = NaN;
	if (typeof value === "number") number = value;
	else if (typeof value === "string" && value.trim() !== "") number = Number(value);
	if (!Number.isFinite(number)) return range.fallback;
	if (number < range.min) return range.min;
	if (number > range.max) return range.max;
	return number;
}

/**
 * 时间戳归一化：非正数/非数字一律取 fallback。
 * @param value - 原始值。
 * @param fallback - 兜底时间戳。
 * @returns 时间戳。
 */
function pickTimestamp(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 校验并归一化一条模型条目（宿主自带实现：不 import src/shared/config.js，客户端不可信）。
 *
 * 数值字段**不报错只截断**（design 1.1「越界按边界截断」）；字符串字段越界才算问题。
 * @param input - 原始条目。
 * @returns { ok, problems, value } —— 问题说明为空才算 ok。
 */
export function validateHostModel(input) {
	const source = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
	const problems = [];
	const now = Date.now();

	const id = typeof source["id"] === "string" ? source["id"].trim() : "";
	if (id === "") problems.push("id 必须是非空字符串");
	else if (id.length > ID_MAX) problems.push("id 最多 " + ID_MAX + " 个字符");

	const model = typeof source["model"] === "string" ? source["model"].trim() : "";
	if (model === "") problems.push("model 必须是 1–" + MODEL_MAX + " 个字符");
	else if (model.length > MODEL_MAX) problems.push("model 最多 " + MODEL_MAX + " 个字符");

	const endpoint = typeof source["endpoint"] === "string" ? source["endpoint"].trim() : "";
	const endpointIssue = endpointProblem(endpoint, "endpoint");
	if (endpointIssue !== void 0) problems.push(endpointIssue);

	// 空密钥合法（本地 Ollama / LM Studio / 内网反代无需密钥），只卡长度上限 —— 与客户端 validateModel 同契约。
	const apiKey = typeof source["apiKey"] === "string" ? source["apiKey"] : "";
	if (apiKey.length > API_KEY_MAX) problems.push("apiKey 最多 " + API_KEY_MAX + " 个字符");

	const rawName = typeof source["name"] === "string" ? source["name"].trim() : "";
	if (rawName.length > NAME_MAX) problems.push("name 最多 " + NAME_MAX + " 个字符");

	return {
		ok: problems.length === 0,
		problems,
		value: {
			id,
			name: rawName === "" ? model.slice(0, NAME_MAX) : rawName,
			endpoint,
			apiKey,
			model,
			temperature: clampNumber(source["temperature"], TEMPERATURE_RANGE),
			timeoutMs: clampNumber(source["timeoutMs"], TIMEOUT_RANGE),
			isDefault: source["isDefault"] === true,
			createdAt: pickTimestamp(source["createdAt"], now),
			updatedAt: pickTimestamp(source["updatedAt"], now)
		}
	};
}

/**
 * 校验并归一化整张模型表。
 *
 * 上限 20 条是硬拒绝（不是截断）：多的条目不会悄悄丢掉，由调用方决定怎么处理；而
 * isDefault 重复只降级不报错（design 1.1「全表至多一条」），降级记在 notices 里。
 * @param input - 原始数组。
 * @returns { ok, models, problems, notices }。
 */
export function normalizeHostModels(input) {
	const problems = [];
	const notices = [];
	if (input !== void 0 && input !== null && !Array.isArray(input)) {
		return { ok: false, models: [], problems: ["models must be an array"], notices };
	}
	const source = Array.isArray(input) ? input : [];
	if (source.length > MODEL_LIMIT) problems.push("models must not exceed " + MODEL_LIMIT + " entries (got " + source.length + ")");
	const models = [];
	const seen = new Set();
	let hasDefault = false;
	for (let index = 0; index < source.length && index < MODEL_LIMIT; index += 1) {
		const built = validateHostModel(source[index]);
		if (!built.ok) {
			for (const message of built.problems) problems.push("models[" + index + "]." + message);
			continue;
		}
		const entry = built.value;
		if (seen.has(entry.id)) {
			problems.push("models[" + index + "].id 与前面的条目重复：" + entry.id);
			continue;
		}
		seen.add(entry.id);
		if (entry.isDefault) {
			if (hasDefault) {
				entry.isDefault = false;
				notices.push("models[" + index + "].isDefault 已有默认模型，本条已降级为普通模型");
			} else hasDefault = true;
		}
		models.push(entry);
	}
	return { ok: problems.length === 0, models, problems, notices };
}

/**
 * 校验并归一化全局设置（字段白名单 + 取值枚举）。
 * @param input - 原始对象。
 * @returns { ok, problems, value }。
 */
export function normalizeHostSettings(input) {
	const problems = [];
	if (input !== void 0 && input !== null && (typeof input !== "object" || Array.isArray(input))) {
		return { ok: false, problems: ["config.settings must be an object"], value: { ...DEFAULT_SETTINGS } };
	}
	const source = input !== null && typeof input === "object" ? input : {};
	const unsupported = Object.keys(source).filter((key) => SETTINGS_FIELDS.indexOf(key) === -1);
	if (unsupported.length > 0) problems.push("unsupported config.settings field(s): " + unsupported.join(", "));
	const value = {
		strength: readSetting(source, "strength", STRENGTH_OPTIONS, DEFAULT_SETTINGS.strength, problems),
		locale: readSetting(source, "locale", LOCALE_OPTIONS, DEFAULT_SETTINGS.locale, problems),
		engine: readSetting(source, "engine", ENGINE_OPTIONS, DEFAULT_SETTINGS.engine, problems),
		mergeMode: readSetting(source, "mergeMode", MERGE_MODE_OPTIONS, DEFAULT_SETTINGS.mergeMode, problems),
		schemaVersion: SCHEMA_VERSION
	};
	const rawVersion = source["schemaVersion"];
	if (rawVersion !== void 0 && rawVersion !== null && rawVersion !== SCHEMA_VERSION) {
		problems.push("config.settings.schemaVersion must be " + SCHEMA_VERSION);
	}
	return { ok: problems.length === 0, problems, value };
}

/**
 * 读一个枚举设置项：缺省取兜底值，取值非法记一条问题。
 * @param source - 原始对象。
 * @param key - 字段名。
 * @param allowed - 白名单。
 * @param fallback - 兜底值。
 * @param problems - 问题收集数组。
 * @returns 归一化后的值。
 */
function readSetting(source, key, allowed, fallback, problems) {
	const raw = source[key];
	if (raw === void 0 || raw === null) return fallback;
	const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (allowed.indexOf(text) === -1) {
		problems.push("config.settings." + key + " must be one of " + allowed.join("/"));
		return fallback;
	}
	return text;
}

/**
 * 收集配置的问题说明。
 *
 * 「未配置 llmEndpoint」**不算问题**：默认引擎是本地引擎，用户没填 LLM 地址时插件必须照常
 * 装上（按钮照常出现、点击走本地）；缺地址只在请求进来时降级成 501。空串/纯空白同理视为
 * 未配置。写了就必须是合法地址 —— 那一类笔误仍然在装载期报出来。models / settings 同理：
 * 没写就不校验，写了就必须整份合法。
 * @param raw - 装载行的 config；未写时为 undefined。
 * @returns 问题说明；空数组表示合法。
 */
function configProblems(raw) {
	if (raw === void 0 || raw === null) return [];
	if (typeof raw !== "object" || Array.isArray(raw)) return ["config must be an object"];
	const record = raw;
	const problems = [];
	const unsupported = Object.keys(record).filter((key) => CONFIG_FIELDS.indexOf(key) === -1);
	if (unsupported.length > 0) problems.push(`unsupported config field(s): ${unsupported.join(", ")}`);
	const endpoint = record["llmEndpoint"];
	if (endpoint !== void 0 && endpoint !== null) {
		if (typeof endpoint !== "string") problems.push("config.llmEndpoint must be a string");
		else {
			const text = endpoint.trim();
			if (text !== "") {
				const problem = endpointProblem(text, "config.llmEndpoint");
				if (problem !== void 0) problems.push(problem);
			}
		}
	}
	for (const field of ["llmApiKey", "llmModel"]) {
		const value = record[field];
		if (value !== void 0 && value !== null && typeof value !== "string") problems.push(`config.${field} must be a string`);
	}
	const temperature = record["llmTemperature"];
	if (temperature !== void 0 && temperature !== null) {
		if (typeof temperature !== "number" || !Number.isFinite(temperature)) problems.push("config.llmTemperature must be a number");
		else if (temperature < 0 || temperature > MAX_TEMPERATURE) problems.push(`config.llmTemperature must be within 0..${MAX_TEMPERATURE}`);
	}
	const timeout = record["llmTimeoutMs"];
	if (timeout !== void 0 && timeout !== null) {
		if (typeof timeout !== "number" || !Number.isInteger(timeout)) problems.push("config.llmTimeoutMs must be an integer");
		else if (timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) problems.push(`config.llmTimeoutMs must be within ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}`);
	}
	if (record["models"] !== void 0 && record["models"] !== null) {
		for (const message of normalizeHostModels(record["models"]).problems) problems.push("config." + message);
	}
	if (record["settings"] !== void 0 && record["settings"] !== null) {
		for (const message of normalizeHostSettings(record["settings"]).problems) problems.push(message);
	}
	return problems;
}

/**
 * 收窄装载行里的 config。
 *
 * 五个 llm* 字段**恒定出现**（缺省空串 / 默认数字），既有断言守着它们的精确形状；models 与
 * settings 只在装载行确实写了的时候才出现（不凭空多出字段，也就不会与旧配置的形状断言冲突）。
 * @param raw - 装载行的 config；未写时为 undefined。
 * @returns 收窄后的配置。
 * @throws {Error} 形状不合法时（未配置 endpoint 合法）；问题说明与 Config 报的同源。
 */
function narrowConfig(raw) {
	const problems = configProblems(raw);
	if (problems.length > 0) throw new Error(`prompt-optimizer: invalid config — ${problems.join("; ")}`);
	const record = raw === void 0 || raw === null ? {} : raw;
	const value = {
		llmEndpoint: typeof record["llmEndpoint"] === "string" ? record["llmEndpoint"].trim() : "",
		llmApiKey: typeof record["llmApiKey"] === "string" ? record["llmApiKey"].trim() : "",
		llmModel: typeof record["llmModel"] === "string" ? record["llmModel"].trim() : "",
		llmTemperature: typeof record["llmTemperature"] === "number" ? record["llmTemperature"] : DEFAULT_TEMPERATURE,
		llmTimeoutMs: typeof record["llmTimeoutMs"] === "number" ? record["llmTimeoutMs"] : DEFAULT_TIMEOUT_MS
	};
	if (record["models"] !== void 0 && record["models"] !== null) value.models = normalizeHostModels(record["models"]).models;
	if (record["settings"] !== void 0 && record["settings"] !== null) value.settings = normalizeHostSettings(record["settings"]).value;
	return value;
}

/** 装载行配置的 schema（standard-schema 形状，手写，与参考插件同源）。 */
export const Config = { "~standard": {
	version: 1,
	vendor: "dsh-plugin-prompt-optimizer",
	/**
	 * 校验并规范化装载行配置。
	 * @param value - 装载行的 config；未写时为 undefined。
	 * @returns 合法时给出收窄后的配置，否则给出问题列表。
	 */
	validate(value) {
		const problems = configProblems(value);
		return problems.length > 0 ? { issues: problems.map((message) => ({ message })) } : { value: narrowConfig(value) };
	}
} };

/**
 * 统一的 JSON 响应（显式 no-store：优化结果与模型表都不该被任何一层缓存）。
 * @param body - 响应体。
 * @param status - HTTP 状态码。
 * @returns 响应。
 */
function jsonResponse(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		}
	});
}

/**
 * 密钥掩码：只露末 4 位（design 假设 5）；长度不足以掩码时整体掩码为「…」。
 * @param key - 原始密钥。
 * @returns 形如 sk-…a1b2 的字符串。
 */
export function maskApiKey(key) {
	const text = typeof key === "string" ? key : "";
	if (text.length <= 8) return "…";
	return text.slice(0, 3) + "…" + text.slice(-4);
}

/**
 * 对外可见的模型条目（GET 用）：apiKey 一律换成掩码。
 * @param entry - 归一化后的模型条目。
 * @returns 掩码后的条目。
 */
function publicModel(entry) {
	return {
		id: entry.id,
		name: entry.name,
		endpoint: entry.endpoint,
		apiKey: maskApiKey(entry.apiKey),
		model: entry.model,
		temperature: entry.temperature,
		timeoutMs: entry.timeoutMs,
		isDefault: entry.isDefault,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt
	};
}

/**
 * 发往上游的请求头。
 *
 * 只发这两个（外加非空时的 authorization）：不转发任何来自浏览器的头。
 * @param upstream - 已解析出的上游配置。
 * @returns 请求头。
 */
function upstreamHeaders(upstream) {
	const headers = {
		"content-type": "application/json",
		accept: "application/json"
	};
	const key = typeof upstream?.apiKey === "string" ? upstream.apiKey.trim() : "";
	if (key !== "") headers.authorization = `Bearer ${key}`;
	return headers;
}

/**
 * 上游请求体（OpenAI 兼容 chat/completions 形状）。
 *
 * 形状固定三个键：model / temperature / messages —— 请求体里的任何字段都不参与拼装。
 * @param upstream - 已解析出的上游配置。
 * @param text - 已校验的原文。
 * @param strength - 归一化后的强度。
 * @param locale - 归一化后的语种。
 * @returns 请求体。
 */
function upstreamPayload(upstream, text, strength, locale) {
	return {
		model: typeof upstream?.model === "string" ? upstream.model : "",
		temperature: typeof upstream?.temperature === "number" ? upstream.temperature : DEFAULT_TEMPERATURE,
		messages: [
			{ role: "system", content: buildSystemPrompt(strength, locale) },
			{ role: "user", content: text }
		]
	};
}

/**
 * 原文的问题说明。
 * @param value - 请求体里的 text。
 * @returns 问题说明；合法时为 undefined。
 */
function textProblem(value) {
	if (typeof value !== "string") return "text 必须是字符串";
	if (value.trim() === "") return "text 不能为空";
	if (value.length > MAX_TEXT_LENGTH) return `text 超过 ${MAX_TEXT_LENGTH} 字符上限`;
	return;
}

/**
 * 请求体里那些「出现了也不采信」的字段名。
 * @param body - 请求体对象。
 * @returns 命中的字段名数组（没有就是空数组，此时响应里不出现 ignoredFields）。
 */
function ignoredBodyFields(body) {
	return IGNORED_BODY_FIELDS.filter((field) => body[field] !== void 0);
}

/**
 * 读请求体里的 JSON 对象。
 * @param request - 浏览器请求（requestBody 为 buffered）。
 * @returns 结局：ok 时给对象，否则标记失败（非法 JSON / 不是对象）。
 */
async function readJsonBody(request) {
	try {
		const value = await request.json();
		if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false };
		return {
			ok: true,
			value
		};
	} catch {
		return { ok: false };
	}
}

/**
 * 从上游响应里取正文。
 * @param raw - 上游响应体（形状未经校验）。
 * @returns 非空字符串；形状不符时为 undefined。
 */
function contentOf(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const choices = raw["choices"];
	if (!Array.isArray(choices) || choices.length === 0) return void 0;
	const choice = choices[0];
	if (typeof choice !== "object" || choice === null) return void 0;
	const message = choice["message"];
	if (typeof message !== "object" || message === null) return void 0;
	const content = message["content"];
	return typeof content === "string" && content.trim() !== "" ? content : void 0;
}

/**
 * 异常的名字。
 *
 * 只看 name，不看 message —— message 可能带上游地址，把它拼进客户端 body 等于泄漏。
 * @param error - 捕获到的异常。
 * @returns 名字；取不到时为空串。
 */
function errorName(error) {
	return error !== null && typeof error === "object" && typeof error["name"] === "string" ? error["name"] : "";
}

/** node:fs / node:path / node:os 的缓存（第一次落盘时解析，装载期不碰）。 */
let hostIo;

/**
 * 取宿主文件系统能力（动态 import，保持静态图零 import）。
 * @returns { fs, join, homedir } —— fs 为 node:fs/promises。
 */
async function hostFileSystem() {
	if (hostIo === void 0) {
		const [fsModule, pathModule, osModule] = await Promise.all([import("node:fs"), import("node:path"), import("node:os")]);
		hostIo = {
			fs: fsModule.promises,
			join: pathModule.join,
			homedir: osModule.homedir
		};
	}
	return hostIo;
}

/**
 * 模型表所在目录。
 *
 * 约定沿用本机插件生态的 $DSH_HOME/<plugin>/（dsh-our-free-model、channel-pack 都是这个形状）：
 * 取 DSH_HOME，缺失时回落 ~/.dsh，再拼插件短名。deps.dataDir 只给测试用（临时目录），生产不用。
 * @param options - { dataDir? }。
 * @returns 绝对目录路径。
 */
async function pluginDataDir(options) {
	const override = options === void 0 || options === null ? void 0 : options.dataDir;
	if (typeof override === "string" && override.trim() !== "") return override;
	const io = await hostFileSystem();
	const env = typeof process === "object" && process !== null ? process.env : void 0;
	const configured = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
	return io.join(configured !== "" ? configured : io.join(io.homedir(), ".dsh"), DATA_DIR_NAME);
}

/**
 * 读模型表文件。
 *
 * 文件不存在、不是合法 JSON、结构不符都返回 null（调用方回落到 config 里的模型表）——模型表损坏
 * 绝不能把优化通路带崩。
 * @param options - { dataDir? }。
 * @returns { models, settings, schemaVersion } 或 null。
 */
async function readModelsFile(options) {
	const io = await hostFileSystem();
	let text;
	try {
		text = await io.fs.readFile(io.join(await pluginDataDir(options), MODELS_FILE_NAME), "utf8");
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return {
		models: normalizeHostModels(parsed["models"]).models,
		settings: normalizeHostSettings(parsed["settings"]).value,
		schemaVersion: SCHEMA_VERSION
	};
}

/**
 * 原子写模型表：同目录临时文件 → fsync → rename 覆盖。
 *
 * rename 在同一目录内是原子的，所以任何一步失败都不会留下半截 models.json（失败时顺手删掉临时
 * 文件）。fsync 是为了让「宿主已经回过 200」这句话在掉电后仍然成立。
 * @param options - { dataDir? }。
 * @param payload - { schemaVersion, models, settings }。
 * @returns 写成功后的绝对路径。
 * @throws 任何一步失败都往上抛，由调用方归一成固定错误码（不把路径/异常拼进响应）。
 */
async function writeModelsFile(options, payload) {
	const io = await hostFileSystem();
	const dir = await pluginDataDir(options);
	const target = io.join(dir, MODELS_FILE_NAME);
	const temp = io.join(dir, MODELS_FILE_NAME + ".tmp-" + String(process.pid) + "-" + String(Date.now()) + "-" + Math.random().toString(16).slice(2));
	await io.fs.mkdir(dir, { recursive: true });
	try {
		const handle = await io.fs.open(temp, "w");
		try {
			await handle.writeFile(JSON.stringify(payload, null, "\t") + "\n", "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await io.fs.rename(temp, target);
	} catch (error) {
		try {
			await io.fs.unlink(temp);
		} catch {
			// 临时文件可能压根没建起来，删不掉就算了 —— 目标文件无论如何都没被动过
		}
		throw error;
	}
	return target;
}

/**
 * 宿主当前持有的模型表：优先落盘的那份（POST 写入的），为空时回落到装载行 config.models。
 * @param config - 收窄后的配置。
 * @param options - { dataDir? }。
 * @returns 归一化后的模型条目数组。
 */
async function loadModelTable(config, options) {
	const state = await readModelsFile(options);
	if (state !== null && state.models.length > 0) return state.models;
	return Array.isArray(config?.models) ? config.models : [];
}

/**
 * 决定这次请求打到哪个上游。
 *
 * 只有两个可信来源：宿主模型表（按 providerId 查）与 config.llmEndpoint。请求体里的地址/密钥/
 * 模型名从不参与 —— 查不到就退回 config，两者都缺才返回 undefined（调用方回 501）。
 * @param config - 收窄后的配置。
 * @param models - 宿主模型表。
 * @param providerId - 请求体里的 providerId（已归一化，可能为空串）。
 * @returns 上游配置；两者都缺时为 undefined。
 */
function resolveUpstream(config, models, providerId) {
	if (providerId !== "") {
		const table = Array.isArray(models) ? models : [];
		for (const entry of table) {
			if (entry.id !== providerId) continue;
			return {
				source: "models",
				providerId: entry.id,
				endpoint: entry.endpoint,
				apiKey: entry.apiKey,
				model: entry.model,
				temperature: entry.temperature,
				timeoutMs: entry.timeoutMs
			};
		}
	}
	const endpoint = typeof config?.llmEndpoint === "string" ? config.llmEndpoint : "";
	if (endpoint === "") return void 0;
	return {
		source: "config",
		providerId: "",
		endpoint,
		apiKey: typeof config?.llmApiKey === "string" ? config.llmApiKey : "",
		model: typeof config?.llmModel === "string" ? config.llmModel : "",
		temperature: typeof config?.llmTemperature === "number" ? config.llmTemperature : DEFAULT_TEMPERATURE,
		timeoutMs: typeof config?.llmTimeoutMs === "number" ? config.llmTimeoutMs : DEFAULT_TIMEOUT_MS
	};
}

/**
 * 处理一次优化请求。
 * @param request - 浏览器请求。
 * @param config - 收窄后的配置（未配置 endpoint 时为空对象）。
 * @param fetchImpl - 上游请求实现。
 * @param options - { dataDir? }。
 * @returns JSON 响应：`{ ok: true, text, 可选的 providerId / ignoredFields }` 或 `{ error }`。
 */
async function handleOptimize(request, config, fetchImpl, options) {
	if (request.method !== "POST") return new Response(null, {
		status: 405,
		headers: { allow: "POST" }
	});
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return jsonResponse({ error: "请求体不是合法的 JSON 对象" }, 400);
	const body = parsed.value;
	const strength = pickOption(body["strength"], STRENGTH_OPTIONS, DEFAULT_STRENGTH);
	const locale = pickOption(body["locale"], LOCALE_OPTIONS, DEFAULT_LOCALE);
	const providerId = typeof body["providerId"] === "string" ? body["providerId"].trim() : "";
	const upstream = resolveUpstream(config, providerId === "" ? [] : await loadModelTable(config, options), providerId);
	if (upstream === void 0) return jsonResponse({ error: "llm endpoint not configured" }, 501);
	const text = body["text"];
	const problem = textProblem(text);
	if (problem !== void 0) return jsonResponse({ error: problem }, 400);
	let response;
	try {
		response = await fetchImpl(upstream.endpoint, {
			method: "POST",
			redirect: "error",
			headers: upstreamHeaders(upstream),
			body: JSON.stringify(upstreamPayload(upstream, text, strength, locale)),
			signal: AbortSignal.timeout(upstream.timeoutMs)
		});
	} catch (error) {
		const name = errorName(error);
		const timedOut = name === "TimeoutError" || name === "AbortError";
		return timedOut ? jsonResponse({ error: "上游超时" }, 504) : jsonResponse({ error: "无法连接上游" }, 502);
	}
	if (!response.ok) return jsonResponse({ error: `上游返回 ${response.status}` }, 502);
	let reply;
	try {
		reply = await response.json();
	} catch {
		return jsonResponse({ error: "上游响应不是 JSON" }, 502);
	}
	const content = contentOf(reply);
	if (content === void 0) return jsonResponse({ error: "上游响应缺少正文" }, 502);
	const payload = {
		ok: true,
		text: content
	};
	const ignored = ignoredBodyFields(body);
	if (ignored.length > 0) payload.ignoredFields = ignored;
	if (upstream.providerId !== "") payload.providerId = upstream.providerId;
	return jsonResponse(payload, 200);
}

/**
 * 处理一次模型表请求（GET 读整表 / POST 整表覆盖写）。
 * @param request - 浏览器请求。
 * @param config - 收窄后的配置（模型表的回落来源）。
 * @param options - { dataDir? }。
 * @returns JSON 响应。
 */
async function handleModels(request, config, options) {
	if (request.method !== "GET" && request.method !== "POST") {
		return new Response(null, {
			status: 405,
			headers: { allow: "GET, POST" }
		});
	}
	if (request.method === "GET") {
		const state = await readModelsFile(options);
		const table = state !== null && state.models.length > 0 ? state.models : Array.isArray(config?.models) ? config.models : [];
		const settings = state !== null ? state.settings : normalizeHostSettings(config?.settings).value;
		return jsonResponse({
			ok: true,
			schemaVersion: SCHEMA_VERSION,
			source: state !== null ? "host" : "config",
			models: table.map(publicModel),
			settings
		}, 200);
	}
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return jsonResponse({ error: "请求体不是合法的 JSON 对象", code: "invalid-json" }, 400);
	const body = parsed.value;
	if (!Array.isArray(body["models"])) {
		return jsonResponse({ error: "models 必须是数组", code: "invalid-models", problems: ["models must be an array"] }, 400);
	}
	const list = normalizeHostModels(body["models"]);
	if (!list.ok) return jsonResponse({ error: "模型表校验未通过", code: "invalid-models", problems: list.problems }, 400);
	const settings = normalizeHostSettings(body["settings"]);
	if (!settings.ok) return jsonResponse({ error: "设置校验未通过", code: "invalid-settings", problems: settings.problems }, 400);
	try {
		await writeModelsFile(options, {
			schemaVersion: SCHEMA_VERSION,
			models: list.models,
			settings: settings.value
		});
	} catch {
		return jsonResponse({ error: "模型表写入失败", code: "models-write-failed" }, 500);
	}
	const payload = {
		ok: true,
		schemaVersion: SCHEMA_VERSION,
		count: list.models.length,
		settings: settings.value
	};
	if (list.notices.length > 0) payload.notices = list.notices;
	return jsonResponse(payload, 200);
}

/**
 * 优化通路的 route 定义。
 * @param config - 收窄后的配置。
 * @param deps - 可注入的 { fetchImpl, dataDir }（测试用）。
 * @returns ConnectionFetchRoute。
 */
function optimizeRoute(config, deps) {
	const fetchImpl = deps?.fetchImpl ?? ((url, init) => fetch(url, init));
	const options = { dataDir: deps?.dataDir };
	return {
		path: ROUTE_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: (request) => handleOptimize(request, config, fetchImpl, options)
	};
}

/**
 * 模型表通路的 route 定义。
 * @param config - 收窄后的配置。
 * @param deps - 可注入的 { dataDir }（测试用）。
 * @returns ConnectionFetchRoute。
 */
function modelsRoute(config, deps) {
	const options = { dataDir: deps?.dataDir };
	return {
		path: MODELS_ROUTE_PATH,
		methods: ["GET", "POST"],
		requestBody: "buffered",
		fetch: (request) => handleModels(request, config, options)
	};
}

/**
 * 注册宿主路由。
 *
 * **注册必须走 ctx.inject，不能在 apply 期用 ctx.get 读一次**：加载器的 entry 是**并行**
 * 创建的（vendor/loader/src/config/group.ts 的 Promise.allSettled），各 entry 的 apply 先后
 * 没有保证；而 connection 的 fiber 要等 credentials，依赖链比本插件长 —— 在 apply 期读一次
 * 很可能读到"还没就绪"，然后**永久**跳过注册且没有任何报错（浏览器那边只看到 404）。
 *
 * 回调必须用它的参数作用域（scoped）读服务、挂副作用：副作用挂在外层 ctx 上只有插件卸载时
 * 才释放，挂在子 fiber 上才能"依赖失去时释放"。两条路由共用一次 inject + 一次 effect，
 * 卸载时一起撤销。
 *
 * 没有 connection（该组装没有 web 载体）时不注册任何东西 —— 那是设计内的降级；缺少
 * inject / effect 面则属于异常组装，留一条日志而不是静默跳过。
 * @param ctx - host 侧插件上下文。
 * @param config - 收窄后的配置。
 * @param deps - 可注入的 { fetchImpl, dataDir }（测试用）。
 * @param only - 'optimize' / 'models' / undefined（两条都注册）。
 */
export function registerRoutes(ctx, config, deps, only) {
	if (typeof ctx?.inject !== "function") {
		console.warn("[prompt-optimizer] 宿主路由未注册：host 上下文没有 ctx.inject 面");
		return;
	}
	const routes = [];
	if (only !== "models") routes.push(optimizeRoute(config, deps));
	if (only !== "optimize") routes.push(modelsRoute(config, deps));
	ctx.inject(["connection"], (scoped) => {
		const fetchFace = scoped.get?.("connection")?.fetch;
		const register = fetchFace?.register;
		if (fetchFace === void 0 || register === void 0) return;
		if (typeof scoped.effect !== "function") {
			console.warn("[prompt-optimizer] 宿主路由未注册：connection 就绪了，但作用域没有 ctx.effect 面");
			return;
		}
		scoped.effect(() => {
			const disposers = routes.map((route) => register.call(fetchFace, route));
			return () => {
				for (const dispose of disposers) if (typeof dispose === "function") dispose();
			};
		}, "prompt-optimizer: host routes");
	});
}

/**
 * 只注册优化通路（既有单测按「一条路由」断言它的形状）。
 * @param ctx - host 侧插件上下文。
 * @param config - 收窄后的配置。
 * @param deps - 可注入的 { fetchImpl, dataDir }（测试用）。
 */
export function registerOptimizeRoute(ctx, config, deps) {
	registerRoutes(ctx, config, deps, "optimize");
}

/**
 * 只注册模型表通路。
 * @param ctx - host 侧插件上下文。
 * @param config - 收窄后的配置。
 * @param deps - 可注入的 { dataDir }（测试用）。
 */
export function registerModelsRoute(ctx, config, deps) {
	registerRoutes(ctx, config, deps, "models");
}

/**
 * 组件主体。
 * @param ctx - host 上下文。
 * @param config - 装载行的 config；形状不对就抛错，不静默忽略。
 */
export function apply(ctx, config) {
	registerRoutes(ctx, narrowConfig(config));
}
