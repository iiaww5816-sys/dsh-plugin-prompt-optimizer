import test from 'node:test';
import assert from 'node:assert/strict';

import { optimize, STRENGTHS } from '../src/engine/optimize.js';

const FENCE = String.fromCharCode(96, 96, 96);
const CODE = FENCE + 'js\nconst a = 1; // 不要 修改这一行\n' + FENCE;

const SAMPLE = [
  '你是一名资深前端工程师。',
  '请帮我审查下面这段代码，找出 2025 年之后才会出现的兼容性问题。',
  '不得删改原有逻辑，禁止引入新依赖。',
  '参考 https://example.com/spec 与 @team 的说明。',
  '输出必须是 JSON 格式，字段名保持 original_name 不变。',
  '相关片段：',
  CODE,
].join('\n');

const zh = { strength: 'standard', locale: 'zh' };
const bullets = (body) => body.split('\n').filter((l) => l.trim().indexOf('- ') === 0);
const count = (hay, needle) => hay.split(needle).length - 1;

test('STRENGTHS 暴露三档且顺序由弱到强', () => {
  assert.deepEqual(STRENGTHS, ['light', 'standard', 'deep']);
});

test('默认参数 = standard + zh，且五段顺序固定', () => {
  const res = optimize(SAMPLE);
  assert.equal(res.ok, true);
  assert.equal(res.meta.strength, 'standard');
  assert.equal(res.meta.locale, 'zh');
  assert.deepEqual(res.segments.map((s) => s.key), ['role', 'task', 'context', 'output', 'constraints']);
  assert.deepEqual(res.segments.map((s) => s.title), ['角色', '任务', '上下文', '输出要求', '约束']);
  assert.deepEqual(
    res.text.match(/^### .+$/gm),
    ['### 角色', '### 任务', '### 上下文', '### 输出要求', '### 约束'],
  );
});

test('meta 字段完整且长度自洽', () => {
  const res = optimize(SAMPLE, zh);
  assert.equal(res.meta.engine, 'local');
  assert.equal(res.meta.originalLength, SAMPLE.length);
  assert.equal(res.meta.optimizedLength, res.text.length);
  assert.equal(res.meta.changed, true);
  assert.equal(res.meta.truncated, false);
  assert.equal(res.reason, undefined);
});

test('忠于原意：数字 / 否定词 / URL / @引用 / 专有名词 全部原样保留', () => {
  const res = optimize(SAMPLE, zh);
  for (const token of ['2025', '不得', '禁止', 'https://example.com/spec', '@team', 'original_name', 'JSON']) {
    assert.ok(res.text.includes(token), '丢失了 ' + token);
  }
});

test('忠于原意：代码块整体保留，内部一个字符都不改（standard 与 deep 都验证）', () => {
  for (const strength of ['standard', 'deep']) {
    const res = optimize(SAMPLE, { strength, locale: 'zh' });
    assert.ok(res.text.includes(CODE), strength + ' 破坏了代码块');
    assert.equal(count(res.text, FENCE), 2, strength + ' 围栏数量异常');
    assert.ok(res.text.includes('const a = 1; // 不要 修改这一行'));
  }
});

test('light：只补角色与输出要求两段，其余三段标题不出现，原文整段保留', () => {
  const res = optimize(SAMPLE, { strength: 'light', locale: 'zh' });
  assert.deepEqual(res.segments.map((s) => s.key), ['role', 'output']);
  assert.deepEqual(res.text.match(/^### .+$/gm), ['### 角色', '### 输出要求']);
  assert.equal(res.text.includes('### 任务'), false);
  assert.equal(res.text.includes('### 上下文'), false);
  assert.equal(res.text.includes('### 约束'), false);
  assert.ok(res.text.includes(SAMPLE), 'light 丢失了原文主体');
});

test('standard：五段齐备', () => {
  const res = optimize(SAMPLE, zh);
  assert.equal(res.segments.length, 5);
  assert.equal(res.text.match(/^### .+$/gm).length, 5);
});

test('deep：每段要点列表化，且约束段追加 3 条验收标准又不与原文冲突', () => {
  const res = optimize(SAMPLE, { strength: 'deep', locale: 'zh' });
  const byKey = Object.fromEntries(res.segments.map((s) => [s.key, s.body]));
  assert.equal(res.segments.length, 5);
  assert.ok(bullets(byKey.output).length >= 1, 'output 未列表化');
  assert.equal(count(res.text, '验收：'), 3, '验收标准条数不是 3');
  assert.ok(byKey.constraints.includes('不得删改原有逻辑'), 'deep 丢了原文约束');
  assert.ok(byKey.constraints.includes('禁止引入新依赖'), 'deep 丢了原文约束');
});

test('三档输出互不相同（差异可验证）', () => {
  const light = optimize(SAMPLE, { strength: 'light', locale: 'zh' }).text;
  const standard = optimize(SAMPLE, { strength: 'standard', locale: 'zh' }).text;
  const deep = optimize(SAMPLE, { strength: 'deep', locale: 'zh' }).text;
  assert.notEqual(light, standard);
  assert.notEqual(standard, deep);
  assert.equal(light.includes('### 约束'), false);
  assert.ok(standard.includes('### 约束') && !standard.includes('验收：'));
  assert.ok(deep.includes('### 约束') && deep.includes('验收：'));
});

test('幂等：同一档位跑两次，第二次 changed:false 且 text 与输入完全相同', () => {
  for (const strength of STRENGTHS) {
    const first = optimize(SAMPLE, { strength, locale: 'zh' });
    const second = optimize(first.text, { strength, locale: 'zh' });
    assert.equal(second.ok, true, strength);
    assert.equal(second.meta.changed, false, strength + ' 二次优化仍判为 changed');
    assert.equal(second.text, first.text, strength + ' 二次优化改动了文本');
    assert.equal(count(second.text, '### 角色'), 1, strength + ' 标题被叠加');
    const third = optimize(second.text, { strength, locale: 'zh' });
    assert.equal(third.text, first.text, strength + ' 三次优化不稳定');
  }
});

test('幂等：standard/deep/en 产物再次优化也不叠加', () => {
  for (const strength of STRENGTHS) {
    const first = optimize(SAMPLE, { strength, locale: 'en' });
    const second = optimize(first.text, { strength, locale: 'en' });
    assert.equal(second.text, first.text);
    assert.equal(second.meta.changed, false);
  }
});

test('空输入：空串与纯空白都返回 empty', () => {
  for (const input of ['', '   ', '\n\n\t  \r\n']) {
    const res = optimize(input, zh);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'empty');
    assert.equal(res.text, '');
    assert.deepEqual(res.segments, []);
    assert.equal(res.meta.originalLength, input.length);
    assert.equal(res.meta.optimizedLength, 0);
    assert.equal(res.meta.changed, false);
  }
});

test('非字符串输入返回 unsupported', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    const res = optimize(input, zh);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unsupported');
    assert.equal(res.text, '');
    assert.deepEqual(res.segments, []);
  }
});

test('超长：保留前 8000 字符、标记截断、ok 仍为 true 且不设 reason', () => {
  const long = 'X'.repeat(9000);
  const res = optimize(long, zh);
  assert.equal(res.ok, true);
  assert.equal(res.reason, undefined);
  assert.equal(res.meta.truncated, true);
  assert.equal(res.meta.originalLength, 9000);
  assert.ok(res.text.includes('（原文过长已截断）'));
  assert.ok(res.text.length <= 8000 + 200, '未按 8000 截断：' + res.text.length);
  assert.equal(res.meta.optimizedLength, res.text.length);
});

test('超长：截断点落在围栏内时回退到围栏起始处，不产出半截代码块', () => {
  const src = 'A'.repeat(7900) + '\n' + FENCE + 'js\n' + 'B'.repeat(400) + '\n' + FENCE;
  assert.ok(src.length > 8000);
  const res = optimize(src, zh);
  assert.equal(res.meta.truncated, true);
  assert.equal(res.text.includes(FENCE), false, '围栏被切开');
  assert.equal(count(res.text, FENCE), 0);
  assert.ok(res.text.includes('（原文过长已截断）'));
});

test('zh / en 切换：标题与正文语言随之改变', () => {
  const en = optimize(SAMPLE, { strength: 'standard', locale: 'en' });
  assert.deepEqual(en.segments.map((s) => s.title), ['Role', 'Task', 'Context', 'Output', 'Constraints']);
  assert.deepEqual(
    en.text.match(/^### .+$/gm),
    ['### Role', '### Task', '### Context', '### Output', '### Constraints'],
  );
  assert.equal(en.meta.locale, 'en');
  assert.equal(en.text.includes('### 角色'), false);

  const enDeep = optimize(SAMPLE, { strength: 'deep', locale: 'en' });
  assert.equal(count(enDeep.text, 'Acceptance:'), 3);

  const zhRecovered = optimize(en.text, { strength: 'standard', locale: 'zh' });
  assert.equal(zhRecovered.meta.changed, false, '跨 locale 也应识别为自己的产物');
  assert.equal(zhRecovered.text, en.text);
});

test('确定性：同输入同输出，与调用次数和顺序无关', () => {
  const a = optimize(SAMPLE, { strength: 'deep', locale: 'zh' });
  optimize('无关输入', { strength: 'light', locale: 'en' });
  const b = optimize(SAMPLE, { strength: 'deep', locale: 'zh' });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('非法 strength/locale 归一化为默认值而不是崩溃', () => {
  const res = optimize(SAMPLE, { strength: 'ultra', locale: 'fr' });
  assert.equal(res.meta.strength, 'standard');
  assert.equal(res.meta.locale, 'zh');
  assert.equal(res.ok, true);
});

test('segments 形状：每段都有非空 key/title/body', () => {
  for (const strength of STRENGTHS) {
    const res = optimize(SAMPLE, { strength, locale: 'zh' });
    for (const seg of res.segments) {
      assert.equal(typeof seg.key, 'string');
      assert.ok(seg.key.length > 0);
      assert.ok(seg.title.length > 0);
      assert.ok(seg.body.trim().length > 0);
    }
  }
});
