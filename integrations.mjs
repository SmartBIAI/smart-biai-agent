import { models as supportedModels } from './mock.mjs';

const socialRoot = 'https://border-api.biaibiai.com/open-api';
const videoRoot = 'https://developer.biaibiai.com';
const platforms = { 10: 'TikTok', 40: 'YouTube', 70: 'Instagram' };
const authorizations = { 10: '未授权', 20: '已授权', 30: '授权失败', 40: '授权异常' };

export class IntegrationError extends Error {
  constructor(message, status, { retryable = false, uncertain = false, retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.uncertain = uncertain;
    this.retryAfter = retryAfter;
  }
}

function unexpected(service) {
  return new IntegrationError(`${service} 返回的信息暂时无法读取，请稍后再试。`, 502, { uncertain: true });
}

function integer(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) throw unexpected('Smart BIAI 社媒');
  return JSON.rawJSON(value);
}

async function jsonRequest(service, url, { headers = {}, body, timeout = 15000, frozen = false } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : frozen ? body : JSON.stringify(body)
    });
  } catch {
    throw new IntegrationError(`${service} 暂时无法连接，请检查网络后再试。`, 503, { retryable: true, uncertain: true });
  }
  if (!response.ok) {
    const status = response.status;
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfter = Math.max(0, Number(retryAfterHeader) * 1000 || Date.parse(retryAfterHeader) - Date.now() || 0);
    const retryable = status === 429 || status >= 500 || status === 408;
    await response.body?.cancel().catch(() => {});
    const detail = status === 401 || status === 403 ? '连接未通过，请检查密钥和服务权限' : status === 402 ? '额度或余额不足' :
      status === 429 ? '操作过于频繁，请稍后再试' : status === 409 ? '可能已有相同任务，请查看任务记录' : `暂时无法完成操作（错误码 ${status}）`;
    throw new IntegrationError(`${service}：${detail}。`, retryable ? 503 : 422, {
      retryable, retryAfter, uncertain: status === 408 || status >= 500 || status === 409
    });
  }
  try {
    return JSON.parse(await response.text(), (key, value, context) =>
      typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value);
  } catch { throw unexpected(service); }
}

