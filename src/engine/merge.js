/**
 * 归并引擎（P4a）：纯函数、无副作用、无 IO、无网络、无 DOM、无时钟、无第三方依赖。
 *
 * 职责：把一段自由文本按「角色 / 任务 / 上下文 / 输出要求 / 约束」五栏归并，
 * 未命中任何信号的句子落到兜底栏「其他」，并提供三道内容守恒校验
 * （句子守恒 / 硬 Token 守恒 / 栏目合法性）与两种失败处理策略（strict / lenient）。
 *
 * 硬性不变量：mergeSections 归入各栏的句子总数严格等于 splitSentences(text) 的条数，
 * 一条不多、一条不少 —— 任何句子都必须落到某一栏（含 other），不得丢弃、不得重复。
 */

/** 五个固定栏目及其顺序（§4.2：段名与顺序固定） */
export const SECTION_ORDER = ['role', 'task', 'context', 'output', 'constraint'];

/** 栏目中文名；other 为兜底栏，仅在有未归类句时才出现在渲染结果里 */
export const SECTION_TITLE = {
  role: '角色',
  task: '任务',
  context: '上下文',
  output: '输出要求',
  constraint: '约束',
  other: '其他',
};

/** 兜底栏标记（§4.2「未归类，请确认」，UI 直接展示） */
export const OTHER_NOTE = '(未归类，请确认)';

/** 空栏占位：恒输出五个段头，空段写 - （无） */
export const EMPTY_PLACEHOLDER = '- （无）';

const FENCE = String.fromCharCode(96, 96, 96);
const BACKTICK = String.fromCharCode(96);
const TERMINATORS = ['。', '！', '？', '；'];

/** §4.1 角色信号（高置信：人称 + 身份） */
const ROLE_SIGNALS = [
  '你是', '您是', '您将扮演', '扮演', '作为一名', '作为一位', '作为角色', '你的身份',
  '角色是', '身份是', 'act as', 'you are', 'your role', 'persona',
];

/** §4.1 任务信号（请求 / 动宾开头） */
const TASK_SIGNALS = [
  '请', '帮我', '麻烦', '给我', '实现', '生成', '分析', '写一个', '写一份', '改造', '创建',
  '构建', '修复', '优化', '审查', '评审', '总结', '翻译', '解释', '梳理', '整理', '设计',
  'create', 'write', 'generate', 'analyze', 'analyse', 'build', 'implement', 'fix',
  'translate', 'explain', 'review', 'refactor', 'draft', 'summarize', 'summarise',
];

/** 祈使句首动词（§4.1 低置信信号：动宾结构开头） */
const IMPERATIVE_HEADS = [
  '请', '帮我', '麻烦', '给我', '实现', '生成', '分析', '写', '改造', '创建', '构建',
  '修复', '优化', '审查', '评审', '总结', '翻译', '解释', '梳理', '整理', '设计',
  '对比', '补充', '说明', '给出', '列出', '输出', '返回',
];

/** §4.1 约束信号（否定 / 上下限 / 原样保留） */
const CONSTRAINT_SIGNALS = [
  '必须', '不得', '禁止', '严禁', '切勿', '只能', '不要', '不能', '不可', '务必',
  '仅限', '限定', '最多', '最少', '至少', '至多', '不超过', '不允许', '一律', '保留',
  '原样', '保持', '勿',
  'must', 'never', 'do not', "don't", 'only', 'at most', 'no more than', 'avoid',
  'without changing', 'keep',
];

/** §4.1 输出要求信号（格式 / 篇幅 / 结构化产出物） */
const OUTPUT_SIGNALS = [
  '格式', '字数', '长度', '语言', '表格', '分点', '列点', '要点', '字段', '返回结构',
  '列出', '输出', '返回',
  'json', 'markdown', 'yaml', 'xml', 'csv', 'output', 'format', 'table', 'bullet', 'field',
];

/** §4.1 上下文信号（背景 / 材料 / 引用） */
const CONTEXT_SIGNALS = [
  '背景', '上下文', '已知', '材料', '参考', '根据', '输入是', '用户是', '当前', '前提',
  '现状', '资料', '素材', '原文如下', 'http://', 'https://', '@',
  'background', 'context', 'reference', 'given', 'existing',
];

