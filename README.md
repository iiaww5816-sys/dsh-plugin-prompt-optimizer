# dsh-plugin-prompt-optimizer · 提示词优化（v0.4.1）

在 DSH 输入框工具行的 `conversation.input.activity` 槽位放一个四角星 **✦**：读当前草稿 → 结构化改写 → **写回同一个输入框**，并可一键还原原文；v0.2 起支持**多模型 API 管理**、设置面板与内容守恒校验；v0.3 起密钥可选、`endpoint` 允许带 query、引擎新增 `auto` 档并成为默认；v0.4 重写系统提示词，解决「连上 API 后优化质量仍然一般」；v0.4.1 软守恒新增反义极性层，同轴正反词被对调时判不保真。

> 与 `dsh-plugin-structured-prompt` 的区别：那个插件让你从空表单**新建**一条消息发出去；本插件改写**你已经在输入框里写下的这段话**，不改变你的发送动作。

## v0.4.1 变更（相对 v0.4.0）

本版只做技术债收口：不改系统提示词、不改界面与交互。

1. **反义极性层**：软守恒原先只看词汇覆盖率，阈值 `0.6` 时「提高」被换成「降低」仍判保真。现在按反义轴逐词配对，同轴正反词在原句与结果中方向相反即判不保真（`src/engine/merge.js` 的 `SOFT_POLARITY_AXES` 与 `polarityConflictOf`）。
2. **构建期端点自检误伤**：占位端点曾被要求拼接成 `"https:" + "//api.example.com/v1/chat/completions"` 以绕开 `scripts/build.mjs` 的盘符正则；现在正则只匹配非协议上下文，端点恢复直写常量（`src/client/overlays.js`）。
3. **发布准备**：补 `LICENSE`（MIT）、`CHANGELOG.md`、`.gitignore`，以及 `repository` / `homepage` / `bugs` / `author` 字段；校验基线更新为 144 项 / 22 组 / 176 项。

> 技术债细节见 `docs/techdebt-record-2026-10-26.md`；极性层仍有的边界见 `docs/known-limitations.md` 第 12 条。

## v0.4.0 变更（相对 v0.3.1）

本次只解决一件事：**连上 API 后优化质量仍然一般**。诊断结论是「把『忠于原意』实现成了『保留原字节』」——系统提示词通篇只有禁止项、没有一条正向质量要求；`standard` 档还自相矛盾（上句允许把模糊表述具体化，下句禁止新增原文没有的要求，而具体化必然是新增）；五个段头被当成「原文的容器」而不是「下游模型需要的信息」，`### 上下文` 的定义是「背景、材料与指代关系」，模型没有背景只能抄原句，于是产出「原文原句为『…』」这种零增益复述。

1. **三档强度加正向质量目标**：从「禁止清单」改成「补全额度 + 改写尺度」，每档都写明增益要求，`light` 档也给出「增益信息只能来自推断时就写成带『（待确认）』的标注行」这条出口（`src/host/index.js:90-107`）。
2. **四道输出前自检**：增益检查（至少含 1 条原文读者拿不到的信息：背景/验收标准/示例/边界条件）、空转检查（`### 上下文` 禁止出现「原文说的是…」「原文原句为…」，无背景就写「（待补充：本任务的背景是 __ ）」）、可执行检查（单独交给另一个模型不需追问即可开工）、完整性检查（五个段头全出现，无内容写 `- （无）`）。
3. **一对 few-shot 示例**：原文「帮我把这段代码改好点」→ 五段输出，示范把含糊动词拆成可验收交付物、不确定处写「（待确认）」而不假装知道、主动补工程默认约束。
4. **提问类 / 指令类分流**：含疑问词（怎么/如何/为什么/是否）且无祈使动词 → 提问类，任务段写「回答以下问题并给出可执行方案」、输出要求指定深度与结构；否则指令类，输出要求须含交付物形态与验收标准。
5. **守恒口径同步调整**（不改这里，前四项会立刻被自己的校验拦住）：旧口径按「原句子串匹配」判丢失，后果是**它在鼓励模型抄原文**——只要结果里出现「原文原句为…」就整句命中、不判丢失；而一旦允许重写表达，又会把每次正常改写真报成「内容未能保真」。现在改成两层：硬层（数字、URL、@引用、行内代码、按**极性词族**计次的否定词）零容忍，软层（2–4 字实义片段覆盖率）阈值 `0.6`；代码围栏仍整块字面零容忍（`src/engine/merge.js`）。
6. **结构兜底**：以前结果缺 `### 段头` 时 `strict` 模式原样返回残缺结果（实测四段结果照样交给用户），现在按 `SECTION_ORDER` 补齐并各写 `- （无）`，记进 `report.details` 与新增的 `report.backfilled`；而「一条段头都没有」的结果不做兜底（那是没按格式产出，补空壳反而盖住用户输入，见 known-limitations 13）。
7. **删掉 `deep` 档专属第六段** `### 其他（推断补充，请确认）`，改为五段内就地标注「（待确认）」——第六段与「五个段头必须全出现」并存会让模型两难。

