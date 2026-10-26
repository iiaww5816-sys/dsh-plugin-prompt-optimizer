/**
 * 槽位装配 + 引擎接线。
 *
 * conversation.input.activity 是 single 槽：只注册一条，浮层全部由组件自己渲染。
 * 引擎在构建期被内联成同一个 factory 作用域里的模块，这里把它接进 engine.js 的
 * 注入点 —— 客户端产物因此不需要 require 任何本地文件。
 */
import { PromptOptimizerButton } from "./button.js";
import { ensureStyle } from "./style.js";
import { setEngine, setRemote, setMerge } from "./engine.js";
import { optimize, STRENGTHS } from "../engine/optimize.js";
import { verifyConservation, applyConservation, mergeSections, SECTION_ORDER, SECTION_TITLE, OTHER_NOTE } from "../engine/merge.js";
import { optimizeViaRemote, FAILURE_TEXT } from "./llm.js";

// 内联引擎接线（构建产物里 optimize/STRENGTHS 就是 src/engine 的那份实现）
setEngine({ optimize, STRENGTHS });
// LLM 通路接线：同源 fetch 到宿主注册的 /api/prompt-optimizer/optimize；失败即回退上面的本地引擎
setRemote({ optimizeViaRemote, FAILURE_TEXT });
// 守恒校验兜底接线：单独注入（未装载时兜底降级为「不校验、原样展示」，不影响优化通路本身）
setMerge({ verifyConservation, applyConservation, mergeSections, SECTION_ORDER, SECTION_TITLE, OTHER_NOTE });

/**
 * 槽位注册清单。
 * registerOptions 是空集，所以只需要 name：useInput / inputActions 等是渲染器
 * 无条件注入的标准 props，不靠 store 座位。
 */
export function slotEntries() {
	return [{
		name: "conversation.input.activity",
		options: { name: "conversation.input.activity" },
		component: PromptOptimizerButton
	}];
}

/**
 * 客户端插件主体：注入样式表（一次）+ 注册槽位。
 * @param ctx Web Client 根上下文
 */
export function apply(ctx) {
	ensureStyle();
	for (const entry of slotEntries()) ctx.slots.inject(entry.name, () => ctx.slots.register(entry.options, entry.component));
}

export const inject = ["slots"];

/** 供状态机仿真替换引擎/远端实现（默认即上面内联的那两份）。 */
export { setEngine, setRemote, setMerge };

/** 组件也对外导出，便于宿主/仿真直接挂载。 */
export { PromptOptimizerButton };
