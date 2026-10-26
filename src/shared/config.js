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
export const CONFIG_KEY = "dsh-plugin-prompt-optimizer/config";

/** localStorage 键：v0.2 多模型配置（{ schemaVersion, models, settings }）。 */
export const MODELS_KEY = "dsh-plugin-prompt-optimizer/models";

/** 模型条目上限（design 假设 3）。 */
export const MODEL_LIMIT = 20;

/** 配置结构版本，用于旧配置迁移。 */
export const SCHEMA_VERSION = 2;

export const STRENGTH_OPTIONS = ["light", "standard", "deep"];
export const LOCALE_OPTIONS = ["zh", "en"];
export const ENGINE_OPTIONS = ["local", "llm", "auto"];
export const MERGE_MODE_OPTIONS = ["strict", "lenient"];

/** 内容守恒校验模式兜底值（design 4.3）。 */
export const DEFAULT_MERGE_MODE = "strict";

/**
 * 默认配置：标准强度 + 中文 + auto 引擎。
 * auto 语义（由客户端消费）：有可用默认模型就走 LLM，没有就本地 —— 装上就能用，不必先配模型。
 */
export const DEFAULT_CONFIG = Object.freeze({
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
export function normalizeConfig(raw) {
	const source = raw !== null && typeof raw === "object" ? raw : {};
	return {
		strength: pick(source.strength, STRENGTH_OPTIONS, DEFAULT_CONFIG.strength),
		locale: pick(source.locale, LOCALE_OPTIONS, DEFAULT_CONFIG.locale),
		engine: pick(source.engine, ENGINE_OPTIONS, DEFAULT_CONFIG.engine),
		mergeMode: pick(source.mergeMode, MERGE_MODE_OPTIONS, DEFAULT_MERGE_MODE)
	};
}

/** 序列化（先归一化，保证写进去的永远是合法值）。 */
export function serializeConfig(config) {
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
export function loadConfig(storage) {
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
export function saveConfig(storage, config) {
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
export function validateModel(input) {
	const built = buildModel(input);
	return { ok: built.errors.length === 0, errors: built.errors, value: built.value };
}

/**
 * 归一化单条模型条目；永不抛错，必填缺失时给空串而不是抛异常（配合 validateModel 判定合法性）。
 * @param input 原始条目
 * @param options 可含 now（注入时间戳，单测用）
 */
export function normalizeModel(input, options) {
	return buildModel(input, options).value;
}

/**
 * 归一化整个模型列表：丢弃非法条目、纠正重复 id、截断到 MODEL_LIMIT、保证默认模型唯一。
 * @param input 原始数组（任何类型都接受）
 * @returns {{ models: Array, errors: Array<{ field: string, message: string }> }}
 */
export function normalizeModelList(input) {
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
export function maskApiKey(key) {
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
export function loadModels(storage) {
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
export function saveModels(payload, storage) {
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
export function migrateConfig(oldConfig) {
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
export function upsertModel(list, model) {
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
export function removeModel(list, id) {
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
export function setDefaultModel(list, id) {
	const normalized = normalizeModelList(list).models;
	if (!normalized.some((item) => item.id === id)) return normalized;
	return normalized.map((item) => ({ ...item, isDefault: item.id === id }));
}
