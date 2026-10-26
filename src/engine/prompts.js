/**
 * 本地提示词优化引擎 —— 静态资源表
 * 纯数据 + 纯字符串常量：无副作用、无第三方依赖、无网络、无时钟。
 */

/** 五段固定顺序（zh/en 共用） */
export const ORDER = ['role', 'task', 'context', 'output', 'constraints'];

/**
 * 单行归类的判定优先级：先命中先归位。
 * role 最先（"你是…"句式最独特），output 次之（"输出/格式/json"），
 * constraints 再次（"不得/禁止/must"），context 再次（"背景/参考/URL/@引用"），
 * 其余全部落到 task（默认桶，保证零丢失）。
 */
export const CLASSIFY_ORDER = ['role', 'output', 'constraints', 'context', 'task'];

/** 原文长度上限；超出后保留前 N 字符（围栏安全） */
export const MAX_LENGTH = 8000;

export const LOCALES = {
  zh: {
    code: 'zh',
    titles: {
      role: '角色',
      task: '任务',
      context: '上下文',
      output: '输出要求',
      constraints: '约束',
    },
    truncatedNote: '> （原文过长已截断）',
    placeholders: {
      role: '（原文未指定角色，以下为默认设定）',
      task: '（原始需求见上下文中的原文片段）',
      context: '（原文未提供额外上下文）',
      output: '（原文未指定输出格式）',
      constraints: '（原文未显式声明约束）',
    },
    defaultRole: '你是一名严谨、专业的助手：只依据已给出的信息作答，结论明确、可直接执行。',
    outputLines: [
      '直接给出结果，不重复题目与要求。',
      '使用与原文一致的语言作答。',
      '信息不足时先列出需要补充的关键信息，不要臆测。',
    ],
    acceptance: [
      '验收：输出中出现的所有数字、专有名词、链接与原文完全一致。',
      '验收：原文中每一条否定/禁止类约束都被遵守，无一例外。',
      '验收：按上述五段结构作答，五段齐备且顺序不变。',
    ],
  },
  en: {
    code: 'en',
    titles: {
      role: 'Role',
      task: 'Task',
      context: 'Context',
      output: 'Output',
      constraints: 'Constraints',
    },
    truncatedNote: '> (truncated)',
    placeholders: {
      role: '(no role was specified in the source; default used)',
      task: '(the request is carried by the source fragment in Context)',
      context: '(the source provides no extra context)',
      output: '(the source specifies no output shape)',
      constraints: '(the source declares no explicit constraints)',
    },
    defaultRole: 'You are a rigorous, professional assistant: answer only from the given information, and make the result concrete and directly usable.',
    outputLines: [
      'Return the result directly; do not restate the prompt.',
      'Answer in the same language as the source.',
      'If information is missing, list what is needed instead of guessing.',
    ],
    acceptance: [
      'Acceptance: every number, proper noun, and link matches the source exactly.',
      'Acceptance: every negative constraint from the source is honored without exception.',
      'Acceptance: answer in the five sections above, in the given order, without omitting any.',
    ],
  },
};

/** 角色启发式：按关键词命中挑选领域人设；都不命中时用 locale 的 defaultRole */
export const ROLE_PRESETS = [
  {
    match: ['代码', '编程', '函数', '脚本', '重构', '单元测试', 'code', 'function', 'script', 'refactor', 'bug', 'api'],
    zh: '你是一名资深软件工程师，熟悉多语言与工程实践：回答直接、结论明确、可直接落地。',
    en: 'You are a senior software engineer with broad language and engineering experience: direct, decisive, and directly applicable.',
  },
  {
    match: ['数据', '分析', '统计', '报表', '指标', '口径', 'data', 'analysis', 'analytics', 'metric', 'sql'],
    zh: '你是一名资深数据分析师：先给结论，再给依据与口径，数字必须与原文一致。',
    en: 'You are a senior data analyst: conclusion first, then evidence and definitions; numbers must match the source.',
  },
  {
    match: ['文案', '写作', '润色', '营销', '标题', '种草', 'copy', 'writing', 'rewrite', 'tone', 'slogan'],
    zh: '你是一名资深中文文案编辑：语言干净、结构清晰、避免套话与空泛表达。',
    en: 'You are a seasoned copy editor: clean wording, clear structure, no filler or vague claims.',
  },
  {
    match: ['翻译', 'translate', 'translation', 'localize', '本地化'],
    zh: '你是一名严谨的双语译者：忠实原意，术语统一，不增删信息。',
    en: 'You are a rigorous bilingual translator: faithful to the meaning, consistent terminology, no added or dropped information.',
  },
  {
    match: ['设计', '界面', '排版', '配色', '交互', 'design', 'ui', 'ux', 'layout'],
    zh: '你是一名资深产品设计师：兼顾信息层级、可用性与实现成本。',
    en: 'You are a senior product designer: balance hierarchy, usability, and implementation cost.',
  },
  {
    match: ['论文', '研究', '文献', '综述', '实验', 'research', 'paper', 'literature', 'study'],
    zh: '你是一名严谨的研究助理：结论需有依据，不臆造事实与引用。',
    en: 'You are a rigorous research assistant: conclusions must be grounded; never invent facts or citations.',
  },
];

/** 单行归类的关键词表；en 关键词用小写比对 */
export const KEYWORDS = {
  role: [
    '你是', '您将扮演', '扮演', '作为一名', '作为一位', '你的身份', '角色是',
    'act as', 'you are', 'you will act', 'your role', 'persona',
  ],
  output: [
    '输出', '返回', '格式', '字段', '表格', '列出', '分点', '要点', '列点', '字数',
    'json', 'markdown', 'yaml', 'xml', 'csv', 'output', 'return', 'format', 'table',
    'bullet', 'field', 'list',
  ],
  constraints: [
    '不得', '不要', '不能', '不可', '禁止', '严禁', '勿', '必须', '务必', '只能',
    '一律', '至少', '至多', '不超过', '限定', '仅限', '不允许', '保持',
    'must', 'never', 'do not', "don't", 'only', 'at most', 'no more than', 'avoid',
    'keep', 'without changing',
  ],
  context: [
    '背景', '上下文', '参考', '已知', '现状', '前提', '资料', '素材', '原文如下',
    'http://', 'https://', '@',
    'background', 'context', 'reference', 'given', 'existing',
  ],
  task: [
    '请', '帮我', '生成', '写', '分析', '总结', '改写', '优化', '实现', '修复',
    '翻译', '解释', '评审', '审查', '梳理', '整理',
    'create', 'write', 'generate', 'analyze', 'analyse', 'summarise', 'summarize',
    'build', 'implement', 'fix', 'translate', 'explain', 'review', 'refactor', 'draft',
  ],
};
