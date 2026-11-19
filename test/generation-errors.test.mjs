import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { apiErrorMessage, imageClient, videoClient } from '../integrations.mjs';
import { createLiveJobs, migrateLive } from '../live-jobs.mjs';

test('API error extraction keeps messages, codes and field errors without dumping response secrets', () => {
  assert.equal(apiErrorMessage({ error: { code: 'bad_reference', message: '参考图片无法读取' } }), '参考图片无法读取 （bad_reference）');
  assert.equal(apiErrorMessage({ detail: [{ loc: ['body', 'images', 0], msg: 'Invalid image', input: 'private-input' }] }), 'body.images.0: Invalid image');
  const detail = apiErrorMessage({ error: { message: '输入参数无效', fields: [{ field: 'body.model', message: 'Field required' }] }, request: { headers: { Authorization: 'private-header' } } });
  assert.ok(detail.includes('body.model: Field required'));
  assert.ok(!detail.includes('private-header'));
  assert.equal(apiErrorMessage('provider says secret-test-key', ['secret-test-key']), 'provider says [已隐藏]');
  assert.equal(apiErrorMessage({ error: {} }), '');
});

test('image/video HTTP failures preserve the API reason and retry/uncertainty behavior', async () => {
  const fetch = globalThis.fetch;
  try {
    for (const client of [imageClient, videoClient]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'unsupported_reference', message: '参考图片超过模型限制。' } }), { status: 422 });
      await assert.rejects(client({ key: 'test-key' }).quote({}), error => {
        assert.ok(error.message.includes('参考图片超过模型限制。'));
        assert.ok(error.message.includes('unsupported_reference'));
        assert.ok(error.message.includes('HTTP 422'));
        assert.equal(error.retryable, false); assert.equal(error.uncertain, false);
        return true;
      });
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'provider_busy', message: '生成服务暂时繁忙' } }), { status: 503, headers: { 'Retry-After': '7' } });
      await assert.rejects(client({ key: 'test-key' }).create({}), error => {
        assert.ok(error.message.includes('provider_busy'));
        assert.equal(error.status, 503); assert.equal(error.retryable, true); assert.equal(error.uncertain, true); assert.equal(error.retryAfter, 7000);
        return true;
      });
      globalThis.fetch = async () => new Response('<html>gateway stack trace</html>', { status: 502 });
      await assert.rejects(client({ key: 'test-key' }).quote({}), error => !error.message.includes('<html>') && error.message.includes('502'));
    }
  } finally { globalThis.fetch = fetch; }
});

test('video failed state and a later status refresh retain the full upstream error without resubmission', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE generation (id TEXT PRIMARY KEY, parameters TEXT NOT NULL, credits INTEGER, created INTEGER, source_id TEXT, url TEXT, cover TEXT, expires INTEGER);
    CREATE TABLE publication (id TEXT PRIMARY KEY, status TEXT, planned INTEGER, created INTEGER, source_id TEXT);`);
  migrateLive(db);
  const id = randomUUID();
  db.prepare("INSERT INTO generation (id,parameters,created,mode,scope,state,payload) VALUES (?,?,?,'live','scope','queued',?)")
    .run(id, JSON.stringify({ model: 'test-model' }), Date.now(), JSON.stringify({ request_id: id, model: 'test-model' }));
  const reason = 'Content audit failed.\n' + '保持完整的接口错误详情。'.repeat(500);
  const fetch = globalThis.fetch;
  let submissions = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'POST') submissions++;
    return new Response(JSON.stringify({ id: 'vid_test', request_id: id, model: 'test-model', status: 'failed', error: { code: 'upstream_failed', message: reason } }));
  };
  try {
    const jobs = createLiveJobs(db, () => ({ key: 'test-key', scope: 'scope' }), 900000);
    await jobs.run();
    let row = db.prepare('SELECT * FROM generation WHERE id=?').get(id);
    assert.equal(row.state, 'failed'); assert.ok(row.error.includes(reason)); assert.ok(row.error.includes('upstream_failed'));
    db.prepare('UPDATE generation SET error=? WHERE id=?').run('旧版通用提示', id);
    row = await jobs.refreshVideo(db.prepare('SELECT * FROM generation WHERE id=?').get(id));
    assert.ok(row.error.includes(reason)); assert.equal(submissions, 1);
  } finally { globalThis.fetch = fetch; db.close(); }
});

test('upstream video generation checks wait 15 seconds while a manual refresh can query immediately', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE generation (id TEXT PRIMARY KEY, parameters TEXT NOT NULL, credits INTEGER, created INTEGER, source_id TEXT, url TEXT, cover TEXT, expires INTEGER);
    CREATE TABLE publication (id TEXT PRIMARY KEY, status TEXT, planned INTEGER, created INTEGER, source_id TEXT);`);
  migrateLive(db);
  const id = randomUUID();
  db.prepare("INSERT INTO generation (id,parameters,created,mode,scope,state,payload) VALUES (?,?,?,'live','scope','queued',?)")
    .run(id, JSON.stringify({ model: 'test-model' }), Date.now(), JSON.stringify({ request_id: id, model: 'test-model' }));
  const fetch = globalThis.fetch, originalNow = Date.now;
  let clock = originalNow(), queries = 0;
  Date.now = () => clock;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'GET') queries++;
    return new Response(JSON.stringify({ id: 'vid_wait', request_id: id, model: 'test-model', status: 'accepted' }));
  };
  try {
    const jobs = createLiveJobs(db, () => ({ key: 'test-key', scope: 'scope' }), 900000);
    await jobs.run();
    assert.equal(db.prepare('SELECT poll_at FROM generation WHERE id=?').get(id).poll_at, clock + 15000);
    clock += 14999; await jobs.run(); assert.equal(queries, 0);
    clock++; await jobs.run(); assert.equal(queries, 1);
    await jobs.refreshVideo(db.prepare('SELECT * FROM generation WHERE id=?').get(id)); assert.equal(queries, 2);
  } finally { globalThis.fetch = fetch; Date.now = originalNow; db.close(); }
});
