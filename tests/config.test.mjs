import test from "node:test";
import assert from "node:assert/strict";
import {
	CONFIG_KEY,
	MODELS_KEY,
	MODEL_LIMIT,
	SCHEMA_VERSION,
	DEFAULT_MERGE_MODE,
	MERGE_MODE_OPTIONS,
	DEFAULT_CONFIG,
	STRENGTH_OPTIONS,
	LOCALE_OPTIONS,
	ENGINE_OPTIONS,
	normalizeConfig,
	serializeConfig,
	loadConfig,
	saveConfig,
	validateModel,
	normalizeModel,
	normalizeModelList,
	loadModels,
	saveModels,
	upsertModel,
	removeModel,
	setDefaultModel,
	maskApiKey,
	migrateConfig
} from "../src/shared/config.js";

/** 最小 storage 替身：可注入抛错，模拟无痕模式。 */
function fakeStorage(initial, throwOn) {
	const box = {
		data: { ...(initial || {}) },
		getItem(key) {
			if (throwOn === "get") throw new Error("SecurityError");
			return Object.prototype.hasOwnProperty.call(box.data, key) ? box.data[key] : null;
		},
		setItem(key, value) {
			if (throwOn === "set") throw new Error("QuotaExceededError");
			box.data[key] = String(value);
		},
		removeItem(key) {
			if (throwOn === "remove") throw new Error("SecurityError");
			delete box.data[key];
		}
	};
	return box;
}

test("配置键固定为 dsh-plugin-prompt-optimizer/config", () => {
	assert.equal(CONFIG_KEY, "dsh-plugin-prompt-optimizer/config");
});

test("DEFAULT_CONFIG 是冻结的合法默认值", () => {
	assert.deepEqual(DEFAULT_CONFIG, { strength: "standard", locale: "zh", engine: "auto", mergeMode: "strict" });
	assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
});

test("选项白名单与引擎契约一致", () => {
	assert.deepEqual(STRENGTH_OPTIONS, ["light", "standard", "deep"]);
	assert.deepEqual(LOCALE_OPTIONS, ["zh", "en"]);
	assert.deepEqual(ENGINE_OPTIONS, ["local", "llm", "auto"]);
});

test("normalizeConfig 对合法输入原样通过", () => {
	assert.deepEqual(normalizeConfig({ strength: "deep", locale: "en", engine: "llm" }), {
		strength: "deep",
		locale: "en",
		engine: "llm",
		mergeMode: "strict"
	});
});

test("normalizeConfig 对大小写与首尾空白容错", () => {
	assert.deepEqual(normalizeConfig({ strength: "  DEEP ", locale: "EN", engine: " LLM " }), {
		strength: "deep",
		locale: "en",
		engine: "llm",
		mergeMode: "strict"
	});
});

test("normalizeConfig 对非对象输入退回默认值而不是抛错", () => {
	const inputs = [null, undefined, 0, 1, "", "x", true, false, [], [1, 2], () => undefined];
	for (const raw of inputs) {
		assert.deepEqual(normalizeConfig(raw), { ...DEFAULT_CONFIG }, "输入 " + String(raw));
	}
});

test("normalizeConfig 逐字段归一化非法值", () => {
	assert.deepEqual(normalizeConfig({ strength: "ultra", locale: "fr", engine: "cloud" }), { ...DEFAULT_CONFIG });
	assert.deepEqual(normalizeConfig({ strength: 42, locale: null, engine: {} }), { ...DEFAULT_CONFIG });
	assert.deepEqual(normalizeConfig({ strength: "light" }), { strength: "light", locale: "zh", engine: "auto", mergeMode: "strict" });
	assert.deepEqual(normalizeConfig({ locale: "en", extra: "忽略未知字段" }), { strength: "standard", locale: "en", engine: "auto", mergeMode: "strict" });
});

test("normalizeConfig 返回值永远是新的可写对象（不泄漏 DEFAULT_CONFIG 引用）", () => {
	const first = normalizeConfig(null);
	first.strength = "deep";
	assert.equal(DEFAULT_CONFIG.strength, "standard");
	assert.deepEqual(normalizeConfig(null), { ...DEFAULT_CONFIG });
});

