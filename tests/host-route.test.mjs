import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apply,
  buildSystemPrompt,
  Config,
  maskApiKey,
  MODELS_ROUTE_PATH,
  normalizeHostModels,
  normalizeHostSettings,
  registerModelsRoute,
  registerOptimizeRoute,
  ROUTE_PATH,
  validateHostModel,
} from '../src/host/index.js';
import { FAILURE_TEXT, optimizeViaRemote } from '../src/client/llm.js';

const ENDPOINT = 'https://llm.example.com/v1/chat/completions';
const KEY = 'sk-test-secret-value';
const ORIGIN = 'http://127.0.0.1:7244';
const SAMPLE = '你是一名资深前端工程师。请审查下面这段代码，找出兼容性问题。不得删改原有逻辑。';

const baseConfig = () => ({
  llmEndpoint: ENDPOINT,
  llmApiKey: KEY,
  llmModel: 'gpt-4o-mini',
  llmTemperature: 0.2,
  llmTimeoutMs: 30000,
});

/** 假 ctx：inject 立即回调 scoped，scoped.get 给出带 register 的 connection，effect 立即执行 fn。 */
function makeCtx() {
  const calls = { inject: 0, dependencies: null, effect: 0, labels: [], routes: [], thisValues: [] };
  const ctx = {
    inject(dependencies, callback) {
      calls.inject += 1;
      calls.dependencies = dependencies;
      const fetchFace = {
        register(route) {
          calls.routes.push(route);
          calls.thisValues.push(this);
          return () => {};
        },
      };
      callback({
        get: (service) => (service === 'connection' ? { fetch: fetchFace } : undefined),
        effect: (fn, label) => {
          calls.effect += 1;
          calls.labels.push(label);
          return fn();
        },
      });
    },
  };
  return { ctx, calls };
}

/** makeCtx() + 直接把注册跑起来（等价于 apply 里的注册那一步）。 */
function harness(config, fetchImpl, deps) {
  const built = makeCtx();
  registerOptimizeRoute(built.ctx, config, { fetchImpl, ...deps });
  return built.calls;
}

/** 只注册模型表通路；deps.dataDir 指向临时目录，写盘断言不落真实用户目录。 */
function harnessModels(config, deps) {
  const built = makeCtx();
  registerModelsRoute(built.ctx, config, deps);
  return built.calls;
}

/** 临时目录：用完即删（落盘相关断言一律走这里）。 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'po-host-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 一条合法的模型条目，按需覆盖字段。 */
const modelEntry = (overrides = {}) => ({
  id: 'm-1',
  name: 'DeepSeek 官方',
  endpoint: 'https://table.example.com/v1/chat/completions',
  apiKey: 'sk-table-secret-a1b2',
  model: 'deepseek-chat',
  isDefault: true,
  ...overrides,
});

/** 发给模型表通路的请求。 */
const modelsRequest = (method, body) =>
  new Request(ORIGIN + MODELS_ROUTE_PATH, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** 记录每次上游调用的假 fetch。 */
function recorder(reply) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return reply(url, init);
  };
  return { fetchImpl, seen };
}

const okReply = (content) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const post = (body) =>
  new Request(ORIGIN + ROUTE_PATH, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const json = async (response) => JSON.parse(await response.text());

// ---------------------------------------------------------------- 1. 注册形状

test('注册形状：/api 前缀、methods 含 POST、requestBody buffered、inject 与 register 各一次', () => {
  const { fetchImpl } = recorder(() => okReply('x'));
  const calls = harness(baseConfig(), fetchImpl);
  assert.equal(calls.inject, 1, 'ctx.inject 必须恰好调用一次');
  assert.deepEqual(calls.dependencies, ['connection']);
  assert.equal(calls.effect, 1, '副作用必须挂一次 scoped.effect');
  assert.equal(calls.routes.length, 1, 'register 必须恰好调用一次');
  assert.equal(typeof calls.thisValues[0].register, 'function', 'register 必须以 connection.fetch 为 this 调用');
  const route = calls.routes[0];
  assert.equal(route.path, ROUTE_PATH);
  assert.ok(route.path.startsWith('/api'), 'path 必须以 /api 开头，否则装载期抛错');
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.requestBody, 'buffered');
  assert.equal(typeof route.fetch, 'function');
});

// ---------------------------------------------------------------- 2. 成功路径

test('成功路径：200 + { ok, text }，上游 URL / 头 / 体全部可断言', async () => {
  const CONTENT = '### 角色\n资深前端工程师\n### 任务\n审查代码';
  const { fetchImpl, seen } = recorder(() => okReply(CONTENT));
  const calls = harness(baseConfig(), fetchImpl);

  const response = await calls.routes[0].fetch(post({ text: SAMPLE, strength: 'deep', locale: 'zh' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, text: CONTENT });

  assert.equal(seen.length, 1);
  const [{ url, init }] = seen;
  assert.equal(url, ENDPOINT, '上游地址必须恰为 llmEndpoint');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error', '不得跟随重定向：跟出去等于绕开配置里的地址');
  assert.ok(init.signal instanceof AbortSignal, '必须带超时信号');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers.authorization, 'Bearer ' + KEY);

  const payload = JSON.parse(init.body);
  assert.deepEqual(Object.keys(payload).sort(), ['messages', 'model', 'temperature'], 'body 不得夹带请求体里的任何字段');
  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[0].role, 'system');
  for (const section of ['### 角色', '### 任务', '### 上下文', '### 输出要求', '### 约束']) {
    assert.ok(payload.messages[0].content.includes(section), '系统提示词缺段 ' + section);
  }
  assert.deepEqual(payload.messages[1], { role: 'user', content: SAMPLE });
});

