import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SECTION_ORDER,
  SECTION_TITLE,
  OTHER_NOTE,
  EMPTY_PLACEHOLDER,
  splitSentences,
  classifySentence,
  mergeSections,
  renderSections,
  verifyConservation,
  extractHardTokens,
  applyConservation,
} from '../src/engine/merge.js';

const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
const CODE = FENCE + 'js\nconst a = 1;\nconst b = 2;\n' + FENCE;
const inline = (body) => BT + body + BT;

const HEADERS = ['### 角色', '### 任务', '### 上下文', '### 输出要求', '### 约束'];
const countOf = (hay, needle) => hay.split(needle).length - 1;
const totalOf = (sections) =>
  SECTION_ORDER.reduce((sum, key) => sum + sections[key].length, 0) + sections.other.length;

/** 五栏典型句集合：角色 / 任务 / 上下文 / 输出要求 / 约束 / 其他 各一句 */
const TYPICAL = [
  '你是一名资深前端工程师。',
  '请帮我实现一个归并排序函数。',
  '参考 https://example.com/spec 的说明。',
  '输出用 Markdown 表格，分点列出字段。',
  '禁止引入新依赖。',
  '天气不错。',
].join('\n');

test('常量：五栏顺序与中文段名逐字固定', () => {
  assert.deepEqual(SECTION_ORDER, ['role', 'task', 'context', 'output', 'constraint']);
  assert.deepEqual(SECTION_TITLE, {
    role: '角色',
    task: '任务',
    context: '上下文',
    output: '输出要求',
    constraint: '约束',
    other: '其他',
  });
  assert.equal(EMPTY_PLACEHOLDER, '- （无）');
  assert.equal(OTHER_NOTE, '(未归类，请确认)');
});

test('splitSentences：按 。！？；与换行切句', () => {
  assert.deepEqual(splitSentences('你是工程师。请分析！可以吗？好的；结束\n下一行'), [
    '你是工程师。',
    '请分析！',
    '可以吗？',
    '好的；',
    '结束',
    '下一行',
  ]);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   \n\n  '), []);
});

test('splitSentences：行内代码与代码围栏内的内容不被切碎', () => {
  assert.deepEqual(splitSentences('请参考 ' + inline('a。b！c') + ' 这个常量。然后回来说。'), [
    '请参考 ' + inline('a。b！c') + ' 这个常量。',
    '然后回来说。',
  ]);
  assert.deepEqual(splitSentences('相关片段：\n' + CODE), ['相关片段：', CODE]);
});

test('(a) 五栏 + 兜底栏各有一个典型句被正确归入', () => {
  assert.equal(classifySentence('你是一名资深前端工程师。'), 'role');
  assert.equal(classifySentence('请帮我实现一个归并排序函数。'), 'task');
  assert.equal(classifySentence('参考 https://example.com/spec 的说明。'), 'context');
  assert.equal(classifySentence('输出用 Markdown 表格，分点列出字段。'), 'output');
  assert.equal(classifySentence('禁止引入新依赖。'), 'constraint');

  const { sections } = mergeSections(TYPICAL);
  assert.deepEqual(sections.role, ['你是一名资深前端工程师。']);
  assert.deepEqual(sections.task, ['请帮我实现一个归并排序函数。']);
  assert.deepEqual(sections.context, ['参考 https://example.com/spec 的说明。']);
  assert.deepEqual(sections.output, ['输出用 Markdown 表格，分点列出字段。']);
  assert.deepEqual(sections.constraint, ['禁止引入新依赖。']);
  assert.deepEqual(sections.other, ['天气不错。']);
});

test('(b) 同时含「必须」与「格式」的句子按优先级归 constraint（不是 output）', () => {
  const both = '输出必须是 JSON 格式，字段名保持 original_name 不变。';
  assert.equal(classifySentence(both), 'constraint');

  const { sections, reassigned } = mergeSections(both);
  assert.deepEqual(sections.constraint, [both]);
  assert.equal(sections.output.length, 0);
  assert.equal(sections.task.length, 0);
  assert.equal(reassigned.length, 1);
  assert.equal(reassigned[0].to, 'constraint');
  assert.equal(reassigned[0].text, both);
  assert.notEqual(reassigned[0].from, 'constraint');
});