test("serializeConfig 先归一化再序列化", () => {
	assert.equal(serializeConfig({ strength: "bogus", locale: "en" }), '{"strength":"standard","locale":"en","engine":"auto","mergeMode":"strict"}');
	assert.equal(serializeConfig(null), '{"strength":"standard","locale":"zh","engine":"auto","mergeMode":"strict"}');
});

test("loadConfig 没有 storage 时返回默认值", () => {
	assert.deepEqual(loadConfig(fakeStorage({}, "get")), { ...DEFAULT_CONFIG });
	assert.deepEqual(loadConfig(null), { ...DEFAULT_CONFIG });
	assert.deepEqual(loadConfig({}), { ...DEFAULT_CONFIG });
});

test("loadConfig 读取并归一化已保存的配置", () => {
	const box = fakeStorage({ [CONFIG_KEY]: '{"strength":"deep","locale":"en","engine":"llm"}' });
	assert.deepEqual(loadConfig(box), { strength: "deep", locale: "en", engine: "llm", mergeMode: "strict" });
});

test("loadConfig 遇到损坏 JSON / 空值时静默降级", () => {
	assert.deepEqual(loadConfig(fakeStorage({ [CONFIG_KEY]: "{不是 json" })), { ...DEFAULT_CONFIG });
	assert.deepEqual(loadConfig(fakeStorage({ [CONFIG_KEY]: "" })), { ...DEFAULT_CONFIG });
	assert.deepEqual(loadConfig(fakeStorage({ [CONFIG_KEY]: "[]" })), { ...DEFAULT_CONFIG });
	assert.deepEqual(loadConfig(fakeStorage({ [CONFIG_KEY]: "null" })), { ...DEFAULT_CONFIG });
});

test("saveConfig 写入后可被 loadConfig 读回", () => {
	const box = fakeStorage({});
	assert.equal(saveConfig(box, { strength: "light", locale: "en", engine: "local" }), true);
	assert.equal(box.data[CONFIG_KEY], '{"strength":"light","locale":"en","engine":"local","mergeMode":"strict"}');
	assert.deepEqual(loadConfig(box), { strength: "light", locale: "en", engine: "local", mergeMode: "strict" });
});

test("saveConfig 写入失败返回 false 而不是抛错（无痕模式）", () => {
	assert.equal(saveConfig(fakeStorage({}, "set"), { strength: "deep" }), false);
	assert.equal(saveConfig(null, DEFAULT_CONFIG), false);
});

test("saveConfig 永远写归一化后的合法值", () => {
	const box = fakeStorage({});
	saveConfig(box, { strength: "??", locale: "??", engine: "??" });
	assert.equal(box.data[CONFIG_KEY], '{"strength":"standard","locale":"zh","engine":"auto","mergeMode":"strict"}');
});

// ---------------------------------------------------------------------------
// v0.2：多模型配置（docs/design-v0.2.md 第 1.1 节 + 2.3 + 4.3）
// ---------------------------------------------------------------------------

/** 一条字段齐备的合法模型条目。 */
function validModel(overrides) {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "DeepSeek 官方",
		endpoint: "https://api.deepseek.com/v1/chat/completions",
		apiKey: "sk-abcdefgh1234a1b2",
		model: "deepseek-chat",
		temperature: 0.2,
		timeoutMs: 30000,
		isDefault: true,
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...overrides
	};
}

/** 第 index 条条目的唯一合法 uuid v4。 */
function modelId(index) {
	return "00000000-0000-4000-8000-" + String(index).padStart(12, "0");
}

test("v0.2 常量固定：MODELS_KEY / MODEL_LIMIT / SCHEMA_VERSION / DEFAULT_MERGE_MODE", () => {
	assert.equal(MODELS_KEY, "dsh-plugin-prompt-optimizer/models");
	assert.equal(MODEL_LIMIT, 20);
	assert.equal(SCHEMA_VERSION, 2);
	assert.equal(DEFAULT_MERGE_MODE, "strict");
	assert.deepEqual(MERGE_MODE_OPTIONS, ["strict", "lenient"]);
});