test('llmApiKey 为空时不发 Authorization 头', async () => {
  const { fetchImpl, seen } = recorder(() => okReply('ok'));
  const calls = harness({ ...baseConfig(), llmApiKey: '' }, fetchImpl);
  await calls.routes[0].fetch(post({ text: SAMPLE }));
  assert.equal('authorization' in seen[0].init.headers, false);
});

// ---------------------------------------------------------------- 3. 上游失败归一

test('上游 500 → 502，且不透传上游 body 与密钥', async () => {
  const { fetchImpl } = recorder(() => new Response('internal boom ' + KEY, { status: 500 }));
  const calls = harness(baseConfig(), fetchImpl);
  const response = await calls.routes[0].fetch(post({ text: SAMPLE }));
  assert.equal(response.status, 502);
  const body = await json(response);
  assert.equal(typeof body.error, 'string');
  assert.ok(!JSON.stringify(body).includes(KEY), '错误信息不得泄漏密钥');
  assert.ok(!JSON.stringify(body).includes('boom'), '不得透传上游 body');
});

test('上游返回非 JSON → 502', async () => {
  const { fetchImpl } = recorder(() => new Response('<html>nope</html>', { status: 200 }));
  const calls = harness(baseConfig(), fetchImpl);
  const response = await calls.routes[0].fetch(post({ text: SAMPLE }));
  assert.equal(response.status, 502);
  assert.equal(typeof (await json(response)).error, 'string');
});

test('上游 content 为空 / 形状不符 → 502', async () => {
  const replies = [
    () => new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 }),
    () => new Response(JSON.stringify({ choices: [{ message: { content: 42 } }] }), { status: 200 }),
    () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    () => new Response(JSON.stringify({}), { status: 200 }),
  ];
  for (const reply of replies) {
    const { fetchImpl } = recorder(reply);
    const calls = harness(baseConfig(), fetchImpl);
    const response = await calls.routes[0].fetch(post({ text: SAMPLE }));
    assert.equal(response.status, 502, '形状不符必须归一成 502');
  }
});

test('超时 / 中止 → 504；其它网络异常 → 502', async () => {
  const timeoutish = ['TimeoutError', 'AbortError'];
  for (const name of timeoutish) {
    const { fetchImpl } = recorder(() => {
      throw new DOMException('gone', name);
    });
    const calls = harness(baseConfig(), fetchImpl);
    const response = await calls.routes[0].fetch(post({ text: SAMPLE }));
    assert.equal(response.status, 504, name + ' 必须归一成 504');
  }
  const { fetchImpl } = recorder(() => {
    throw new TypeError('fetch failed');
  });
  const calls = harness(baseConfig(), fetchImpl);
  assert.equal((await calls.routes[0].fetch(post({ text: SAMPLE }))).status, 502);
});

// ---------------------------------------------------------------- 4. 配置校验

test('Config 校验：合法 config → value 收窄且两个数字落到默认值', () => {
  const outcome = Config['~standard'].validate({ llmEndpoint: ENDPOINT });
  assert.deepEqual(outcome, {
    value: { llmEndpoint: ENDPOINT, llmApiKey: '', llmModel: '', llmTemperature: 0.2, llmTimeoutMs: 30000 },
  });
});

test('Config 校验：缺失 / 非 URL / 带凭据 / 带 fragment / 非白名单字段 → issues', () => {
  const cases = [
    [{ llmEndpoint: 'llm.example.com/v1' }, 'valid absolute URL'],
    [{ llmEndpoint: 'ftp://llm.example.com/v1' }, 'http'],
    [{ llmEndpoint: 'https://user:pass@llm.example.com/v1' }, 'credentials'],
    [{ llmEndpoint: ENDPOINT + '#frag' }, 'fragment'],
    [{ llmEndpoint: ENDPOINT, bogus: true }, 'unsupported config field(s): bogus'],
    [{ llmEndpoint: ENDPOINT, llmTemperature: 3 }, '0..2'],
    [{ llmEndpoint: ENDPOINT, llmTimeoutMs: 1000 }, '5000..120000'],
    [{ llmEndpoint: ENDPOINT, llmTimeoutMs: 1.5 }, 'integer'],
    [{ llmEndpoint: 42 }, 'must be a string'],
  ];
  for (const [raw, needle] of cases) {
    const outcome = Config['~standard'].validate(raw);
    assert.ok(Array.isArray(outcome.issues), JSON.stringify(raw) + ' 本该报错');
    assert.ok(
      outcome.issues.some((issue) => issue.message.includes(needle)),
      JSON.stringify(raw) + ' → ' + JSON.stringify(outcome.issues),
    );
  }
});

test('apply：未知字段 / 非法地址仍然在装载期抛错', () => {
  assert.throws(() => apply({ inject() {} }, { llmEndpoint: ENDPOINT, bogus: true }), /unsupported config field/);
  assert.throws(() => apply({ inject() {} }, { llmEndpoint: 'not a url' }), /invalid config/);
});