真机证据（同一句口语输入「我绝得连上api后的提示词优化还是很一般，，要怎么改进」，`system = buildSystemPrompt(strength,'zh')`）：

| 模型 / 档位 | 输出字数 | 五段齐 | 是否复述原文 |
|---|---|---|---|
| deepseek-v4-pro / standard | 841 | 是 | 否 |
| deepseek-flash / standard | 1134 | 是 | 否 |
| deepseek-v4-pro / light | 620 | 是 | 否 |
| deepseek-v4-pro / deep | 1023 | 是 | 否 |

`### 上下文` 的典型产出从「原文原句为『…』」变成「- 当前已知：…」+ 四条「（待补充：模型/API 名称与版本…）」。四份真实输出回灌新的守恒校验：`dropped` 与 `lostTokens` 全为空、`applied=false`——即校验对正常改写零误报。

## v0.3.1 修复（相对 v0.3.0）

1. **「+ 添加模型」点了完全没反应**：`src/client/button.js` 的 `startAdd()` 里残留旧函数名 `setPanelNotice("")`，该标识符全仓从未声明也从未导入，点击时抛 `ReferenceError` 被 React 事件处理器吞掉 → `setForm` 永不执行、表单不出现、界面毫无反馈。已改回 `patchModelState({ notice: "" })`（与 `startEdit` 一致）。
2. **引擎切到 `auto` 后控件跳回 `local`**：`resolveEngine` 把 `auto` 当场折成 `local`/`llm` 写回 settings，三档控件的选中态于是弹回原处，看起来又是一次「点了没反应」，还会把宿主 `models.json` 写成 `engine: "local"`。现在 `auto` 原样留存，另出 `effective` 字段供调度判断（`auto` 有默认模型即走 `llm`，没有即 `local`）。
3. **新增一条静态自检**：`scripts/verify.mjs` 第 11 段逐个文件核对「每个 `setXxx(` 调用都有声明或导入」，第 1 类事故（未定义 setter 静默吞掉点击）从此在提交前就会被拦下（校验项 140 → 141）。

## v0.3 变更（相对 v0.2）

1. **API 密钥改为可选**：`apiKey` 允许空串，只卡 512 字符上限；空密钥条目照常保存、照常参与去重，转发时**不发** `Authorization` 头——无 Key 的本地 Ollama / LM Studio / 内网反代因此可用。
2. **`endpoint` 允许带 query**：仍拒绝 fragment、仍拒绝用户名/密码、仍要求 http/https 绝对 URL；Azure OpenAI 的 `?api-version=` 现在写得进去。
3. **引擎新增第三档 `auto` 并成为默认**：配好默认模型就真调 API（走 `llm`），没配就走本地规则引擎；显式选 `llm` 但无默认模型仍回退 local，并提示「未选择默认模型，已回退本地引擎」。
4. **表单校验失败不再静默**：保存按钮始终可点，校验不通过时按钮上方出现汇总块（`role="alert"`，「还差 N 项，请检查以下字段」+ 逐行「中文名：原因」），点保存时小条也给出同一句摘要。

---

## 1. 这是什么

