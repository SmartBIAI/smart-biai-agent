import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { webAccess } from '../web-access.mjs';
import { createWebSessions } from '../web-sessions.mjs';

const username = 'admin';
const password = 'test-password-long-enough';
const env = { BIAI_LOGIN_USER: username, BIAI_LOGIN_PASSWORD: password, BIAI_BASE_PATH: '/agent', BIAI_PUBLIC_ORIGIN: 'https://agent.example.com' };
const request = (cookie, headers = {}) => ({ headers: { cookie, ...headers }, socket: { remoteAddress: '127.0.0.1' } });
const firstCookie = result => result.cookie.split(';')[0];

test('sessions expire, persist across reopening, rotate, revoke and bind to current credentials', () => {
  const db = new DatabaseSync(':memory:');
  let time = 1000;
  const access = webAccess(env);
  const sessions = createWebSessions(db, access, () => time);
  const login = sessions.login(request(), username, password);
  const cookie = firstCookie(login);
  assert.equal(login.status, 200);
  assert.match(login.cookie, /Path=\/agent\/; HttpOnly; SameSite=Lax; Secure$/);
  assert.ok(!db.prepare('SELECT token FROM web_session').get().token.includes(cookie.split('=')[1]));
  assert.ok(sessions.authorized(request(cookie)));
  assert.ok(!sessions.authorized(request('biai_session_invalid=anything')));
  assert.ok(createWebSessions(db, access, () => time).authorized(request(cookie)));
  time += 12 * 60 * 60 * 1000;
  assert.ok(!sessions.authorized(request(cookie)));
  const remember = sessions.login(request(), username, password, true);
  assert.match(remember.cookie, /Max-Age=604800/);
  const rotated = sessions.login(request(firstCookie(remember)), username, password, true);
  assert.ok(!sessions.authorized(request(firstCookie(remember))));
  assert.ok(sessions.authorized(request(firstCookie(rotated))));
  const changed = createWebSessions(db, webAccess({ ...env, BIAI_LOGIN_PASSWORD: `${password}-changed` }), () => time);
  assert.ok(!changed.authorized(request(firstCookie(rotated))));
  assert.match(sessions.logout(request(firstCookie(rotated))), /Max-Age=0/);
  assert.ok(!sessions.authorized(request(firstCookie(rotated))));
  const last = sessions.login(request(), username, password, true);
  time += 7 * 24 * 60 * 60 * 1000;
  assert.ok(!sessions.authorized(request(firstCookie(last))));
  db.close();
});

test('login returns only safe app redirects and bounds repeated authentication failures', () => {
  const db = new DatabaseSync(':memory:');
  let time = 0;
  const sessions = createWebSessions(db, webAccess(env), () => time);
  for (const value of ['https://evil.example/', '//evil.example/agent/', '/elsewhere/', '/agent/../elsewhere', '/agent/login', '/agent/\\evil']) assert.equal(sessions.safeReturn(value), '/agent/');
  assert.equal(sessions.safeReturn('/agent/?mode=mock#tasks'), '/agent/?mode=mock#tasks');
  for (let i = 0; i < 8; i++) assert.equal(sessions.login(request(), username, 'wrong').status, 401);
  assert.equal(sessions.login(request(), username, password).status, 429);
  // A client cannot reset the limit by adding a forged first forwarded address.
  assert.equal(sessions.login(request(undefined, { 'x-forwarded-for': '203.0.113.10, 127.0.0.1' }), username, password).status, 429);
  time += 15 * 60 * 1000;
  assert.equal(sessions.login(request(), username, password).status, 200);
  db.close();
});

