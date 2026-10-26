import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, MODEL_LIMIT } from "../src/shared/config.js";
import {
	FORM_FIELDS,
	NO_KEY_TEXT,
	emptyForm,
	formFromModel,
	formWithField,
	displayApiKey,
	formatUpdatedAt,
	defaultMarker,
	rowSummary,
	countText,
	canAddModel,
	limitReason,
	findSameModel,
	addModelToList,
	updateModelInList,
	deleteModelFromList,
	chooseDefaultModel,
	applySetting,
	resolveEngine,
	providerIdOf,
	legacyConfigPrompt,
	legacyModels,
	corruptNotice,
	migratedNotice,
	storageNotice,
	hostNotice,
	upstreamStatusOf,
	summarizeTest,
	emptyModelsText,
	validateForm,
	canSaveForm,
	modelFromForm,
	formErrorEntries,
	formErrorSummaryText,
	FORM_FIELD_LABELS,
	ENGINE_OPTIONS_CLIENT,
	ENGINE_LABELS_CLIENT
} from "../src/client/settings.js";

const ID_MAIN = "11111111-1111-4111-8111-111111111111";
const ID_SPARE = "22222222-2222-4222-8222-222222222222";
const ID_THIRD = "33333333-3333-4333-8333-333333333333";

/** 生成合法 uuid v4 形状的 id（normalizeModel 会丢弃不合法的条目）。 */
function uid(index) {
	const tail = index.toString(16).padStart(12, "0");
	return "aaaaaaaa-aaaa-4aaa-8aaa-" + tail;
}

/** 一条完整合法的模型条目；每一项都可以覆盖。 */
function model(overrides) {
	return {
		id: ID_MAIN,
		name: "OpenAI 主力",
		endpoint: "https://api.openai.com/v1/chat/completions",
		apiKey: "sk-openai-key-a1b2",
		model: "gpt-4o-mini",
		temperature: 0.2,
		timeoutMs: 30000,
		isDefault: true,
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
		...overrides
	};
}

const FILLED_FORM = {
	...emptyForm(),
	endpoint: "https://api.openai.com/v1/chat/completions",
	apiKey: "sk-openai-key-a1b2",
	model: "gpt-4o-mini"
};

test("表单校验：空表单的每个错误都映射到具体字段", () => {
	const result = validateForm(emptyForm(), null);
	assert.equal(result.ok, false);
	const errorKeys = Object.keys(result.errors);
	for (const key of errorKeys) assert.ok(["name", "endpoint", "apiKey", "model", "temperature", "timeoutMs"].includes(key), "错误键必须是表单字段：" + key);
	// 密钥自 v0.3 起可选（支持无 Key 的本地模型），因此不再断言 apiKey 必然出现在空表单错误里。
	assert.ok(errorKeys.includes("endpoint") && errorKeys.includes("model"), "空表单必须报出地址与模型名");
	const typed = validateForm(FILLED_FORM, null);
	assert.equal(typed.ok, true);
	assert.equal(typed.model.name, "gpt-4o-mini");
});

test("空表单禁用保存，必填项补齐后放行", () => {
	assert.equal(canSaveForm(emptyForm(), null), false);
	assert.equal(canSaveForm(FILLED_FORM, null), true);
	const typed = formWithField(emptyForm(), "model", "gpt-4o-mini");
	assert.equal(typed.model, "gpt-4o-mini");
	assert.equal(typed.endpoint, "");
});

test("编辑态密钥留空即沿用原值，且保留 createdAt", () => {
	const base = model();
	const form = formFromModel(base);
	assert.equal(form.apiKey, "");
	assert.equal(canSaveForm(form, base), true);
	const built = modelFromForm(form, base);
	assert.equal(built.ok, true);
	assert.equal(built.model.apiKey, base.apiKey);
	assert.equal(built.model.createdAt, base.createdAt);
});

test("密钥只以掩码展示，真实值不进任何展示文本", () => {
	assert.equal(displayApiKey(model()), "sk-…a1b2");
	assert.equal(displayApiKey(model({ apiKey: "" })), NO_KEY_TEXT);
	const summary = rowSummary(model());
	assert.equal(summary.key, "sk-…a1b2");
	assert.equal(summary.meta.includes("sk-openai-key-a1b2"), false);
});

