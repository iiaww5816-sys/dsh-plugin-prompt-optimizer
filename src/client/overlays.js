/**
 * 浮层渲染：小条 / 对比面板 / 设置面板 / 错误提示。
 *
 * 硬约定（为什么都塞进同一个组件）：conversation.input.activity 是 single 槽，
 * 再注册第二个槽会互相遮蔽，所以浮层不新增槽位 —— 它们全部由入口组件自己渲染，
 * 用 position:fixed（类名里已声明）+ 按钮的 getBoundingClientRect() 定位。
 *
 * 这里只放无状态渲染；状态机、落盘与网络副作用都在 button.js，纯规则在 settings.js。
 */
import react from "react";
import { preventFocusSteal, copyText } from "./dom.js";
import {
	STRENGTH_OPTIONS,
	LOCALE_OPTIONS,
	MERGE_MODE_OPTIONS
} from "../shared/config.js";
import {
	canAddModel,
	limitReason,
	emptyModelsText,
	rowSummary,
	formErrorEntries,
	ENGINE_OPTIONS_CLIENT,
	ENGINE_LABELS_CLIENT
} from "./settings.js";

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
export function StatusToast({ style, note, guard, onCompare, onRestore, onDismiss }) {
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
export function ComparePanel({ style, panelRef, meta, original, optimized, conservation, onClose }) {
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
export function SettingsPanel({ style, panelRef, view, actions }) {
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
export function ErrorBanner({ style, message, onClose }) {
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