| 能力 | 说明 | 证据 |
|---|---|---|
| ✦ 入口按钮 | 注册在 `conversation.input.activity` **single 槽**（`src/client/index.js:27-31`）；浮层由组件自己 `position:fixed` 渲染，不额外占槽 | `tests/client-settings.test.mjs`；界面观感**待人工验收** |
| 本地确定性引擎 | 纯函数、无网络、无 `Date`/`random`（`src/engine/optimize.js` + `prompts.js`） | `tests/engine.test.mjs`（19 项） |
| LLM 引擎 | 浏览器只向同源 `/api/prompt-optimizer/optimize` 发 POST，宿主加 `Authorization` 后转发；密钥不进浏览器请求 | `tests/host-route.test.mjs`（43 项） |
| 多模型表 | 本地 `localStorage` 存 `models[]`，最多 20 条；宿主另有 `models.json` 副本供转发使用 | `tests/config.test.mjs`（40 项） |
| 设置面板 | 620px 上限、两段式（模型列表 + 四组行为设置）、五个动作 | `tests/client-settings.test.mjs`（31 项）；**真实窗口排版待人工验收** |
| 守恒校验 | `strict` / `lenient` 两档，`applyGuard` 永不抛错；硬层零容忍 + 软层覆盖率 0.6 + 段头兜底 | `tests/merge.test.mjs`（25 项）+ `tests/merge-wire.test.mjs`（12 项） |

当前构建产物（连跑两次 `build`，字节与哈希一致）：

- `lib/client.js` — 207561 bytes，`sha256=0d4728ac8518c7a531432af642c7a070ce770d09e907da97d6ef2487a5187715`
- `lib/index.js` — 49479 bytes，`sha256=3e08db125d69b18dd00bb11d1f484781d53973a3415ae2e40d42a824d24a2e31`

---

## 2. 安装

DSH 没把 `dsh` 注册进 PATH，`node.exe` 也读不了 `app.asar`，唯一入口是 `resources\runtime\cli\bin\dsh.cmd`（一个 `ELECTRON_RUN_AS_NODE` shim）。

### 2.1 必须先完全退出 DSH

**关窗口只是隐藏，进程还在。** 托盘右键 → 退出，然后确认进程数为 0：

```powershell
Get-Process "DeepSeek Harness" -ErrorAction SilentlyContinue | Measure-Object | % Count   # 期望 0
```

装完**必须完全重启 DSH**（不是刷新、不是重开窗口）：客户端模块图在**启动时**由 profile 的 `dsh.profile.bundles` 一次性建立，浏览器侧的热重载/刷新看不到新插件。宿主半边同理，Loader 只在启动时解析装载行。

### 2.2 一条命令装

```powershell
& 'C:\Users\23897\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop add "link:<本目录绝对路径>"
```

Windows PowerShell 里一行写完（续行反引号易错）：

```powershell
& 'C:\Users\23897\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add "link:D:/DeppSeekWork/deepseek-work1/dsh-plugin-prompt-optimizer"
```

`add` 的两种失败输出必须认得：

- `declares no dsh.bundle — installed as a plain dependency, not a profile layer` → 装载行没登记，装了等于没装。
- `installation rejected: ...` → patch 校验失败，已自动回滚 `package.json` / lock / `node_modules`。

**外部用户从 GitHub 装**（`dsh plugin add` 透传给 `pnpm add`，其 `--help` 列出 `<git host>:<git user>/<repo name>` 与 `<git repo url>` 两类来源）：

```powershell
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add "github:iiaww5816-sys/dsh-plugin-prompt-optimizer"
```

`lib/` 已随仓库提交，从 git 安装不需要本地构建；装完同样必须完全重启。

### 2.3 或者用脚本（推荐，带预检与备份）

`D:\DeppSeekWork\deepseek-work1\install-prompt-optimizer.ps1`，参数表（`install-prompt-optimizer.ps1:29-33`）：

| 参数 | 类型 | 作用 |
|---|---|---|
| `-Force` | switch | 允许 `Stop-Process` 强杀 DSH（可能丢未保存内容，默认关闭） |
| `-DryRun` | switch，别名 `-WhatIf` | 只做预检与备份，不执行安装 |
| `-NoLaunch` | switch | 装成功后不自动启动 DSH |

```powershell
D:\DeppSeekWork\deepseek-work1\install-prompt-optimizer.ps1 -DryRun    # 先看预检
D:\DeppSeekWork\deepseek-work1\install-prompt-optimizer.ps1            # 正式安装 + 启动
```