/** 收窄为字符串数组 */
function toList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function isLineStart(text, index) {
  if (index === 0) return true;
  const prev = text[index - 1];
  return prev === '\n' || prev === '\r';
}

/**
 * 按 。！？；与换行切句。
 * 行内代码（反引号内容）与代码围栏（三反引号块）内的内容不得被切碎：
 * 围栏整块算作一句，围栏内的换行不触发切分。
 * @param {string} text
 * @returns {string[]} 已去除首尾空白、丢弃空句的句子数组
 */
export function splitSentences(text) {
  const src = typeof text === 'string' ? text : '';
  const out = [];
  let buf = '';
  let index = 0;
  let inFence = false;

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed !== '') out.push(trimmed);
    buf = '';
  };

  while (index < src.length) {
    const ch = src[index];

    if (inFence) {
      if (ch === '\n' && src.startsWith(FENCE, index + 1)) {
        buf += '\n' + FENCE;
        index += 1 + FENCE.length;
        inFence = false;
        continue;
      }
      buf += ch;
      index += 1;
      continue;
    }

    if (ch === BACKTICK && src.startsWith(FENCE, index) && isLineStart(src, index)) {
      inFence = true;
      buf += FENCE;
      index += FENCE.length;
      continue;
    }

    if (ch === BACKTICK) {
      let run = 1;
      while (src[index + run] === BACKTICK) run += 1;
      const marker = BACKTICK.repeat(run);
      const close = src.indexOf(marker, index + run);
      const stop = close === -1 ? src.length : close + run;
      buf += src.slice(index, stop);
      index = stop;
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      flush();
      index += 1;
      continue;
    }

    if (TERMINATORS.indexOf(ch) !== -1) {
      buf += ch;
      flush();
      index += 1;
      continue;
    }

    buf += ch;
    index += 1;
  }

  flush();
  return out;
}

function hits(text, signals) {
  return signals.some((signal) => text.indexOf(signal) !== -1);
}

/** 命中集合：角色与任务由人称与句法独立判定，不参与 约束>输出要求>上下文 的优先级竞争 */
function analyzeSentence(sentence) {
  const raw = typeof sentence === 'string' ? sentence : '';
  const text = raw.trim().toLowerCase();
  const hit = { role: false, task: false, context: false, output: false, constraint: false };
  if (text === '') return hit;

  // 代码围栏整块不是可归类的自然语言句，保持原样落「其他」
  if (text.startsWith(FENCE)) return hit;

  const taskDeclared = /你的任务|任务是|task is/.test(text);
  hit.role = !taskDeclared && hits(text, ROLE_SIGNALS);
  hit.task = taskDeclared || hits(text, TASK_SIGNALS) || hits(text, IMPERATIVE_HEADS.slice(0, 5)) ||
    IMPERATIVE_HEADS.some((head) => text.startsWith(head));
  hit.constraint = hits(text, CONSTRAINT_SIGNALS);
  hit.output = hits(text, OUTPUT_SIGNALS);
  hit.context = hits(text, CONTEXT_SIGNALS);
  return hit;
}

/**
 * 单句归栏（§4.1 信号表 + §4.2 优先级）。
 * 判定顺序：角色（人称/身份）→ 约束 > 输出要求 > 上下文 → 任务（祈使句）→ other。
 * 角色/任务不参与优先级竞争；同时命中多栏时按 §4.2「约束 > 输出要求 > 上下文」取首个。
 * @param {string} sentence
 * @returns {'role'|'task'|'context'|'output'|'constraint'|'other'}
 */
export function classifySentence(sentence) {
  const hit = analyzeSentence(sentence);
  return pickSection(hit);
}

function pickSection(hit) {
  if (hit.role) return 'role';
  if (hit.constraint) return 'constraint';
  if (hit.output) return 'output';
  if (hit.context) return 'context';
  if (hit.task) return 'task';
  return 'other';
}

/**
 * 整段归并。不变量：各栏条目总数 === splitSentences(text).length。
 * @param {string} text
 * @returns {{ sections: { role: string[], task: string[], context: string[], output: string[], constraint: string[], other: string[] }, reassigned: Array<{ from: string, to: string, text: string }> }}
 *   reassigned：句子命中多栏且被优先级改判时记录（from = 按 SECTION_ORDER 的首个命中栏，to = 实际归入栏）
 */