test('Config 校验：未配置 endpoint 不是 issue，value 给出全默认值', () => {
  const defaults = { llmEndpoint: '', llmApiKey: '', llmModel: '', llmTemperature: 0.2, llmTimeoutMs: 30000 };
  for (const raw of [undefined, null, {}, { llmEndpoint: '' }, { llmEndpoint: '   ' }]) {
    assert.deepEqual(Config['~standard'].validate(raw), { value: defaults }, JSON.stringify(raw) + ' 本该放行');
  }
});

test('apply：未配置 endpoint 不阻断装载，注册照做', () => {
  for (const config of [undefined, null, {}, { llmEndpoint: '' }, { llmEndpoint: '   ' }]) {
    const built = makeCtx();
    assert.doesNotThrow(() => apply(built.ctx, config), String(config) + ' 不该抛');
    assert.equal(built.calls.inject, 1, String(config) + ' 必须调用 ctx.inject');
    assert.equal(built.calls.effect, 1, String(config) + ' 两条路由必须共用一次 effect');
    assert.equal(built.calls.routes.length, 2, String(config) + ' 必须完成两条路由的注册');
    assert.deepEqual(
      built.calls.routes.map((route) => route.path),
      [ROUTE_PATH, MODELS_ROUTE_PATH],
      String(config) + ' 路由顺序固定：优化通路在前、模型表在后',
    );
  }
});

// ---------------------------------------------------------------- 5. 未配置

test('未配置 endpoint：注册照做，请求进来返回 501 且不打上游', async () => {
  const { fetchImpl, seen } = recorder(() => okReply('x'));
  const calls = harness({}, fetchImpl);
  assert.equal(calls.routes.length, 1, '注册必须照做');
  const response = await calls.routes[0].fetch(post({ text: SAMPLE }));
  assert.equal(response.status, 501);
  assert.deepEqual(await json(response), { error: 'llm endpoint not configured' });
  assert.equal(seen.length, 0, '未配置时不得发出任何上游请求');
});

// ---------------------------------------------------------------- 6. 入参校验

test('超长原文（>20000）→ 400', async () => {
  const { fetchImpl, seen } = recorder(() => okReply('x'));
  const calls = harness(baseConfig(), fetchImpl);
  const response = await calls.routes[0].fetch(post({ text: 'a'.repeat(20001) }));
  assert.equal(response.status, 400);
  assert.equal(typeof (await json(response)).error, 'string');
  assert.equal(seen.length, 0);
});

test('刚好 20000 字符放行', async () => {
  const { fetchImpl } = recorder(() => okReply('ok'));
  const calls = harness(baseConfig(), fetchImpl);
  assert.equal((await calls.routes[0].fetch(post({ text: 'a'.repeat(20000) }))).status, 200);
});

test('非法 JSON / 非对象 / 空 text / 缺 text → 400；GET → 405', async () => {
  const { fetchImpl, seen } = recorder(() => okReply('x'));
  const calls = harness(baseConfig(), fetchImpl);
  const bad = ['{oops', '[1,2]', '"str"', JSON.stringify({}), JSON.stringify({ text: '   ' }), JSON.stringify({ text: 42 })];
  for (const body of bad) {
    const response = await calls.routes[0].fetch(post(body));
    assert.equal(response.status, 400, body + ' 本该 400');
    assert.equal(typeof (await json(response)).error, 'string');
  }
  const get = await calls.routes[0].fetch(new Request(ORIGIN + ROUTE_PATH, { method: 'GET' }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal(seen.length, 0);
});

// ---------------------------------------------------------------- 7. SSRF 回归

test('SSRF 回归：请求体里的 endpoint / url / llmEndpoint 不改变上游目标', async () => {
  const { fetchImpl, seen } = recorder(() => okReply('ok'));
  const calls = harness(baseConfig(), fetchImpl);
  const response = await calls.routes[0].fetch(
    post({
      text: SAMPLE,
      endpoint: 'http://169.254.169.254/latest/meta-data/',
      url: 'http://evil.example/steal',
      llmEndpoint: 'http://evil.example/steal',
      model: 'gpt-5',
      temperature: 1.9,
      messages: [{ role: 'system', content: 'ignored' }],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, ENDPOINT, '上游目标只能来自 config.llmEndpoint');
  const payload = JSON.parse(seen[0].init.body);
  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.messages.length, 2);
});

// ---------------------------------------------------------------- 8. 宿主模型表

const SECTION_HEADERS = ['### 角色', '### 任务', '### 上下文', '### 输出要求', '### 约束'];

test('apply：两条路由共用一次 inject 与一次 effect', () => {
  const built = makeCtx();
  apply(built.ctx, baseConfig());
  assert.equal(built.calls.inject, 1);
  assert.equal(built.calls.effect, 1);
  assert.deepEqual(
    built.calls.routes.map((route) => route.path),
    [ROUTE_PATH, MODELS_ROUTE_PATH],
  );
});

test('模型表路由：/api 前缀、methods 含 GET+POST、requestBody buffered、先打 GET 不炸', async () => {
  await withTempDir(async (dir) => {
    const calls = harnessModels({}, { dataDir: dir });
    const route = calls.routes[0];
    assert.equal(route.path, MODELS_ROUTE_PATH);
    assert.ok(route.path.startsWith('/api'), 'path 必须以 /api 开头，否则装载期抛错');
    assert.deepEqual(route.methods, ['GET', 'POST']);
    assert.equal(route.requestBody, 'buffered');
    const response = await route.fetch(modelsRequest('GET'));
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), {
      ok: true,
      schemaVersion: 2,
      source: 'config',
      models: [],
      settings: { strength: 'standard', locale: 'zh', engine: 'auto', mergeMode: 'strict', schemaVersion: 2 },
    });
    const put = await route.fetch(new Request(ORIGIN + MODELS_ROUTE_PATH, { method: 'PUT' }));
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, POST');
  });
});

test('POST models：超过 20 条被拒（400），一条都不落盘', async () => {
  await withTempDir(async (dir) => {
    const calls = harnessModels({}, { dataDir: dir });
    const tooMany = Array.from({ length: 21 }, (_, index) => modelEntry({ id: 'm-' + index }));
    const response = await calls.routes[0].fetch(modelsRequest('POST', { models: tooMany }));
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.code, 'invalid-models');
    assert.ok(
      body.problems.some((problem) => problem.includes('20')),
      '必须明确说出 20 条上限：' + JSON.stringify(body.problems),
    );
    assert.deepEqual(await readdir(dir), [], '校验失败不得留下任何文件');
  });
});

