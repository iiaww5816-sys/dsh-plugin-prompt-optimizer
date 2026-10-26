/**
 * 设置面板的纯逻辑层：表单校验、行数据装配、删除与默认迁移、提示判定、测试结果文案。
 *
 * 为什么单独成文件：这些规则必须能被 node:test 直接测（不依赖 DOM / storage / 网络），
 * overlays.js 只负责把它们画出来，button.js 只负责编排副作用。
 * 依赖方向单向：settings.js → shared/config.js，不反向依赖 client 其它文件。
 */
import {
	MODEL_LIMIT,
	normalizeConfig,
	normalizeModelList,
	validateModel,
	upsertModel,
	removeModel,
	setDefaultModel,
	maskApiKey,
	migrateConfig
} from "../shared/config.js";

/** 表单里真实存在的字段（顺序即渲染顺序）。 */
export const FORM_FIELDS = ["name", "endpoint", "apiKey", "model", "temperature", "timeoutMs"];

/** 表单字段 → 中文显示名（错误汇总文案用；表里没有的字段原样显示 key）。 */
export const FORM_FIELD_LABELS = {
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
export const ENGINE_OPTIONS_CLIENT = ["auto", "local", "llm"];

/** 引擎分段控件的三档文案（顺序即渲染顺序，auto 排首位因为它是默认档）。 */
export const ENGINE_LABELS_CLIENT = {
	auto: "自动（推荐，有可用模型时走 LLM）",
	local: "本地规则（不调网络，省 token）",
	llm: "LLM 改写（需配置模型）"
};

/** 密钥留空时的显示文案（绝不显示明文）。 */
export const NO_KEY_TEXT = "未设密钥";

/** 旧配置里代表「一条模型」的三个字段（design 假设 7）。 */
const LEGACY_MODEL_FIELDS = ["llmEndpoint", "llmApiKey", "llmModel"];

/** 空表单：数值字段用字符串承载（输入框只能给字符串，校验交给 validateModel 截断）。 */
export function emptyForm() {
	return { id: "", name: "", endpoint: "", apiKey: "", model: "", temperature: "0.2", timeoutMs: "30000" };
}

/**
 * 模型条目 → 表单初值。密钥**不回填**：编辑态留空即沿用原值（design 2.2「编辑」第 2 条）。
 * @param model 模型条目
 * @returns 表单初值
 */
export function formFromModel(model) {
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
export function formWithField(form, field, value) {
	const source = form !== null && typeof form === "object" ? form : emptyForm();
	return { ...source, [field]: typeof value === "string" ? value : String(value) };
}

/**
 * 本次要提交的密钥：输入框有内容就用输入框的，留空则沿用原条目的密钥。
 * @param form 表单
 * @param baseModel 编辑态的原条目（新增态传 null）
 * @returns 密钥明文（只在内存里流转，不写日志、不进对比面板）
 */
export function resolvedFormKey(form, baseModel) {
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
export function formCandidate(form, baseModel) {
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
export function modelFromForm(form, baseModel, options) {
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
export function validateForm(form, baseModel, options) {
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
export function formErrorEntries(errors) {
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
export function formErrorSummaryText(errors) {
	const entries = formErrorEntries(errors);
	if (entries.length === 0) return "";
	return "还差 " + String(entries.length) + " 项：" + entries.map((item) => item.label + "（" + item.message + "）").join("、");
}

/** 校验是否放行（保存按钮不再靠它禁用，只作为「现在能不能直接提交」的判定）。 */
export function canSaveForm(form, baseModel, options) {
	return validateForm(form, baseModel, options).ok === true;
}

/** 密钥显示：只露末 4 位；没有密钥时给固定文案。 */
export function displayApiKey(model) {
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
export function formatUpdatedAt(timestamp, date) {
	const value = typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
	if (value === 0) return "最近修改 —";
	const moment = date instanceof Date ? date : new Date(value);
	if (Number.isNaN(moment.getTime())) return "最近修改 —";
	return "最近修改 " + pad2(moment.getMonth() + 1) + "-" + pad2(moment.getDate()) + " " + pad2(moment.getHours()) + ":" + pad2(moment.getMinutes());
}

/** 默认标记：● 默认 / ○ 非默认（design 2.1 列表区）。 */
export function defaultMarker(model) {
	return model !== null && typeof model === "object" && model.isDefault === true ? "\u25cf" : "\u25cb";
}

/** 默认标记的无障碍文案。 */
export function markerLabel(model) {
	return model !== null && typeof model === "object" && model.isDefault === true ? "当前默认模型" : "设为默认模型";
}

/**
 * 行数据装配：列表区一行要显示的全部文本（不在渲染里现算，便于单测）。
 * @param model 模型条目
 * @returns {{ id, marker, markerLabel, name, model, key, endpoint, updated, meta }}
 */
export function rowSummary(model) {
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
export function countText(count) {
	const size = typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
	return "共 " + size + " 条 / 上限 " + MODEL_LIMIT;
}

/** 还能不能再加一条。 */
export function canAddModel(models) {
	const list = Array.isArray(models) ? models : [];
	return list.length < MODEL_LIMIT;
}

/** 不能加时的原因文案（能加时为空串）。 */
export function limitReason(models) {
	return canAddModel(models) ? "" : "最多 " + MODEL_LIMIT + " 个模型";
}

/**
 * 找出内容完全相同的条目（同样的地址 + 密钥 + 模型名）。
 * 重复提交的幂等判定就落在这里：同内容不产生第二条（design 2.2 无重复条目）。
 * @param models 现有列表
 * @param model 待加入条目
 * @returns 命中的条目或 null
 */
export function findSameModel(models, model) {
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
export function addModelToList(models, model) {
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
export function updateModelInList(models, model, options) {
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
export function deleteModelFromList(models, settings, id) {
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
export function chooseDefaultModel(models, id) {
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
export function applySetting(settings, key, value) {
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
export function resolveEngine(settings, models) {
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
export function providerIdOf(models) {
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
export function legacyConfigPrompt(legacyText, models) {
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
export function legacyModels(legacyText) {
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
export function corruptNotice(state) {
	const corrupt = state !== null && typeof state === "object" && state.corrupt === true;
	return { show: corrupt, text: corrupt ? "检测到损坏的旧配置，已备份" : "" };
}

/** 迁移完成提示：loadModels 返回 migrated=true 时。 */
export function migratedNotice(state) {
	const migrated = state !== null && typeof state === "object" && state.migrated === true;
	return { show: migrated, text: migrated ? "已从旧版配置迁移到多模型配置" : "" };
}

/**
 * 落盘失败提示（无痕模式 / 配额满）：内存值继续可用（design 2.3）。
 * @param result saveModels 的返回
 * @returns {{ show: boolean, text: string }}
 */
export function storageNotice(result) {
	const failed = result === null || result === undefined || typeof result !== "object" ? true : result.ok !== true;
	return { show: failed, text: failed ? "配置未能保存，关闭后将丢失" : "" };
}

/**
 * 宿主模型接口缺失提示：GET 探测失败时面板降级为只读展示（不因路由缺失而消失/抛错）。
 * @param status "unknown" / "ready" / "missing"
 * @returns {{ show: boolean, text: string }}
 */
export function hostNotice(status) {
	if (status === "missing") {
		return { show: true, text: "宿主未提供模型接口，当前使用 patch 配置的单一地址（面板只读展示）" };
	}
	return { show: false, text: "" };
}

/** 从宿主错误文案里抽出上游真实状态码（宿主把上游非 2xx 包成 502 + 「上游返回 401」）。 */
export function upstreamStatusOf(errorText) {
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
export function classifyTestFailure(outcome) {
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
export function summarizeTest(outcome) {
	const source = outcome !== null && typeof outcome === "object" ? outcome : {};
	if (source.ok === true) {
		const duration = typeof source.durationMs === "number" && Number.isFinite(source.durationMs) ? Math.round(source.durationMs) : 0;
		return { tone: "ok", text: "连接正常 \u00b7 " + duration + "ms" };
	}
	return { tone: "error", text: "连接失败 \u00b7 " + classifyTestFailure(source).text };
}

/** 空态文案（design 3「空态」）。 */
export function emptyModelsText() {
	return "还没有配置模型。默认使用本地引擎，无需配置即可用。";
}
