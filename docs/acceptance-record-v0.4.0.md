# dsh-plugin-prompt-optimizer v0.4.0 验收记录

记录时间：2026-10-25 23:2x（本地时区）
仓库：D:\DeppSeekWork\deepseek-work1\dsh-plugin-prompt-optimizer
运行实例：DSH 桌面版，desktop profile，宿主 PID 4092（启动 2026-10-25 23:02:40，监听 127.0.0.1:8861）
node：C:\Users\23897\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe（本机 PATH 无 node）

> **本文是 v0.4.0 当次验收的历史快照，数字不回改。** 2026-10-26 又修了两条技术债（构建自检正则、软守恒反义层），闸门随之变为 verify 144 项 / 单测 176 项 / 产物 212870 bytes —— 见 `docs/techdebt-record-2026-10-26.md`；下文 §1、§3 表格里的 141 项 / 170 项 / 207561 bytes 是修复前的基线。

## 1. 结论摘要

| 验收项 | 结果 | 证据类型 |
| --- | --- | --- |
| 版本自证（磁盘产物 == 运行实例） | PASS | sha256 + 进程启动时间线（见 §2） |
| 构建闸门 scripts/build.mjs | PASS（12 模块内联，require 白名单仅 react，逃生口 0） | 命令输出（见 §3） |
| 静态闸门 scripts/verify.mjs | PASS（141 项） | 命令输出 |
| 状态机仿真 scripts/simulate.mjs | PASS（22 组；setDraft 序列 原文→优化后→还原 共 3 次） | 命令输出 |
| 单元测试 tests（6 文件） | PASS（170 / 170） | 命令输出 |
| A 组渲染验收（✦ 位置、三态、⚙ 相邻、620 面板） | 目视通过 | **用户目视确认**，非自动化断言 |
| 真实上游调用（三档差异、守恒回灌、错误分类） | 用户实测通过 | **用户实测**，口头反馈「没什么问题」，非程序化断言（见 §5） |

## 2. 版本自证

产物（scripts/build.mjs 生成，重启前已落盘）：

| 文件 | 字节 | sha256 | mtime |
| --- | --- | --- | --- |
| lib/client.js | 207561 | 0d4728ac8518c7a531432af642c7a070ce770d09e907da97d6ef2487a5187715 | 2026-10-25 23:20:39 |
| lib/index.js | 49479 | 3e08db125d69b18dd00bb11d1f484781d53973a3415ae2e40d42a824d24a2e31 | 2026-10-25 23:20:39 |

判定方法：mtime 会被重复构建污染（23:20:39 即最后一次 build 造成），因此**不以 mtime 作更新判据**；判据是「产物 sha256 在一次重启前后逐字节不变」+「宿主进程创建时间晚于该内容首次落盘（22:52:16 版与 23:20:39 版 sha256 完全相同）」。结论：PID 4092 加载的运行时内容与当前磁盘产物一致，v0.4.0 已生效。

版本号四处一致：package.json:3 `"version": "0.4.0"`、README.md:1、docs/known-limitations.md:1、docs/acceptance-checklist.md:1。另注：全仓唯一与技术版本相关的是 src/shared/config.js:23 的 `SCHEMA_VERSION = 2`（配置 schema 握手版本，非插件版本），0.4.0 字符串从不进入 lib/ 或运行时代码，故界面上不显示插件版本号属预期，不是忘改。

## 3. 闸门复跑命令与结果

工作目录 `D:\DeppSeekWork\deepseek-work1\dsh-plugin-prompt-optimizer`：

```
& $node scripts\build.mjs      # PASS，12 个模块内联（引擎 3 个），产物 207561 bytes
& $node scripts\verify.mjs     # PASS，141 项静态校验全部通过
& $node scripts\simulate.mjs   # PASS，22 组状态机断言
$files = Get-ChildItem tests -Filter *.test.mjs   # 6 个测试文件
& $node --test @($files.FullName)                 # tests 170 / pass 170 / fail 0
```

坑位记录：`node --test tests`（传目录）会以 `test at tests:1:1 ✖ tests` 失败，必须显式传入 6 个 *.test.mjs 路径；统计行前缀是 `ℹ`（U+2139），用 `^# (tests|pass|fail)` 正则抓不到。

## 4. A 组渲染验收（目视）

被测形态（源码事实）：

- 槽位输出为单个 `span.dsh-po-wrap`（`data-dsh-po-root`），内部依次是 [主按钮, ⚙ 齿轮, 浮层]（src/client/button.js:829-866）。
- 主按钮 `button.dsh-po-button`（`data-dsh-po-trigger`、`data-dsh-po-phase`），文案 idle = 「优化提示词」、busy = 「优化中…」、done = 「还原原文」（src/client/button.js:762）。
- 字形：busy 时换成 `span.dsh-po-spin` 旋转点；否则 `span.dsh-po-glyph`，done 时「↺」、其余「✦」（src/client/button.js:847-849）。
- 齿轮 `button.dsh-po-gear`（`data-dsh-po-gear`），`aria-label`「提示词优化设置」、title「优化设置」、内容字符「⚙」（src/client/button.js:853-864）。
- 齿轮面板 `PANEL_WIDTH = 620`（src/client/button.js:57），定位夹取与 CSS 兜底同源。
- 成功小条：「已优化 · 查看对比 · 还原原文」（src/client/overlays.js:128）。