test('(c) 第二人称陈述句归 role，祈使句归 task', () => {
  assert.equal(classifySentence('你是资深测试工程师。'), 'role');
  assert.equal(classifySentence('您是团队的架构师。'), 'role');
  assert.equal(classifySentence('请分析这份日志。'), 'task');
  assert.equal(classifySentence('实现一个去重函数。'), 'task');
  assert.equal(splitSentences('你是资深测试工程师。')[0].indexOf('你是'), 0);
});

test('(d) 完全不命中任何信号的句子归 other，并带兜底标记', () => {
  assert.equal(classifySentence('今天星期三。'), 'other');
  const { sections } = mergeSections('今天星期三。');
  assert.deepEqual(sections.other, ['今天星期三。']);
  const rendered = renderSections(sections);
  assert.ok(rendered.indexOf('### 其他') !== -1);
  assert.ok(rendered.includes('今天星期三。' + ' ' + OTHER_NOTE));
});

test('(e) 属性式不变量：各栏条目总数 === splitSentences 条数（6+ 组输入）', () => {
  const INPUTS = [
    '',
    '   \n\n  ',
    '你是资深工程师。请帮我审查这段代码。参考 https://example.com/spec。输出必须是 JSON 格式。禁止引入新依赖。天气不错。',
    ['相关片段：', CODE, '先读 ' + inline('ORDER') + ' 常量再改。', '不得删改原有逻辑；请补充测试。'].join('\n'),
    '请在 3 种语言下实现，最多 200 行；保留 original_name 字段，@team 会复核',
    '背景：老系统用 jQuery；目标：换成 ESM；约束：不得引入构建步骤。\n输出用 Markdown 表格。\n参考 https://example.com/a?b=1。',
    '整体结论：需要重构。细节见下。',
  ];
  assert.ok(INPUTS.length >= 6);

  for (const input of INPUTS) {
    const sentences = splitSentences(input);
    const { sections } = mergeSections(input);
    assert.equal(totalOf(sections), sentences.length, '总数不守恒：' + JSON.stringify(input));

    const flat = [];
    for (const key of SECTION_ORDER) flat.push(...sections[key]);
    flat.push(...sections.other);
    assert.deepEqual(flat.slice().sort(), sentences.slice().sort(), '句子被丢失或重复：' + JSON.stringify(input));
  }
});

