# 已知限制与不完美清单（v0.4.1）

本文件记录**当前实现确实存在的**缺陷与妥协，逐条给出影响与规避。凡是这里列出的，都**不要**当成 bug 报告重复提出；凡是这里没列出的能力，也不要在没有测试证据时宣称可用。

标注约定：

- **【实现妥协】** 代码能跑、功能正确，但写法不理想。
- **【语义偏差】** 名称/展示与真实含义有出入，会误导读者。
- **【边界收紧】** 比直觉更严格的行为（多为安全性选择）。
- **【未做】** 设计第 8 节明确排除的范围。

---

## 1.【实现妥协】`options.now` 注入只覆盖部分入口

- **现象**：只有 `normalizeModel(input, options)`（`src/shared/config.js:258`）与 `updateModelInList(models, model, options)`（`src/client/settings.js:264-272`）接受 `options.now`；`validateModel(input)`（`src/shared/config.js:248-251`）**没有** options 参数，内部 `buildModel(input)` 直接落回 `Date.now()`；`upsertModel(list, model)`（`src/shared/config.js:474-494`）在更新分支也硬用 `Date.now()` 刷 `updatedAt`（`:484`）。
- **影响**：新增态与「列表内部更新」这两条路径的时间戳无法注入，单测只能断言时间戳的量级/单调性，或改从 `updateModelInList` 走。**功能无影响**，仅测试确定性略损。
- **规避**：需要确定性时间戳的用例统一走 `updateModelInList` 的 `options.now`；`createdAt` 保留语义由它负责。
- **根治条件**：把 `validateModel` / `upsertModel` 的签名扩到接 `options`。改动面涉及客户端调用点，会破坏配置层已公开的签名，未做。

## 2.【语义偏差】`reassigned` 是「结果内的重排」，不是「原文里被改判的句子」

- **现象**：`reassignedOf(text, merge)`（`src/client/engine.js:91-103`）对**已经校验过的结果文本**再跑一次 `merge.mergeSections(text)`，取其中 `{from,to,text}`。
- **影响**：它描述的是「这句话在**结果文本**里被判到了哪一栏」，与「原文中的这句话在归并时被改判到哪一栏」不是同一件事——若结果文本本身已被补回/重排，两者会不等。
- **规避**：UI 上只把它当**计数/参考**展示，不做准确率结论；需要精确判定时读 `details` / `dropped` / `lostTokens`。
- **根治条件**：让 `applyConservation` 把「原文侧」的改判记录一并回传（当前它只回结果侧）。需要改 `src/engine/merge.js` 的返回契约，未做。

## 3.【已修复】`ENDPOINT_PLACEHOLDER` 曾用字符串拼接绕开打包自检

- **原现象**：`src/client/overlays.js:306` 曾写作 `const ENDPOINT_PLACEHOLDER = "https:" + "//api.example.com/v1/chat/completions";`，只为了绕开产物自检。
- **根因**：`scripts/build.mjs:274` 的产出自检是内联正则 `/[A-Za-z]:[\/]{1,2}[A-Za-z0-9_]/`（拦「盘符绝对路径泄漏进产物」）。`https://api` 里的 `s://a` 与 `C:/x` **同形**，直接写整串会被误判。
- **2026-10-26 修复**：自检正则收紧并抽成具名常量 —— `scripts/build.mjs:275` `const ABSOLUTE_PATH_PATTERN = /(?<![A-Za-z0-9_])[A-Za-z]:[\/]{1,2}[A-Za-z0-9_]/;`（前置断言排除协议名这类单词字符前缀），`:283` 用它做判定；`src/client/overlays.js:303` 恢复完整字面量；`scripts/verify.mjs:295-322` 新增**同源护栏**：从 build.mjs 源码抓同一份正则字面量、`new RegExp` 重建，再跑 mustCatch（`C:\Users\x`、`D:/work`、`"E:\a"`）与 mustMiss（`https://api.example.com/v1/chat/completions`、`https://x`），防止「改正则忘了同步护栏」的漂移。
- **回归证据**：build exit 0；verify 141→144 项全 PASS；单测 176/176；产物 `literal=1 / concat=0`；端到端临时注入 `C:\Users\test` 仍触发 `[build] FAILED 产物里出现盘符绝对路径`（exit 1，注入已回滚）。详见 `docs/techdebt-record-2026-10-26.md`。

