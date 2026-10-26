import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { applyGuard, setMerge, getMerge } from '../src/client/engine.js';
import {
  SECTION_ORDER,
  SECTION_TITLE,
  OTHER_NOTE,
  mergeSections,
  verifyConservation,
  applyConservation,
} from '../src/engine/merge.js';

/** 与 src/client/index.js 装配出去的同一份对象。 */
const REAL_MERGE = {
  verifyConservation,
  applyConservation,
  mergeSections,
  SECTION_ORDER,
  SECTION_TITLE,
  OTHER_NOTE,
};

function useMerge(next) {
  setMerge(next);
  return () => setMerge(REAL_MERGE);
}

function source(relative) {
  return readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
}

const ORIGINAL = '你是资深评审。请把这段代码重构成三个函数。必须保留日志格式。';

function sectionsText(lines) {
  return lines.join('\n');
}

const PASS = sectionsText([
  '### ' + SECTION_TITLE.role,
  '- 你是资深评审。',
  '### ' + SECTION_TITLE.task,
  '- 请把这段代码重构成三个函数。',
  '### ' + SECTION_TITLE.context,
  '- （无）',
  '### ' + SECTION_TITLE.output,
  '- （无）',
  '### ' + SECTION_TITLE.constraint,
  '- 必须保留日志格式。',
]);

const FAIL = sectionsText([
  '### ' + SECTION_TITLE.role,
  '- 你是资深评审。',
  '### ' + SECTION_TITLE.task,
  '- 重构代码。',
  '### ' + SECTION_TITLE.context,
  '- （无）',
  '### ' + SECTION_TITLE.output,
  '- （无）',
  '### ' + SECTION_TITLE.constraint,
  '- （无）',
]);

setMerge(REAL_MERGE);
test.afterEach(() => setMerge(REAL_MERGE));

test('strict 失败：不改写文本、applied=false，只给非阻塞警示', () => {
  const guard = applyGuard(ORIGINAL, FAIL, 'strict');
  assert.equal(guard.text, FAIL, 'strict 必须原样保留模型返回的文本');
  assert.equal(guard.applied, false);
  assert.equal(guard.report.ok, false);
  assert.equal(guard.report.dropped.length, 2);
  assert.equal(guard.level, 'warning');
  assert.match(guard.notice, /^校验未通过 · 丢失 2 句 \/ 缺少 0 个关键项，已保留原样结果$/);
  assert.equal(guard.degraded, false);
});

test('strict 通过：ok=true 时不出警示、文本原样', () => {
  const guard = applyGuard(ORIGINAL, PASS, 'strict');
  assert.equal(guard.text, PASS);
  assert.equal(guard.report.ok, true);
  assert.equal(guard.applied, false);
  assert.equal(guard.level, 'none');
  assert.equal(guard.notice, '');
});

test('lenient：补回后 recheckOk=true，且写回补回文本', () => {
  const guard = applyGuard(ORIGINAL, FAIL, 'lenient');
  assert.equal(guard.applied, true);
  assert.notEqual(guard.text, FAIL);
  assert.equal(guard.report.recheckOk, true);
  assert.equal(guard.report.compensated, 2);
  assert.match(guard.notice, /^已补回 2 句到「其他」栏$/);
  assert.equal(guard.level, 'info');
  assert.ok(guard.text.includes('请把这段代码重构成三个函数。'), '丢失的原句必须回到结果里');
});

test('lenient 补回后再跑一次不叠加（幂等）', () => {
  const first = applyGuard(ORIGINAL, FAIL, 'lenient');
  const second = applyGuard(ORIGINAL, first.text, 'lenient');
  assert.equal(second.text, first.text, '已补回的文本不得再追加一遍');
});

test('报告字段齐全且类型正确', () => {
  const guard = applyGuard(ORIGINAL, FAIL, 'lenient');
  const report = guard.report;
  assert.equal(typeof report.ok, 'boolean');
  assert.equal(typeof report.sectionValid, 'boolean');
  assert.ok(Array.isArray(report.dropped));
  assert.ok(Array.isArray(report.lostTokens));
  assert.ok(Array.isArray(report.details));
  assert.ok(Array.isArray(report.reassigned));
  assert.equal(typeof report.uncategorized, 'number');
  assert.equal(report.uncategorized, 2, '两根补回行都带 OTHER_NOTE 标记');
  assert.ok(report.dropped.every((item) => typeof item === 'string' && item !== ''));
  assert.ok(report.reassigned.every((item) => typeof item.from === 'string' && typeof item.to === 'string' && typeof item.text === 'string'));
  assert.ok(report.reassigned.length > 0, '多栏命中必须留下改判记录');
});

