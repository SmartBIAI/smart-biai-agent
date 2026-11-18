import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoRequest } from '../dist/demo/demo.js';

const time = Date.UTC(2026, 10, 18, 8);

function fixture(overrides = {}, options = {}) {
  let saved = JSON.stringify({ generations: [], publications: [], conversations: [], ...overrides });
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  return {
    request: createDemoRequest({ storage, key: 'test', now: () => time, ...options }),
    saved: () => JSON.parse(saved)
  };
}

function video(overrides = {}) {
  return {
    id: 'previous-video', status: 'completed', mode: 'mock', created: time - 2000,
    expiresAt: time + 3600000, url: 'https://old.example.com/video.mp4',
    coverUrl: 'https://old.example.com/cover.jpg', ...overrides
  };
}

test('existing videos and publication covers update without losing conversations or task status', async () => {
  const conversation = { id: 'previous-chat', title: '保留的对话', revision: 3, chat: [{ type: 'user', text: '查询账号' }] };
  const app = fixture({
    generations: [video()], conversations: [conversation],
    publications: [{ id: 'previous-publication', generationId: 'previous-video', status: 'completed', coverUrl: 'https://old.example.com/cover.jpg' }]
  });
  const [result] = await app.request('generations');
  assert.equal(result.url, './demo-assets/sample-video.mp4');
  assert.equal(result.coverUrl, './demo-assets/sample-cover.jpg');
  assert.equal(result.expiresAt, time + 3600000);
  assert.equal(app.saved().publications[0].status, 'completed');
  assert.equal(app.saved().publications[0].coverUrl, result.coverUrl);
  assert.deepEqual(app.saved().conversations, [conversation]);
  assert.equal(new URL(result.url, 'https://example.com/nested/demo/').pathname, '/nested/demo/demo-assets/sample-video.mp4');
});

test('pending simulated generation resolves to bundled media', async () => {
  const app = fixture({ generations: [video({ status: 'generating', url: undefined, coverUrl: undefined, expiresAt: undefined })] });
  const [result] = await app.request('generations');
  assert.equal(result.status, 'completed');
  assert.equal(result.url, './demo-assets/sample-video.mp4');
  assert.ok(result.expiresAt > time);
});

test('expired videos remain expired during sample migration', async () => {
  const app = fixture({ generations: [video({ expiresAt: time - 1 })] });
  const [result] = await app.request('generations');
  assert.equal(result.status, 'expired');
  assert.equal(result.url, null);
  assert.equal(result.coverUrl, null);
});

test('custom external video uses its own cover or an empty cover', async () => {
  for (const sampleCover of [undefined, 'https://example.com/custom-cover.jpg']) {
    const app = fixture({ generations: [video()] }, { sampleVideo: 'https://example.com/custom.mp4', sampleCover });
    const [result] = await app.request('generations');
    assert.equal(result.url, 'https://example.com/custom.mp4');
    assert.equal(result.coverUrl, sampleCover || null);
  }
});

test('a custom cover works with the bundled video', async () => {
  const app = fixture({ generations: [video()] }, { sampleCover: 'https://example.com/custom-cover.jpg' });
  const [result] = await app.request('generations');
  assert.equal(result.url, './demo-assets/sample-video.mp4');
  assert.equal(result.coverUrl, 'https://example.com/custom-cover.jpg');
});

test('public demo exposes the full catalog and simulates image quote, confirmation and results', async () => {
  let clock = time;
  const app = fixture({}, { now: () => clock });
  const boot = await app.request('bootstrap');
  assert.equal(boot.models.length, 8);
  assert.equal(boot.imageModels.length, 12);
  const model = boot.imageModels[0];
  const body = { id: 'demo-image', model: model.id, prompt: '明亮自然的马克杯产品图', n: 2, size: model.sizes[0], quality: model.qualities[0] };
  const quote = await app.request('images/quote', body);
  assert.equal(app.saved().images.length, 0);
  await app.request('images', { ...body, credits: quote.credits });
  clock += 2000;
  const [task] = await app.request('images');
  assert.equal(task.status, 'completed');
  assert.equal(task.results.length, 2);
  assert.ok(task.results[0].url.startsWith('./demo-assets/'));
  assert.equal((await app.request('images/demo-image/refresh')).id, task.id);
  assert.equal(app.saved().images.length, 1);
});