export function mergeSections(text) {
  const sections = { role: [], task: [], context: [], output: [], constraint: [], other: [] };
  const reassigned = [];

  for (const sentence of splitSentences(text)) {
    const hit = analyzeSentence(sentence);
    const target = pickSection(hit);
    sections[target].push(sentence);

    const candidates = SECTION_ORDER.filter((key) => hit[key]);
    if (candidates.length > 1 && candidates[0] !== target) {
      reassigned.push({ from: candidates[0], to: target, text: sentence });
    }
  }

  return { sections, reassigned };
}

function renderBlock(title, items, note) {
  const lines = ['### ' + title];
  const body = toList(items);
  if (body.length === 0) {
    lines.push(EMPTY_PLACEHOLDER);
    return lines.join('\n');
  }
  for (const item of body) {
    lines.push(note ? '- ' + item + ' ' + note : '- ' + item);
  }
  return lines.join('\n');
}

/**
 * 排版：五个固定段头恒输出（空段写 - （无））；other 非空时追加「### 其他」并给条目加兜底标记。
 * 只做排版，不改写、不合并、不省略任何原句。
 * @param {{ role?: string[], task?: string[], context?: string[], output?: string[], constraint?: string[], other?: string[] }} sections
 * @returns {string}
 */
export function renderSections(sections) {
  const src = sections && typeof sections === 'object' ? sections : {};
  const blocks = SECTION_ORDER.map((key) => renderBlock(SECTION_TITLE[key], src[key], null));
  const other = toList(src.other);
  if (other.length > 0) blocks.push(renderBlock(SECTION_TITLE.other, other, OTHER_NOTE));
  return blocks.join('\n\n');
}

function normalize(text) {
  return String(text == null ? '' : text).replace(/\s+/g, '');
}

/** 提取行内代码内容，并把代码区域从待比对文本中遮蔽掉（避免重复计数） */
function scanCode(text) {
  const contents = [];
  const masked = text
    .replace(/\x60{3}[\s\S]*?\x60{3}/g, ' ')
    .replace(/\x60+([^\x60\n]+?)\x60+/g, (_full, body) => {
      const trimmed = String(body).trim();
      if (trimmed !== '') contents.push(trimmed);
      return ' ';
    });
  return { masked, contents };
}

/**
 * 提取硬 Token：数字（含小数与千分位）、URL、@引用、行内代码、连续全大写标识符（长度 >= 2）
 * @param {string} text
 * @returns {string[]}
 */
export function extractHardTokens(text) {
  const src = typeof text === 'string' ? text : '';
  const { masked, contents } = scanCode(src);
  const tokens = [];

  for (const match of masked.match(/(?:\d+(?:[.,]\d+)*)/g) || []) tokens.push(match);

  for (const match of masked.match(/https?:\/\/[^\s)）】,，。；;]+/g) || []) {
    tokens.push(match.replace(/[.,;:!?]+$/, ''));
  }

  for (const match of masked.match(/@[A-Za-z0-9_.\-]+/g) || []) tokens.push(match);

  for (const match of masked.match(/\b[A-Z][A-Z0-9_]{1,}\b/g) || []) tokens.push(match);

  for (const content of contents) tokens.push(content);

  return tokens;
}