test('POST models：两条 isDefault 降级为一条，原子落盘且不留临时文件', async () => {
  await withTempDir(async (dir) => {
    const calls = harnessModels({}, { dataDir: dir });
    const response = await calls.routes[0].fetch(
      modelsRequest('POST', {
        models: [modelEntry({ id: 'a', isDefault: true }), modelEntry({ id: 'b', isDefault: true })],
        settings: { strength: 'deep', locale: 'en' },
      }),
    );
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.ok, true);
    assert.equal(body.count, 2);
    assert.equal(body.notices.length, 1, '降级必须留一条说明');

    const stored = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8'));
    assert.equal(stored.schemaVersion, 2);
    assert.deepEqual(stored.models.map((entry) => entry.isDefault), [true, false]);
    assert.equal(stored.settings.strength, 'deep');
    assert.equal(stored.settings.locale, 'en');
    assert.equal(stored.models[0].token ?? 'none', 'none');
    assert.deepEqual(await readdir(dir), ['models.json'], '原子写不得留下临时文件');
  });
});

test('GET models：apiKey 只露末 4 位，明文密钥绝不回传', async () => {
  await withTempDir(async (dir) => {
    const calls = harnessModels({}, { dataDir: dir });
    const secret = 'sk-very-secret-value-a1b2';
    const saved = await calls.routes[0].fetch(
      modelsRequest('POST', { models: [modelEntry({ apiKey: secret }), modelEntry({ id: 'm-2', apiKey: 'short' })] }),
    );
    assert.equal(saved.status, 200);

    const response = await calls.routes[0].fetch(modelsRequest('GET'));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(secret), 'GET 不得回传明文密钥');
    const body = JSON.parse(text);
    assert.equal(body.source, 'host');
    assert.equal(body.models.length, 2);
    assert.equal(body.models[0].apiKey, 'sk-…a1b2');
    assert.equal(body.models[0].apiKey, maskApiKey(secret));
    assert.equal(body.models[1].apiKey, '…', '长度不足 8 时整体掩码');
    assert.equal(body.models[0].endpoint, modelEntry().endpoint);
  });
});

test('POST models：写入失败返回 500 与错误码，且不留半截文件', async () => {
  await withTempDir(async (dir) => {
    const blocker = join(dir, 'blocked');
    await writeFile(blocker, 'not a directory');
    const calls = harnessModels({}, { dataDir: join(blocker, 'nested') });
    const response = await calls.routes[0].fetch(modelsRequest('POST', { models: [modelEntry()] }));
    assert.equal(response.status, 500);
    assert.deepEqual(await json(response), { error: '模型表写入失败', code: 'models-write-failed' });
    assert.deepEqual(await readdir(dir), ['blocked'], '失败后目录里不得多出任何文件');
  });
});

test('模型表校验：越界截断、name 留空取 model、id 必须唯一', () => {
  const built = validateHostModel({
    id: 'x',
    endpoint: 'https://a.example/v1/chat/completions',
    apiKey: 'k',
    model: 'gpt-4o-mini',
    name: '   ',
    temperature: 9,
    timeoutMs: 10,
  });
  assert.equal(built.ok, true);
  assert.equal(built.value.name, 'gpt-4o-mini', 'name 留空取 model');
  assert.equal(built.value.temperature, 2, '温度越界按边界截断');
  assert.equal(built.value.timeoutMs, 5000, '超时下界越界按边界截断');
  assert.equal(validateHostModel({ endpoint: modelEntry().endpoint, apiKey: 'k', model: 'm' }).ok, false, '缺 id 必须报错');
  assert.equal(validateHostModel({ ...modelEntry(), endpoint: 'https://x/v1?key=1' }).ok, true, '带 query 合法（Azure 需要 ?api-version=）');
  assert.equal(validateHostModel({ ...modelEntry(), endpoint: 'https://x/v1#frag' }).ok, false, '带 fragment 仍然必须报错');

  const duplicated = normalizeHostModels([modelEntry({ id: 'dup' }), modelEntry({ id: 'dup' })]);
  assert.equal(duplicated.ok, false, 'id 必须唯一');
  assert.equal(duplicated.models.length, 1);
});