test("计数文案与上限文案跟随 MODEL_LIMIT", () => {
	assert.equal(MODEL_LIMIT, 20);
	assert.equal(countText(3), "共 3 条 / 上限 " + MODEL_LIMIT);
	assert.equal(countText(0), "共 0 条 / 上限 " + MODEL_LIMIT);
});

test("达到 20 条时禁用添加，并给出上限原因", () => {
	const many = Array.from({ length: MODEL_LIMIT }, (unused, index) =>
		model({ id: uid(index), name: "模型 " + index, model: "model-" + index, apiKey: "sk-bulk-key-" + index, isDefault: index === 0 })
	);
	assert.equal(many.length, MODEL_LIMIT);
	assert.equal(canAddModel(many), false);
	assert.equal(limitReason(many), "最多 " + MODEL_LIMIT + " 个模型");
	assert.equal(limitReason([model()]), "");
	const outcome = addModelToList(many, model({ id: ID_THIRD, apiKey: "sk-extra-key-77", model: "fresh-model" }));
	assert.equal(outcome.added, false);
	assert.equal(outcome.reason, "limit");
	assert.equal(outcome.models.length, MODEL_LIMIT);
});

test("删除默认模型后默认自动迁移到首条，引擎不动", () => {
	const list = [model(), model({ id: ID_SPARE, name: "DeepSeek 备用", endpoint: "https://api.deepseek.com/v1/chat/completions", apiKey: "sk-spare-key-b2c3", model: "deepseek-chat", isDefault: false })];
	const outcome = deleteModelFromList(list, { ...DEFAULT_CONFIG, engine: "llm" }, ID_MAIN);
	assert.equal(outcome.removed, true);
	assert.equal(outcome.models.length, 1);
	assert.equal(outcome.models[0].id, ID_SPARE);
	assert.equal(outcome.models[0].isDefault, true);
	assert.equal(outcome.settings.engine, "llm");
	assert.ok(outcome.notices.some((line) => line.includes("默认模型已切换为")));
});

test("删空所有模型时引擎强制回落到本地", () => {
	const outcome = deleteModelFromList([model()], { ...DEFAULT_CONFIG, engine: "llm" }, ID_MAIN);
	assert.equal(outcome.removed, true);
	assert.equal(outcome.models.length, 0);
	assert.equal(outcome.settings.engine, "local");
	assert.ok(outcome.notices.some((line) => line.includes("回落")));
});

test("切换默认模型后列表里只有一个默认", () => {
	const list = [model(), model({ id: ID_SPARE, name: "备用", endpoint: "https://api.deepseek.com/v1/chat/completions", apiKey: "sk-spare-key-b2c3", model: "deepseek-chat", isDefault: false })];
	const outcome = chooseDefaultModel(list, ID_SPARE);
	assert.equal(outcome.changed, true);
	assert.equal(outcome.models.filter((item) => item.isDefault === true).length, 1);
	assert.equal(outcome.models.find((item) => item.isDefault === true).id, ID_SPARE);
});

test("同内容重复提交是幂等的，不产生第二条", () => {
	const first = addModelToList([], model());
	assert.equal(first.added, true);
	assert.equal(first.models.length, 1);
	const second = addModelToList(first.models, model());
	assert.equal(second.added, false);
	assert.equal(second.reason, "duplicate");
	assert.equal(second.models.length, 1);
	assert.equal(second.id, first.id);
	assert.ok(findSameModel(first.models, model()) !== null);
});

test("旧配置导入提示只在能迁出且未导入过时出现", () => {
	const legacy = JSON.stringify({
		llmEndpoint: "https://api.moonshot.cn/v1/chat/completions",
		llmApiKey: "sk-legacy-key-9f8e",
		llmModel: "moonshot-v1-8k"
	});
	const prompt = legacyConfigPrompt(legacy, []);
	assert.equal(prompt.show, true);
	assert.equal(prompt.canImport, true);
	assert.ok(prompt.text.includes("旧版配置"));
	assert.equal(legacyConfigPrompt("", []).show, false);
	assert.equal(legacyConfigPrompt("{ 这不是 json", []).show, false);
	assert.equal(legacyConfigPrompt(JSON.stringify({ locale: "zh" }), []).show, false);
	const migrated = legacyModels(legacy);
	assert.equal(migrated.length, 1);
	const added = addModelToList([], migrated[0]);
	assert.equal(added.added, true);
	assert.equal(legacyConfigPrompt(legacy, added.models).show, false);
});

