/**
 * 浏览器侧小工具：浮层定位、焦点保护、剪贴板。
 * 能力缺失或宿主环境异常时一律静默降级 —— 不抛错、不打断用户操作。
 */

/** 阻止 mousedown 抢走编辑器焦点（内部所有按钮共用）。 */
export function preventFocusSteal(event) {
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
export function anchorOf(node) {
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
export function fixedStyle(anchor, maxWidth) {
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
export function copyText(text) {
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
