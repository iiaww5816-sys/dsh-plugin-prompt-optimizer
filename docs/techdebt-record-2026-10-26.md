# 技术债修复记录 · 2026-10-26

对象：`dsh-plugin-prompt-optimizer` v0.4.0 的两条技术债。来源身份卡：插件技术债治理专家（根因驱动、稳定性优先、不得破坏构建自检、不得大幅降阈值）。

## 结论

| 债 | 处置 | 结果 |
|---|---|---|
| `ENDPOINT_PLACEHOLDER` 字符串拼接（绕构建自检） | 收紧自检正则 + 恢复字面量 + 加同源护栏 | 已消除，自检强度未降 |
| 软守恒反义漏判（阈值 0.6 时「提高」→「降低」判保真） | 阈值**不动**，追加反义极性冲突层 | 反义漏判 6→0，同义/正常误判 0→0 |

两条各自独立、互不共享文件，故拆两个任务并行交付。分离理由：`scripts/simulate.mjs` 断言产物字节数，两侧同时 rebuild 会互相假失败。

## 一、构建自检正则（`ENDPOINT_PLACEHOLDER`）

- 根因：`scripts/build.mjs:274` 旧内联正则 `/[A-Za-z]:[\/]{1,2}[A-Za-z0-9_]/` 把 `https://api` 的 `s://a` 当成 `C:/x` 同形命中，于是源码被迫写成 `"https:" + "//api..."` 躲检查。
- 改法：`scripts/build.mjs:275` 抽出 `const ABSOLUTE_PATH_PATTERN = /(?<![A-Za-z0-9_])[A-Za-z]:[\/]{1,2}[A-Za-z0-9_]/;`，`:283` 使用；`src/client/overlays.js:303` 恢复完整字面量；`scripts/verify.mjs:295-322` 从 build.mjs 源码抓同一份字面量、`new RegExp` 重建后跑 mustCatch / mustMiss 双向护栏。
- 为什么不是「放宽检查」：前置断言 `(?<![A-Za-z0-9_])` 只排除**单词字符前缀**，`C:\Users\x`、`D:/work`、`"E:\a"` 仍全部命中；护栏把这几个反例固化进 verify，正则一旦被改松会立刻红灯。
- 端到端证伪：临时往产物注入 `C:\Users\test`，build 仍 `[build] FAILED 产物里出现盘符绝对路径`（exit 1），注入已回滚。

## 二、软守恒反义漏判（极性层）

- 根因：`coverageOf`（`src/engine/merge.js:401-407`）只数 2–4 字实义片段在不在。反义替换不改片段结构只改方向，「提高→降低」时除「提高」外片段全命中，覆盖率仍高于 0.6。**因此调阈值治不了**——这是不降阈值的依据。
- 改法：`merge.js:409-504` 新增极性层（`SOFT_POLARITY_AXES`:414 七条轴、`POLARITY_NEG_CHARS/WORDS`、`polarityHits`:436、`polarityCount`:464、`firstPolarityWord`:475、`polarityConflictOf`:490）；判定区 `merge.js:616-653` 在覆盖率**通过后**加 `:637 const conflict = polarityConflictOf(sentence, result, flat);`，冲突则并入既有 `dropped`（`dropped` 语义不变、`ok` 自然为 false），`:648` 在 `details` 追加一行「有 N 处反义极性冲突：…」。
- 两个实现要点：① 判定同时吃 `result` 与 `flat`——`normalize()` 删全部空白，`flat` 里 ASCII 词边界消失，`before/after/increase/allow` 会整片漏计；② 紧邻否定（不/没/未/别/无/莫、not/no/never/nor）不计本方向，否则 `Do not enable` 会被误判成反义。

### 误判率前后对比（自建 25 句三分类，改动前 merge.js 快照双跑）

| 分类 | 句数 | 改前 保真/不保真 | 改后 保真/不保真 | 极性层命中 | 结论 |
|---|---|---|---|---|---|
| 同义改写 | 8 | 8 / 0 | 8 / 0 | 0 | 误判 0→0 |
| 反义改写 | 9 | 6 / 3 | 0 / 9 | 6 | 漏判 6→0，命中 33%→100% |
| 正常优化 | 8 | 8 / 0 | 8 / 0 | 0 | 误判 0→0 |
| 合计 | 25 | 22 / 3 | 16 / 9 | 6 | 反义全抓，同义与正常零回退 |

短句反义（覆盖率已不足 0.6 的 3 例）仍由覆盖率层抓，`details` 不出冲突行——两条路径都 push 进 `dropped`，行为一致。

## 三、回归（2026-10-26 统一重建后实测）

```powershell
$node = 'C:\Users\23897\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd 'D:\DeppSeekWork\deepseek-work1\dsh-plugin-prompt-optimizer'
& $node scripts\build.mjs; & $node scripts\verify.mjs; & $node scripts\simulate.mjs
$files = Get-ChildItem tests -Filter *.test.mjs; & $node --test @($files.FullName)
```

| 闸门 | 基线 | 现在 |
|---|---|---|
| scripts/build.mjs | 207561 B | 212870 B · sha256 ea84a9951e954a79a90cae5d11d5c59a132fe3730e4c4b91a1cf376fb8ac1780（12 模块，引擎 3） |
| scripts/verify.mjs | 141 项 | 144 项 PASS |
| scripts/simulate.mjs | 22 组 | 22 组 PASS（产物字节 212870） |
| node --test | 170 | 176 pass / 0 fail |
| lib/index.js | 49479 B | 49479 B（宿主半边未动） |

## 四、遗留

- 极性层边界见 `docs/known-limitations.md` 第 12 条新增的「仍有的边界」三条（白名单外反义词、多处极性只翻一处、ASCII 词边界）。
- 版本号仍为 0.4.0，未擅自升版：是否发 0.4.1 由发布决策方定。
- 25 句语料与前后对比脚本是临时文件，未入库（`%TEMP%\po-stats3.mjs`、`po-table.mjs`、`po-merge-before.mjs`）；表内数字为本记录的一次性实测，不是回归套件的一部分。