脚本内部实际执行的就是 `dsh.cmd plugin --profile desktop add "$LinkSpec"`（`install-prompt-optimizer.ps1:151`），并在装前把 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml`、`cordis.yml` 备份到 `D:\DeppSeekWork\deepseek-work1\_backup-profile-desktop-<时间戳>\`。

### 2.4 文件级验收（DSH 仍关闭时做）

```powershell
$p = 'C:\Users\23897\.dsh\profiles\desktop'
(Select-String -Path "$p\package.json" -Pattern 'prompt-optimizer' | Measure-Object).Count   # 期望 2（dependencies + bundles，均为裸名）
(Get-Item "$p\node_modules\dsh-plugin-prompt-optimizer").LinkType                          # 期望 SymbolicLink（pnpm 常态）或 Junction
```

两种 `LinkType` 都算装好，不要因为不是 `Junction` 就去排查：pnpm 装 `link:` 依赖建的是 **`SymbolicLink`**（本机实测如此），`Junction` 是旧式 pnpm/npm 的行为；`install-prompt-optimizer.ps1:175` 的验收本身也是按 `-notin @('Junction', 'SymbolicLink')` 宽判的，报出别的值才是真的没装上。第 80 行那个 `Select-String ... | Measure-Object` 是**按行**计数（`dependencies` 一行 + `bundles` 一行 = 2），不是按出现次数（按次数会是 3，因为那一行里的 `link:` 路径也含包名）。

---

## 3. 卸载

```powershell
# DSH 完全退出后
& 'C:\Users\23897\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-plugin-prompt-optimizer
```

或 `D:\DeppSeekWork\deepseek-work1\uninstall-prompt-optimizer.ps1`，参数与安装脚本一致：`-Force` / `-DryRun`（别名 `-WhatIf`）/ `-NoLaunch`（`uninstall-prompt-optimizer.ps1:22-26`）。

`remove` 会自动把 `dsh.profile.bundles` 里对应项剔除（按「依赖是否还在」过滤），不用手改 `package.json`。彻底崩了：拷回最近一次 `_backup-profile-desktop-*\` 里的文件后跑 `plugin --profile desktop install`。

注意：卸载不会清 `localStorage` 里的模型表，也不会删 `<DSH_HOME>\prompt-optimizer\models.json`——密钥还在盘上，需要的话自己删。

---

## 4. 快速开始

1. 装完重启 DSH，打开任意会话。
2. 输入框工具行、**模型选择器与发送按钮之间**出现 ✦。
3. 在输入框写一句话（例如「帮我把这个登录接口的错误处理补一下」）→ 点 ✦ → 立刻进入加载态 → 结果写回输入框 → 按钮变「还原原文」，旁边浮出小条「已优化 · 查看对比 · 还原原文」。
4. 点小条「查看对比」看左右分栏原文/优化后（Esc 关闭）；点「还原原文」逐字变回你原来那句话。
5. 默认**零配置即可用**：引擎默认 `auto`，没配默认模型时走本地确定性引擎，不联网。

按钮状态（`src/client/button.js` 头部注释与模拟断言）：

| 状态 | 按钮 | 点击后 |
|---|---|---|
| idle，草稿为空/纯空白 | ✦ 禁用 | 无动作 |
| idle，有草稿 | ✦ 优化提示词 | 加载态 → 写回结果 → 变「还原原文」 |
| loading | 转圈、禁用 | 零副作用（重复点击被令牌拦截，不叠加） |
| done | 还原原文 | 写回原文快照 → 回 idle |
| error | 恢复可点 | 明示失败原因，**草稿一字不动** |

---

## 5. 多模型配置

点 ✦ 旁的小齿轮打开设置面板（宽度 `min(620px, 100vw - 24px)`，最大高 `min(52vh, 440px)`，见 `src/client/style.js:25`）。面板两段式：**上段模型 API 列表**，**下段四组行为设置**。

### 5.1 模型条目：10 个字段

| 字段 | 类型 / 边界 | 说明 |
|---|---|---|
| `id` | uuid v4，客户端生成 | 非法即被重新生成并记一条 error（该条目会被丢弃，见 known-limitations） |
| `name` | 1–40 字符 | 留空自动取 `model` |
| `endpoint` | 绝对 http(s) URL | **必须完整到 `/chat/completions`，不自动补**；不许带用户名/密码、fragment；**query 允许**（Azure OpenAI 的 `?api-version=` 就写在这里） |
| `apiKey` | 0–512 字符，**可留空** | 空密钥合法（本地 Ollama / LM Studio 不需要密钥）；**明文存 localStorage**（见第 8 节） |
| `model` | 1–120 字符 | 传给上游的模型名 |
| `temperature` | 0–2，默认 0.2 | 越界按边界截断 |
| `timeoutMs` | 5000–120000，默认 30000 | 越界按边界截断 |
| `isDefault` | 布尔 | 全表**至多一条**为 true |
| `createdAt` | 毫秒数字 | 客户端生成 |
| `updatedAt` | 毫秒数字 | 每次编辑刷新 |

上限 **20 条**（`MODEL_LIMIT`，`src/shared/config.js:20`）。达到上限时「+ 添加模型」置灰并提示「最多 20 个模型」。

表单校验失败**不再静默**：保存按钮始终可点；校验不通过时按钮上方出现汇总块（`.dsh-po-formsummary`，`role="alert"`，首行「还差 N 项，请检查以下字段」，其后每行「中文名：原因」，字段中文名见 `src/client/settings.js:24-31`），点保存时小条也给出同一句摘要。

### 5.2 五个动作

1. **添加** —— `+ 添加模型`；表为空时新条目自动设为默认。
2. **编辑** —— 行内 `编辑`；密钥框**不回填**，留空即沿用原值。
3. **删除** —— 行内 `删除`；删掉默认项时默认自动迁移到首条，删空则引擎回落本地并提示。
4. **切换默认** —— 点行首 ○/● 标记；命中项置 true，其余一律 false。
5. **测试连接** —— 行内 `测试`；走**真实的优化通路**发一条 `text:'ping'`（`src/client/llm.js:250-253`），只判通不通，60 秒超时且可再点取消。

失败分类文案（`src/client/settings.js:521-535`）：`超时` / `地址不可达` / `401 密钥无效`（403 同）/ `404 路径不对` / `408|504 超时` / `宿主未登记该模型，请先保存后再测`（501）。

### 5.3 四组行为设置

| 键 | 取值 | 默认 | 作用 |
|---|---|---|---|
| `strength` | `light` / `standard` / `deep` | `standard` | 进入宿主 `buildSystemPrompt(strength, locale)`（`src/host/index.js:133`）；light 只去口语填充，standard 结构化为五段，deep 可补推断但必须写进「### 其他（推断补充，请确认）」 |
| `locale` | `zh` / `en` | `zh` | 同上；段头固定中文「### 角色 / 任务 / 上下文 / 输出要求 / 约束」，因为本地归并引擎按中文段头识别 |
| `engine` | `local` / `llm` | `local` | 默认必须是能真正跑通的那条（不联网） |
| `mergeMode` | `strict` / `lenient` | `strict` | 守恒校验档位，见第 7 节 |

存 `localStorage["dsh-plugin-prompt-optimizer/models"]`，形状 `{ schemaVersion: 2, models, settings }`。

### 5.4 装载行 config（可选，另一条路）

写在 `cordis.patch.yml` 该条目的 `config:` 下（**与 `id` / `name` 平级**；写到 bundle 层或条目外层会被 loader 原样保留，不报错也不生效）：

```yaml
- insert:
  - id: dsh-plugin-prompt-optimizer
    name: dsh-plugin-prompt-optimizer
    config:
      llmEndpoint: https://api.example.com/v1/chat/completions   # 可选
      llmApiKey: sk-…ab12                                        # 可选（示例占位，不要照抄）
      llmModel: gpt-4o-mini                                      # 可选
      llmTemperature: 0.2                                        # 可选 0..2
      llmTimeoutMs: 30000                                        # 可选 5000..120000