function countTokens(text) {
  const counts = new Map();
  for (const token of extractHardTokens(text)) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function diffTokens(originalText, resultText) {
  const want = countTokens(originalText);
  const have = countTokens(resultText);
  const lost = [];
  for (const [token, expected] of want) {
    const actual = have.get(token) || 0;
    for (let index = actual; index < expected; index += 1) lost.push(token);
  }
  return lost;
}

/* ---------- 软守恒：关键片段覆盖率 ---------- */

/** 关键片段长度区间：2–4 个实义字符 */
const SOFT_PIECE_MIN = 2;
const SOFT_PIECE_MAX = 4;

/** 覆盖率阈值：低于它才判该句丢失（0.6 = 原句实义片段至少六成仍以原文形态出现） */
const SOFT_COVERAGE_THRESHOLD = 0.6;

/** 多字虚词：先整体剔除，避免虚词把实义片段粘成假片段 */
const SOFT_STOP_WORDS = [
  '还是', '或者', '但是', '因为', '所以', '如果', '可以', '这个', '那个', '我们', '你们',
  '他们', '怎么', '什么', '怎样', '如何', '已经', '非常', '觉得', '一个', '一些', '这种',
  '那样', '这样', '然后', '而且', '以及', '的话', '是不是', '有没有',
];

/** 单字虚词：逐字剔除（不含否定字「不 / 没 / 无 / 未」，否定走硬守恒层） */
const SOFT_STOP_CHARS = '的地得了着是在我你他她它这那有和与及也都就还很太要会能可把被让给对从向于么怎呢吗吧啊呀嘛请帮们之其而且则若';

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const ASCII_WORD_CHAR = /[0-9a-z]/;

/** 把一段实义串切成关键片段：2–4 字整串算一个，更长的串取全部 2/3/4 字子串 */
function pushRunPieces(run, pieces) {
  if (run.length < SOFT_PIECE_MIN) return;
  if (run.length <= SOFT_PIECE_MAX) {
    pieces.push(run);
    return;
  }
  for (let size = SOFT_PIECE_MIN; size <= SOFT_PIECE_MAX; size += 1) {
    for (let start = 0; start + size <= run.length; start += 1) pieces.push(run.slice(start, start + size));
  }
}

/**
 * 切关键片段：剔除虚词后按标点 / 空白切出实义串，再切 2–4 字片段。
 * 片段是原句的实义切片：重写会打散它，但不会让原句没有的片段凭空出现，
 * 所以片段覆盖率能区分「换了说法」与「丢了内容」。
 * @param {string} text
 * @returns {string[]} 去重后的片段
 */
function softPieces(text) {
  const src = typeof text === 'string' ? text.toLowerCase() : '';
  let staged = src;
  for (const word of SOFT_STOP_WORDS) staged = staged.split(word).join(' ');
  const pieces = [];
  let run = '';
  let word = '';
  const flushRun = () => {
    if (run !== '') {
      pushRunPieces(run, pieces);
      run = '';
    }
  };
  const flushWord = () => {
    if (word !== '') {
      if (word.length >= SOFT_PIECE_MIN) pieces.push(word);
      word = '';
    }
  };
  for (const ch of staged) {
    if (CJK_CHAR.test(ch)) {
      flushWord();
      if (SOFT_STOP_CHARS.indexOf(ch) === -1) run += ch;
      else flushRun();
      continue;
    }
    if (ASCII_WORD_CHAR.test(ch)) {
      flushRun();
      word += ch;
      continue;
    }
    flushRun();
    flushWord();
  }
  flushRun();
  flushWord();
  return Array.from(new Set(pieces));
}

/** 覆盖率 = 命中片段数 / 片段总数；切不出片段时返回 null（交回字面判定） */
function coverageOf(sentence, flat) {
  const pieces = softPieces(sentence);
  if (pieces.length === 0) return null;
  let hit = 0;
  for (const piece of pieces) if (flat.indexOf(piece) !== -1) hit += 1;
  return hit / pieces.length;
}

/**
 * 反义极性轴：同一条轴上的两个方向，组内同义同向（提高 / 提升），组间互为反义（提高 / 降低）。
 * 覆盖率只数「片段还在不在」—— 提高→降低 时除「提高」外的片段全命中，覆盖率仍高于阈值，
 * 所以方向被翻转必须由这一层单独守。
 */
const SOFT_POLARITY_AXES = [
  ['增减', ['提高', '增加', '上升', '提升', '增强', '扩大', '加快'], ['降低', '减少', '下降', '削弱', '缩小', '减慢', '减弱']],
  ['许可', ['允许', '启用', '开启', '支持'], ['禁止', '禁用', '关闭', '反对']],
  ['极值', ['最大'], ['最小']],
  ['频次', ['总是', '始终'], ['从不', '绝不']],
  ['时序', ['before'], ['after']],
  ['增减-en', ['increase', 'raise', 'boost'], ['decrease', 'reduce', 'lower']],
  ['许可-en', ['allow', 'enable', 'permit'], ['forbid', 'disable', 'deny']],
];

/** 极性词紧邻的否定字 / 词：不允许、不提高、not increase 是反向表达，不能按本方向计数 */
const POLARITY_NEG_CHARS = '不没未别无莫';
const POLARITY_NEG_WORDS = ['not', 'no', 'never', 'nor'];
const POLARITY_ASCII_WORD = /^[a-z0-9']+$/;

/**
 * 计一个极性词的有效次数：CJK 按字面、ASCII 按词边界（allow 不命中 allowlist），
 * 紧邻否定的匹配不计入本方向。
 * @param {string} text
 * @param {string} word
 * @returns {number}
 */
function polarityHits(text, word) {
  const hay = typeof text === 'string' ? text.toLowerCase() : '';
  const needle = typeof word === 'string' ? word.toLowerCase() : '';
  if (hay === '' || needle === '') return 0;
  const ascii = POLARITY_ASCII_WORD.test(needle);
  let hits = 0;
  let from = hay.indexOf(needle);
  while (from !== -1) {
    const lead = from > 0 ? hay.charAt(from - 1) : '';
    const tail = hay.charAt(from + needle.length);
    const boundaryBad = ascii && (/[a-z0-9]/.test(lead) || /[a-z0-9]/.test(tail));
    const leadWord = from === 0 ? '' : (hay.slice(0, from).match(/[a-z']+\s*$/) || [''])[0].trim();
    const negated =
      (lead !== '' && POLARITY_NEG_CHARS.indexOf(lead) !== -1) ||
      (ascii && POLARITY_NEG_WORDS.indexOf(leadWord) !== -1);
    if (!boundaryBad && !negated) hits += 1;
    from = hay.indexOf(needle, from + needle.length);
  }
  return hits;
}

/**
 * 该方向全部词的有效次数之和。同时给出原文（保留空白，ASCII 靠词边界计）与归一化文本
 * （去空白，CJK 被换行拆开时也能命中），每个词取两者较大值，避免一种形态漏计。
 * @param {string[]} texts
 * @param {string[]} words
 * @returns {number}
 */
function polarityCount(texts, words) {
  let total = 0;
  for (const word of words) {
    let best = 0;
    for (const text of texts) best = Math.max(best, polarityHits(text, word));
    total += best;
  }
  return total;
}

/** 该方向里第一个真正出现的词（供 details 文案用），没有则返回空串 */
function firstPolarityWord(texts, words) {
  for (const word of words) {
    for (const text of texts) if (polarityHits(text, word) > 0) return word;
  }
  return '';
}

/**
 * 反义极性冲突：原句用了某方向的极性词，结果里该方向整体缺失、却出现同轴反向词。
 * 同向同义（提高 / 提升）不冲突；反向词也没出现时不算冲突，仍归覆盖率判定。
 * @param {string} sentence 原句
 * @param {string} result 结果全文（原文形态 + 归一化形态一起看）
 * @param {string} flat 归一化并小写后的结果全文
 * @returns {string} 冲突说明（空串 = 无冲突）
 */
function polarityConflictOf(sentence, result, flat) {
  const mineTexts = [sentence];
  const hayTexts = [result, flat];
  for (const [label, forward, backward] of SOFT_POLARITY_AXES) {
    for (const [mine, opposite] of [[forward, backward], [backward, forward]]) {
      if (polarityCount(mineTexts, mine) === 0) continue;
      // 原方向还在结果里：方向没被翻转
      if (polarityCount(hayTexts, mine) > 0) continue;
      // 反向词也没出现：属覆盖率范畴，不在这一层判
      if (polarityCount(hayTexts, opposite) === 0) continue;
      return label + '「' + firstPolarityWord(mineTexts, mine) + '」被改成「' + firstPolarityWord(hayTexts, opposite) + '」';
    }
  }
  return '';
}

/**
 * 硬守恒层的否定词族：守的是「否定语义没丢」，不是「否定词字节没丢」。
 * 同族内任一写法命中即视为该族满足（不要 ⇄ 请勿 这类极性替换不算丢），但族内总出现
 * 次数不得减少 —— 次数是信息量，仍按零容忍处理。
 */
const HARD_NEGATION_FAMILIES = [
  ['不要', '不许', '不得', '禁止', '严禁', '切勿', '请勿', '不能', '不可'],
  ['never', 'do not', "don't", 'must not'],
];

/** 复合词排除：命中位置前一个字若在此表里，它只是「能不能 / 可不可以 / 是不是 / 会不会 / 不得不」里的片段，不算否定 */
const NEGATION_LEAD_EXCLUDE = ['能', '可', '是', '否', '会', '不', '得'];

/** 只有以「能 / 可 / 得」结尾的否定词才会被复合词吞掉，才需要看相邻的字 */
const NEGATION_TAIL_CHARS = '能可得';

/**
 * 计次：ASCII 词按词边界比对（never 不命中 whenever）；CJK 词按字面计次，但剔除复合词片段。
 * @param {string} text
 * @param {string} word
 * @returns {number}
 */
function countWord(text, word) {
  const needle = typeof word === 'string' ? word.toLowerCase() : '';
  if (needle === '') return 0;
  const hay = typeof text === 'string' ? text.toLowerCase() : '';
  if (/^[a-z0-9' ]+$/.test(needle)) {
    const padded = ' ' + hay.replace(/[^a-z0-9']+/g, ' ').replace(/ +/g, ' ').trim() + ' ';
    return padded.split(' ' + needle + ' ').length - 1;
  }
  const guardLead = NEGATION_TAIL_CHARS.indexOf(needle.charAt(needle.length - 1)) !== -1;
  let count = 0;
  let from = hay.indexOf(needle);
  while (from !== -1) {
    const lead = from > 0 ? hay.charAt(from - 1) : '';
    const next = hay.charAt(from + needle.length);
    // 前一个字构成复合词（能不能 / 可不可以 / 是不是 / 会不会）或是「不得不 / 不能不」这类双重否定表肯定，都不算否定
    const compound = guardLead && NEGATION_LEAD_EXCLUDE.indexOf(lead) !== -1;
    const doubleNegative = guardLead && next === '不';
    if (!compound && !doubleNegative) count += 1;
    from = hay.indexOf(needle, from + needle.length);
  }
  return count;
}

/** 族计数：族内各写法的有效次数之和 */
function familyCount(text, family) {
  let total = 0;
  for (const word of family) total += countWord(text, word);
  return total;
}

/**
 * 否定语义守恒：按族比较原文与结果的计数，差的次数以族标签（族内首个词）推入 lostTokens，
 * 保证 lostTokens 仍是 string[] 且可直接显示。
 */
function diffNegations(originalText, resultText) {
  const lost = [];
  for (const family of HARD_NEGATION_FAMILIES) {
    const want = familyCount(originalText, family);
    if (want === 0) continue;
    const have = familyCount(resultText, family);
    for (let index = have; index < want; index += 1) lost.push(family[0]);
  }
  return lost;
}

function checkSections(resultText) {
  const details = [];
  const expected = SECTION_ORDER.map((key) => SECTION_TITLE[key]);
  const heads = [];
  for (const match of resultText.match(/^###\s+(.+)$/gm) || []) heads.push(match.replace(/^###\s+/, '').trim());

  const real = heads.filter((title) => title !== SECTION_TITLE.other);
  let ok = true;

  if (real.length !== expected.length) {
    ok = false;
    details.push('段头数量应为 ' + expected.length + ' 个，实际 ' + real.length + ' 个');
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (real[index] !== expected[index]) {
      ok = false;
      details.push('第 ' + (index + 1) + ' 段应为「' + expected[index] + '」，实际「' + (real[index] || '缺失') + '」');
    }
  }
  const otherCount = heads.length - real.length;
  if (otherCount > 1) {
    ok = false;
    details.push('「' + SECTION_TITLE.other + '」段重复出现 ' + otherCount + ' 次');
  }
  if (otherCount === 1 && heads[heads.length - 1] !== SECTION_TITLE.other) {
    ok = false;
    details.push('「' + SECTION_TITLE.other + '」段必须位于五段之后');
  }
  return { ok, details };
}

/**
 * 三道内容守恒校验（§4.3）：硬 Token 零容忍 + 句子关键片段覆盖率 + 栏目合法性。
 * 软守恒口径：原句不再要求字面复现，只要求关键片段覆盖率不低于 SOFT_COVERAGE_THRESHOLD ——
 * 表达被重写但原意保住时 dropped 为空，真正丢信息时才判 dropped。
 * 极性口径：软守恒通过后再判一次反义冲突 —— 原句的极性方向在结果里消失、却出现同轴反向词
 * （提高 → 降低）时，覆盖率照样合格，同样判该句丢内容。
 * 硬守恒口径不变：extractHardTokens 的 token 与否定词必须逐个出现，缺一个就 ok=false。
 * @param {string} originalText 原文
 * @param {string} resultText 结果
 * @returns {{ ok: boolean, dropped: string[], lostTokens: string[], sectionValid: boolean, details: string[] }}
 *   dropped/lostTokens 均为原文原文（便于 UI 直接显示）
 */
export function verifyConservation(originalText, resultText) {
  const original = typeof originalText === 'string' ? originalText : '';
  const result = typeof resultText === 'string' ? resultText : '';
  const details = [];
  try {
    const flat = normalize(result).toLowerCase();
    const dropped = [];
    const polarityConflicts = [];
    for (const sentence of splitSentences(original)) {
      if (flat.indexOf(normalize(sentence).toLowerCase()) !== -1) continue;
      // 代码围栏整块按字面守恒：程序片段不允许被「重写」
      if (sentence.indexOf(FENCE) === 0) {
        dropped.push(sentence);
        continue;
      }
      const coverage = coverageOf(sentence, flat);
      if (coverage === null || coverage < SOFT_COVERAGE_THRESHOLD) {
        dropped.push(sentence);
        continue;
      }
      // 覆盖率只数片段在不在：提高→降低 时其余片段全命中，通过后必须再判一次极性方向
      const conflict = polarityConflictOf(sentence, result, flat);
      if (conflict !== '') {
        dropped.push(sentence);
        polarityConflicts.push(conflict);
      }
    }

    const lostTokens = diffTokens(original, result).concat(diffNegations(original, result));
    const checked = checkSections(result);

    if (dropped.length > 0) details.push('有 ' + dropped.length + ' 处内容未能保真（原句关键片段覆盖率低于 ' + SOFT_COVERAGE_THRESHOLD + '，或极性方向被翻转）');
    if (polarityConflicts.length > 0) details.push('有 ' + polarityConflicts.length + ' 处反义极性冲突：' + polarityConflicts.join('；'));
    if (lostTokens.length > 0) details.push('有 ' + lostTokens.length + ' 处硬 Token 丢失：' + lostTokens.join('、'));
    for (const line of checked.details) details.push(line);

    const ok = dropped.length === 0 && lostTokens.length === 0 && checked.ok;
    return { ok, dropped, lostTokens, sectionValid: checked.ok, details };
  } catch (error) {
    return {
      ok: false,
      dropped: [],
      lostTokens: [],
      sectionValid: false,
      details: ['守恒校验异常：' + (error instanceof Error ? error.message : String(error))],
    };
  }
}

function appendToOther(text, lines) {
  const src = typeof text === 'string' ? text : '';
  const rows = src.split(/\r?\n/);
  const header = '### ' + SECTION_TITLE.other;
  const headerIndex = rows.findIndex((row) => row.trim() === header);

  if (headerIndex === -1) {
    const parts = [];
    const trimmed = src.replace(/\s+$/, '');
    if (trimmed !== '') parts.push(trimmed, '');
    parts.push(header);
    for (const line of lines) parts.push(line);
    return parts.join('\n');
  }

  let end = rows.length;
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    if (/^###\s+/.test(rows[index])) {
      end = index;
      break;
    }
  }

  let insertAt = end;
  while (insertAt > headerIndex + 1 && rows[insertAt - 1].trim() === '') insertAt -= 1;

  const existing = rows.slice(headerIndex + 1, insertAt);
  const hasContent = existing.some((row) => row.trim() !== '' && row.trim() !== EMPTY_PLACEHOLDER);
  const body = hasContent ? existing : [];

  return [...rows.slice(0, headerIndex + 1), ...body, ...lines, ...rows.slice(insertAt)].join('\n');
}

/** 段头行号：只认整行就是「### 段名」的行 */
function findSectionHead(rows, title) {
  const header = '### ' + title;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].trim() === header) return index;
  }
  return -1;
}

/**
 * 段头兜底：按 SECTION_ORDER 补齐缺失段头，缺的段写一行空段占位（与 renderSections 同语义）。
 * 只修结构，不动任何已有内容；插入点取「顺序上后一个已存在的段头」之前，「其他」之前次之，末尾兜底。
 * @param {string} text
 * @returns {{ text: string, added: string[] }} added = 被补齐的段名（有则说明文本被改写过）
 */
function backfillSections(text) {
  const src = typeof text === 'string' ? text : '';
  const expected = SECTION_ORDER.map((key) => SECTION_TITLE[key]);
  const added = [];
  let rows = src.split(/\r?\n/);
  // 一条段头都没有的结果不是「缺段头」而是「没按格式产出」：凭空补五段空壳只会盖掉用户输入，交回 strict/lenient 原有内容口径处理
  if (!rows.some((row) => /^###\s+/.test(row.trim()))) return { text: src, added };

  for (let index = 0; index < expected.length; index += 1) {
    const title = expected[index];
    if (findSectionHead(rows, title) !== -1) continue;

    let at = -1;
    for (let next = index + 1; next < expected.length && at === -1; next += 1) {
      at = findSectionHead(rows, expected[next]);
    }
    if (at === -1) at = findSectionHead(rows, SECTION_TITLE.other);

    if (at === -1) {
      while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
      rows = rows.concat(['', '### ' + title, EMPTY_PLACEHOLDER]);
    } else {
      rows = [...rows.slice(0, at), '', '### ' + title, EMPTY_PLACEHOLDER, '', ...rows.slice(at)];
    }
    added.push(title);
  }

  if (added.length === 0) return { text: src, added };
  return { text: rows.join('\n').replace(/^\n+/, ''), added };
}

/**
 * 按 mergeMode 处理校验失败（§4.3）。
 * 顺序：先做结构兜底（缺段头按 SECTION_ORDER 补齐并写进 report.details），再按模式处理内容。
 * strict：内容原样返回、不补回任何句子，applied 只在真的补过段头时为 true。
 * lenient：把 dropped 句与 lostTokens 补进「### 其他」并标注，applied=true。
 * 永不抛错：任何异常都降级为「原文内容未补偿」的 strict 形状。
 * @param {string} originalText
 * @param {string} resultText
 * @param {'strict'|'lenient'} mode
 * @returns {{ text: string, mode: string, applied: boolean, report: object }}
 */
export function applyConservation(originalText, resultText, mode) {
  const result = typeof resultText === 'string' ? resultText : '';
  const chosen = mode === 'lenient' ? 'lenient' : 'strict';

  try {
    const repaired = backfillSections(result);
    const base = repaired.text;
    // backfilled：给上层区分「只补了段头」与「补回了句子」用（engine.js 的提示文案依赖它），无补齐时为 []
    const report = { ...verifyConservation(originalText, base), backfilled: repaired.added };
    if (repaired.added.length > 0) {
      report.details.unshift('段头缺失已兜底：补齐 ' + repaired.added.length + ' 个段头（' + repaired.added.join('、') + '），各写一行 ' + EMPTY_PLACEHOLDER + ' 占位');
    }
    // applied 的口径：返回值相对入参是否被改写过（段头兜底与内容补回都算改写）
    const applied = base !== result;

    if (report.ok) return { text: base, mode: chosen, applied, report };
    if (chosen === 'strict') return { text: base, mode: 'strict', applied, report };

    const additions = [];
    for (const sentence of report.dropped) additions.push('- ' + sentence + ' ' + OTHER_NOTE);

    // 补回原句通常已经带回了其中的数字 / URL / 否定词，只对仍然缺失的 token 追加标注，避免重复
    const projected = base + '\n' + report.dropped.join('\n');
    const stillLost = diffTokens(originalText, projected).concat(diffNegations(originalText, projected));
    for (const token of stillLost) additions.push('- 丢失的原文 token：' + token + ' ' + OTHER_NOTE);

    if (additions.length === 0) {
      for (const key of SECTION_ORDER) {
        if (base.indexOf('### ' + SECTION_TITLE[key]) === -1) {
          additions.push('- 缺失栏目：' + SECTION_TITLE[key] + ' ' + OTHER_NOTE);
        }
      }
    }
    // 没有任何可补内容时不得凭空造一个空「其他」栏
    if (additions.length === 0) {
      return { text: base, mode: 'lenient', applied, report: { ...report, compensated: 0, recheckOk: report.ok } };
    }

    const patched = appendToOther(base, additions);
    const recheck = verifyConservation(originalText, patched);
    return {
      text: patched,
      mode: 'lenient',
      applied: true,
      report: { ...report, compensated: additions.length, recheckOk: recheck.ok },
    };
  } catch (error) {
    return {
      text: result,
      mode: chosen,
      applied: false,
      report: {
        ok: false,
        dropped: [],
        lostTokens: [],
        sectionValid: false,
        backfilled: [],
        details: ['守恒兜底异常：' + (error instanceof Error ? error.message : String(error))],
      },
    };
  }
}