test('Config 校验：models / settings 扩容后仍按白名单与上限校验', () => {
  const accepted = Config['~standard'].validate({
    models: [modelEntry()],
    settings: { strength: 'deep', locale: 'en', engine: 'llm', mergeMode: 'lenient', schemaVersion: 2 },
  });
  assert.equal(Array.isArray(accepted.issues), false, JSON.stringify(accepted));
  assert.equal(accepted.value.models.length, 1);
  assert.equal(accepted.value.models[0].name, 'DeepSeek 官方');
  assert.equal(accepted.value.settings.strength, 'deep');
  assert.equal(accepted.value.settings.mergeMode, 'lenient');
  assert.equal('models' in Config['~standard'].validate({}).value, false, '没写就不能凭空多出字段');

  const rejected = [
    [{ models: Array.from({ length: 21 }, (_, index) => modelEntry({ id: 'm-' + index })) }, '20'],
    [{ models: [{ ...modelEntry(), endpoint: 'ftp://x.example/v1' }] }, 'http'],
    [{ models: [{ ...modelEntry(), endpoint: 'https://x.example/v1#frag' }] }, 'fragment'],
    [{ models: [{ ...modelEntry(), id: 'a' }, { ...modelEntry(), id: 'a' }] }, '重复'],
    [{ models: 'nope' }, 'array'],
    [{ settings: { bogus: 1 } }, 'settings'],
    [{ settings: { strength: 'hard' } }, 'strength'],
    [{ settings: { schemaVersion: 3 } }, 'schemaVersion'],
  ];
  for (const [raw, needle] of rejected) {
    const outcome = Config['~standard'].validate(raw);
    assert.ok(Array.isArray(outcome.issues), JSON.stringify(raw).slice(0, 60) + ' 本该报错');
    assert.ok(
      outcome.issues.some((issue) => issue.message.includes(needle)),
      JSON.stringify(raw).slice(0, 60) + ' → ' + JSON.stringify(outcome.issues),
    );
  }
  assert.throws(() => apply({ inject() {} }, { models: 'nope' }), /invalid config/);
});

// ---------------------------------------------------------------- 9. providerId 与忽略字段

test('优化：请求体的 endpoint / apiKey / model 被忽略，响应带 ignoredFields', async () => {
  const { fetchImpl, seen } = recorder(() => okReply('ok'));
  const calls = harness(baseConfig(), fetchImpl);
  const response = await calls.routes[0].fetch(
    post({ text: SAMPLE, endpoint: 'http://169.254.169.254/latest/meta-data/', apiKey: 'sk-evil-key', model: 'gpt-5' }),
  );
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ok, true);
  assert.deepEqual(body.ignoredFields, ['endpoint', 'apiKey', 'model'], '被忽略的字段必须回给客户端');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, ENDPOINT, '上游地址只能来自宿主自己的来源');
  assert.equal(seen[0].init.headers.authorization, 'Bearer ' + KEY);
  const payload = JSON.parse(seen[0].init.body);
  assert.equal(payload.model, 'gpt-4o-mini');
  assert.ok(!seen[0].init.body.includes('sk-evil-key'), '宿主不得把请求体里的密钥带上上游');
});

test('优化：providerId 命中宿主模型表 → 用表里的地址 / 密钥 / 模型 / 温度', async () => {
  await withTempDir(async (dir) => {
    const writer = harnessModels({}, { dataDir: dir });
    const saved = await writer.routes[0].fetch(
      modelsRequest('POST', { models: [modelEntry({ temperature: 1.5, timeoutMs: 60000 })] }),
    );
    assert.equal(saved.status, 200);

    const { fetchImpl, seen } = recorder(() => okReply('### 角色\n资深工程师'));
    const calls = harness(baseConfig(), fetchImpl, { dataDir: dir });
    const response = await calls.routes[0].fetch(
      post({ text: SAMPLE, providerId: 'm-1', endpoint: 'http://evil.example/steal', model: 'ignored' }),
    );
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, modelEntry().endpoint, '必须打到模型表里的地址，而不是 config.llmEndpoint');
    assert.equal(seen[0].init.headers.authorization, 'Bearer ' + modelEntry().apiKey);
    const payload = JSON.parse(seen[0].init.body);
    assert.equal(payload.model, 'deepseek-chat');
    assert.equal(payload.temperature, 1.5);
    const body = await json(response);
    assert.equal(body.providerId, 'm-1', '命中时必须回显用的是哪个 provider');
    assert.deepEqual(body.ignoredFields, ['endpoint', 'model']);
  });
});

test('优化：模型表为空时 providerId 退回 config.llmEndpoint', async () => {
  await withTempDir(async (dir) => {
    const { fetchImpl, seen } = recorder(() => okReply('ok'));
    const calls = harness(baseConfig(), fetchImpl, { dataDir: dir });
    const response = await calls.routes[0].fetch(post({ text: SAMPLE, providerId: 'not-in-table' }));
    assert.equal(response.status, 200);
    assert.equal(seen[0].url, ENDPOINT);
    assert.equal(JSON.parse(seen[0].init.body).model, 'gpt-4o-mini');
    const body = await json(response);
    assert.equal('providerId' in body, false, '未命中不得回显 providerId');
    assert.equal('ignoredFields' in body, false, '没有可忽略字段时不得凭空多出该键');
  });
});