test("损坏 / 迁移 / 落盘失败 / 宿主缺失 的提示判定", () => {
	assert.equal(corruptNotice({ corrupt: true }).show, true);
	assert.ok(corruptNotice({ corrupt: true }).text.includes("已备份"));
	assert.equal(corruptNotice({ corrupt: false }).show, false);
	assert.equal(migratedNotice({ migrated: true }).show, true);
	assert.equal(storageNotice({ ok: false }).show, true);
	assert.equal(storageNotice({ ok: true }).show, false);
	assert.equal(storageNotice(null).show, true);
	assert.equal(storageNotice({ ok: false }).text, "配置未能保存，关闭后将丢失");
	assert.equal(hostNotice("missing").show, true);
	assert.equal(hostNotice("ready").show, false);
	assert.equal(hostNotice("unknown").show, false);
});

test("行为设置四组取值都会被合法化，且只含四个键", () => {
	assert.equal(applySetting(DEFAULT_CONFIG, "strength", "极端").strength, DEFAULT_CONFIG.strength);
	assert.equal(applySetting(DEFAULT_CONFIG, "strength", "deep").strength, "deep");
	assert.equal(applySetting(DEFAULT_CONFIG, "locale", "en").locale, "en");
	assert.equal(applySetting(DEFAULT_CONFIG, "engine", "llm").engine, "llm");
	assert.equal(applySetting(DEFAULT_CONFIG, "mergeMode", "loose").mergeMode, DEFAULT_CONFIG.mergeMode);
	assert.equal(applySetting(DEFAULT_CONFIG, "mergeMode", "lenient").mergeMode, "lenient");
	assert.deepEqual(Object.keys(applySetting(DEFAULT_CONFIG, "strength", "light")).sort(), ["engine", "locale", "mergeMode", "strength"]);
});

test("engine=llm 但没有默认模型时回退本地并给出提示", () => {
	const fallback = resolveEngine({ ...DEFAULT_CONFIG, engine: "llm" }, []);
	assert.equal(fallback.settings.engine, "local");
	assert.ok(fallback.notice.length > 0);
	const ready = resolveEngine({ ...DEFAULT_CONFIG, engine: "llm" }, [model()]);
	assert.equal(ready.settings.engine, "llm");
	assert.equal(ready.notice, "");
});

test("providerId 取默认模型 id，没有默认模型时为空串", () => {
	assert.equal(providerIdOf([model()]), ID_MAIN);
	assert.equal(providerIdOf([model({ isDefault: false })]), "");
	assert.equal(providerIdOf([]), "");
});

test("测试连接结果的行内文案与失败分类", () => {
	assert.deepEqual(summarizeTest({ ok: true, durationMs: 320 }), { tone: "ok", text: "连接正常 · 320ms" });
	assert.equal(summarizeTest({ ok: false, status: 502, error: "上游返回 401" }).text, "连接失败 · 401 密钥无效");
	assert.equal(summarizeTest({ ok: false, status: 502, error: "上游返回 404" }).text, "连接失败 · 404 路径不对");
	assert.equal(summarizeTest({ ok: false, kind: "network", status: 0 }).text, "连接失败 · 地址不可达");
	assert.equal(summarizeTest({ ok: false, kind: "timeout" }).text, "连接失败 · 超时");
	assert.equal(summarizeTest({ ok: false, status: 504 }).text, "连接失败 · 超时");
	assert.equal(upstreamStatusOf("上游返回 401"), 401);
	assert.equal(upstreamStatusOf("没有状态码"), 0);
});

test("最近修改时间可注入 Date，缺时间戳时给占位", () => {
	assert.equal(formatUpdatedAt(0), "最近修改 —");
	assert.match(formatUpdatedAt(1700000000000), /^最近修改 \d{2}-\d{2} \d{2}:\d{2}$/);
	assert.equal(formatUpdatedAt(1700000000000, new Date(2024, 0, 5, 9, 7)), "最近修改 01-05 09:07");
});

test("行数据装配：默认标记、名称、模型名与空态文案", () => {
	assert.deepEqual(FORM_FIELDS, ["name", "endpoint", "apiKey", "model", "temperature", "timeoutMs"]);
	const summary = rowSummary(model());
	assert.equal(summary.marker, "●");
	assert.equal(summary.markerLabel, "当前默认模型");
	assert.equal(summary.name, "OpenAI 主力");
	assert.equal(summary.model, "gpt-4o-mini");
	assert.equal(defaultMarker(model({ isDefault: false })), "○");
	const noKey = rowSummary(model({ apiKey: "" }));
	assert.ok(noKey.meta.includes(NO_KEY_TEXT));
	assert.ok(noKey.meta.includes("https://api.openai.com/v1/chat/completions"));
	assert.ok(emptyModelsText().length > 0);
});


