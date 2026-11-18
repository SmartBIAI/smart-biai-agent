import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { models, imageModels, normalizeModel, videoParameters, imageParameters, validateVideoReferences } from '../generation-models.js';
import { interpret } from '../mock.mjs';
import { createImageJobs } from '../image-jobs.mjs';
import { videoClient, imageClient } from '../integrations.mjs';

const imageModel = imageModels.find(model => model.id === 'smartbiai-gpt-img-2-6-sunburst');
const imageBody = () => ({ id: randomUUID(), model: imageModel.id, prompt: '白色背景上的蓝色陶瓷杯', n: 2, size: '1024x1024', quality: 'auto' });
function harness(overrides = {}) {
  const db = new DatabaseSync(':memory:');
  let clock = Date.UTC(2026, 10, 18);
  let scope = 'original-scope';
  const calls = { create: [], detail: [], recover: [], quote: [] };
  const upstream = {
    async quote(body) { calls.quote.push(body); return body.n * 5; },
    async create(body) { calls.create.push(body); return { id: 'img_test', request_id: body.request_id, model: body.model, status: 'queued', data: [] }; },
    async detail(id) { calls.detail.push(id); return { id, status: 'succeeded', charged_credits: 10, refunded_credits: 0, data: [
      { index: 0, status: 'succeeded', url: 'https://example.com/one.png', expires_at: new Date(clock + 86400000).toISOString(), url_expires_at: new Date(clock + 3600000).toISOString(), mime_type: 'image/png' },
      { index: 1, status: 'succeeded', url: 'https://example.com/two.png', expires_at: new Date(clock + 86400000).toISOString() }
    ] }; },
    async recover(id) { calls.recover.push(id); return null; }, ...overrides
  };
  const jobs = createImageJobs(db, { connection: () => ({ key: 'test-key', scope }), models: async () => [imageModel],
    prepareFiles: async ids => ids.map(id => ({ type: 'image', url: `https://example.com/${id}.png` })),
    client: () => upstream, now: () => clock });
  return { db, jobs, calls, upstream, tick: ms => { clock += ms; }, changeScope: value => { scope = value; } };
}

test('live model discovery keeps all granted models, including new identifiers', async () => {
  const original = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async url => {
    paths.push(String(url));
    const image = String(url).includes('media_type=image');
    const data = image ? [{ id: imageModel.id, name: imageModel.name, media_type: 'image', capabilities: imageModel.capabilities }] :
      [...models, { ...models[0], id: 'future-authorized-model' }].map(model => ({ id: model.id, name: model.name, media_type: 'video', capabilities: model.capabilities }));
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  try {
    const video = await videoClient({ key: 'test-key' }).models();
    const image = await imageClient({ key: 'test-key' }).models();
    assert.equal(video.length, models.length + 1);
    assert.ok(video.some(model => model.id === 'future-authorized-model'));
    assert.equal(image[0].id, imageModel.id);
    assert.ok(paths[0].endsWith('?media_type=video'));
    assert.ok(paths[1].endsWith('?media_type=image'));
  } finally { globalThis.fetch = original; }
});

test('video validation follows each model capability rather than its name', () => {
  const base = { prompt: '竖屏产品视频测试，晨光下的马克杯', ratio: '9:16', resolution: '720p', duration: 6, audio: false };
  assert.equal(videoParameters({ ...base, model: 'smartbiai-sd-2-5-260719', duration: 30, resolution: '1080p' }, models).duration, 30);
  assert.equal(videoParameters({ ...base, model: models[0].id, duration: -1 }, models).duration, -1);
  assert.throws(() => videoParameters({ ...base, model: 'smartbiai-sd-2-0-lite-260722', duration: -1 }, models));
  assert.throws(() => videoParameters({ ...base, model: 'smartbiai-sd-2-0-lite-260722', resolution: '1080p' }, models));
  assert.equal(normalizeModel({ id: 'new-model', capabilities: models[0].capabilities }).maxPrompt, 20000);
  assert.throws(() => validateVideoReferences([{ type: 'audio', url: 'https://example.com/a.mp3' }], models[0], '9:16'));
});

test('image and video instructions select separate flows', () => {
  assert.equal(interpret('生成两张图片').generate, false);
  assert.equal(interpret('生成两张图片').n, 2);
  assert.equal(interpret('生成一张产品海报').generateImage, true);
  assert.equal(interpret('图生视频，制作6秒产品短片').generateImage, false);
  assert.equal(interpret('查看生图记录').imageQuery, true);
  assert.equal(interpret('查看生图记录').generateImage, false);
  assert.equal(interpret('查看图片').imageQuery, true);
  assert.equal(interpret('使用 Seedance2.5 生成30秒视频').model, 'smartbiai-sd-2-5-260719');
});

test('image spec and mask requirements follow the selected model', () => {
  const banana = imageModels.find(model => model.id === 'smartbiai-banana');
  const parsed = imageParameters({ model: banana.id, prompt: '简洁产品图', n: 1, ratio: '1:1', resolution: '1K' }, imageModels);
  assert.equal(parsed.size, undefined);
  assert.equal(parsed.ratio, '1:1');
  assert.throws(() => imageParameters({ ...imageBody(), maskFileId: randomUUID() }, imageModels));
  assert.throws(() => imageParameters({ ...imageBody(), n: 9 }, imageModels));
});

test('image generation requires a matching confirmed quote and is idempotent', async () => {
  const h = harness();
  try {
    const body = imageBody();
    await assert.rejects(h.jobs.create({ ...body, credits: 10 }, 'live'), /报价/);
    const quote = await h.jobs.quote(body, 'live');
    assert.equal(h.calls.create.length, 0);
    await assert.rejects(h.jobs.create({ ...body, prompt: '改过的提示词', credits: quote.credits }, 'live'), /报价/);
    const created = await h.jobs.create({ ...body, credits: quote.credits }, 'live');
    assert.equal(created.status, 'queued');
    await h.jobs.create({ ...body, credits: quote.credits }, 'live');
    await h.jobs.run();
    assert.equal(h.calls.create.length, 1);
    assert.equal(h.calls.create[0].request_id, body.id);
    assert.equal(h.calls.create[0].max_credits, quote.credits);
    h.tick(5000); await h.jobs.run();
    const completed = h.jobs.get(body.id, 'live');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.results.length, 2);
    assert.equal(completed.chargedCredits, 10);
    assert.throws(() => h.jobs.get(body.id, 'mock'), /找不到/);
  } finally { h.db.close(); }
});