test('merge 未装载：降级为不校验、原样展示、不抛错', () => {
  useMerge(null);
  assert.equal(getMerge(), null);
  const guard = applyGuard(ORIGINAL, FAIL, 'lenient');
  assert.equal(guard.degraded, true);
  assert.equal(guard.text, FAIL);
  assert.equal(guard.applied, false);
  assert.equal(guard.report.ok, true, '降级报告的 ok 恒为 true，UI 因此不占空间');
  assert.match(guard.error, /merge 引擎未装载/);
});

test('merge 抛错：兜底被吃掉、原因留在可追溯字段里', () => {
  useMerge({
    ...REAL_MERGE,
    applyConservation() {
      throw new Error('boom');
    },
  });
  const guard = applyGuard(ORIGINAL, FAIL, 'lenient');
  assert.equal(guard.degraded, true);
  assert.equal(guard.text, FAIL);
  assert.match(guard.error, /boom/);
  assert.equal(guard.report.ok, true);
});

test('mergeSections 抛错同样整体降级（不是只丢 reassigned）', () => {
  useMerge({
    ...REAL_MERGE,
    mergeSections() {
      throw new Error('sections down');
    },
  });
  const guard = applyGuard(ORIGINAL, FAIL, 'strict');
  assert.equal(guard.degraded, true);
  assert.equal(guard.text, FAIL);
  assert.match(guard.error, /sections down/);
});

test('只有校验能力时依旧给报告，但绝不改写文本', () => {
  useMerge({ verifyConservation, SECTION_TITLE, OTHER_NOTE });
  const guard = applyGuard(ORIGINAL, FAIL, 'lenient');
  assert.equal(guard.degraded, false);
  assert.equal(guard.applied, false);
  assert.equal(guard.text, FAIL);
  assert.equal(guard.report.ok, false);
});

test('button.js：兜底只在唯一写回点调用一次，且按 mergeMode 分流', () => {
  const text = source('src/client/button.js');
  assert.equal(text.match(/applyGuard\(/g).length, 1, '重复调用会让补回叠加');
  assert.ok(text.includes('applyGuard(token.source, text, configRef.current.mergeMode)'));
  assert.ok(text.includes('conservation: guard'));
  assert.ok(
    text.indexOf('applyGuard(token.source') < text.indexOf('write.call(inputActions, finalText)'),
    '兜底必须先于写回发生',
  );
});

test('overlays.js / style.js：校验区用 dsh-po-guard 单类命名且只用 CSS 变量', () => {
  const overlays = source('src/client/overlays.js');
  assert.ok(overlays.includes('ConservationBlock({ conservation })'));
  assert.ok(overlays.includes('className: "dsh-po-guard"'));
  assert.ok(overlays.includes('report.ok === true) return null'), '空报告不占空间');

  const style = source('src/client/style.js');
  assert.ok(style.includes('.dsh-po-guard{'));
  assert.ok(style.includes('].join("")'), 'CSS 仍保持数组 + join("") 的形状');
  const guardRules = style.split('\n').filter((line) => line.includes('dsh-po-guard') || line.includes('dsh-po-note-warn'));
  assert.ok(guardRules.length >= 8);
  for (const rule of guardRules) {
    assert.equal(/[:;](color|background-color|border-color):#/.test(rule), false, '禁止写死色值：' + rule);
    if (rule.includes('color:')) assert.ok(rule.includes('var(--dsw-alias-'), '颜色必须走宿主变量：' + rule);
  }
});

test('build.mjs：merge 已进打包白名单与引擎标记', () => {
  const build = source('scripts/build.mjs');
  assert.ok(build.includes('"src/engine/merge.js"'));
  assert.ok(build.includes('"function verifyConservation(originalText, resultText)"'));
  assert.ok(build.includes('"const SECTION_ORDER = ["'));
});