## 4.【边界收紧】宿主对超过 20 条整体拒绝，且不保证表里有默认项

- **现象**：`normalizeHostModels`（`src/host/index.js:322-333`）在条数超限时记 `models must not exceed 20 entries (got N)` 并让整表 `ok:false`；`handleModels` 的 POST 随即返回 **400** `{"error":"模型表校验未通过","code":"invalid-models","problems":[...]}`（`:890`）。它**不截断**。
- 对照：客户端 `normalizeModelList`（`src/shared/config.js:277-280`）遇到超限是**截断**并记 error。两条路径口径不同。
- 宿主只做条目级归一化，**不保证**表里至少有一条 `isDefault`。
- **影响**：`engine` 为 `auto` 或 `llm` 但表里没有默认项时，由客户端回落（`src/client/settings.js:403-416` 给出「未选择默认模型，已回退本地引擎」），不是宿主报错。超 20 条的手写 POST 会被整份打回，客户端不会自动砍掉多余条目。
- **规避**：客户端已在上限处禁用「添加」按钮并提示，正常 UI 操作碰不到；直接调 API 时自己截断。
- **设计理由**：静默截断会**丢用户数据**且用户不知情；整体拒绝更安全。这是刻意选择，不是遗漏。

## 5.【边界收紧】客户端是模型表唯一真源，宿主 GET 的掩码密钥**不能**回写

- **现象**：`GET /api/prompt-optimizer/models` 返回 `models: table.map(publicModel)`，其中 `apiKey` 已被 `maskApiKey` 掩成 `sk-…ab12`（`src/host/index.js:526-531`）。
- **影响**：若拿 GET 结果回写 `localStorage`，会把**真密钥覆盖成掩码字符串**，且不可逆。因此客户端只读不回写（`fetchModelTable` 只做健康检查/展示）。连带后果：
  - **多浏览器 / 多设备不同步**——各自 `localStorage` 独立，换机器必须重新录入密钥。
  - 宿主 `models.json` 与客户端表可能不一致（宿主那份只服务转发）。
- **规避**：改配置只在**同一台机器的同一个浏览器**里做；迁移机器时重新录入密钥。
- **根治条件**：设计一个真正的密钥保管方案（宿主持有、客户端只留 id），涉及跨进程身份与权限模型，超出 v0.3。

## 6.【边界收紧】手写配置里 id 不是 uuid v4 的条目会被整条丢弃

- **现象**：`buildModel` 发现 `id` 不是 uuid v4 会重生成 id 并压一条 error（`src/shared/config.js:205-208`）；而 `normalizeModelList` 对 `errors.length > 0` 的条目直接 `continue`（`:282-287`）——**整条消失**，不是修好 id 后保留。
- **影响**：仅影响**手写** `localStorage` / 手写 patch config `models` 这条只读回落路径。客户端生成的条目永远是 uuid，正常 UI 操作碰不到。
- **规避**：手写时用真正的 uuid v4（`xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`）。
- **根治条件**：把「id 需修复」与「条目不合法」两类 error 分开，前者保留条目。需要改配置层已公开的归一化契约，未做。

## 7.【语义偏差】上游状态码只能靠文案解析