test('优化：providerId 未命中且 config 无地址 → 501 且不打上游', async () => {
  await withTempDir(async (dir) => {
    const { fetchImpl, seen } = recorder(() => okReply('x'));
    const calls = harness({}, fetchImpl, { dataDir: dir });
    const response = await calls.routes[0].fetch(post({ text: SAMPLE, providerId: 'not-in-table' }));
    assert.equal(response.status, 501);
    assert.deepEqual(await json(response), { error: 'llm endpoint not configured' });
    assert.equal(seen.length, 0, '两者都缺时不得发出任何上游请求');
  });
});

// ---------------------------------------------------------------- 10. 三档强度 × 语种

test('buildSystemPrompt：三档互不相同，都含五个段头与硬规则', () => {
  const prompts = {
    light: buildSystemPrompt('light', 'zh'),
    standard: buildSystemPrompt('standard', 'zh'),
    deep: buildSystemPrompt('deep', 'zh'),
  };
  assert.equal(new Set(Object.values(prompts)).size, 3, '三档产出必须互不相同');
  for (const [level, prompt] of Object.entries(prompts)) {
    for (const header of SECTION_HEADERS) assert.ok(prompt.includes(header), level + ' 缺段 ' + header);
    assert.ok(prompt.includes('原样保留'), level + ' 缺「原样保留」硬规则');
    assert.ok(prompt.includes('不得新增、删改或臆测'), level + ' 缺「不臆测」硬规则');
    assert.ok(prompt.includes('不要用代码围栏'), level + ' 缺「不要代码围栏」硬规则');
    assert.ok(prompt.includes('只输出这五段正文'), level + ' 缺「只输出正文」硬规则');
  }
  assert.ok(prompts.light.includes('禁止改动句式结构'));
  assert.ok(prompts.light.includes('禁止增删原文任何信息'));
  assert.ok(prompts.standard.includes('凡是新增的请求，必须是原文意图的显式化'), '标准档要把「禁止新增」换成「意图显式化」');
  assert.ok(prompts.standard.includes('禁止删减用户已给出的信息'));
  assert.ok(prompts.deep.includes('推断补出的一律逐条标注「（待确认）」'));
  assert.ok(!prompts.light.includes('### 其他'), '轻档不得允许推断补充');
  assert.ok(!prompts.standard.includes('### 其他'), '标准档不得允许推断补充');
  // 三档都必须带正向质量目标（不再只是禁止清单），且中文提示词有长度上限
  for (const [level, prompt] of Object.entries(prompts)) {
    assert.ok(prompt.includes('增益检查'), level + ' 缺正向质量目标：增益检查');
    assert.ok(prompt.includes('空转检查'), level + ' 缺正向质量目标：空转检查');
    assert.ok(prompt.includes('可执行检查'), level + ' 缺正向质量目标：可执行检查');
    assert.ok(prompt.includes('完整性检查'), level + ' 缺正向质量目标：完整性检查');
    assert.ok(prompt.includes('（待确认）'), level + ' 缺推断标注规则');
    assert.ok(prompt.includes('提问类') && prompt.includes('指令类'), level + ' 缺任务类型分流');
    assert.ok(prompt.includes('原文原句为'), level + ' 缺禁止复述原文的禁令');
    assert.ok(prompt.includes('原文：帮我把这段代码改好点'), level + ' 缺 few-shot 示例');
    assert.ok(prompt.length <= 2000, level + ' 中文提示词超长：' + prompt.length);
  }
  assert.ok(!prompts.standard.includes('禁止新增原文没有的要求'), '标准档的自相矛盾禁止项必须删掉');
  assert.ok(!prompts.standard.includes('### 其他（推断补充，请确认）'), '推断内容改为就地标注，不再单开第六段');
  assert.ok(!prompts.deep.includes('### 其他'), '推断内容改为就地标注，不给深档开第六段');
});

test('buildSystemPrompt：locale=en 输出英文模板，段头保持固定', () => {
  const en = buildSystemPrompt('standard', 'en');
  assert.ok(en.includes('You are a prompt-engineering expert'), 'en 必须是英文模板');
  assert.ok(!en.includes('你是一名提示词工程专家'), 'en 不得混入中文导语');
  for (const header of SECTION_HEADERS) assert.ok(en.includes(header), 'en 也必须保留固定段头 ' + header);
  assert.ok(en.includes('原样保留'), 'en 也要点明原样保留');
  assert.notEqual(en, buildSystemPrompt('standard', 'zh'));
  assert.ok(buildSystemPrompt('deep', 'en').includes('Strength: deep'));
  assert.ok(buildSystemPrompt('deep', 'en').includes('（待确认）'), 'en 也要有点名推断的标注规则');
  assert.ok(buildSystemPrompt('light', 'en').includes('Strength: light'));
});

test('buildSystemPrompt：未知强度 / 语种退回默认值，大小写容错', () => {
  assert.equal(buildSystemPrompt('nonsense', 'zh'), buildSystemPrompt('standard', 'zh'));
  assert.equal(buildSystemPrompt(undefined, undefined), buildSystemPrompt('standard', 'zh'));
  assert.equal(buildSystemPrompt(null, null), buildSystemPrompt('standard', 'zh'));
  assert.equal(buildSystemPrompt(' DEEP ', 'EN'), buildSystemPrompt('deep', 'en'));
});

