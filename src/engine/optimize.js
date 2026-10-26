/**
 * 一键提示词优化 —— 本地优化引擎（纯函数）
 *
 * 约束：无第三方依赖、无网络、无随机数、不读时钟 —— 同一输入永远得到同一输出。
 * 核心不变量（fidelity / 忠于原意）：原文按"行/围栏代码块"切分成原子单元，
 * 每个单元要么原样落到某个分段，要么被 repairFidelity() 兜底追回，一个字符都不丢。
 */
import {
  ORDER,
  CLASSIFY_ORDER,
  MAX_LENGTH,
  LOCALES,
  KEYWORDS,
  ROLE_PRESETS,
} from './prompts.js';

/** 支持的强度档位（顺序即由弱到强） */
export const STRENGTHS = ['light', 'standard', 'deep'];

/** 反引号：用转义写法避免源码里出现裸围栏字符，便于本文件被内联进客户端产物 */
const TICK = '\u0060';

/**
 * @param {string} rawText 用户草稿原文
 * @param {{ strength?: 'light'|'standard'|'deep', locale?: 'zh'|'en' }} [options]
 * @returns {{ ok: boolean, reason?: string, text: string, segments: Array<{key:string,title:string,body:string}>, meta: object }}
 */
export function optimize(rawText, options) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const strength = normalizeStrength(opts.strength);
  const locale = normalizeLocale(opts.locale);
  const dict = LOCALES[locale];

  if (typeof rawText !== 'string') return fail('unsupported', strength, locale, '');
  if (rawText.trim() === '') return fail('empty', strength, locale, rawText);

  // 幂等闸门：输入已经是本引擎（同形）产物时，原样返回，绝不叠加标题。
  const already = parseOptimized(rawText);
  if (already) {
    return {
      ok: true,
      text: rawText,
      segments: already,
      meta: buildMeta(strength, locale, rawText, rawText, false),
    };
  }

  const clipped = clip(rawText, MAX_LENGTH);
  const built = assemble(strength, clipped.text, dict, locale);
  const text = clipped.truncated ? dict.truncatedNote + '\n\n' + built.text : built.text;

  return {
    ok: true,
    text,
    segments: built.segments,
    meta: buildMeta(strength, locale, rawText, text, clipped.truncated),
  };
}

export default optimize;

/* ------------------------------------------------------------------ meta -- */

function buildMeta(strength, locale, original, output, truncated) {
  return {
    strength,
    locale,
    engine: 'local',
    originalLength: original.length,
    optimizedLength: output.length,
    changed: output !== original,
    truncated: Boolean(truncated),
  };
}

function fail(reason, strength, locale, rawText) {
  return {
    ok: false,
    reason,
    text: '',
    segments: [],
    meta: {
      strength,
      locale,
      engine: 'local',
      originalLength: rawText.length,
      optimizedLength: 0,
      changed: false,
      truncated: false,
    },
  };
}

function normalizeStrength(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STRENGTHS.indexOf(s) !== -1 ? s : 'standard';
}

function normalizeLocale(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return s.indexOf('en') === 0 ? 'en' : 'zh';
}

/* -------------------------------------------------------------- assembly -- */

function assemble(strength, sourceText, dict, locale) {
  const units = splitUnits(sourceText);

  if (strength === 'light') {
    // light 只补「角色」与「输出要求」两段；原文整段作为主体追加，永不重复进这两段。
    const segments = [
      { key: 'role', title: dict.titles.role, body: deriveRole(sourceText, dict) },
      { key: 'output', title: dict.titles.output, body: deriveOutput(dict) },
    ];
    const text = render(segments) + '\n\n---\n\n' + sourceText;
    return { segments, text };
  }

  const buckets = classify(units);
  const segments = ORDER.map((key) => ({
    key,
    title: dict.titles[key],
    body: bodyFor(key, buckets, strength, dict, sourceText),
  }));

  const repaired = repairFidelity(segments, units);
  return { segments: repaired, text: render(repaired) };
}

function bodyFor(key, buckets, strength, dict, sourceText) {
  const list = buckets[key] || [];
  const deep = strength === 'deep';
  const out = [];

  if (list.length > 0) {
    for (const unit of list) {
      if (unit.type === 'code') out.push(unit.text); // 代码块整体保留，内部一个字符不改
      else out.push(deep ? '- ' + unit.text.trim() : unit.text);
    }
  } else {
    const derived =
      key === 'role'
        ? deriveRole(sourceText, dict)
        : key === 'output'
          ? deriveOutput(dict)
          : dict.placeholders[key];
    for (const line of derived.split('\n')) {
      out.push(deep && !isBullet(line) ? '- ' + line.trim() : line);
    }
  }

  if (deep && key === 'constraints') {
    for (const item of dict.acceptance) out.push('- ' + item);
  }

  return out.join('\n');
}

function render(segments) {
  return segments
    .map((s) => '### ' + s.title + '\n' + s.body.trim())
    .join('\n\n');
}

function deriveRole(sourceText, dict) {
  const hay = sourceText.toLowerCase();
  for (const preset of ROLE_PRESETS) {
    for (const word of preset.match) {
      if (hay.indexOf(word.toLowerCase()) !== -1) return preset[dict.code];
    }
  }
  return dict.defaultRole;
}

function deriveOutput(dict) {
  return dict.outputLines.map((line) => '- ' + line).join('\n');
}

function isBullet(line) {
  const t = line.trim();
  return t.indexOf('- ') === 0 || t.indexOf('* ') === 0 || /^\d+[.)]\s/.test(t);
}

/* --------------------------------------------------------------- fidelity -- */