- **现象**：宿主机把上游任何非 2xx 包成 **502** + `{"error":"上游返回 <status>"}`（`src/host/index.js:838`），客户端 `upstreamStatusOf`（`src/client/settings.js:507-513`）用正则 `/上游返回\s*(\d{3})/` 把它抽回来做分类。
- **影响**：宿主文案一改，客户端的「401 密钥无效 / 404 路径不对 / 超时」分类同时失效（会退化成「上游返回异常」）。这是**跨进程靠字符串耦合**。
- **规避**：改 `src/host/index.js:838` 的文案时必须同步改 `src/client/settings.js:509` 的正则——`tests/host-route.test.mjs` 与 `tests/client-settings.test.mjs` 都钉了这条字面量。
- **根治条件**：让宿主回结构化 `{ code, upstreamStatus }`。会改公开响应形状，v0.3 冻结未做。

## 8.【未做】设计第 8 节明确排除的范围

- 流式输出（当前是一次性返回完整结果）。
- 批量优化（一次只处理输入框里的那段文本）。
- 提示词库 / 历史记录管理。
- 多用户 / 多设备同步。
- 非 OpenAI 兼容协议的适配层（只认 `POST <endpoint>` + `choices[0].message.content`）。

---

## 9.【状态】尚未人工验收的部分

自动化测试覆盖的是纯逻辑（配置归一化、归并规则、路由契约、状态机仿真）。以下**没有**自动化证据，只能在真实 DSH 窗口里手点：

- ✦ 按钮的实际位置与槽位冲突观感（尤其与语音输入插件的互斥）。
- 620px 设置面板、对比浮层在真实窗口/窄窗口下的排版与遮挡。
- 真实上游的 401 / 404 / 超时端到端链路（宿主 502/504 → 客户端分类文案）。
- 真实密钥下的完整闭环（添加 → 保存 → 测试连接 → 优化）。
- `light` / `standard` / `deep` 三档在**真实 LLM** 上的产出差异。
- `lenient` 档在真实 LLM 输出上的补回效果。

## 10.【状态】自动化校验覆盖不到的地方

当前三条闸门全绿：`scripts/verify.mjs` **144 项**静态校验、`scripts/simulate.mjs` **22 组**状态机仿真、`node --test` 六文件 **176 项**单测。但它们覆盖的只是**纯逻辑与产物形态**，不是运行时现实：

- 静态校验查的是字符串层面的事实（`scripts/verify.mjs` 的 144 项里，产物白名单、`slots.register(` 只出现一次、`@keyframes` 带前缀、产物只有一处 `fetch`、无 `XMLHttpRequest`/`WebSocket`），证明的是**代码形状**，不是**渲染结果**。
- 状态机仿真跑在脚本自建的假宿主上（`scripts/simulate.mjs` 里伪造的 `slots.register`/`hooks`），没有真实 DSH 的 React 树，也没有真实浏览器的布局、合成与焦点行为。
- 单测全部针对纯函数（配置归一化、归并规则、路由处理、列表操作），**没有一个字符经过真实 DOM**。

因此这三类永远拿不到自动化证据：**真实渲染与排版**（620px 面板、`position:fixed` 浮层跟手）、**真实槽位冲突**（✦ 与语音输入按钮抢位）、**真实上游网络链路**（401/404/超时、TLS、代理、证书）。要补上只能引入浏览器自动化（Playwright 类）与可回放的假上游，两者都会给这个「零运行时依赖、产物单文件」的插件增加依赖与构建复杂度，v0.3 未做。与第 9 条的分工：第 9 条列**没验什么**，本条说明**为什么自动化验不到**。

---

## 11.【语义偏差】`auto` 会在配好默认模型后自动产生真实上游调用

- **现象**：`engine` 默认是 `auto`；`resolveEngine`（`src/client/settings.js:403-416`）在表里存在默认模型时把它解析成 `llm`，此后每点一次 ✦ 都会经宿主真实调用上游。
- **影响**：装完插件、随手存过一条能用的模型却不打算用 LLM 的人，会一直在消耗对方的 token 与额度，界面上没有第二次确认。
- **规避**：需要完全本地行为就把设置面板「引擎」切到 `local`——它是显式档位，不会被 `resolveEngine` 改写。
- **根治条件**：给 `auto` 加「首次调用前确认」，但这会破坏「零配置即可用」的默认语义（默认档变成要交互一次），未做。

