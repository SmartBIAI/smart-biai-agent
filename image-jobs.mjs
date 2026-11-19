import { apiErrorMessage, imageClient, mediaUrl } from './integrations.mjs';
import { imageModels, imageParameters, validationError } from './generation-models.js';

const sampleUrl = './demo-assets/sample-cover.jpg';
const validId = value => {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) validationError('任务编号无效。');
  return value;
};
const timestamp = value => typeof value === 'number' && value > 0 ? value < 10_000_000_000 ? value * 1000 : value :
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function createImageJobs(database, { connection, models, prepareFiles, client = imageClient, now = Date.now }) {
  database.exec(`CREATE TABLE IF NOT EXISTS image_generation (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, parameters TEXT NOT NULL, credits INTEGER NOT NULL,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, scope TEXT, state TEXT NOT NULL,
    source_id TEXT, payload TEXT, results TEXT NOT NULL DEFAULT '[]', error TEXT,
    poll_at INTEGER NOT NULL DEFAULT 0, charged INTEGER NOT NULL DEFAULT 0, refunded INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_image_generation_poll ON image_generation(mode, state, poll_at);
  CREATE TABLE IF NOT EXISTS image_quote (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, parameters TEXT NOT NULL, payload TEXT NOT NULL,
    credits INTEGER NOT NULL, expires INTEGER NOT NULL
  );`);
  const get = database.prepare('SELECT * FROM image_generation WHERE id = ?');
  let running = false;
  const refreshes = new Map();

  function view(row, mode) {
    if (!row || row.mode !== mode) validationError('找不到这项图片生成任务。', 404);
    const time = now();
    const results = JSON.parse(row.results).map(item => ({ ...item,
      status: item.expiresAt && item.expiresAt <= time ? 'expired' : item.status,
      url: item.expiresAt && item.expiresAt <= time || item.urlExpiresAt && item.urlExpiresAt <= time ? null : item.url
    }));
    const successes = results.filter(item => ['succeeded', 'expired'].includes(item.status));
    const expired = successes.length && successes.every(item => item.status === 'expired');
    return { id: row.id, mode: row.mode, parameters: JSON.parse(row.parameters), credits: row.credits,
      created: row.created, updated: row.updated, status: expired ? 'expired' : row.state, sourceTaskId: row.source_id,
      results, error: row.error, chargedCredits: row.charged, refundedCredits: row.refunded };
  }

  function advanceMock() {
    const time = now();
    for (const row of database.prepare("SELECT * FROM image_generation WHERE mode='mock' AND state='generating' AND created <= ?").all(time - 1800)) {
      const parameters = JSON.parse(row.parameters);
      const results = Array.from({ length: parameters.n }, (_, index) => ({ index, status: 'succeeded', url: sampleUrl,
        expiresAt: time + 7 * 86400000, urlExpiresAt: null, mimeType: 'image/jpeg', width: 496, height: 864 }));
      database.prepare("UPDATE image_generation SET state='completed', results=?, source_id=?, updated=? WHERE id=?")
        .run(JSON.stringify(results), `mock-img-${row.id}`, time, row.id);
    }
  }

  async function quote(body, mode) {
    const id = validId(body.id);
    if (get.get(id)) validationError('该草稿已有图片任务，请查看生成记录。', 409);
    const live = mode === 'live';
    const current = live ? connection() : null;
    const catalog = live ? await models(current) : imageModels;
    if (!catalog.length) validationError('当前应用没有可用的生图模型，请到 Smart BIAI 开通图片模型。', 422);
    const parameters = imageParameters(body, catalog);
    const model = catalog.find(item => item.id === parameters.model);
    if (!live) return { parameters, credits: parameters.n * 5 };
    const files = await prepareFiles(parameters.fileIds, model);
    const payload = { model: parameters.model, prompt: parameters.prompt, n: parameters.n,
      ...(model.spec === 'size' ? { size: parameters.size, quality: parameters.quality } : { aspect_ratio: parameters.ratio, resolution: parameters.resolution }) };
    const references = [...parameters.references, ...files.map(item => item.url)];
    if (references.length) payload.images = references;
    if (parameters.maskFileId) payload.mask = (await prepareFiles([parameters.maskFileId], model, true))[0].url;
    const credits = await client(current).quote(payload);
    if (!Number.isSafeInteger(credits) || credits < 1 || credits > 2_000_000_000) validationError('本次生图报价无法建立明确的费用上限。', 422);
    database.prepare('DELETE FROM image_quote WHERE expires <= ?').run(now());
    database.prepare('INSERT OR REPLACE INTO image_quote VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, current.scope, JSON.stringify(parameters), JSON.stringify(payload), credits, now() + 5 * 60000);
    return { parameters, credits };
  }

  async function create(body, mode) {
    const id = validId(body.id);
    const existing = get.get(id);
    if (existing && existing.mode !== mode) validationError('任务编号属于另一种运行模式。', 409);
    const live = mode === 'live';
    const current = live ? connection() : null;
    const parameters = imageParameters(body, live ? await models(current) : imageModels);
    const frozen = JSON.stringify(parameters);
    if (existing) {
      if (existing.parameters !== frozen || existing.credits !== body.credits || live && existing.scope !== current.scope) validationError('该编号已经用于另一份图片生成草稿。', 409);
      return view(existing, mode);
    }
    const estimate = live ? database.prepare('SELECT * FROM image_quote WHERE id=? AND expires>?').get(id, now()) : { parameters: frozen, credits: parameters.n * 5 };
    if (!estimate || estimate.parameters !== frozen || estimate.credits !== body.credits || live && estimate.scope !== current.scope) validationError('请重新获取并确认图片报价。', 409);
    const time = now();
    const payload = live ? JSON.stringify({ ...JSON.parse(estimate.payload), request_id: id, max_credits: estimate.credits }) : null;
    database.prepare(`INSERT INTO image_generation (id, mode, parameters, credits, created, updated, scope, state, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, mode, frozen, estimate.credits, time, time, current?.scope ?? null, live ? 'queued' : 'generating', payload);
    return view(get.get(id), mode);
  }

  function accept(row, task) {
    if (!task || typeof task.id !== 'string' || !task.id || row.source_id && task.id !== row.source_id ||
        task.request_id && task.request_id !== row.id || task.model && task.model !== JSON.parse(row.parameters).model || !Array.isArray(task.data) && task.status !== 'failed') {
      throw Object.assign(new Error('暂时无法确认图片任务结果，工作台会继续查询原任务。'), { uncertain: true });
    }
    const statuses = { succeeded: 'completed', partially_succeeded: 'partial', failed: 'failed', review: 'review' };
    const state = statuses[task.status] || 'generating';
    const n = JSON.parse(row.parameters).n;
    const secrets = [connection().key];
    const results = (Array.isArray(task.data) ? task.data : []).slice(0, n).map((item, index) => ({
      index: Number.isInteger(item.index) ? item.index : index, status: String(item.status || 'queued'), url: mediaUrl(item.url),
      urlExpiresAt: timestamp(item.url_expires_at), expiresAt: timestamp(item.expires_at), mimeType: String(item.mime_type || ''),
      width: Number.isInteger(item.width) ? item.width : null, height: Number.isInteger(item.height) ? item.height : null,
      error: apiErrorMessage(item.error, secrets) || (item.status === 'failed' ? '这张图片生成失败，接口未返回具体原因。' : null)
    }));
    const error = apiErrorMessage(task.error, secrets) || (['failed', 'partial'].includes(state) ? results.filter(item => item.error)
      .map(item => n === 1 ? item.error : `第 ${item.index + 1} 张：${item.error}`).join('\n') : '');
    const complete = ['completed', 'partial', 'failed'].includes(state);
    database.prepare('UPDATE image_generation SET source_id=?, state=?, results=?, updated=?, poll_at=?, error=?, charged=?, refunded=? WHERE id=?')
      .run(task.id, state, JSON.stringify(results), now(), complete ? 0 : now() + 10000,
        error || (state === 'failed' ? '图片生成失败，接口未返回具体原因。' : null),
        amount(task.charged_credits), amount(task.refunded_credits), row.id);
    return get.get(row.id);
  }

  async function refresh(id, mode) {
    advanceMock();
    const row = get.get(validId(id));
    const result = view(row, mode);
    if (mode !== 'live') return result;
    const current = connection();
    if (!current.scope || row.scope !== current.scope) validationError('生成密钥已更换，请改回生成这组图片时的密钥。', 409);
    if (!row.source_id) return result;
    if (refreshes.has(id)) return refreshes.get(id);
    const pending = client(current).detail(row.source_id).then(task => view(accept(get.get(id), task), mode));
    refreshes.set(id, pending);
    try { return await pending; }
    finally { refreshes.delete(id); }
  }

  async function process(row) {
    const current = connection();
    if (!current.scope || row.scope !== current.scope) {
      database.prepare('UPDATE image_generation SET poll_at=?, error=? WHERE id=?').run(now() + 60000, '生成密钥已更换，改回原密钥后继续查询。', row.id);
      return;
    }
    try {
      if (row.source_id) { await refresh(row.id, 'live'); return; }
      if (row.state !== 'queued') {
        const task = await client(current).recover(row.id);
        if (task) { accept(row, task); return; }
        database.prepare("UPDATE image_generation SET state='unknown', poll_at=?, error=? WHERE id=?")
          .run(now() + 15000, '任务受理结果暂未确认，正在查询原任务。', row.id);
        return;
      }
      database.prepare("UPDATE image_generation SET state='submitting', updated=? WHERE id=?").run(now(), row.id);
      accept(row, await client(current).create(JSON.parse(row.payload)));
    } catch (error) {
      const state = row.source_id ? row.state : row.state !== 'queued' || error.uncertain ? 'unknown' : 'failed';
      database.prepare('UPDATE image_generation SET state=?, poll_at=?, error=?, updated=? WHERE id=?')
        .run(state, state === 'failed' ? 0 : now() + Math.max(error.retryAfter || 0, 15000), error.message, now(), row.id);
    }
  }

  async function run() {
    advanceMock();
    if (running) return;
    running = true;
    try {
      const rows = database.prepare(`SELECT * FROM image_generation WHERE mode='live' AND state IN ('queued','submitting','generating','review','unknown') AND poll_at<=? ORDER BY created LIMIT 3`).all(now());
      const claimed = rows.filter(row => database.prepare('UPDATE image_generation SET poll_at=? WHERE id=? AND poll_at=?').run(now() + 120000, row.id, row.poll_at).changes);
      await Promise.allSettled(claimed.map(process));
    } finally { running = false; }
  }

  return {
    quote, create, refresh, run,
    list(mode) { advanceMock(); return database.prepare('SELECT * FROM image_generation WHERE mode=? ORDER BY created DESC').all(mode).map(row => view(row, mode)); },
    get(id, mode) { advanceMock(); return view(get.get(validId(id)), mode); }
  };
}