test("mergeMode 进 DEFAULT_CONFIG / normalizeConfig，非法值回落 strict", () => {
	assert.equal(DEFAULT_CONFIG.mergeMode, "strict");
	assert.equal(normalizeConfig({ mergeMode: "lenient" }).mergeMode, "lenient");
	assert.equal(normalizeConfig({ mergeMode: " LENIENT " }).mergeMode, "lenient");
	assert.equal(normalizeConfig({ mergeMode: "loose" }).mergeMode, "strict");
	assert.equal(normalizeConfig({}).mergeMode, "strict");
});

test("validateModel 对合法条目通过并规范化可选字段", () => {
	const result = validateModel(validModel({ temperature: "0.7", timeoutMs: 15000 }));
	assert.equal(result.ok, true);
	assert.deepEqual(result.errors, []);
	assert.equal(result.value.temperature, 0.7);
	assert.equal(result.value.timeoutMs, 15000);
	assert.equal(result.value.isDefault, true);
});

test("engine 默认 auto、白名单接受 auto、非法值回落 auto", () => {
	assert.equal(DEFAULT_CONFIG.engine, "auto");
	assert.equal(ENGINE_OPTIONS.indexOf("auto") > -1, true);
	assert.equal(normalizeConfig({}).engine, "auto");
	assert.equal(normalizeConfig(null).engine, "auto");
	assert.equal(normalizeConfig({ engine: "auto" }).engine, "auto");
	assert.equal(normalizeConfig({ engine: "  AUTO " }).engine, "auto");
	assert.equal(normalizeConfig({ engine: "local" }).engine, "local");
	assert.equal(normalizeConfig({ engine: "llm" }).engine, "llm");
	assert.equal(normalizeConfig({ engine: "cloud" }).engine, "auto");
	assert.equal(normalizeConfig({ engine: 42 }).engine, "auto");
});

test("validateModel 缺 apiKey 合法（本地 Ollama / LM Studio / 内网反代无需密钥）", () => {
	const input = validModel();
	delete input.apiKey;
	const result = validateModel(input);
	assert.equal(result.ok, true);
	assert.deepEqual(result.errors, []);
	assert.equal(result.value.apiKey, "");
	assert.equal(validateModel(validModel({ apiKey: "" })).ok, true);
	assert.equal(normalizeModel({ ...validModel(), apiKey: "" }).apiKey, "");
	assert.equal(normalizeModel({ ...validModel(), apiKey: "   " }).apiKey, "");
});

test("validateModel 拒绝超长 apiKey（512 是上限）", () => {
	assert.equal(validateModel(validModel({ apiKey: "k".repeat(512) })).ok, true);
	const tooLong = validateModel(validModel({ apiKey: "k".repeat(513) }));
	assert.equal(tooLong.ok, false);
	assert.deepEqual(tooLong.errors.map((error) => error.field), ["apiKey"]);
	assert.equal(tooLong.errors[0].message, "密钥最多 512 个字符");
});

test("validateModel 允许带 query 的 endpoint（Azure 等需要 ?api-version=）", () => {
	const withQuery = validateModel(
		validModel({ endpoint: "https://api.deepseek.com/v1/chat/completions?api-version=2024-05-01" })
	);
	assert.equal(withQuery.ok, true);
	assert.deepEqual(withQuery.errors, []);
	assert.equal(withQuery.value.endpoint, "https://api.deepseek.com/v1/chat/completions?api-version=2024-05-01");
	assert.equal(normalizeModel(validModel({ endpoint: "https://x.example/v1/chat/completions?key=1" })).endpoint, "https://x.example/v1/chat/completions?key=1");
});

test("validateModel 仍然拒绝带 fragment 的 endpoint", () => {
	const withHash = validateModel(validModel({ endpoint: "https://api.deepseek.com/v1/chat/completions#frag" }));
	assert.equal(withHash.ok, false);
	assert.deepEqual(withHash.errors.map((error) => error.field), ["endpoint"]);
	assert.equal(withHash.errors[0].message, "地址不能包含 fragment");
});