```

也可写 `models:`（数组）与 `settings:`（四键），宿主会做整份校验。**未知字段直接拒绝装载**（`unsupported config field(s): ...`）。`llmEndpoint` 缺省**不阻断装载**——这是刻意的，装完就该有按钮；缺地址只在请求进来时降级成 501。

---

## 6. 引擎说明

| 引擎 | 通路 | 失败行为 |
|---|---|---|
| `auto`（默认） | 有默认模型时同 `llm` 走宿主转发；没有就是纯本地 | 与 `llm` 相同：回退本地并在小条标注原因 |
| `local` | 纯本地函数（`src/engine/optimize.js`），不联网 | 除空输入/超长外基本不会失败 |
| `llm` | 同源 POST `/api/prompt-optimizer/optimize`，宿主按 `providerId` 查自己的模型表并转发 | **一律自动回退本地引擎**，并在小条标注「LLM 不可用，已回退本地：<原因>」 |

回退文案取自 `src/client/llm.js:27-36`：`未配置 LLM 地址`（501）/ `服务超时，请重试`（504 或 `TimeoutError`）/ `请求无效，请重试`（400）/ `无法连接优化服务，请检查网络` / `服务返回异常`。

只有本地也失败时（空输入、超 20000 字符）才进错误态——**草稿仍然不动**。

---

## 7. 守恒校验与 mergeMode

`applyGuard(originalText, resultText, mode)`（`src/client/engine.js:132-169`）在**写回前**做内容守恒兜底，返回 `{ text, mode, applied, degraded, error, report, level, notice }`：

| 档位 | 检出丢句/丢关键项时 | 用户看到 |
|---|---|---|
| `strict`（默认） | **不改写文本**，只给非阻塞警示 | 小条 `校验未通过 · 丢失 N 句 / 缺少 M 个关键项，已保留原样结果` |
| `lenient` | 把丢失句子补进「### 其他」栏 | 小条 `已补回 N 句到「其他」栏` |

任何异常（merge 引擎未装载、内部抛错）都降级为「不校验、原样展示」，`degraded:true` 记在返回值里，**永不抛错**——兜底自身不能成为新的失败点。校验只对「首次成功结果」执行一次（写回点在 `writeResult` 唯一处），重复点击与撤回被令牌挡住，所以补回不会叠加。

---

## 8. 安全与隐私

**密钥在盘上是明文，这是当前实现的真实状态，不是疏忽。**

- 浏览器侧：`localStorage["dsh-plugin-prompt-optimizer/models"]` 里 `apiKey` 明文；同源脚本可读。**界面只露末 4 位**（`maskApiKey`：`sk-…ab12`；长度 ≤ 8 整体显示 `…`）。
- 宿主侧：`<DSH_HOME>\prompt-optimizer\models.json` 里同样明文（`src/host/index.js:82-84`），写入走「临时文件 → fsync → rename」保证不出现半截文件。
- 浏览器请求里**没有密钥**：客户端只发 `{ text, strength, locale, providerId }`，`Authorization` 由宿主侧加上。

**SSRF 边界（核心约束）**

优化路由的上游地址只来自**宿主自己持有的两处**：宿主模型表（按 `providerId` 查）或装载行 config 的 `llmEndpoint`（`src/host/index.js:771-798`）。请求体里若塞了 `endpoint` / `apiKey` / `model`，**一律不采信**，并在响应里回 `ignoredFields: ["endpoint","apiKey","model"]` 便于排查（`src/host/index.js:597-599, 851-853`）。查不到就退 `config.llmEndpoint`，两者都缺才 501。因此浏览器侧不可能把请求指向任意地址。

**错误信息不回传上游内容**：所有失败响应体都是固定字面量，唯一插值是上游状态码数字（`上游返回 401`），从不回传上游 body。上游 `redirect: "error"`、超时走 `AbortSignal.timeout(upstream.timeoutMs)`。

**输入不用于其它用途**：原文只用于本次优化转发，宿主不落盘原文、不记日志正文、不做统计。

---

## 9. 旧配置迁移

v0.1 的键 `dsh-plugin-prompt-optimizer/config`（`{strength, locale, engine}` + 可能存在的 `llmEndpoint` 等）**只读保留**，不会被删除或改写。

- 新键为空、旧键存在时，`loadModels` 自动把旧内容迁移进 `settings`，并把 `llmEndpoint/llmApiKey/llmModel/llmTemperature/llmTimeoutMs` 收成一条 `isDefault` 的模型条目（`src/shared/config.js:382-395, 436-465`）。
- 迁移后设置面板会显示提示条，让你确认是否导入；已达 20 条上限时提示「请先删除一条」。
- `localStorage` 内容损坏时**不静默丢弃**：原样挪到 `.../models.corrupt` 后按空表启动（`src/shared/config.js:329-336`）。

---

## 10. 兼容性与已知限制

- DSH：桌面版 desktop profile，客户端槽位 `conversation.input.activity`（**single 槽**）。
- 与 `dsh-experimental-voice-input-bundle` **互斥**——两者抢同一个槽，后注册者被丢弃。关掉语音输入再试。
- 上游协议只支持 **OpenAI 兼容**的 `POST <endpoint>` + `choices[0].message.content`；其它协议需要适配层（未做）。
- 模型表以 `localStorage` 为唯一真源，宿主 GET 返回的是**掩码**密钥，因此**多浏览器/多设备之间不同步**，换机器要重新录入密钥。

完整的已知不完美清单、影响与规避见 [`docs/known-limitations.md`](docs/known-limitations.md)。

---

## 11. 故障排查

### 11.1 按钮不出现

| 症状 | 原因 | 查什么 |
|---|---|---|
| 设置→插件能看到，输入框没按钮，Console 干净 | client 半边没进启动图（装载行带子路径会被 `exactPackageSpecifier` 静默跳过） | profile `package.json` 的 `dsh.profile.bundles` 必须是**裸名** `dsh-plugin-prompt-optimizer` |
| Console: `client bundle not found` / `declares dsh.client but exports no …` | 产物格式不对或缺 `exports["./client"]` | `lib/client.js` 首行必须是 `window.__ModuleLoader__.load({ id: "dsh-plugin-prompt-optimizer", …` |
| 按钮消失 / 语音输入按钮消失 | `conversation.input.activity` 是 **single** 槽，被别的插件占了 | 关掉语音输入或另一个抢槽插件，重启 DSH |
| 有红色 React 栈 | 组件渲染抛错被错误边界隔离 | DevTools 栈里看 `PromptOptimizerButton` |
| 启动失败 | host 半边 Loader 报错 | `C:\Users\23897\.dsh\logs\startup-*.log` 出现 `dsh: startup failed: N required plugins did not activate` |

### 11.2 模型接口 501

状态 501 + `{"error":"llm endpoint not configured"}` = 宿主**当前没有任何可用上游**：既没在设置面板保存过模型（`models.json` 为空），装载行也没写 `llmEndpoint`。此时插件不报错，自动走本地引擎，小条明说「未配置 LLM 地址」。

处置：设置面板加一条模型并保存（会同时 POST 到宿主落盘），或改用默认的本地引擎。

### 11.3 上游 401 / 404 / 超时怎么判定

宿主把上游非 2xx 一律包成 **502** + `{"error":"上游返回 <状态码>"}`，客户端再从文案里抽状态码分类（`src/client/settings.js:507-513`）。所以看「测试连接」的行内文案即可：

| 文案 | 含义 | 下一步 |
|---|---|---|
| `401 密钥无效` / `403 密钥无效` | 密钥错、过期或权限不足 | 编辑该模型，重填密钥（密钥框留空 = 沿用原值，别留空） |
| `404 路径不对` | `endpoint` 少写/多写了 `/v1` 或 `/chat/completions` | endpoint 必须完整到 `/chat/completions`，插件**不会**替你补 |
| `超时` | 宿主侧 `AbortSignal.timeout(timeoutMs)`（504）或客户端取消 | 调大该条目的 `timeoutMs`（上限 120000）或换网络 |
| `地址不可达` | 网络/DNS/代理层失败（宿主 502 `无法连接上游`） | 先 `curl` 同一地址确认可达 |
| `宿主未登记该模型，请先保存后再测` | 501：该 `providerId` 在宿主表里查不到 | 先「保存」，再测 |

### 11.4 其它状态码

| 状态 | 文案 | 含义 |
|---|---|---|
| 400 | `请求体不是合法的 JSON 对象`（模型路由另带 `code:"invalid-json"`） | 手写请求或客户端 bug：请求体不是 JSON 对象 |
| 400 | `models 必须是数组`（`code:"invalid-models"`） | POST 模型表时 `models` 缺失或不是数组 |
| 400 | `模型表校验未通过` + `problems` | 保存的表不合法（常见：超过 20 条、endpoint 不合法、缺 model（密钥已不再必填）） |
| 400 | `设置校验未通过` + `problems` | `settings` 四键取值越界 |
| 400 | `text 必须是字符串` / `text 不能为空` / `text 超过 20000 字符上限` | 优化请求体里的原文不合法 |
| 405 | 空响应体 + `allow` 头 | 方法不对：优化路由只收 POST，模型路由只收 GET/POST |
| 500 | `模型表写入失败` | 落盘失败（权限/磁盘），宿主不把路径拼进响应 |

---

## 12. 开发

```powershell
$node = 'C:\Users\23897\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd 'D:\DeppSeekWork\deepseek-work1\dsh-plugin-prompt-optimizer'
& $node scripts/build.mjs            # src/** → lib/{client,index}.js（客户端单文件内联，只 require("react")）
& $node --check lib/client.js
& $node scripts/verify.mjs           # 141 项静态契约校验（产物形态/白名单/安全断言）
& $node scripts/simulate.mjs         # 22 组状态机仿真断言
& $node --test tests\config.test.mjs tests\merge.test.mjs tests\engine.test.mjs tests\host-route.test.mjs tests\client-settings.test.mjs tests\merge-wire.test.mjs
```

三条闸门当前全部通过（exit 0）：

- `node scripts/verify.mjs` — **141 项**静态契约校验（产物里有什么、不许有什么）。
- `node scripts/simulate.mjs` — **22 组**状态机仿真断言（交互序列下不崩、状态可读）。
- `node --test` 六个文件合计 **170/170 通过**（40 + 25 + 19 + 43 + 31 + 12）。
- `node scripts/build.mjs` **幂等**：连跑两次字节与 sha256 一致（数值见第 1 节）。

三条各自守备的范围不同，**任何一条红了都不能发布**：静态校验守「产物形状」（白名单、单槽注册、`@keyframes` 前缀、产物里只有一处 `fetch`、无 `XMLHttpRequest`/`WebSocket`）；仿真守「状态机」（设置面板四键持久化、LLM 失败回退本地、守恒校验四形态 strict/lenient/未装载/抛错 + 幂等）；单测守「纯函数行为」。三者都不覆盖真实浏览器渲染与真实上游链路——那部分只能人工验收，见第 13 节。

改完 `src/` **必须重新 `build`**——跑的是 `lib/`，源码改了不构建等于没改。

```
src/engine/{optimize,prompts,merge}.js   本地优化引擎 + 归并引擎（纯函数、确定性、无 Date/random/网络）
src/host/index.js                        宿主：两条 /api 路由、Config 校验、上游转发、models.json 原子写（零 import）
src/client/{index,button,overlays,settings,dom,style,llm,engine}.js  客户端（禁 JSX，手写 createElement）
src/shared/config.js                     默认配置 + 归一化 + 迁移（host 与 client 共用）
lib/{client,index}.js                    构建产物
docs/design-v0.2.md                      设计方案（第 9 节为 as-built 差异记录）
docs/known-limitations.md                已知不完美清单
cordis.patch.yml                         恰一条 insert，id/name 均为裸包名
```

---

## 13. 待人工验收清单

以下能力**没有自动化证据**，必须在真实 DSH 窗口里手点确认（这是本文档唯一不允许被当作「已验证」的部分）：

1. ✦ 是否真的落在模型选择器与发送按钮**之间**，是否与语音输入按钮冲突。
2. 620px 设置面板在真实窗口（含窄窗口 < 620px）下的排版：两段式、滚动、浮层遮挡。
3. 设置面板与对比浮层的 `position:fixed` 定位在窗口缩放 / 滚动时是否跟手。
4. 真实上游的 **401 / 404 / 超时** 端到端链路：宿主 502/504 → 客户端分类文案是否如表中所示。
5. 真实密钥下添加模型 → 保存 → 测试连接 → 优化的一次完整闭环。
6. `light` / `standard` / `deep` 三档在**真实 LLM**上产出的差异是否可肉眼区分（本地引擎的差异有单测）。
7. `lenient` 档在真实 LLM 输出（而非构造用例）上补回的效果与可读性。
8. 重启 DSH 后模型表与四组设置是否仍在（`localStorage` 持久化）。
9. 卸载后按钮消失、插件清单不再出现。
