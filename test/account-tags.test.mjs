import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountTagScope, createAccountTags } from '../account-tags.mjs';
import { accountCountry, validateAccountFilters } from '../web/account-properties.js';
import { runConversationAgent } from '../agent.mjs';

const accounts = [
  { id: '101', name: '品牌主号', platform: 'TikTok', country: '美国', authStatus: 20 },
  { id: '102', name: '品牌主页', platform: 'Facebook', country: 'USA', authStatus: 10 },
  { id: '103', name: '日本账号', platform: 'Instagram', country: 'JP', authStatus: 20 },
  { id: '104', name: '印尼频道', platform: 'YouTube', country: '印度尼西亚', authStatus: 20 }
];
function setup(t) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  const store = createAccountTags(db), scope = accountTagScope('live', 'app-a');
  store.remember(scope, accounts);
  const tag = (name, color = 'purple') => store.save(scope, { name, color }).tagId;
  return { db, store, scope, tag };
}

test('tag names are normalized and unique; rename preserves assignments and concurrent edits require a refresh', t => {
  const { store, scope, tag } = setup(t);
  const id = tag('  Brand Ａ  ', 'blue');
  assert.equal(store.snapshot(scope).tags[0].name, 'Brand A');
  assert.throws(() => tag('brand a'), { status: 409 });
  for (const name of ['', 'x'.repeat(21), '标签\n换行']) assert.throws(() => tag(name), { status: 400 });
  assert.throws(() => tag('名称', 'red;bad'), { status: 400 });
  store.assign(scope, { accountIds: ['101'], tagIds: [id], action: 'replace', revision: 0 });
  store.save(scope, { id, name: '品牌主号', color: 'green', revision: 1 });
  assert.equal(store.enrich(scope, accounts)[0].tags[0].name, '品牌主号');
  assert.equal(store.snapshot(scope).tags[0].count, 1);
  assert.throws(() => store.save(scope, { id, name: '覆盖', color: 'gray', revision: 1 }), { status: 409 });
  assert.throws(() => store.assign(scope, { accountIds: ['101'], tagIds: [], action: 'replace', revision: 0 }), { status: 409 });
});

test('bulk additions and removals merge tags, enforce ten per account and roll back the whole batch on failure', t => {
  const { store, scope, tag } = setup(t);
  const ids = Array.from({ length: 11 }, (_, index) => tag(`标签${index}`));
  store.assign(scope, { accountIds: ['102'], tagIds: ids.slice(0, 10), action: 'add' });
  assert.throws(() => store.assign(scope, { accountIds: ['101', '102'], tagIds: [ids[10]], action: 'add' }), { status: 422 });
  assert.equal(store.snapshot(scope).assignments['101'], undefined);
  assert.equal(store.snapshot(scope).revisions['101'], 0);
  assert.equal(store.snapshot(scope).assignments['102'].length, 10);
  store.assign(scope, { accountIds: ['101', '102'], tagIds: [ids[0]], action: 'add' });
  const revision = store.snapshot(scope).revisions['102'];
  store.assign(scope, { accountIds: ['102'], tagIds: [ids[0]], action: 'add' });
  assert.equal(store.snapshot(scope).revisions['102'], revision, 'idempotent addition');
  store.assign(scope, { accountIds: ['101', '102'], tagIds: [ids[0]], action: 'remove' });
  assert.equal(store.snapshot(scope).assignments['102'].length, 9);
  assert.throws(() => store.assign(scope, { accountIds: ['101', 'unknown'], tagIds: [ids[0]], action: 'add' }), { status: 404 });
  assert.equal(store.snapshot(scope).assignments['101'], undefined);
});

test('tag deletion verifies the displayed count, removes bindings and invalidates stale account editors', t => {
  const { store, scope, tag } = setup(t), id = tag('测试标签');
  store.assign(scope, { accountIds: ['101', '102'], tagIds: [id], action: 'add' });
  assert.throws(() => store.remove(scope, { id, revision: 1, expectedCount: 1 }), { status: 409 });
  store.remove(scope, { id, revision: 1, expectedCount: 2 });
  assert.equal(store.snapshot(scope).tags.length, 0);
  assert.deepEqual(Object.keys(store.snapshot(scope).assignments), []);
  assert.equal(store.snapshot(scope).revisions['101'], 2);
  assert.throws(() => store.assign(scope, { accountIds: ['101'], tagIds: [], action: 'replace', revision: 1 }), { status: 409 });
});