test('subpath login serves assets, authorizes cookies and logs out without a browser Basic prompt', async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), 'biai-login-test-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, PORT: String(port), BIAI_HOST: '127.0.0.1', BIAI_BIND_PORT: '', BIAI_PUBLIC_ORIGIN: '', BIAI_DATA_DIR: directory }
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    assert.ok(directory.startsWith(join(tmpdir(), 'biai-login-test-')));
    await rm(directory, { recursive: true, force: true, maxRetries: 4 });
  });
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/agent`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) assert.fail(`Server stopped: ${logs}`);
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { /* Startup. */ }
    if (i === 149) assert.fail('Login server did not start');
    await wait(20);
  }
  const root = await fetch(`${url}/`, { redirect: 'manual' });
  assert.equal(root.status, 303);
  assert.match(root.headers.get('location'), /^\/agent\/login\?next=/);
  assert.equal(root.headers.get('www-authenticate'), null);
  const loginPage = await fetch(`${url}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /欢迎回来/);
  assert.equal(loginPage.headers.get('cache-control'), 'no-store');
  for (const asset of ['login.css', 'login.js']) assert.equal((await fetch(`${url}/${asset}`)).status, 200);
  for (const asset of ['app.js', 'api/bootstrap']) assert.equal((await fetch(`${url}/${asset}`)).status, 401);
  const authenticate = (body, headers = {}) => fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
  assert.equal((await authenticate({ username, password }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await authenticate({ username, password: 'wrong' })).status, 401);
  const login = await authenticate({ username, password, remember: true, next: '/agent/#tasks' });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).redirect, '/agent/#tasks');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const auth = { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await fetch(`${url}/`, { headers: auth })).status, 200);
  const bootstrap = await fetch(`${url}/api/bootstrap`, { headers: auth });
  assert.equal(bootstrap.status, 200);
  const boot = await bootstrap.json();
  assert.deepEqual(boot.access, { required: true, username });
  const api = async (path, body, status = 200) => {
    const response = await fetch(`${url}/api/${path}`, {
      headers: { ...auth, Origin: origin, 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
    });
    const result = await response.json();
    assert.equal(response.status, status, result.error);
    return result;
  };
  const utc = offset => new Date(Date.now() + offset * 60_000).toISOString().slice(0, 16);
  const model = boot.models[0];
  const rule = await api('automation/save', { name: '审核后发布', zone: 'UTC', startsAt: utc(5), frequency: 'once',
    policy: 'review', publishAt: utc(15).slice(11), accountId: boot.accounts[0].id, title: '产品视频', maxCredits: 1000,
    video: { model: model.id, prompt: '细节展示：一只白色陶瓷杯缓慢旋转。', ratio: model.ratios[0],
      resolution: model.resolutions[0], duration: model.durations?.[0] ?? model.min, audio: false } });
  assert.equal(rule.enabled, false);
  assert.equal((await api('automation')).runs.length, 0);
  const execution = await api('automation/manage', { id: rule.id, action: 'run', revision: rule.revision });
  await api('automation/manage', { id: rule.id, action: 'run', revision: rule.revision }, 409);
  const runPath = `automation/runs/${execution.id}`;
  async function untilRun(check) {
    for (let attempt = 0; attempt < 90; attempt++) {
      const run = await api(runPath);
      if (check(run)) return run;
      if (['failed','missed'].includes(run.status)) assert.fail(run.error);
      await wait(100);
    }
    assert.fail('automation execution timed out');
  }
  await untilRun(run => run.reviewable);
  assert.equal((await api('publications')).length, 0);
  const draftId = randomUUID(), draftMessage = '新建自动化任务';
  await api(`conversations/${draftId}`, { revision: 0, chat: [{ type: 'user', text: draftMessage }], drafts: [] });
  const draft = await api('agent', { protocol: 'agent.v1', turnId: randomUUID(), conversationId: draftId, revision: 1, message: draftMessage,
    command: { tool: 'prepare_automation', arguments: { action: 'create', changes: { name: 'Agent 规则草稿', policy: 'auto' } } } });
  assert.equal(draft.conversation.chat.find(entry => entry.automation)?.automation.proposal.name, 'Agent 规则草稿');
  assert.equal((await api('automation')).rules.length, 1, 'the agent proposal does not save or enable a rule');
  const conversationId = randomUUID(), message = '查看自动化任务';
  await api(`conversations/${conversationId}`, { revision: 0, chat: [{ type: 'user', text: message }], drafts: [] });
  const response = await api('agent', { protocol: 'agent.v1', turnId: randomUUID(), conversationId, revision: 1, message,
    command: { tool: 'list_automations', arguments: { reviewOnly: true } } });
  assert.equal(response.conversation.chat.find(entry => entry.automation)?.automation.runs[0].id, execution.id);
  assert.equal((await api('publications')).length, 0);
  await api('automation/review', { id: execution.id, action: 'approve', title: '确认后的标题' });
  const scheduled = await untilRun(run => run.status === 'scheduled');
  const [publication] = await api('publications');
  assert.equal(publication.id, scheduled.publicationId);
  assert.equal(publication.title, '确认后的标题');
  assert.equal((await fetch(`${url}/automation.js`, { headers: auth })).status, 200);
  const basic = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  assert.equal((await fetch(`${url}/api/bootstrap`, { headers: basic })).status, 200);
  assert.equal((await fetch(`${url}/api/bootstrap`, { headers: { ...basic, 'Sec-Fetch-Site': 'same-origin' } })).status, 401);
  const logout = await fetch(`${url}/auth/logout`, { method: 'POST', headers: { ...auth, Origin: origin } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${url}/api/bootstrap`, { headers: auth })).status, 401);
  assert.equal((await fetch(`${url}/api/automation`, { headers: auth })).status, 401);
});