test('优化：strength / locale 真的进了上游 system 提示词', async () => {
  const captured = [];
  const { fetchImpl } = recorder((url, init) => {
    captured.push(JSON.parse(init.body).messages[0].content);
    return okReply('ok');
  });
  const calls = harness(baseConfig(), fetchImpl);
  await calls.routes[0].fetch(post({ text: SAMPLE, strength: 'light', locale: 'zh' }));
  await calls.routes[0].fetch(post({ text: SAMPLE, strength: 'deep', locale: 'zh' }));
  await calls.routes[0].fetch(post({ text: SAMPLE, strength: 'standard', locale: 'en' }));
  assert.equal(captured.length, 3);
  assert.ok(captured[0].includes('禁止改动句式结构'), 'light 必须进 prompt');
  assert.ok(captured[1].includes('本次强度：深度（deep）'), 'deep 必须进 prompt');
  assert.ok(captured[2].includes('You are a prompt-engineering expert'), 'en 必须进 prompt');
  assert.equal(new Set(captured).size, 3);
});

// ---------------------------------------------------------------- 11. 宿主侧零静态 import

test('宿主产物静态图零 import：src/host/index.js 里没有 import 语句', async () => {
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  const staticImports = source.match(/^\s*import\s.+$/gm) ?? [];
  assert.deepEqual(staticImports, [], '宿主源码不得出现 import 语句：' + staticImports.join(' | '));
  assert.ok(/\bimport\(/.test(source), '落盘能力只能走动态 import()');
  const specifiers = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, '必须能找到动态 import 的内置模块');
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('node:'), '只允许动态 import node: 内置模块，实际：' + specifier);
  }
});

// ---------------------------------------------------------------- 客户端通路

/** 临时替换全局 fetch；返回还原函数。 */
function stubFetch(reply) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return reply(url, init);
  };
  return {
    seen,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('客户端：成功时返回 { ok:true, text }，打到宿主 ROUTE_PATH', async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ ok: true, text: '### 角色\nx' }), { status: 200 }));
  try {
    const result = await optimizeViaRemote(SAMPLE, { strength: 'deep', locale: 'zh' });
    assert.deepEqual(result, { ok: true, text: '### 角色\nx' });
    assert.equal(stub.seen[0].url, ROUTE_PATH, '两半边的路径必须一致');
    assert.equal(stub.seen[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(stub.seen[0].init.body), { text: SAMPLE, strength: 'deep', locale: 'zh' });
  } finally {
    stub.restore();
  }
});

test('客户端：所有失败都归一成 { ok:false, error }，永不抛', async () => {
  const cases = [
    [() => new Response(JSON.stringify({ error: 'llm endpoint not configured' }), { status: 501 }), FAILURE_TEXT.notConfigured],
    [() => new Response(JSON.stringify({ error: 'x' }), { status: 504 }), FAILURE_TEXT.timeout],
    [() => new Response(JSON.stringify({ error: 'x' }), { status: 400 }), FAILURE_TEXT.invalid],
    [() => new Response('boom', { status: 500 }), FAILURE_TEXT.badResponse],
    [() => new Response('not json', { status: 200 }), FAILURE_TEXT.badResponse],
    [() => new Response(JSON.stringify({ ok: true, text: '   ' }), { status: 200 }), FAILURE_TEXT.badResponse],
    [() => new Response(JSON.stringify({ ok: true }), { status: 200 }), FAILURE_TEXT.badResponse],
    [
      () => {
        throw new TypeError('fetch failed');
      },
      FAILURE_TEXT.network,
    ],
    [
      () => {
        throw new DOMException('gone', 'TimeoutError');
      },
      FAILURE_TEXT.timeout,
    ],
  ];
  for (const [reply, expected] of cases) {
    const stub = stubFetch(reply);
    try {
      const result = await optimizeViaRemote(SAMPLE, {});
      assert.deepEqual(result, { ok: false, error: expected });
    } finally {
      stub.restore();
    }
  }
});

test('客户端：本地前置校验（空原文 / 超长）直接失败，不发请求', async () => {
  const stub = stubFetch(() => new Response('{}', { status: 200 }));
  try {
    assert.deepEqual(await optimizeViaRemote('   ', {}), { ok: false, error: FAILURE_TEXT.empty });
    assert.deepEqual(await optimizeViaRemote(42, {}), { ok: false, error: FAILURE_TEXT.empty });
    assert.deepEqual(await optimizeViaRemote('a'.repeat(20001), {}), { ok: false, error: FAILURE_TEXT.tooLong });
    assert.equal(stub.seen.length, 0);
  } finally {
    stub.restore();
  }
});