test("无密钥 + 带 query 的地址：0 errors（用户「添加不了模型」的直接回归）", () => {
	const result = validateModel({
		endpoint: "http://127.0.0.1:11434/v1/chat/completions?api-version=2024-05-01",
		apiKey: "",
		model: "qwen3:8b"
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.errors, []);
	assert.equal(result.value.apiKey, "");
	assert.equal(result.value.endpoint, "http://127.0.0.1:11434/v1/chat/completions?api-version=2024-05-01");
	assert.equal(result.value.name, "qwen3:8b");
});

test("validateModel 拒绝非 http/https 的 endpoint", () => {
	const ftp = validateModel(validModel({ endpoint: "ftp://api.deepseek.com/v1/chat/completions" }));
	assert.equal(ftp.ok, false);
	assert.equal(ftp.errors[0].field, "endpoint");
	assert.equal(validateModel(validModel({ endpoint: "/v1/chat/completions" })).ok, false);
});

test("validateModel 拒绝含用户名密码的 endpoint", () => {
	const withSecret = validateModel(validModel({ endpoint: "https://user:pass@api.deepseek.com/v1/chat/completions" }));
	assert.equal(withSecret.ok, false);
	assert.equal(withSecret.errors[0].field, "endpoint");
	assert.equal(validateModel(validModel({ endpoint: "https://user@api.deepseek.com/v1/chat/completions" })).ok, false);
});

test("normalizeModelList 第 21 条被截断并在 errors 里说明", () => {
	const input = [];
	for (let index = 1; index <= 21; index += 1) {
		input.push(validModel({ id: modelId(index), name: "模型 " + index, isDefault: index === 1 }));
	}
	const result = normalizeModelList(input);
	assert.equal(result.models.length, MODEL_LIMIT);
	assert.equal(result.models.length, 20);
	assert.equal(result.models[19].id, modelId(20));
	assert.equal(result.errors.some((error) => error.field === "models"), true);
});

test("normalizeModelList 多条 isDefault 只保留第一条", () => {
	const result = normalizeModelList([
		validModel({ id: modelId(1), isDefault: false }),
		validModel({ id: modelId(2), isDefault: true }),
		validModel({ id: modelId(3), isDefault: true })
	]);
	assert.equal(result.models.length, 3);
	assert.deepEqual(result.models.map((item) => item.isDefault), [false, true, false]);
	assert.equal(result.errors.some((error) => error.field === "models[2].isDefault"), true);
});

test("temperature / timeoutMs 越界按边界截断，非法值取默认", () => {
	assert.equal(normalizeModel(validModel({ temperature: 5 })).temperature, 2);
	assert.equal(normalizeModel(validModel({ temperature: -3 })).temperature, 0);
	assert.equal(normalizeModel(validModel({ timeoutMs: 100 })).timeoutMs, 5000);
	assert.equal(normalizeModel(validModel({ timeoutMs: 999999 })).timeoutMs, 120000);
	const fallback = normalizeModel(validModel({ temperature: "abc", timeoutMs: null }));
	assert.equal(fallback.temperature, 0.2);
	assert.equal(fallback.timeoutMs, 30000);
});

test("name 留空时自动取 model", () => {
	const entry = normalizeModel(validModel({ name: "   " }));
	assert.equal(entry.name, "deepseek-chat");
	assert.equal(validateModel(validModel({ name: "" })).ok, true);
});

test("normalizeModel 支持注入 now 且保留已有时间戳", () => {
	const fresh = normalizeModel(validModel({ createdAt: undefined, updatedAt: undefined }), { now: 123 });
	assert.equal(fresh.createdAt, 123);
	assert.equal(fresh.updatedAt, 123);
	assert.equal(normalizeModel(validModel({ createdAt: 9 })).createdAt, 9);
});

test("maskApiKey 只露末 4 位，短串整体掩码", () => {
	assert.equal(maskApiKey("sk-abcdefgh1234a1b2"), "sk-…a1b2");
	assert.equal(maskApiKey("sk-1234567890abcd"), "sk-…abcd");
	assert.equal(maskApiKey("12345678"), "…");
	assert.equal(maskApiKey("short"), "…");
	assert.equal(maskApiKey(""), "…");
	assert.equal(maskApiKey(null), "…");
});

test("saveModels 写入后可被 loadModels 读回", () => {
	const box = fakeStorage({});
	assert.deepEqual(saveModels({ models: [validModel()], settings: { strength: "deep", mergeMode: "lenient" } }, box), { ok: true });
	const stored = JSON.parse(box.data[MODELS_KEY]);
	assert.equal(stored.schemaVersion, 2);
	assert.equal(stored.models.length, 1);
	assert.equal(stored.settings.mergeMode, "lenient");
	const loaded = loadModels(box);
	assert.equal(loaded.schemaVersion, 2);
	assert.equal(loaded.models.length, 1);
	assert.equal(loaded.settings.strength, "deep");
	assert.equal(loaded.migrated, false);
	assert.equal(loaded.corrupt, false);
});

test("saveModels 写失败返回 ok:false 且不抛错", () => {
	const quota = saveModels({ models: [] }, fakeStorage({}, "set"));
	assert.equal(quota.ok, false);
	assert.equal(typeof quota.reason, "string");
	const noStorage = saveModels({ models: [] }, null);
	assert.equal(noStorage.ok, false);
	assert.equal(typeof noStorage.reason, "string");
});

test("loadModels 无 storage 时返回默认值", () => {
	assert.deepEqual(loadModels(null), {
		schemaVersion: 2,
		models: [],
		settings: { strength: "standard", locale: "zh", engine: "auto", mergeMode: "strict" },
		migrated: false,
		corrupt: false
	});
	assert.equal(loadModels({}).models.length, 0);
});

test("loadModels 损坏 JSON 回落默认值并原样写到 .corrupt 键", () => {
	const box = fakeStorage({ [MODELS_KEY]: "{不是 json" });
	const state = loadModels(box);
	assert.equal(state.corrupt, true);
	assert.deepEqual(state.models, []);
	assert.equal(state.settings.mergeMode, "strict");
	assert.equal(box.data[MODELS_KEY + ".corrupt"], "{不是 json");
});

test("migrateConfig 把旧 llmEndpoint 变成一条 isDefault 模型", () => {
	const migrated = migrateConfig({
		llmEndpoint: "https://api.deepseek.com/v1/chat/completions",
		llmApiKey: "sk-legacy-1234a1b2",
		llmModel: "deepseek-chat",
		llmTemperature: 0.5,
		llmTimeoutMs: 20000,
		engine: "llm",
		strength: "deep",
		locale: "en"
	});
	assert.equal(migrated.schemaVersion, 2);
	assert.equal(migrated.models.length, 1);
	assert.equal(migrated.models[0].isDefault, true);
	assert.equal(migrated.models[0].name, "deepseek-chat");
	assert.equal(migrated.models[0].temperature, 0.5);
	assert.equal(migrated.models[0].timeoutMs, 20000);
	assert.equal(migrated.settings.engine, "llm");
	assert.equal(migrated.settings.strength, "deep");
});

test("migrateConfig 旧字段不全时跳过并记录", () => {
	const migrated = migrateConfig({ llmEndpoint: "https://api.deepseek.com/v1/chat/completions", engine: "llm" });
	assert.deepEqual(migrated.models, []);
	assert.equal(migrated.errors.length > 0, true);
	assert.equal(migrated.errors.some((error) => error.field === "llm.model"), true);
});

test("loadModels 见 schemaVersion 不为 2 时自动迁移并标记 migrated", () => {
	const box = fakeStorage({
		[MODELS_KEY]: JSON.stringify({
			schemaVersion: 1,
			llmEndpoint: "https://api.deepseek.com/v1/chat/completions",
			llmApiKey: "sk-legacy-1234a1b2",
			llmModel: "deepseek-chat"
		})
	});
	const state = loadModels(box);
	assert.equal(state.migrated, true);
	assert.equal(state.models.length, 1);
	assert.equal(state.models[0].isDefault, true);
});

test("upsertModel / removeModel / setDefaultModel 维护单一默认模型", () => {
	const first = upsertModel([], validModel({ id: modelId(1), isDefault: false }));
	assert.equal(first.length, 1);
	assert.equal(first[0].isDefault, true);

	const second = upsertModel(first, validModel({ id: modelId(2), name: "第二条", isDefault: true }));
	assert.equal(second.length, 2);
	assert.deepEqual(second.map((item) => item.isDefault), [false, true]);

	const switched = setDefaultModel(second, modelId(1));
	assert.deepEqual(switched.map((item) => item.isDefault), [true, false]);

	const removed = removeModel(switched, modelId(1));
	assert.equal(removed.length, 1);
	assert.equal(removed[0].id, modelId(2));
	assert.equal(removed[0].isDefault, true);
	assert.equal(removeModel(second, "不存在的 id").length, 2);
});

