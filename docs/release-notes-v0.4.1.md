## v0.4.1 · 提示词优化插件

在输入框工具行的 ✦ 按钮上，把你已经写下的草稿按「角色／任务／上下文／输出要求／约束」五段结构化改写，**回填同一个输入框**，并可一键还原原文。

### 本版修复

- **反义极性层**：软守恒不再只看词汇覆盖率。结果把同一轴上的正反词对调（提高↔降低、增大↔减小、启用↔禁用）时判为不保真，避免「提高 30%」被悄悄改成「降低 30%」还显示通过。
- **构建期端点自检误伤**：占位端点恢复为直写常量，盘符正则只匹配非协议上下文，不再需要拼接字符串绕开自己的自检。

### 校验基线

| 闸门 | 结果 |
| --- | --- |
| `scripts/verify.mjs` | 144 项 PASS |
| `scripts/simulate.mjs` | 22 组 PASS |
| `node --test tests/*.test.mjs` | 176 pass / 0 fail |
| `lib/client.js` | 212870 B，sha256 `ea84a995…78b0` |

### 安装

`dsh plugin add` 透传给 `pnpm add`，其帮助里列出 `<git host>:<git user>/<repo name>` 与 `<git repo url>` 两类来源，因此：

```sh
dsh plugin --profile <profile> add github:iiaww5816-sys/dsh-plugin-prompt-optimizer
# 等价写法
dsh plugin --profile <profile> add https://github.com/iiaww5816-sys/dsh-plugin-prompt-optimizer.git
```

`lib/` 已提交进仓库，从 git 安装不需要本地构建。

装完需**完全重启** DSH。注意区分两层：重启只能让宿主重新读盘，改过 `src` 之后必须先跑 `node scripts/build.mjs` 重建 `lib/client.js`，否则重启也不会生效。

### 已知限制

13 条，逐条给影响与规避，见 [docs/known-limitations.md](docs/known-limitations.md)。最值得先看的是第 10 条（自动化验不到真实渲染与真实上游）和第 12 条（极性层的三个边界）。
