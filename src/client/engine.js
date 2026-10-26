/**
 * 引擎注入点。
 *
 * 打包产物启动时把内联引擎（构建期由 src/engine/{prompts,optimize}.js 合成）接进来；
 * 仿真/测试可以用 setEngine() 换成假引擎，从而覆盖「引擎抛错」这类错误路径。
 * 源码这里不 import 引擎 —— 客户端产物不允许 require 本地文件。
 */

let engineImpl = null;

/** @param next 引擎对象（需提供 optimize）；传 null 表示卸载 */
export function setEngine(next) {
	engineImpl = next !== null && typeof next === "object" ? next : null;
}

/** @returns 当前引擎（未装载时为 null，调用方必须自己判空） */
export function getEngine() {
	return engineImpl;
}

/** 远端（宿主 LLM 通路）实现：{ optimizeViaRemote, FAILURE_TEXT }。 */
let remoteImpl = null;

/** @param next 远端实现；传 null 表示卸载（此时 engine=llm 直接回退本地） */
export function setRemote(next) {
	remoteImpl = next !== null && typeof next === "object" ? next : null;
}

/** @returns 当前远端实现（未装载时为 null） */
export function getRemote() {
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
export function setMerge(next) {
	mergeImpl = next !== null && typeof next === "object" ? next : null;
}

/** @returns 当前 merge 模块（未装载时为 null） */
export function getMerge() {
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
export function applyGuard(originalText, resultText, mode) {
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

