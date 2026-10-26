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
export function ensureStyle() {
	if (typeof document === "undefined" || document === null) return;
	if (document.head === null || document.head === undefined) return;
	if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-plugin-prompt-optimizer";
	tag.dataset.pluginCss = STYLE_ID;
	tag.textContent = CSS + SPIN_CSS;
	document.head.appendChild(tag);
}