test('客户端：调用方取消 → 已取消', async () => {
  const stub = stubFetch(() => {
    throw new DOMException('aborted', 'AbortError');
  });
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await optimizeViaRemote(SAMPLE, { signal: controller.signal });
    assert.deepEqual(result, { ok: false, error: FAILURE_TEXT.cancelled });
    assert.ok(stub.seen[0].init.signal === controller.signal, '调用方信号必须透传');
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------- 12. 空密钥 / query / auto（契约回访）

test('validateHostModel 与客户端同契约：空密钥合法、地址允许 query、fragment 仍拒', () => {
  const emptyKey = validateHostModel({ ...modelEntry(), apiKey: '' });
  assert.equal(emptyKey.ok, true, '空密钥必须合法：' + JSON.stringify(emptyKey.problems));
  assert.deepEqual(emptyKey.problems, []);
  assert.equal(emptyKey.value.apiKey, '');

  const noKeyField = validateHostModel({ ...modelEntry(), apiKey: undefined });
  assert.equal(noKeyField.ok, true, '缺 apiKey 字段同样合法');
  assert.equal(noKeyField.value.apiKey, '');

  const tooLong = validateHostModel({ ...modelEntry(), apiKey: 'k'.repeat(513) });
  assert.equal(tooLong.ok, false, '超 512 仍然必须报错');
  assert.ok(
    tooLong.problems.some((problem) => problem.includes('512')),
    '必须点名 512 上限：' + JSON.stringify(tooLong.problems),
  );

  const azure = validateHostModel({
    ...modelEntry(),
    endpoint: 'https://x.openai.azure.com/openai/deployments/d1/chat/completions?api-version=2024-05-01',
  });
  assert.equal(azure.ok, true, '带 query 必须合法：' + JSON.stringify(azure.problems));
  assert.equal(azure.value.endpoint.includes('api-version=2024-05-01'), true, 'query 必须原样保留');

  const frag = validateHostModel({ ...modelEntry(), endpoint: 'https://x.example/v1#frag' });
  assert.equal(frag.ok, false, 'fragment 仍然必须报错');
});

test('宿主 settings 与客户端同口径：engine 默认 auto，白名单接受 auto', () => {
  assert.equal(normalizeHostSettings(undefined).value.engine, 'auto');
  assert.equal(normalizeHostSettings({}).value.engine, 'auto');
  const auto = normalizeHostSettings({ engine: 'auto' });
  assert.equal(auto.ok, true, JSON.stringify(auto.problems));
  assert.equal(auto.value.engine, 'auto');
  assert.equal(normalizeHostSettings({ engine: ' AUTO ' }).value.engine, 'auto');
  assert.equal(normalizeHostSettings({ engine: 'local' }).value.engine, 'local');
  assert.equal(normalizeHostSettings({ engine: 'llm' }).value.engine, 'llm');
  const bogus = normalizeHostSettings({ engine: 'cloud' });
  assert.equal(bogus.ok, false, '非法 engine 必须报错');
  assert.equal(bogus.value.engine, 'auto', '非法 engine 回落 auto');
});

test('Config 校验：models 条目空密钥 / 带 query 通过，超长密钥仍被拒', () => {
  const accepted = Config['~standard'].validate({
    models: [modelEntry({ apiKey: '', endpoint: 'http://127.0.0.1:11434/v1/chat/completions?api-version=1' })],
  });
  assert.equal(Array.isArray(accepted.issues), false, JSON.stringify(accepted));
  assert.equal(accepted.value.models[0].apiKey, '');
  assert.equal(accepted.value.models[0].endpoint, 'http://127.0.0.1:11434/v1/chat/completions?api-version=1');

  const badKey = Config['~standard'].validate({ models: [{ ...modelEntry(), apiKey: 'k'.repeat(513) }] });
  assert.ok(Array.isArray(badKey.issues), '超长密钥必须在装载期报错');
  assert.ok(
    badKey.issues.some((issue) => issue.message.includes('apiKey')),
    JSON.stringify(badKey.issues),
  );

  const badFrag = Config['~standard'].validate({ models: [{ ...modelEntry(), endpoint: 'https://x.example/v1#frag' }] });
  assert.ok(Array.isArray(badFrag.issues), 'fragment 必须在装载期报错');
});

test('POST models：接受空密钥 + 带 query 的条目，GET 回来密钥只回掩码', async () => {
  await withTempDir(async (dir) => {
    const calls = harnessModels({}, { dataDir: dir });
    const entry = modelEntry({
      id: 'local-ollama',
      name: '本地 Ollama',
      apiKey: '',
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions?api-version=1',
      model: 'qwen3:8b',
    });
    const response = await calls.routes[0].fetch(modelsRequest('POST', { models: [entry] }));
    assert.equal(response.status, 200, JSON.stringify(await json(response)));

    const stored = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8'));
    assert.equal(stored.models[0].apiKey, '', '空密钥必须原样落盘');
    assert.equal(
      stored.models[0].endpoint,
      'http://127.0.0.1:11434/v1/chat/completions?api-version=1',
      'query 必须原样保留',
    );

    const got = await json(await calls.routes[0].fetch(modelsRequest('GET')));
    assert.equal(got.source, 'host');
    assert.equal(got.models[0].apiKey, '…', '空密钥只回掩码');
  });
});

test('优化：模型表条目密钥为空时不发 Authorization 头', async () => {
  await withTempDir(async (dir) => {
    const writer = harnessModels({}, { dataDir: dir });
    const saved = await writer.routes[0].fetch(modelsRequest('POST', { models: [modelEntry({ apiKey: '' })] }));
    assert.equal(saved.status, 200);

    const { fetchImpl, seen } = recorder(() => okReply('ok'));
    const calls = harness(baseConfig(), fetchImpl, { dataDir: dir });
    const response = await calls.routes[0].fetch(post({ text: SAMPLE, providerId: 'm-1' }));
    assert.equal(response.status, 200);
    assert.equal(seen[0].url, modelEntry().endpoint, '必须打到模型表里的地址');
    assert.equal('authorization' in seen[0].init.headers, false, '空密钥不得发 Authorization 头');
    assert.equal(seen[0].init.headers['content-type'], 'application/json', '其余头照发');
  });
});

