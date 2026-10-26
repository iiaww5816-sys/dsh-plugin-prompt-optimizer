/**
 * 客户端 → 宿主 HTTP 通路的唯一入口（纯函数，无 UI、无副作用）。
 *
 * 约束（本文件会被内联进 lib/client.js）：
 *  - 纯 ESM，只依赖 fetch / AbortSignal / JSON —— 不 require 任何包；不读不写 localStorage；
 *  - 永不抛异常：所有失败都归一成 { ok: false, ... }，error 是可以直接显示给用户的中文短句；
 *  - 全文件只有一处 fetch：优化、模型表读写、连接测试都收敛到下面的 requestJson
 *    （scripts/verify.mjs 断言产物里 fetch 调用恰好出现一次）。
 */

/** 宿主侧注册的同源路由（必须与 src/host/index.js 的 ROUTE_PATH 一致）。 */
const ROUTE_PATH = '/api/prompt-optimizer/optimize';

/** 宿主侧的模型表路由（必须与 src/host/index.js 的 MODELS_ROUTE_PATH 一致）。 */
export const MODELS_ROUTE_PATH = '/api/prompt-optimizer/models';

/** 宿主侧单次上游超时是 30 秒，这里的兜底比它长，让宿主先报超时。 */
const DEFAULT_TIMEOUT_MS = 70000;

/** 连接测试只想知道通不通，等 60 秒足够，且可被用户取消。 */
const PROBE_TIMEOUT_MS = 60000;

/** 与宿主同口径的原文长度上限（字符数）。 */
const MAX_TEXT_LENGTH = 20000;

/** 失败文案：短句、可直显，且不含任何服务端细节。 */
export const FAILURE_TEXT = {
  empty: '原文为空，无法优化',
  tooLong: '原文过长（超过 20000 字符），请先精简',
  notConfigured: '未配置 LLM 地址',
  timeout: '服务超时，请重试',
  network: '无法连接优化服务，请检查网络',
  badResponse: '服务返回异常',
  invalid: '请求无效，请重试',
  cancelled: '已取消',
};

function failure(error) {
  return { ok: false, error };
}

/** 只取 name：DOMException / Error 都覆盖，不依赖 instanceof。 */
function errorName(error) {
  return error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : '';
}

/** 异常 → 一行可显示文案（保留原始 message，便于宿主日志对账）。 */
function messageOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

function isTimeout(error) {
  const name = errorName(error);
  return name === 'TimeoutError' || name === 'AbortError';
}

/** 调用方传入的取消信号（没有就是 undefined）。 */
function callerSignal(options) {
  if (options === null || typeof options !== 'object') return undefined;
  const signal = options.signal;
  return signal === null || signal === undefined ? undefined : signal;
}

/** 本轮的有效信号：调用方的优先，否则按超时兜底。 */
function resolveSignal(options, timeoutMs) {
  const given = callerSignal(options);
  if (given !== undefined) return given;
  try {
    return AbortSignal.timeout(timeoutMs);
  } catch (error) {
    return undefined;
  }
}

/** HTTP 状态码 → 给用户看的短句。 */
function statusError(status) {
  if (status === 501) return FAILURE_TEXT.notConfigured;
  if (status === 504) return FAILURE_TEXT.timeout;
  if (status === 400) return FAILURE_TEXT.invalid;
  return FAILURE_TEXT.badResponse;
}

/** 请求体：只放宿主认识的字段（绝不带 endpoint / apiKey / model，那些在宿主侧查表）。 */
function requestPayload(rawText, options) {
  const payload = { text: rawText };
  const strength = options?.strength;
  const locale = options?.locale;
  const providerId = options?.providerId;
  if (typeof strength === 'string' && strength !== '') payload.strength = strength;
  if (typeof locale === 'string' && locale !== '') payload.locale = locale;
  if (typeof providerId === 'string' && providerId !== '') payload.providerId = providerId;
  return payload;
}

/**
 * 唯一 fetch 调用点：payload 为 null 时发 GET，否则 POST JSON。
 * 网络异常向外抛（由各调用方归类），HTTP 非 2xx 与解析失败都作为结果返回。
 * @returns {Promise<{ ok: boolean, status: number, body: any }>}
 */
async function requestJson(path, payload, signal) {
  const init = { method: payload === null ? 'GET' : 'POST' };
  if (signal !== undefined) init.signal = signal;
  if (payload !== null) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(path, init);
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  return {
    ok: response.ok === true,
    status: typeof response.status === 'number' ? response.status : 0,
    body,
  };
}

/** 路由不存在 / 宿主未挂载该接口的判定：404、405，或压根连不上宿主。 */
function routeMissingFrom(status, thrown) {
  if (thrown === true) return true;
  return status === 404 || status === 405;
}

/**
 * 通过宿主通路优化一段原文。
 * @param rawText 待优化的原文
 * @param options { strength?, locale?, providerId?, signal? }
 * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string }>} 永不 reject
 */
export async function optimizeViaRemote(rawText, options) {
  try {
    if (typeof rawText !== 'string' || rawText.trim() === '') return failure(FAILURE_TEXT.empty);
    if (rawText.length > MAX_TEXT_LENGTH) return failure(FAILURE_TEXT.tooLong);
    const signal = resolveSignal(options, DEFAULT_TIMEOUT_MS);
    let outcome = null;
    try {
      outcome = await requestJson(ROUTE_PATH, requestPayload(rawText, options), signal);
    } catch (error) {
      if (signal !== undefined && signal.aborted === true && callerSignal(options) !== undefined) return failure(FAILURE_TEXT.cancelled);
      return failure(isTimeout(error) ? FAILURE_TEXT.timeout : FAILURE_TEXT.network);
    }
    if (outcome.ok !== true) return failure(statusError(outcome.status));
    const text = outcome.body !== null && typeof outcome.body === 'object' ? outcome.body.text : undefined;
    if (typeof text !== 'string' || text.trim() === '') return failure(FAILURE_TEXT.badResponse);
    return { ok: true, text };
  } catch (error) {
    return failure(FAILURE_TEXT.badResponse);
  }
}