test('ambiguous submissions recover the original request without submitting twice', async () => {
  const h = harness();
  try {
    h.upstream.create = async body => { h.calls.create.push(body); throw Object.assign(new Error('network timeout'), { uncertain: true }); };
    const body = imageBody();
    const q = await h.jobs.quote(body, 'live'); await h.jobs.create({ ...body, credits: q.credits }, 'live');
    await h.jobs.run();
    assert.equal(h.jobs.get(body.id, 'live').status, 'unknown');
    h.tick(16000); await h.jobs.run();
    h.upstream.recover = async id => { h.calls.recover.push(id); return { id: 'img_recovered', request_id: id, model: body.model, status: 'queued', data: [] }; };
    h.tick(16000); await h.jobs.run();
    assert.equal(h.calls.create.length, 1);
    assert.equal(h.jobs.get(body.id, 'live').sourceTaskId, 'img_recovered');
  } finally { h.db.close(); }
});

test('expired quotes and changed credentials cannot confirm an image submission', async () => {
  const h = harness();
  try {
    const body = { ...imageBody(), fileIds: [randomUUID()], maskFileId: randomUUID() };
    const quoted = await h.jobs.quote(body, 'live');
    assert.equal(h.calls.quote[0].images.length, 1);
    assert.ok(h.calls.quote[0].mask.endsWith('.png'));
    h.tick(300001);
    await assert.rejects(h.jobs.create({ ...body, credits: quoted.credits }, 'live'), /报价/);
    await h.jobs.quote(body, 'live'); h.changeScope('another-key');
    await assert.rejects(h.jobs.create({ ...body, credits: quoted.credits }, 'live'), /报价/);
    assert.equal(h.calls.create.length, 0);
  } finally { h.db.close(); }
});

test('image expiry, partial delivery and credentials remain separate concerns', async () => {
  const h = harness();
  try {
    const body = imageBody(); const q = await h.jobs.quote(body, 'live');
    await h.jobs.create({ ...body, credits: q.credits }, 'live'); await h.jobs.run();
    h.upstream.detail = async id => ({ id, status: 'partially_succeeded', charged_credits: 5, refunded_credits: 5, data: [
      { index: 0, status: 'succeeded', url: 'https://example.com/one.png', expires_at: new Date(Date.UTC(2026, 10, 19)).toISOString(), url_expires_at: new Date(Date.UTC(2026, 10, 18, 1)).toISOString() },
      { index: 1, status: 'failed', error: { code: 'generation_failed' } }
    ] });
    h.tick(5000); await h.jobs.run();
    assert.equal(h.jobs.get(body.id, 'live').status, 'partial');
    assert.equal(h.jobs.get(body.id, 'live').refundedCredits, 5);
    h.tick(3600000);
    assert.equal(h.jobs.get(body.id, 'live').results[0].url, null);
    assert.equal(h.jobs.get(body.id, 'live').status, 'partial');
    h.changeScope('another-key');
    await assert.rejects(h.jobs.refresh(body.id, 'live'), /密钥/);
    h.tick(86400000); assert.equal(h.jobs.get(body.id, 'live').status, 'expired');
  } finally { h.db.close(); }
});

test('mock image tasks store metadata and survive reopening the job manager', async () => {
  const h = harness();
  try {
    const body = imageBody(); const q = await h.jobs.quote(body, 'mock');
    await h.jobs.create({ ...body, credits: q.credits }, 'mock'); h.tick(2000);
    assert.equal(h.jobs.list('mock')[0].results.length, 2);
    const reopened = createImageJobs(h.db, { connection: () => ({}), models: async () => [], prepareFiles: async () => [], now: () => Date.UTC(2026, 10, 18, 0, 0, 2) });
    assert.equal(reopened.list('mock')[0].id, body.id);
    assert.ok(reopened.list('mock')[0].results[0].url.startsWith('./demo-assets/'));
  } finally { h.db.close(); }
});