/* ------------------------------------------------------------------ *
 * v0.3 客户端交互：提交失败给汇总提示、表单常驻错误区、引擎三档 auto
 * ------------------------------------------------------------------ */

const OVERLAYS_SRC = readFileSync(new URL("../src/client/overlays.js", import.meta.url), "utf8");
const BUTTON_SRC = readFileSync(new URL("../src/client/button.js", import.meta.url), "utf8");
const STYLE_SRC = readFileSync(new URL("../src/client/style.js", import.meta.url), "utf8");

test("校验失败时提交提示写成人话，字段用中文名", () => {
	const built = validateForm(emptyForm(), null);
	assert.equal(built.ok, false);
	const text = formErrorSummaryText(built.list);
	const fields = new Set(built.list.map((item) => item.field));
	assert.ok(fields.size >= 3);
	assert.ok(text.startsWith("还差 " + String(fields.size) + " 项："));
	assert.ok(text.includes("地址（"));
	assert.ok(text.includes("显示名（"));
	assert.ok(text.includes("模型名（"));
	assert.equal(formErrorSummaryText(validateForm(FILLED_FORM, null).list), "");
});

test("错误汇总项数按字段去重，与字段出现顺序无关", () => {
	const list = [
		{ field: "endpoint", message: "不是合法的绝对 URL" },
		{ field: "apiKey", message: "请填写 API 密钥" },
		{ field: "endpoint", message: "同字段的第二条不再出现" }
	];
	assert.equal(formErrorSummaryText(list), "还差 2 项：地址（不是合法的绝对 URL）、密钥（请填写 API 密钥）");
	const mapped = { apiKey: "请填写 API 密钥", endpoint: "不是合法的绝对 URL" };
	assert.equal(formErrorEntries(mapped).length, 2);
	assert.equal(formErrorSummaryText(mapped).includes("第二条"), false);
	assert.equal(formErrorSummaryText([]), "");
	assert.equal(formErrorSummaryText({}), "");
	assert.equal(formErrorSummaryText(null), "");
});

test("错误条目带中文显示名，未知字段保留原名", () => {
	assert.deepEqual(Object.keys(FORM_FIELD_LABELS).sort(), ["apiKey", "endpoint", "model", "name", "temperature", "timeoutMs"]);
	const entries = formErrorEntries([{ field: "temperature", message: "不在允许范围" }, { field: "unknownKey", message: "x" }]);
	assert.equal(entries[0].label, "温度");
	assert.equal(entries[0].message, "不在允许范围");
	assert.equal(entries[1].label, "unknownKey");
});

test("submitForm 校验失败时把汇总文案写进提示条", () => {
	const at = BUTTON_SRC.indexOf("function submitForm()");
	assert.ok(at > 0);
	const body = BUTTON_SRC.slice(at, BUTTON_SRC.indexOf("function confirmDeleteNow()"));
	assert.ok(body.includes("formErrorSummaryText(built.errors)"));
	assert.ok(body.includes("patchModelState({ notice:"));
	assert.equal(body.includes("if (built.ok !== true) return;"), false);
});

test("保存按钮渲染上不再带 disabled，始终可点", () => {
	const at = OVERLAYS_SRC.indexOf('"submit-form"');
	assert.ok(at > 0);
	const start = OVERLAYS_SRC.lastIndexOf("miniButton(", at);
	const call = OVERLAYS_SRC.slice(start, OVERLAYS_SRC.indexOf("\n", at));
	assert.equal(call.includes("disabled"), false);
	assert.ok(call.includes("strong: true"));
});

test("表单内有常驻错误汇总区，无错误时零占位", () => {
	assert.ok(OVERLAYS_SRC.includes('"data-dsh-po-role": "form-summary"'));
	assert.ok(OVERLAYS_SRC.includes("className: \"dsh-po-formsummary dsh-po-field-wide\""));
	assert.ok(OVERLAYS_SRC.includes("if (entries.length === 0) return null;"));
	assert.ok(OVERLAYS_SRC.indexOf("formSummaryNode(view.errors)") < OVERLAYS_SRC.indexOf("dsh-po-formfoot dsh-po-field-wide"));
});