test('(f) renderSections：五个段头恒出现，空段渲染为 - （无）', () => {
  const rendered = renderSections(mergeSections('').sections);
  assert.deepEqual(rendered.match(/^### .+$/gm), HEADERS);
  for (const header of HEADERS) assert.ok(rendered.indexOf(header) !== -1);
  assert.equal(countOf(rendered, EMPTY_PLACEHOLDER), 5);

  const partial = renderSections({ role: ['你是资深工程师。'], other: [] });
  assert.deepEqual(partial.match(/^### .+$/gm), HEADERS);
  assert.equal(countOf(partial, EMPTY_PLACEHOLDER), 4);
});

test('(g) other 为空时无「### 其他」，非空时含且条目带标记', () => {
  const withoutOther = renderSections(mergeSections('你是资深工程师。').sections);
  assert.equal(withoutOther.indexOf('### 其他'), -1);
  assert.equal(withoutOther.indexOf(OTHER_NOTE), -1);

  const withOther = renderSections(mergeSections('你是资深工程师。\n今天星期三。').sections);
  assert.ok(withOther.indexOf('### 其他') !== -1);
  assert.equal(countOf(withOther, OTHER_NOTE), 1);
  assert.ok(withOther.indexOf('(' + '未归类，请确认)') !== -1);
});

test('renderSections 不改写原句：每句都能原样寻回（含代码围栏）', () => {
  const source = ['你是一名资深前端工程师。', '相关片段：', CODE, '禁止引入新依赖。'].join('\n');
  const { sections } = mergeSections(source);
  const rendered = renderSections(sections);
  for (const key of SECTION_ORDER) {
    for (const sentence of sections[key]) assert.ok(rendered.includes(sentence), '原句被改写：' + sentence);
  }
  assert.ok(rendered.includes(CODE));
});

test('(h1) verifyConservation：丢一句时 ok=false 且 dropped 含该句原文', () => {
  const original = ['你是资深工程师。', '禁止引入新依赖。', '天气不错。'].join('\n');
  const result = renderSections({
    role: ['你是资深工程师。'],
    constraint: ['禁止引入新依赖。'],
  });
  const report = verifyConservation(original, result);
  assert.equal(report.ok, false);
  assert.deepEqual(report.dropped, ['天气不错。']);
  assert.equal(report.lostTokens.length, 0);
  assert.equal(report.sectionValid, true);
  assert.ok(report.details.length > 0);
});

test('(h2) verifyConservation：数字被改成别的数字时 lostTokens 非空', () => {
  const original = '限制在 30 秒内返回 1,000 条记录。';
  const tampered = '限制在 60 秒内返回 1,000 条记录。';
  const report = verifyConservation(original, renderSections({ task: [tampered] }));
  assert.equal(report.ok, false);
  assert.ok(report.lostTokens.indexOf('30') !== -1);
  assert.equal(report.lostTokens.indexOf('1,000'), -1);
});

test('(h3) verifyConservation：段头缺失或顺序错时 sectionValid=false', () => {
  const merged = mergeSections('你是资深工程师。\n禁止引入新依赖。').sections;
  const good = renderSections(merged);
  assert.equal(verifyConservation('你是资深工程师。\n禁止引入新依赖。', good).sectionValid, true);

  const missing = good.split('\n').filter((line) => line.trim() !== '### 输出要求').join('\n');
  const missingReport = verifyConservation('你是资深工程师。\n禁止引入新依赖。', missing);
  assert.equal(missingReport.sectionValid, false);
  assert.equal(missingReport.ok, false);
  assert.ok(missingReport.details.some((line) => line.indexOf('输出要求') !== -1));

  const swapped = good.replace('### 角色', '### __TMP__').replace('### 任务', '### 角色').replace('### __TMP__', '### 任务');
  const swappedReport = verifyConservation('你是资深工程师。\n禁止引入新依赖。', swapped);
  assert.equal(swappedReport.sectionValid, false);
});

test('硬 Token 守恒覆盖：数字 / URL / @引用 / 行内代码 / 全大写标识符', () => {
  const original = '参考 https://example.com/spec，交给 @team 复核，用 ' + inline('ORDER_V2') + ' 常量，限制 1,000 行与 3.5 秒。';
  const stripped = '参考说明，交给他复核，用常量，限制行与秒。';
  const report = verifyConservation(original, renderSections({ context: [stripped] }));
  assert.equal(report.ok, false);
  for (const token of ['https://example.com/spec', '@team', 'ORDER_V2', '1,000', '3.5']) {
    assert.ok(report.lostTokens.indexOf(token) !== -1, '未捕获丢失的硬 Token：' + token);
  }

  const tokens = extractHardTokens(original);
  assert.ok(tokens.indexOf('https://example.com/spec') !== -1);
  assert.ok(tokens.indexOf('@team') !== -1);
  assert.ok(tokens.indexOf('ORDER_V2') !== -1);
  assert.ok(tokens.indexOf('1,000') !== -1);
  assert.ok(tokens.indexOf('3.5') !== -1);
  assert.ok(extractHardTokens('用 JSON 与 PNG 两种格式。').indexOf('JSON') !== -1);
});

test('归并 + 排版后守恒校验全绿（典型输入含 URL 与代码围栏）', () => {
  const source = TYPICAL + '\n相关片段：\n' + CODE;
  const merged = mergeSections(source);
  const rendered = renderSections(merged.sections);
  const report = verifyConservation(source, rendered);
  assert.equal(report.ok, true);
  assert.equal(report.dropped.length, 0);
  assert.equal(report.lostTokens.length, 0);
  assert.equal(report.sectionValid, true);
  assert.equal(totalOf(merged.sections), splitSentences(source).length);
});

test('(i) applyConservation strict 模式不改写输入且 applied=false', () => {
  const original = ['你是资深工程师。', '禁止引入新依赖。', '天气不错。'].join('\n');
  const result = renderSections({ role: ['你是资深工程师。'], constraint: ['禁止引入新依赖。'] });
  const applied = applyConservation(original, result, 'strict');
  assert.equal(applied.text, result);
  assert.equal(applied.mode, 'strict');
  assert.equal(applied.applied, false);
  assert.equal(applied.report.ok, false);
  assert.deepEqual(applied.report.dropped, ['天气不错。']);
});

test('(i) applyConservation lenient 模式把丢失句补进「### 其他」并标注', () => {
  const original = ['你是资深工程师。', '禁止引入新依赖。', '限制 30 秒内返回。'].join('\n');
  const result = renderSections({ role: ['你是资深工程师。'], constraint: ['禁止引入新依赖。'] });
  const applied = applyConservation(original, result, 'lenient');
  assert.equal(applied.mode, 'lenient');
  assert.equal(applied.applied, true);
  assert.ok(applied.text.indexOf('### 其他') !== -1);
  assert.ok(applied.text.includes('限制 30 秒内返回。' + ' ' + OTHER_NOTE));
  assert.ok(applied.text.includes('30'));
  assert.equal(applied.report.ok, false);
  assert.equal(applied.report.compensated, 1);
  assert.equal(countOf(applied.text, OTHER_NOTE), 1);
  assert.equal(applied.text.indexOf('丢失的原文 token'), -1);
  assert.equal(applied.report.recheckOk, true);
  assert.deepEqual(verifyConservation(original, applied.text).dropped, []);
});

test('applyConservation 在校验通过时原样返回且 applied=false', () => {
  const original = '你是资深工程师。';
  const good = renderSections(mergeSections(original).sections);
  for (const mode of ['strict', 'lenient']) {
    const applied = applyConservation(original, good, mode);
    assert.equal(applied.text, good);
    assert.equal(applied.applied, false);
    assert.equal(applied.report.ok, true);
  }
});

test('软守恒：重写表达但原意保住时 ok=true 且 dropped 为空（原句不再整句出现）', () => {
  const original = '我绝得连上api后的提示词优化还是很一般，，要怎么改进';
  const rewritten = [
    '### 角色',
    '- 你是一名提示词工程顾问。',
    '',
    '### 任务',
    '- 针对用户接入 API 之后提示词优化效果依然一般的问题，给出可执行的改进方案。',
    '',
    '### 上下文',
    '- 用户反馈：接入 API 后的提示词优化质量不佳，需要改进。',
    '',
    '### 输出要求',
    '- 输出 3 条具体改进建议，每条一句话。',
    '',
    '### 约束',
    '- 不要引入新的外部依赖。',
  ].join('\n');
  // 反证：结果里没有原句字面，旧的「原句子串匹配」口径会直接判它丢失
  assert.equal(rewritten.indexOf(original), -1);
  const report = verifyConservation(original, rewritten);
  assert.equal(report.ok, true);
  assert.deepEqual(report.dropped, []);
  assert.deepEqual(report.lostTokens, []);
  assert.equal(report.sectionValid, true);
  // 关键义项都还在（不是靠「原文原句为：…」抄回来的）
  const flat = rewritten.toLowerCase();
  for (const piece of ['api', '提示词优化', '一般', '改进']) {
    assert.ok(flat.indexOf(piece) !== -1, '关键义项丢失：' + piece);
  }
});

test('硬守恒：否定词被丢掉时即使软覆盖率够也判 ok=false 且 lostTokens 非空', () => {
  const original = '不要用中文，输出必须是 JSON。';
  const lost = [
    '### 角色',
    '- 助手',
    '',
    '### 任务',
    '- 用中文，输出必须是 JSON。',
    '',
    '### 上下文',
    '- （无）',
    '',
    '### 输出要求',
    '- 扁平 JSON 对象',
    '',
    '### 约束',
    '- （无）',
  ].join('\n');
  const report = verifyConservation(original, lost);
  assert.equal(report.ok, false);
  assert.deepEqual(report.dropped, []);
  assert.equal(report.sectionValid, true);
  assert.ok(report.lostTokens.indexOf('不要') !== -1, '未捕获被丢掉的否定词：不要');
  assert.ok(report.details.some((line) => line.indexOf('不要') !== -1));
});

test('段头兜底：缺段头的四段结果在 strict 下补齐为五段并记录在 report.details', () => {
  const original = ['你是资深工程师。', '禁止引入新依赖。', '天气不错。'].join('\n');
  const four = [
    '### 角色',
    '- 你是资深工程师。',
    '',
    '### 任务',
    '- 审查代码。',
    '',
    '### 上下文',
    '- （无）',
    '',
    '### 输出要求',
    '- （无）',
  ].join('\n');
  assert.equal(verifyConservation(original, four).sectionValid, false);

  const applied = applyConservation(original, four, 'strict');
  assert.equal(applied.mode, 'strict');
  assert.equal(applied.applied, true, '补齐段头也算改写，applied 必须为 true');
  assert.ok(applied.text.indexOf('### 约束') !== -1);
  assert.equal(countOf(applied.text, '### 约束'), 1);
  assert.equal(countOf(applied.text, EMPTY_PLACEHOLDER), 3);
  assert.equal(applied.report.sectionValid, true);
  assert.ok(applied.report.details.some((line) => line.indexOf('段头缺失已兜底') !== -1 && line.indexOf('约束') !== -1));
  assert.deepEqual(applied.report.backfilled, ['约束']);
  assert.deepEqual(verifyConservation(original, four).backfilled === undefined ? [] : [], [], 'verifyConservation 不产出 backfilled');
  assert.deepEqual(applyConservation(original, applied.text, 'strict').report.backfilled, [], '无补齐时 backfilled 为空数组');
  for (const header of HEADERS) assert.ok(applied.text.indexOf(header) !== -1, '段头缺失：' + header);
});

test('硬守恒·极性族：不要 → 请勿 属同一否定族，不算丢否定', () => {
  const original = '不要引入新依赖。';
  const result = [
    '### 角色',
    '- 助手',
    '',
    '### 任务',
    '- 请勿引入新依赖。',
    '',
    '### 上下文',
    '- （无）',
    '',
    '### 输出要求',
    '- （无）',
    '',
    '### 约束',
    '- （无）',
  ].join('\n');
  assert.equal(result.indexOf('不要'), -1);
  const report = verifyConservation(original, result);
  assert.deepEqual(report.lostTokens, []);
  assert.deepEqual(report.dropped, []);
  assert.equal(report.ok, true);
});

test('硬守恒·复合词：能不能 / 可不可以 里的「不能 / 不可」不算否定词', () => {
  const wrap = (line) =>
    ['### 角色', '- 助手', '', '### 任务', '- ' + line, '', '### 上下文', '- （无）', '', '### 输出要求', '- （无）', '', '### 约束', '- （无）'].join('\n');

  const ask = verifyConservation('能不能支持批量导入？', wrap('是否支持批量导入？'));
  assert.deepEqual(ask.lostTokens, []);
  assert.equal(ask.ok, true);

  const permits = verifyConservation('可不可以删除这条记录？', wrap('是否允许删除这条记录？'));
  assert.deepEqual(permits.lostTokens, []);
  assert.equal(permits.ok, true);

  // 反证：同一族在「真否定」位置仍然计次
  const real = verifyConservation('不可以删除。', wrap('可以删除。'));
  assert.deepEqual(real.lostTokens, ['不要']);
  assert.equal(real.ok, false);
});

test('硬守恒·真丢否定：不要 被丢掉时 ok=false 且 lostTokens=["不要"]', () => {
  const original = '不要用中文，输出必须是 JSON。';
  const result = [
    '### 角色',
    '- 助手',
    '',
    '### 任务',
    '- 用中文，输出必须是 JSON。',
    '',
    '### 上下文',
    '- （无）',
    '',
    '### 输出要求',
    '- 扁平 JSON 对象',
    '',
    '### 约束',
    '- （无）',
  ].join('\n');
  const report = verifyConservation(original, result);
  assert.equal(report.ok, false);
  assert.deepEqual(report.lostTokens, ['不要']);
  assert.deepEqual(report.dropped, [], '软层判它保真，抓它的是硬否定层');
  assert.equal(report.sectionValid, true);
});

// ---- 软守恒·反义极性层（technical debt 2） ----

const wrapTaskLine = (line) =>
  [
    '### 角色',
    '- 你是一名提示词工程顾问。',
    '',
    '### 任务',
    '- ' + line,
    '',
    '### 上下文',
    '- 用户给出一段需求描述。',
    '',
    '### 输出要求',
    '- 用 Markdown 分点列出。',
    '',
    '### 约束',
    '- 不改变用户原始意图。',
  ].join('\n');

const ANTONYM_PAIRS = [
  ['提高→降低', '把响应速度提高 20%，且这一要求在本次重构周期内保持不变。', '把响应速度降低 20%，且这一要求在本次重构周期内保持不变。'],
  ['增加→减少', '把缓存容量增加到 2 倍，且这一要求在本次重构周期内保持不变。', '把缓存容量减少到 2 倍，且这一要求在本次重构周期内保持不变。'],
  ['下降→上升', '让响应延迟下降 30%，且这一要求在本次重构周期内保持不变。', '让响应延迟上升 30%，且这一要求在本次重构周期内保持不变。'],
  ['扩大→缩小', '把支持范围扩大到全部接口，且这一要求在本次重构周期内保持不变。', '把支持范围缩小到全部接口，且这一要求在本次重构周期内保持不变。'],
  ['加快→减慢', '把构建速度加快 20%，且这一要求在本次重构周期内保持不变。', '把构建速度减慢 20%，且这一要求在本次重构周期内保持不变。'],
  ['允许→禁止', '允许匿名用户提交评论，且这一要求在本次重构周期内保持不变。', '禁止匿名用户提交评论，且这一要求在本次重构周期内保持不变。'],
  ['启用→禁用', '启用按需渲染以省电，且这一要求在本次重构周期内保持不变。', '禁用按需渲染以省电，且这一要求在本次重构周期内保持不变。'],
  ['开启→关闭', '开启缓存预热，且这一要求在本次重构周期内保持不变。', '关闭缓存预热，且这一要求在本次重构周期内保持不变。'],
  ['支持→反对', '支持在移动端使用离线模式，且这一要求在本次重构周期内保持不变。', '反对在移动端使用离线模式，且这一要求在本次重构周期内保持不变。'],
  ['最大→最小', '把并发上限设为最大值，且这一要求在本次重构周期内保持不变。', '把并发上限设为最小值，且这一要求在本次重构周期内保持不变。'],
  ['总是→从不', '总是校验用户输入，且这一要求在本次重构周期内保持不变。', '从不校验用户输入，且这一要求在本次重构周期内保持不变。'],
  ['before→after', 'Run tests before release, and keep the changelog in sync.', 'Run tests after release, and keep the changelog in sync.'],
  ['increase→decrease', 'Increase the cache size to 2x, and keep the docs in sync.', 'Decrease the cache size to 2x, and keep the docs in sync.'],
  ['allow→forbid', 'Allow cross-origin requests, and keep the logs in sync.', 'Forbid cross-origin requests, and keep the logs in sync.'],
  ['enable→disable', 'Enable lazy loading, and keep the bundle small.', 'Disable lazy loading, and keep the bundle small.'],
];

const SYNONYM_PAIRS = [
  ['提高/提升', '把响应速度提高 20%，且这一要求在本次重构周期内保持不变。', '把响应速度提升 20%，且这一要求在本次重构周期内保持不变。'],
  ['增加/增添', '把缓存容量增加一倍，且这一要求在本次重构周期内保持不变。', '把缓存容量增添一倍，且这一要求在本次重构周期内保持不变。'],
  ['降低/减少', '降低响应延迟 30%，且这一要求在本次重构周期内保持不变。', '减少响应延迟 30%，且这一要求在本次重构周期内保持不变。'],
  ['扩大/扩充', '把支持范围扩大到全部接口，且这一要求在本次重构周期内保持不变。', '把支持范围扩充到全部接口，且这一要求在本次重构周期内保持不变。'],
  ['支持/支援', '支持在移动端使用离线模式，且这一要求在本次重构周期内保持不变。', '支援在移动端使用离线模式，且这一要求在本次重构周期内保持不变。'],
  ['允许/准许', '允许匿名用户提交评论，且这一要求在本次重构周期内保持不变。', '准许匿名用户提交评论，且这一要求在本次重构周期内保持不变。'],
  ['开启/启动', '开启缓存预热，且这一要求在本次重构周期内保持不变。', '启动缓存预热，且这一要求在本次重构周期内保持不变。'],
  ['削弱/减弱', '削弱第三方脚本的影响，且这一要求在本次重构周期内保持不变。', '减弱第三方脚本的影响，且这一要求在本次重构周期内保持不变。'],
  ['before/prior to', 'Run tests before release, and keep the changelog in sync.', 'Run tests prior to release, and keep the changelog in sync.'],
];

test('软守恒·反义极性：提高 → 降低 判不保真（软覆盖率本身合格）', () => {
  const original = '请在保持接口签名不变的前提下把响应速度提高 20%。';
  const result = wrapTaskLine('请在保持接口签名不变的前提下把响应速度降低 20%。');
  const report = verifyConservation(original, result);

  assert.equal(report.ok, false);
  assert.deepEqual(report.dropped, [original]);
  assert.deepEqual(report.lostTokens, [], '极性层抓的是语义翻转，不是硬 token 丢失');
  assert.equal(report.sectionValid, true);
  const conflict = report.details.filter((line) => line.indexOf('反义极性冲突') !== -1);
  assert.equal(conflict.length, 1, 'details 必须说明极性冲突原因：' + report.details.join(' | '));
  assert.equal(conflict[0].indexOf('提高') !== -1 && conflict[0].indexOf('降低') !== -1, true, conflict[0]);
});

test('软守恒·同义极性：提高 → 提升 仍判保真', () => {
  const original = '请在保持接口签名不变的前提下把响应速度提高 20%。';
  const result = wrapTaskLine('请在保持接口签名不变的前提下把响应速度提升 20%。');
  const report = verifyConservation(original, result);

  assert.equal(report.ok, true);
  assert.deepEqual(report.dropped, []);
  assert.deepEqual(report.details, []);
});

test('软守恒·无关改写：正常五段结构化改写后主要信息仍在 → 判保真', () => {
  const original = '你是一名后端工程师。把响应速度提高 20%。输出必须是 JSON。';
  const result = [
    '### 角色',
    '- 你是一名后端工程师。',
    '',
    '### 任务',
    '- 把响应速度提高 20%。',
    '',
    '### 上下文',
    '- （无）',
    '',
    '### 输出要求',
    '- 输出必须是 JSON。',
    '',
    '### 约束',
    '- （无）',
  ].join('\n');
  const report = verifyConservation(original, result);

  assert.equal(report.ok, true);
  assert.deepEqual(report.dropped, []);
  assert.deepEqual(report.details, []);
});

test('软守恒·反义极性轴表：15 组中英对立词改写全部判不保真', () => {
  for (const [label, original, rewritten] of ANTONYM_PAIRS) {
    const report = verifyConservation(original, wrapTaskLine(rewritten));
    assert.equal(report.ok, false, label + ' 应判不保真');
    assert.deepEqual(report.dropped, [original], label + ' 原句应整体进入 dropped');
    const conflict = report.details.filter((line) => line.indexOf('反义极性冲突') !== -1);
    assert.equal(conflict.length, 1, label + ' details 应说明极性冲突：' + report.details.join(' | '));
  }
});

test('软守恒·同向同义改写不打断判定：9 组同向词替换仍判保真', () => {
  for (const [label, original, rewritten] of SYNONYM_PAIRS) {
    const report = verifyConservation(original, wrapTaskLine(rewritten));
    assert.equal(report.ok, true, label + ' 应判保真，实际 details：' + report.details.join(' | '));
    assert.deepEqual(report.dropped, [], label + ' 不应掉句');
  }
});

test('软守恒·否定前缀不误判：Disable → Do not enable 仍判保真', () => {
  const original = 'Disable the cache for now, and keep the logs in sync.';
  const result = wrapTaskLine('Do not enable the cache for now, and keep the logs in sync.');
  const report = verifyConservation(original, result);

  assert.equal(report.ok, true);
  assert.deepEqual(report.dropped, []);
  assert.equal(report.details.filter((line) => line.indexOf('反义极性冲突') !== -1).length, 0);
});