/**
 * 兜底校验：把原文单元逐个回查输出的拼接体，凡未原样出现的单元立即补回 task 段。
 * 这是"不删减任何显式约束"的运行时保证，而不是靠构造函数自觉。
 */
function repairFidelity(segments, units) {
  const hay = segments.map((s) => s.body).join('\n');
  const missing = units.filter((u) => u.needle !== '' && hay.indexOf(u.needle) === -1);
  if (missing.length === 0) return segments;

  const extra = missing
    .map((u) => (u.type === 'code' ? u.text : u.text.trim()))
    .join('\n');
  const target = Math.max(0, segments.findIndex((s) => s.key === 'task'));
  const next = segments.slice();
  next[target] = { ...next[target], body: next[target].body + '\n' + extra };
  return next;
}

/* ------------------------------------------------------------- unit split -- */

function stripCr(line) {
  return line.length > 0 && line.charAt(line.length - 1) === '\r' ? line.slice(0, -1) : line;
}

/**
 * 围栏探测：返回 { char, len, bare } 或 null。
 * bare=true 表示这一行只有围栏本身（可作为闭合行），带语言标注只可能是开围栏。
 */
function fenceOf(line) {
  const t = line.trim();
  let char = '';
  if (t.indexOf(TICK + TICK + TICK) === 0) char = TICK;
  else if (t.indexOf('~~~') === 0) char = '~';
  else return null;

  let len = 0;
  while (t.charAt(len) === char) len += 1;
  const rest = t.slice(len).trim();
  return { char, len, bare: rest === '' };
}

/** 把原文切成原子单元：围栏代码块整体一个 code 单元，其余每行一个 line 单元 */
function splitUnits(text) {
  const lines = text.split('\n');
  const units = [];
  let buffer = null;
  let open = null;

  for (const raw of lines) {
    const line = stripCr(raw);
    if (open) {
      buffer.push(line);
      const f = fenceOf(line);
      if (f && f.char === open.char && f.len >= open.len && f.bare) {
        units.push(codeUnit(buffer));
        buffer = null;
        open = null;
      }
      continue;
    }
    const f = fenceOf(line);
    if (f) {
      open = f;
      buffer = [line];
      continue;
    }
    units.push(lineUnit(line));
  }
  if (buffer) units.push(codeUnit(buffer));
  return units;
}

function lineUnit(line) {
  const needle = line.trim();
  return { type: needle === '' ? 'blank' : 'line', text: line, needle };
}

function codeUnit(buffer) {
  const text = buffer.join('\n');
  return { type: 'code', text, needle: text.trim() };
}

/* ------------------------------------------------------------ classifying -- */

function classify(units) {
  const buckets = { role: [], task: [], context: [], output: [], constraints: [] };
  for (const unit of units) {
    if (unit.type === 'blank') continue;
    const key = unit.type === 'code' ? 'context' : classifyLine(unit.text);
    buckets[key].push(unit);
  }
  return buckets;
}

function classifyLine(line) {
  const lower = line.toLowerCase();
  for (const key of CLASSIFY_ORDER) {
    const words = KEYWORDS[key] || [];
    for (const word of words) {
      if (lower.indexOf(word.toLowerCase()) !== -1) return key;
    }
  }
  return 'task';
}

/* -------------------------------------------------------------- truncation -- */

/** 超长裁剪；若截断点落在围栏内部，则回退到该围栏起始处，绝不产出半截代码块 */
function clip(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const openAt = lastOpenFenceStart(cut);
  const safeEnd = openAt >= 0 ? openAt : cut.length;
  const safe = cut.slice(0, safeEnd).trimEnd();
  return { text: safe, truncated: true };
}

function lastOpenFenceStart(src) {
  const lines = src.split('\n');
  let offset = 0;
  let open = null;
  for (const raw of lines) {
    const f = fenceOf(stripCr(raw));
    if (f) {
      if (!open) open = { offset, char: f.char, len: f.len };
      else if (f.char === open.char && f.len >= open.len && f.bare) open = null;
    }
    offset += raw.length + 1;
  }
  return open ? open.offset : -1;
}

/* -------------------------------------------------------------- idempotency -- */

/**
 * 识别"已经是本引擎产物"的输入：五个标题齐备且顺序正确，或 light 形态（角色 + 输出要求）。
 * 命中即原样返回（changed:false），因此重复优化不会叠加标题。
 */
function parseOptimized(text) {
  const inverse = {};
  for (const code of Object.keys(LOCALES)) {
    const titles = LOCALES[code].titles;
    for (const key of ORDER) inverse[titles[key]] = key;
  }

  const lines = text.split('\n');
  const seen = [];
  const bodies = {};
  const titleOf = {};
  let current = null;

  for (const raw of lines) {
    const line = stripCr(raw);
    const head = line.indexOf('### ') === 0 ? line.slice(4).trim() : '';
    const key = head !== '' && Object.prototype.hasOwnProperty.call(inverse, head) ? inverse[head] : null;
    if (key) {
      current = key;
      if (!bodies[key]) {
        bodies[key] = [];
        seen.push(key);
        titleOf[key] = head;
      }
      continue;
    }
    if (current) bodies[current].push(line);
  }

  const full = ORDER.every((k) => seen.indexOf(k) !== -1);
  const lightForm = seen.length === 2 && seen.indexOf('role') !== -1 && seen.indexOf('output') !== -1;
  if (!full && !lightForm) return null;

  if (full) {
    let last = -1;
    for (const key of ORDER) {
      const at = seen.indexOf(key);
      if (at <= last) return null;
      last = at;
    }
  }

  return seen.map((key) => ({
    key,
    title: titleOf[key],
    body: (bodies[key] || []).join('\n').trim(),
  }));
}