---

## 12.【语义偏差】软守恒只保证「词汇覆盖」，不保证语义等价

- **现象**：`coverageOf`（`src/engine/merge.js`）按原句 2–4 字实义片段命中率判丢失，阈值 `SOFT_COVERAGE_THRESHOLD = 0.6`。把「提高」改成「降低」、把「必须」改成「可以」时片段覆盖仍是 1.0，会被判成保真。
- **为什么会这样**：2–4 字片段是词汇级切片；判断语义极性需要模型而不是字符串比较，而守恒校验必须在客户端本地、零依赖、同步完成（`applyGuard` 就在写回前那一次调用里）。
- **已做的收窄**：数字、URL、@引用、行内代码走硬层零容忍；否定词按**极性词族**计次——`不要/不许/不得/禁止/严禁/切勿/请勿/不能/不可` 同族，`never/do not/don't/must not` 同族，族内总出现次数减少即判丢失；`能不能`/`可不可以`/`不得不` 这类复合词命中时前接字在排除表内，不计入否定。
- **2026-10-26 追加极性层（阈值未动）**：`verifyConservation` 在覆盖率通过后再跑 `polarityConflictOf`（`src/engine/merge.js:490`），沿 7 条极性轴（`SOFT_POLARITY_AXES`，`:414`：增减／许可／极值／频次／时序／增减-en／许可-en）判「原方向整体消失、且同轴反向词出现」，冲突则并入既有 `dropped` 并在 `details` 追加「有 N 处反义极性冲突：…」。`SOFT_COVERAGE_THRESHOLD` 仍为 **0.6**（`:327`），未下调。25 句三分类实测：反义类漏判 6→0（命中率 33%→100%），同义类误判 0→0、正常优化类 0→0，未扩大误判。用例见 `tests/merge.test.mjs:441-566`（6 个，含 15 组中英对立词与 9 组同向同义守卫）。
- **极性层仍有的边界**（刻意保守，不是 bug）：① 词表是白名单，表外反义词（「改善/恶化」「收紧/放宽」一类）仍只靠覆盖率层，可能漏判；② 只在「原方向整体消失」时判冲突——多处极性词、只翻转其中一处时原方向仍有命中，不报错；③ 中英混写时 ASCII 词在去空白的 `flat` 里丢词边界，故判定同时吃原文与 `flat` 取大值，紧贴其它字母的英文极性词仍可能漏计。
- **残余风险**：族内换词（「不要 A」→「请勿 B」）判为否定保住——极性确实保住，但 A→B 的内容替换只能靠上层提示词约束 + 人工对比（对比面板并列显示原文与结果）。
- **根治条件**：引入语义相似度模型或第二轮 LLM 复核；两者都要么加依赖要么加一次上游调用，违背「零运行时依赖」，未做。

---

## 13.【设计选择】一条 `### ` 段头都没有的结果不做结构兜底

- **现象**：`backfillSections`（`src/engine/merge.js`）首行先检查「结果里是否至少有一个 `### ` 段头」，一个都没有时原样返回，不补五段空壳。
- **理由**：那种结果不是「缺段头」而是「没按格式产出」（模型空返回、纯解释、报错文案）。凭空补五个 `- （无）` 会把用户输入框盖成空壳——实测空字符串会被补成 71 字符的五段骨架。
- **代价**：这类结果在 strict 下仍是原样展示 + `warning`，在 lenient 下仍走「其他」栏补句，不享受段头兜底。
- **若确需补齐**：去掉该 guard 即可，但要同时确认「空返回不写回」在上层已被挡住。