用户目视结论：**都没问题**（对话原话）。

证据级别说明：本项为**用户目视确认**。自动化路径全部被挡住——桌面宿主 PID 4092 未开 `--remote-debugging-port`，renderer 挂不上 CDP；Web GUI `http://127.0.0.1:8861` 的根路径与 `/api/prompt-optimizer/models` 均返回 401（需 `dsh web` 打印的一次性 token URL，ego-browser 独立 profile 无该 cookie）；改用 Windows 截屏取证（_verify/shot-idle.png，1295x829）后视觉模型对底部工具行判定不可靠（把左侧会话列表误判为搜索框、并断言「没有星形按钮、没有齿轮按钮」，vision_detect 返回 elements: []），故不作自动化断言。

## 5. 真实上游调用（用户实测）

接口 `POST /api/prompt-optimizer/optimize` 与 `GET|POST /api/prompt-optimizer/models` 被 401 拦截（需 `dsh web` 一次性 token URL），无法程序化调用。按用户选择改由界面内实测。

用户实测结论：**没什么问题**（对话原话）。证据级别：口头实测确认，未留下逐条勾选记录；下列清单即该结论的推定覆盖范围，其中未单独点名的条目（尤其是第 5 条失败路径的错误分类）仍属未验证。

给出的观察清单：

1. 输入框留空 → ✦ 主按钮应为禁用态。
2. 输入一段含数字/URL/@引用/否定词的草稿 → 点 ✦ → 文案变「优化中…」，成功后变「↺ 还原原文」，浮出小条；输入框内容被回填为五段头齐全的结构化提示词（角色／任务／上下文／输出要求／约束）。
3. 守恒抽查：上述数字、URL、@引用、字段名、代码块、否定词是否原样保留（硬 Token 零容忍层）。
4. 齿轮 → 设置面板（宽 620px）切换质量档位（浅／中／深）→ 对同一草稿再点一次 ✦ → 对比两份输出的详略差异是否与档位相符。
5. 失败路径：把模型配置改成错误密钥或断网 → 点 ✦ → 检查输入框原文未被覆盖、错误以分类文案呈现（上游 401 / 404 / 超时）。

## 6. 已知限制

见 docs/known-limitations.md（13 条）。与本记录相关的两条：#3 `ENDPOINT_PLACEHOLDER` 由 `"https:" + "//api.example.com/v1/chat/completions"` 拼成，是为绕开 build 自检正则 `/[A-Za-z]:[\/]{1,2}[A-Za-z0-9_]/`，改这一行会构建失败；#12 软守恒只保词汇覆盖不保语义等价（阈值 SECT 0.6 时「提高」→「降低」仍判保真）。

> **2026-10-26 更新**：第 3 条已修复、第 12 条已加反义极性层（覆盖率阈值仍 0.6），闸门变为 verify 144 项 / 单测 176 项 / 产物 212870 bytes。证据见 `docs/techdebt-record-2026-10-26.md`。本记录其余数字是 v0.4.0 当次取证的**原始快照**，未回改。

## 7. 复验一键命令

```powershell
$node = 'C:\Users\23897\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd D:\DeppSeekWork\deepseek-work1\dsh-plugin-prompt-optimizer
& $node scripts\build.mjs; & $node scripts\verify.mjs; & $node scripts\simulate.mjs
& $node --test @((Get-ChildItem tests -Filter *.test.mjs).FullName)
```
## 8. 环境说明（结论：不是插件缺陷，后续勿再排查）

本记录中出现的「自动化通道不可用」全部源自本地环境，与 dsh-plugin-prompt-optimizer 无关：

- Web GUI `http://127.0.0.1:8861` 返回 401 需 `dsh web` 一次性 token URL，而 web 版 DSH 因安装了若干 web 版插件后无法启动（见 C:\Users\23897\.dsh\logs\startup-*.log 中 `listen EADDRINUSE: address already in use 127.0.0.1:8899` 与 `2 required plugins did not activate`），因此拿不到 token，也无法用指令重新部署 web 版。
- 桌面宿主 PID 4092 未开 `--remote-debugging-port`，renderer 挂不上 CDP。
- 视觉模型对窗口截图的控件判定不可靠（曾把左侧会话列表误判为搜索框并断言「没有星形按钮」）。

用户结论（对话原话）：**这个插件已经没有问题，4.0 改版成功**。后续复验请走 §7 的四条本地命令 + 界面实测，不要再去解决 8861 认证或 Electron CDP——那不是本插件的待办。

