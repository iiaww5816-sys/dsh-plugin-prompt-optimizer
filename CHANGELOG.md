# 变更日志

本文件记录 dsh-plugin-prompt-optimizer 对外可见的变更。格式参照 Keep a Changelog，版本号遵循语义化版本。

## [0.4.1] - 2026-10-26

### 修复

- 软守恒新增**反义极性层**：结果把同一轴上的正向词换成反向词（提高↔降低、增大↔减小、启用↔禁用）时判为不保真，不再只看词汇覆盖率。轴表与冲突判定见 `src/engine/merge.js` 的 `SOFT_POLARITY_AXES` / `polarityConflictOf`，回归证据见 `docs/techdebt-record-2026-10-26.md`。
- 构建期端点自检不再误伤协议头：`src/client/overlays.js` 的占位端点恢复为直写常量，`scripts/build.mjs` 的盘符正则只匹配非协议上下文。

### 变更

- 版本号与文档标题统一到 0.4.1。
- `package.json` 补 `repository` / `homepage` / `bugs` / `author`；新增 `LICENSE`（MIT）、`CHANGELOG.md`、`.gitignore`。
- 校验基线：`scripts/verify.mjs` 144 项、`scripts/simulate.mjs` 22 组、`node --test` 176 项全部通过；产物 `lib/client.js` 212870 B（sha256 `ea84a9951e954a79a90cae5d11d5c59a132fe3730e4c4b91a1cf376fb8ac1780`）、`lib/index.js` 49479 B。

### 已知限制

- 见 `docs/known-limitations.md`（13 条）。第 12 条记录极性层仍有的三个边界：只在同轴词表内生效、同方向出现两次只翻一处仍可能漏判、不保证语义等价。

## [0.4.0]

### 变更

- 重写系统提示词：三档正向质量目标、四道输出前自检、few-shot 示例、提问与指令分流，删除 deep 档第六段。
- 守恒校验改为两层：硬 Token 零容忍 + 软片段覆盖率阈值 `SOFT_COVERAGE_THRESHOLD = 0.6`，缺段头时自动兜底补齐。
- 基线：`verify` 141 项、`simulate` 22 组、`node --test` 170 项；产物 207561 B。

## [0.3.1] 及更早

- 0.3.1 修「添加模型／切换引擎点了没反应」。
- 0.3 密钥可选、`endpoint` 允许带 query、引擎新增 `auto` 档并成为默认。
- 0.2 多模型 API 管理、设置面板、内容守恒校验；0.1 首个可用版本（✦ 按钮 + 五段改写 + 一键还原）。
- 逐版本人工验收记录见 `docs/acceptance-record-v0.4.0.md`。