export function socialClient(config) {
  if (!config.appId || !config.key) throw new IntegrationError('请在连接设置填写社媒 App ID 和 Access Token。', 422);
  const headers = { Authorization: `Bearer ${config.key}`, 'Client-Id': config.appId };
  const call = async (path, options = {}) => {
    const data = await jsonRequest('Smart BIAI 社媒', `${socialRoot}${path}`, {
      ...options, headers: { ...headers, ...options.headers }
    });
    if (data?.code === 0) return data.data;
    if (!Number.isInteger(data?.code)) throw unexpected('Smart BIAI 社媒');
    if (data.code === 1007000111) throw new IntegrationError('Smart BIAI 正在处理这条发布任务。', 503, { retryable: true, uncertain: true });
    if (data.code === 1007000110) throw new IntegrationError('这条发布任务可能已存在，请先查看发布记录。', 422, { uncertain: true });
    if (data.code === 401 || data.code === 403) throw new IntegrationError('无法连接 Smart BIAI 社媒，请在连接设置检查 App ID、Access Token 和服务权限。', 422);
    throw new IntegrationError(`Smart BIAI 社媒未能完成此操作（错误码 ${data.code}）。`, 422);
  };
  return {
    async accounts({ platform, id, country, keyword, maxPages = 10 } = {}) {
      const platformId = Object.keys(platforms).find(key => platforms[key] === platform);
      const query = new URLSearchParams({ pageSize: '50' });
      if (platformId) query.set('platform', platformId);
      if (id) query.set('id', id);
      let limited = false;
      const accounts = [];
      for (let page = 1; page <= maxPages; page++) {
        query.set('pageNo', String(page));
        const data = await call(`/v1/account/page?${query}`);
        if (!Array.isArray(data?.list)) throw unexpected('Smart BIAI 社媒');
        for (const item of data.list) {
          const accountId = String(item.id ?? '');
          if (!/^[1-9]\d{0,18}$/.test(accountId)) continue;
          const authStatus = Number(item.authStatus);
          const account = {
            id: accountId, platform: platforms[item.platform] ?? '其他平台', name: String(item.name ?? item.alias ?? accountId),
            alias: String(item.alias ?? ''), country: String(item.country ?? ''),
            authStatus, authorization: authorizations[authStatus] ?? '待核实', expiry: String(item.expiryDate ?? ''),
            canPublish: authStatus === 20 && Boolean(platforms[item.platform]) && (!/^\d{4}-\d\d-\d\d$/.test(item.expiryDate) || item.expiryDate >= new Date().toISOString().slice(0, 10))
          };
          const countryCodes = { 美国: 'US', 英国: 'GB', 日本: 'JP', 德国: 'DE', 法国: 'FR', 中国: 'CN', 加拿大: 'CA', 澳大利亚: 'AU' };
          const lowerCountry = country?.toLowerCase();
          if (id && account.id !== id || platform && account.platform !== platform || country && ![
            lowerCountry, countryCodes[country]?.toLowerCase(), country === '英国' ? 'uk' : undefined
          ].includes(account.country.toLowerCase()) || keyword && !`${account.name} ${account.alias}`.toLowerCase().includes(keyword.toLowerCase())) continue;
          accounts.push(account);
        }
        if (id || data.list.length < 50 || Number(data.total) <= page * 50) break;
        if (page === maxPages) limited = true;
      }
      return { accounts, limited };
    },
    publishBody(row, videoUrl) {
      return JSON.stringify([{
        accountId: integer(row.account), videoUrl, coverUrl: row.cover ?? '', title: row.title,
        ...(row.description ? { description: row.description } : {}), isAiGenerated: row.ai, clientTaskId: row.id
      }]);
    },
    async publish(row) {
      const data = await call('/v1/publish/videos', { body: row.payload, frozen: true, headers: { 'Idempotency-Key': row.id } });
      const task = Array.isArray(data) && data.find(item => item.clientTaskId === row.id);
      if (typeof task?.id !== 'string' || !task.id) throw unexpected('Smart BIAI 发布');
      return task;
    },
    status(id) { return call(`/v1/publish/status?${new URLSearchParams({ id })}`); }
  };
}

export function videoClient(config) {
  if (!config.key) throw new IntegrationError('请配置 Smart BIAI 视频生成 API Key。', 422);
  const call = (path, body) => jsonRequest('Smart BIAI 视频', `${videoRoot}${path}`, { headers: { Authorization: `Bearer ${config.key}` }, body });
  return {
    async models() {
      const data = (await call('/v1/models'))?.data;
      if (!Array.isArray(data)) throw unexpected('Smart BIAI 视频');
      return data.flatMap(item => {
        const known = supportedModels.find(model => model.id === item.id);
        const cap = item.capabilities;
        if (!known || !Array.isArray(cap?.resolutions) || !Array.isArray(cap.aspect_ratios)) return [];
        return [{ ...known, ratios: cap.aspect_ratios, resolutions: cap.resolutions, min: cap.min_duration ?? known.min,
          max: cap.max_duration ?? known.max, durations: cap.durations, audio: Boolean(cap.supports_audio),
          minPrompt: cap.min_prompt_length, maxPrompt: cap.max_prompt_length, lastFrame: Boolean(cap.supports_last_frame) }];
      }).filter(model => model.ratios.length && model.resolutions.length);
    },
    async quote(body) {
      const result = await call('/v1/videos/quote', body);
      if (!Number.isSafeInteger(result?.credits) || result.credits < 0) throw unexpected('Smart BIAI 视频报价');
      return result.credits;
    },
    async recover(requestId) {
      const data = (await call(`/v1/videos?${new URLSearchParams({ request_id: requestId, limit: '100' })}`))?.data;
      if (!Array.isArray(data)) throw unexpected('Smart BIAI 视频');
      const matches = data.filter(task => task.request_id === requestId);
      if (matches.length > 1) throw unexpected('Smart BIAI 视频');
      return matches[0] ?? null;
    },
    create(body) { return call('/v1/videos', body); },
    detail(id) { return call(`/v1/videos/${encodeURIComponent(id)}`); }
  };
}