/**
 * GET 模型表：只作为「宿主是否提供模型接口」的能力探测，**不作为权威列表**
 * （宿主 GET 返回的 apiKey 是掩码，回传会把真密钥写坏；localStorage 才是唯一真源）。
 * @param options { signal? }
 * @returns {Promise<{ ok: boolean, routeMissing: boolean, status: number, schemaVersion: number, source: string, models: Array, settings: object, error: string }>} 永不 reject
 */
export async function fetchModelTable(options) {
  const empty = { ok: false, routeMissing: true, status: 0, schemaVersion: 0, source: '', models: [], settings: null, error: '' };
  try {
    const outcome = await requestJson(MODELS_ROUTE_PATH, null, resolveSignal(options, PROBE_TIMEOUT_MS));
    if (outcome.ok !== true) {
      const error = outcome.body !== null && typeof outcome.body === 'object' && typeof outcome.body.error === 'string' ? outcome.body.error : '';
      return {
        ok: false,
        routeMissing: routeMissingFrom(outcome.status, false),
        status: outcome.status,
        schemaVersion: 0,
        source: '',
        models: [],
        settings: null,
        error,
      };
    }
    const body = outcome.body !== null && typeof outcome.body === 'object' ? outcome.body : {};
    return {
      ok: true,
      routeMissing: false,
      status: outcome.status,
      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 0,
      source: typeof body.source === 'string' ? body.source : '',
      models: Array.isArray(body.models) ? body.models : [],
      settings: body.settings !== null && typeof body.settings === 'object' ? body.settings : null,
      error: '',
    };
  } catch (error) {
    return { ...empty, error: messageOf(error) };
  }
}

/**
 * POST 模型表：把 localStorage 里的权威列表整体推给宿主（宿主原子落盘并重新校验）。
 * settings 只带宿主认识的四个键，多一个都会被 400 拒掉。
 * @param payload { schemaVersion, models, settings }
 * @param options { signal? }
 * @returns {Promise<{ ok: boolean, routeMissing: boolean, status: number, count: number, notices: string[], error: string, code: string }>} 永不 reject
 */
export async function saveModelTable(payload, options) {
  const failed = { ok: false, routeMissing: true, status: 0, count: 0, notices: [], error: '', code: '' };
  const source = payload !== null && typeof payload === 'object' ? payload : {};
  const settings = source.settings !== null && typeof source.settings === 'object' ? source.settings : {};
  const body = {
    schemaVersion: typeof source.schemaVersion === 'number' ? source.schemaVersion : 2,
    models: Array.isArray(source.models) ? source.models : [],
    settings: {
      strength: settings.strength,
      locale: settings.locale,
      engine: settings.engine,
      mergeMode: settings.mergeMode,
    },
  };
  try {
    const outcome = await requestJson(MODELS_ROUTE_PATH, body, resolveSignal(options, PROBE_TIMEOUT_MS));
    const parsed = outcome.body !== null && typeof outcome.body === 'object' ? outcome.body : {};
    if (outcome.ok !== true) {
      return {
        ok: false,
        routeMissing: routeMissingFrom(outcome.status, false),
        status: outcome.status,
        count: 0,
        notices: [],
        error: typeof parsed.error === 'string' ? parsed.error : '',
        code: typeof parsed.code === 'string' ? parsed.code : '',
      };
    }
    return {
      ok: true,
      routeMissing: false,
      status: outcome.status,
      count: typeof parsed.count === 'number' ? parsed.count : body.models.length,
      notices: Array.isArray(parsed.notices) ? parsed.notices : [],
      error: '',
      code: '',
    };
  } catch (error) {
    return { ...failed, error: messageOf(error) };
  }
}

/**
 * 连接测试：走真实的优化通路发一条最小请求（原文 ping），只看通不通。
 * 宿主自己构造上游 messages / max_tokens，客户端无法指定 —— 这是「最小请求」在此架构下的落点。
 * @param providerId 目标模型 id（留空则宿主回落到 config.llmEndpoint）
 * @param options { signal? }
 * @returns {Promise<{ ok: boolean, status: number, error: string, kind: string, durationMs: number }>} 永不 reject
 */
export async function probeConnection(providerId, options) {
  const started = Date.now();
  const payload = { text: 'ping', strength: 'standard', locale: 'zh' };
  if (typeof providerId === 'string' && providerId !== '') payload.providerId = providerId;
  try {
    const outcome = await requestJson(ROUTE_PATH, payload, resolveSignal(options, PROBE_TIMEOUT_MS));
    const durationMs = Date.now() - started;
    const body = outcome.body !== null && typeof outcome.body === 'object' ? outcome.body : {};
    if (outcome.ok === true && typeof body.text === 'string') {
      return { ok: true, status: outcome.status, error: '', kind: '', durationMs };
    }
    return {
      ok: false,
      status: outcome.status,
      error: typeof body.error === 'string' ? body.error : '',
      kind: '',
      durationMs,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: messageOf(error),
      kind: isTimeout(error) ? 'timeout' : 'network',
      durationMs: Date.now() - started,
    };
  }
}
