import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createAutomation } from '../automation.mjs';

function setup(t, overrides = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const videos = new Map();
  const publications = new Map();
  let now = Date.parse('2026-11-26T08:00Z');
  let scope = 'authorized';
  const dependencies = {
    now: () => now,
    connection: mode => mode === 'mock' ? mode : scope,
    parameters: async video => video,
    account: async () => ({ id: '101' }),
    quote: async body => ({ parameters: body, credits: 12 }),
    generate: body => videos.set(body.id, { id: body.id, credits: body.credits, status: 'generating' }),
    video: id => videos.get(id),
    publication: id => publications.get(id),
    publish: async (body, _mode, check) => {
      check();
      publications.set(body.id, { ...body, status: 'scheduled' });
    },
    ...overrides
  };
  const store = createAutomation(db, dependencies);
  const spec = {
    name: '产品演示', zone: 'UTC', startsAt: '2026-11-26T08:01', frequency: 'once', policy: 'review', publishAt: '08:30',
    maxCredits: 15, accountId: '101', title: '演示视频', description: '产品介绍', video: { prompt: '展示产品' }
  };
  const save = (changes = {}, mode = 'mock') => store.save(mode, { ...spec, ...changes });
  const manage = (rule, action, mode = 'mock') => store.manage(mode, { id: rule.id, revision: rule.revision, action });
  const complete = () => { for (const video of videos.values()) Object.assign(video, { status: 'completed', expiresAt: now + 86_400_000 }); };
  const at = date => { now = Date.parse(date); };
  return { db, store, videos, publications, dependencies, save, manage, complete, at, switchScope: () => { scope = 'other'; } };
}

test('a confirmed manual-review rule creates an execution once and schedules publication only after approval', async t => {
  const h = setup(t), rule = await h.save();
  h.at('2026-11-26T08:00:30Z');
  await h.store.tick();
  assert.equal(h.videos.size, 0, 'saving a draft does not run it');
  h.manage(rule, 'enable');
  h.at('2026-11-26T08:01:00Z');
  await Promise.all([h.store.tick(), h.store.tick()]);
  assert.equal(h.videos.size, 1);
  assert.equal(h.store.list('mock').rules[0].enabled, false);
  h.complete();
  await h.store.tick();
  const [run] = h.store.list('mock').runs;
  assert.equal(run.status, 'review');
  assert.equal(h.publications.size, 0);
  assert.throws(() => h.store.review('live', { id: run.id, action: 'approve' }), { status: 404 });
  h.store.review('mock', { id: run.id, action: 'approve', title: '审核后的标题' });
  assert.throws(() => h.store.review('mock', { id: run.id, action: 'approve' }), { status: 409 });
  await Promise.all([h.store.tick(), h.store.tick()]);
  assert.equal(h.publications.size, 1);
  const [published] = h.publications.values();
  assert.equal(published.planned, Date.parse('2026-11-26T08:30Z'));
  assert.equal(published.title, '审核后的标题');
  assert.equal(h.store.run('mock', run.id).status, 'scheduled');
});

test('recurring automatic rules queue the next-day post once and pausing stops future generations', async t => {
  const h = setup(t), rule = await h.save({ policy: 'auto', frequency: 'weekly', publishAt: '08:00' });
  const enabled = h.manage(rule, 'enable');
  assert.equal(enabled.nextAt, Date.parse('2026-11-26T08:01Z'));
  h.at('2026-11-26T08:01Z');
  await h.store.tick();
  h.complete();
  await h.store.tick();
  await h.store.tick();
  assert.equal(h.publications.size, 1);
  assert.equal([...h.publications.values()][0].planned, Date.parse('2026-11-27T08:00Z'));
  const current = h.store.list('mock').rules[0];
  assert.equal(current.nextAt, Date.parse('2026-12-03T08:01Z'));
  h.manage(current, 'pause');
  h.at('2026-12-03T08:01Z');
  await h.store.tick();
  assert.equal(h.videos.size, 1);
});

test('credit caps and a changed connection prevent generation, and repeated run confirmation cannot enqueue another run', async t => {
  const h = setup(t);
  const small = await h.save({ maxCredits: 11 });
  h.manage(small, 'run');
  assert.throws(() => h.manage(small, 'run'), { status: 409 });
  await h.store.tick();
  assert.equal(h.videos.size, 0);
  assert.match(h.store.list('mock').runs[0].error, /超过单次上限/);
  const live = await h.save({}, 'live');
  h.manage(live, 'enable', 'live');
  h.switchScope();
  h.at('2026-11-26T08:01Z');
  await h.store.tick();
  assert.equal(h.store.list('live').runs[0].status, 'failed');
  assert.match(h.store.list('live').runs[0].error, /连接已变化/);
  assert.equal(h.videos.size, 0);
});

test('late losses are visible, passed manual schedules can be moved, and rejecting or canceling prevents release', async t => {
  const h = setup(t);
  h.manage(await h.save({ frequency: 'daily' }), 'enable');
  h.at('2026-11-26T08:24Z');
  await h.store.tick();
  assert.equal(h.store.list('mock').runs[0].status, 'missed');
  assert.equal(h.store.list('mock').rules[0].nextAt, Date.parse('2026-11-27T08:01Z'));
  const manual = h.manage(await h.save(), 'run');
  await h.store.tick();
  h.at('2026-11-26T08:40Z');
  h.complete();
  await h.store.tick();
  assert.throws(() => h.store.review('mock', { id: manual.id, action: 'approve' }), { status: 400 });
  h.store.review('mock', { id: manual.id, action: 'approve', planned: '2026-11-26T09:00' });
  h.store.review('mock', { id: manual.id, action: 'cancel' });
  await h.store.tick();
  const rejected = h.manage(await h.save(), 'run');
  await h.store.tick(); h.complete(); await h.store.tick();
  h.store.review('mock', { id: rejected.id, action: 'reject' });
  await h.store.tick();
  assert.equal(h.store.run('mock', rejected.id).status, 'rejected');
  assert.equal(h.publications.size, 0);
});

test('cancel during asynchronous release and recovery after publication insertion use the original publication ID', async t => {
  const h = setup(t);
  let resume;
  h.dependencies.publish = async (body, mode, check) => {
    await new Promise(resolve => { resume = resolve; });
    check();
    h.publications.set(body.id, { ...body, status: 'scheduled' });
  };
  const run = h.manage(await h.save({ policy: 'auto' }), 'run');
  await h.store.tick(); h.complete(); await h.store.tick();
  const releasing = h.store.tick();
  h.store.review('mock', { id: run.id, action: 'cancel' });
  resume();
  await releasing;
  assert.equal(h.publications.size, 0);
  assert.equal(h.store.run('mock', run.id).status, 'canceled');
  const recovery = h.manage(await h.save({ policy: 'auto' }), 'run');
  await h.store.tick(); h.complete(); await h.store.tick();
  const row = h.db.prepare('SELECT publication_id, publish_at FROM automation_run WHERE id=?').get(recovery.id);
  h.publications.set(row.publication_id, { id: row.publication_id, planned: row.publish_at, status: 'scheduled' });
  const reopened = createAutomation(h.db, h.dependencies);
  await reopened.tick();
  assert.equal(reopened.run('mock', recovery.id).publicationId, row.publication_id);
  assert.equal(h.publications.size, 1);
});