export function mediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.port === '' || url.port === '443') && !url.username && !url.password &&
      url.hostname.includes('.') && !/^(?:\d+\.|localhost|.*\.local$)/i.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function clean(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

const intentRules = `你是 Smart BIAI 工作台的指令理解组件。只返回一个 JSON 对象，不要 Markdown。当前请求不会自动执行。字段：
query,generate,publish,taskQuery 为布尔值，可组合。查看发布任务用 taskQuery，不要当作发布；查看生成记录也不要开始生成。
platform 只能是 TikTok、YouTube、Instagram 或空字符串。accountId 仅从用户消息中明确的数字 ID 提取，其他情况留空。
keyword 是用户明确指定的账号名或别名，country 是用户明确指定的国家（优先 ISO 代码），缺省为空。不要补造账号。
prompt 是生成视频的具体提示词，可扩写用户创作需求，去掉账号、排期等操作指令；ratio 使用用户指定的画幅或留空；duration 为明确提到的整数秒或 null。
title 和 description 为用户提供或基于当前对话建议的发布标题和描述。不要捏造产品承诺。仅在确有发布需求时填写文案建议。
requiresSchedule 表示用户要求预约。不要推断具体日期、时区或未明确的时间。message 用于不属于以上操作时简短回复。
如果操作内容不清楚，礼貌询问。不得索要密钥、改变应用设置或声称操作已执行。`;

export async function understand(config, message, history, fill = false) {
  if (!config.key || !config.model || !['deepseek', 'doubao'].includes(config.provider)) {
    throw new IntegrationError('请在连接设置选择 DeepSeek 或豆包，并填写模型 ID 和 API Key。', 422);
  }
  const instruction = fill ? '为这段视频提示词建议一条简洁标题和可选描述，不添加未经验证的营销承诺，只返回 JSON 对象 {"title":"","description":""}。' : intentRules;
  const content = JSON.stringify({ instruction, history, message });
  const deepseek = config.provider === 'deepseek';
  const result = await jsonRequest(deepseek ? 'DeepSeek' : '豆包', deepseek ? 'https://api.deepseek.com/anthropic/v1/messages' : 'https://ark.cn-beijing.volces.com/api/v3/responses', {
    timeout: 45000,
    headers: deepseek ? { 'x-api-key': config.key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${config.key}` },
    body: deepseek ? { model: config.model, messages: [{ role: 'user', content }], max_tokens: 2048, stream: false } :
      { model: config.model, input: [{ role: 'user', content }], max_output_tokens: 2048, stream: false }
  });
  const done = deepseek ? ['end_turn', 'stop_sequence'].includes(result?.stop_reason) : result?.status === 'completed';
  const blocks = deepseek ? result?.content : result?.output?.filter(item => item.type === 'message' && item.role === 'assistant')?.flatMap(item => item.content ?? []);
  const answer = blocks?.filter(item => item.type === (deepseek ? 'text' : 'output_text')).map(item => item.text ?? '').join('').trim();
  let parsed;
  try { if (done && answer && answer.length < 16000) parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/gi, '')); }
  catch { /* Ask the user to retry below. */ }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unexpected(deepseek ? 'DeepSeek' : '豆包');
  const title = clean(parsed.title, 100);
  const description = clean(parsed.description, 1000);
  if (fill) return { title, description };
  return {
    query: parsed.query === true, generate: parsed.generate === true, publish: parsed.publish === true, taskQuery: parsed.taskQuery === true,
    requiresSchedule: parsed.requiresSchedule === true, platform: Object.values(platforms).includes(parsed.platform) ? parsed.platform : '',
    accountId: typeof parsed.accountId === 'string' && /^[1-9]\d{0,18}$/.test(parsed.accountId) ? parsed.accountId : '',
    keyword: clean(parsed.keyword, 100), country: clean(parsed.country, 80), prompt: clean(parsed.prompt, 2000), title, description,
    ratio: clean(parsed.ratio, 10), duration: Number.isInteger(parsed.duration) && parsed.duration > 0 && parsed.duration <= 600 ? parsed.duration : null,
    message: clean(parsed.message, 600)
  };
}