test('App ID and mode isolate local tags and changing a token does not change their namespace', t => {
  const { store, scope, tag } = setup(t), id = tag('当前应用');
  store.assign(scope, { accountIds: ['101'], tagIds: [id], action: 'add' });
  for (const other of [accountTagScope('mock'), accountTagScope('live', 'app-b')]) {
    store.remember(other, accounts);
    assert.equal(store.snapshot(other).tags.length, 0);
    assert.throws(() => store.assign(other, { accountIds: ['101'], tagIds: [id], action: 'add' }), { status: 404 });
  }
  const credentials = { appId: 'app-a', token: 'old' }; credentials.token = 'new';
  assert.equal(accountTagScope('live', credentials.appId), scope);
  assert.equal(store.snapshot(scope).assignments['101'][0], id);
  assert.throws(() => accountTagScope('live', ''), { status: 422 });
});

test('combined filters support multiple platforms, canonical countries, any/all tags and untagged accounts without changing authorization', t => {
  const { store, scope, tag } = setup(t), brand = tag('品牌A'), priority = tag('重点运营');
  store.assign(scope, { accountIds: ['101', '102'], tagIds: [brand], action: 'add' });
  store.assign(scope, { accountIds: ['101', '103'], tagIds: [priority], action: 'add' });
  const ids = filters => store.filter(scope, accounts, filters).map(account => account.id);
  assert.deepEqual(ids({ platforms: ['TikTok', 'Facebook'], countries: ['US'], tags: ['品牌A'] }), ['101', '102']);
  assert.equal(store.filter(scope, accounts, { tags: [brand] })[1].authStatus, 10);
  assert.deepEqual(ids({ tags: [brand, priority] }), ['101', '102', '103']);
  assert.deepEqual(ids({ tags: [brand, priority], tagMatch: 'all' }), ['101']);
  assert.deepEqual(ids({ untagged: true }), ['104']);
  assert.deepEqual(ids({ countries: ['印尼'] }), ['104']);
  assert.deepEqual(ids({ countries: ['JP', '美国'] }), ['101', '102', '103']);
  assert.throws(() => ids({ tags: ['不存在'] }), { status: 422 });
  for (const filters of [{ tags: '品牌A' }, { tags: [brand], untagged: true }, { countries: [1] }, { tagMatch: 'other' }, { admin: true }]) assert.throws(() => validateAccountFilters(filters), { status: 400 });
  for (const country of ['MY', 'MYS', 'Malaysia', '马来西亚']) assert.equal(accountCountry({ country }).value, 'MY');
});

test('local tag metadata and assignments survive database reopening', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'biai-tags-')), file = join(folder, 'tags.sqlite');
  let db;
  try {
    db = new DatabaseSync(file);
    let store = createAccountTags(db); const scope = accountTagScope('mock');
    store.remember(scope, accounts);
    const id = store.save(scope, { name: '保留标签', color: 'blue' }).tagId;
    store.assign(scope, { accountIds: ['101'], tagIds: [id], action: 'add' });
    db.close(); db = new DatabaseSync(file); store = createAccountTags(db);
    assert.equal(store.snapshot(scope).tags[0].name, '保留标签');
    assert.equal(store.enrich(scope, accounts)[0].tags[0].id, id);
  } finally { db?.close(); await unlink(file); await rmdir(folder); }
});

test('Agent discovers local tags and combines structured tag/country/platform queries without submitting or changing tags', async t => {
  const { store, scope, tag } = setup(t), id = tag('重点运营');
  store.assign(scope, { accountIds: ['101', '103'], tagIds: [id], action: 'add' });
  const before = store.snapshot(scope);
  const plans = [
    { calls: [{ tool: 'list_account_tags', arguments: {} }] },
    { calls: [{ tool: 'list_accounts', arguments: { tags: ['重点运营'], countries: ['US'], platforms: ['TikTok', 'Facebook'] } }] },
    { calls: [{ tool: 'delete_account_tag', arguments: { id } }] },
    { calls: [{ tool: 'respond', arguments: { text: '找到美国区的重点运营账号，请选择账号准备发布草稿。' } }] }
  ];
  const observations = [];
  const result = await runConversationAgent({ conversation: { id: randomUUID(), revision: 1, chat: [{ type: 'user', text: '查询美国区的重点运营账号' }], drafts: [] }, message: '查询美国区的重点运营账号', mode: 'live' }, {
    models: async () => [], accountTags: async () => store.snapshot(scope).tags,
    accounts: async filters => ({ accounts: store.filter(scope, accounts, filters) }),
    plan: async state => { observations.push(state.observations); return plans.shift(); },
    quote: () => assert.fail('query must not generate or publish')
  });
  assert.equal(result.chat.find(entry => entry.accounts)?.accounts[0].id, '101');
  assert.equal(result.drafts.length, 0);
  assert.ok(observations[3].some(step => step.tool === 'delete_account_tag' && !step.ok));
  assert.deepEqual(store.snapshot(scope), before);
});