test("错误汇总区样式只走 CSS 变量，没有写死 #fff", () => {
	assert.equal(/#fff/i.test(STYLE_SRC), false);
	assert.ok(STYLE_SRC.includes(".dsh-po-formsummary{"));
	assert.ok(STYLE_SRC.includes(".dsh-po-formsummary-head{"));
	assert.ok(STYLE_SRC.includes(".dsh-po-formsummary-line{"));
});

test("engine 三档都写得进设置，非法取值退回默认", () => {
	assert.deepEqual(ENGINE_OPTIONS_CLIENT, ["auto", "local", "llm"]);
	assert.equal(applySetting(DEFAULT_CONFIG, "engine", "auto").engine, "auto");
	assert.equal(applySetting(DEFAULT_CONFIG, "engine", "local").engine, "local");
	assert.equal(applySetting(DEFAULT_CONFIG, "engine", "llm").engine, "llm");
	assert.equal(applySetting(DEFAULT_CONFIG, "engine", "极端").engine, DEFAULT_CONFIG.engine);
	assert.deepEqual(Object.keys(applySetting(DEFAULT_CONFIG, "engine", "auto")).sort(), ["engine", "locale", "mergeMode", "strength"]);
});

test("engine=auto 有默认模型时有效引擎为 llm，且档位原样留存", () => {
	const auto = resolveEngine({ ...DEFAULT_CONFIG, engine: "auto" }, [model()]);
	// auto 是用户选定的档位：折成 llm 会让三档控件点回原处，界面看着像「点了没反应」
	assert.equal(auto.settings.engine, "auto");
	assert.equal(auto.effective, "llm");
	assert.equal(auto.notice, "");
});

test("engine=auto 没有默认模型时有效引擎为 local，且档位原样留存", () => {
	const auto = resolveEngine({ ...DEFAULT_CONFIG, engine: "auto" }, []);
	assert.equal(auto.settings.engine, "auto");
	assert.equal(auto.effective, "local");
	assert.equal(auto.notice, "");
	assert.equal(resolveEngine({ ...DEFAULT_CONFIG, engine: "auto" }, null).effective, "local");
});

test("llm 缺默认模型仍回落 local 并给出提示", () => {
	const fallback = resolveEngine({ ...DEFAULT_CONFIG, engine: "llm" }, [model({ isDefault: false })]);
	assert.equal(fallback.settings.engine, "local");
	assert.equal(fallback.effective, "local");
	assert.ok(fallback.notice.includes("默认模型"));
});

test("引擎分段控件是三档且文案齐全，auto 排首位", () => {
	assert.equal(ENGINE_OPTIONS_CLIENT.length, 3);
	assert.equal(ENGINE_OPTIONS_CLIENT[0], "auto");
	assert.equal(ENGINE_OPTIONS_CLIENT.indexOf("local") > 0, true);
	assert.equal(ENGINE_OPTIONS_CLIENT.indexOf("llm") > 0, true);
	for (const value of ENGINE_OPTIONS_CLIENT) {
		assert.ok(typeof ENGINE_LABELS_CLIENT[value] === "string" && ENGINE_LABELS_CLIENT[value].length > 0);
	}
	assert.ok(ENGINE_LABELS_CLIENT.auto.includes("推荐"));
	assert.ok(ENGINE_LABELS_CLIENT.local.includes("本地"));
	assert.ok(ENGINE_LABELS_CLIENT.llm.includes("LLM"));
	assert.ok(OVERLAYS_SRC.includes("optionRow(\"engine\", \"引擎\", ENGINE_OPTIONS_CLIENT, ENGINE_LABELS_CLIENT"));
});

test("原位更新保留 createdAt 并刷新 updatedAt，未知 id 无副作用", () => {
	const updated = updateModelInList([model()], { ...model(), name: "改过的名字" });
	assert.equal(updated.updated, true);
	assert.equal(updated.models[0].name, "改过的名字");
	assert.equal(updated.models[0].createdAt, 1700000000000);
	assert.ok(updated.models[0].updatedAt > 1700000000000);
	assert.equal(updateModelInList([model()], model({ id: ID_THIRD })).updated, false);
	assert.equal(deleteModelFromList([model()], DEFAULT_CONFIG, ID_THIRD).removed, false);
});
