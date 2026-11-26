import { randomUUID } from 'node:crypto';

const day = 86_400_000;
const minute = 60_000;
const startWindow = 15 * minute;
const validClock = /^([01]\d|2[0-3]):[0-5]\d$/;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max, label, optional = false) => {
  if (typeof value !== 'string' || !optional && !value.trim() || value.trim().length > max) fail(400, `请检查${label}。`);
  return value.trim();
};
const formatter = zone => new Intl.DateTimeFormat('sv-SE', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const local = (time, zone) => formatter(zone).format(time).replace(' ', 'T');
const addDays = (date, days) => new Date(Date.parse(date + 'T00:00Z') + days * day).toISOString().slice(0, 10);

export function wallTime(value, zone) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) return null;
  const utc = Date.parse(value + 'Z');
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 16) !== value) return null;
  const format = formatter(zone);
  const asLocal = time => format.format(time).replace(' ', 'T');
  const offsets = new Set([-day, 0, day].map(delta => Date.parse(asLocal(utc + delta) + 'Z') - utc - delta));
  const matches = [...offsets].map(offset => utc - offset).filter(time => asLocal(time) === value);
  return matches.length === 1 ? matches[0] : null;
}

function nextTime(rule, after) {
  const first = wallTime(rule.startsAt, rule.zone);
  if (rule.frequency === 'once') return first > after ? first : null;
  const startDate = rule.startsAt.slice(0, 10);
  const interval = rule.frequency === 'weekly' ? 7 : 1;
  const passed = Math.floor((Date.parse(local(after, rule.zone).slice(0, 10)) - Date.parse(startDate)) / day);
  let index = Math.max(0, Math.floor(passed / interval));
  for (let attempt = 0; attempt < 4; attempt++, index++) {
    const timestamp = wallTime(addDays(startDate, index * interval) + rule.startsAt.slice(10), rule.zone);
    if (timestamp !== null && timestamp > after) return timestamp;
  }
  return null;
}

function publicationTime(rule, timestamp) {
  const at = local(timestamp, rule.zone);
  const date = addDays(at.slice(0, 10), Number(rule.publishAt <= at.slice(11)));
  return wallTime(`${date}T${rule.publishAt}`, rule.zone);
}

function validateRule(body, parameters) {
  const name = text(body.name, 80, '规则名称');
  const zone = text(body.zone, 80, '时区');
  try { formatter(zone); } catch { fail(400, '请选择有效时区。'); }
  if (!['once', 'daily', 'weekly'].includes(body.frequency)) fail(400, '请选择执行频率。');
  if (wallTime(body.startsAt, zone) === null) fail(400, '首次生成时间无效，或处于时区切换，请另选时间。');
  if (typeof body.publishAt !== 'string' || !validClock.test(body.publishAt) || body.publishAt === body.startsAt.slice(11)) fail(400, '请选择与生成时间不同的发布时间。');
  if (!['review', 'auto'].includes(body.policy)) fail(400, '请选择人工审核或自动发布。');
  if (typeof body.accountId !== 'string' || !/^[1-9]\d{0,18}$/.test(body.accountId)) fail(400, '请选择发布账号。');
  if (!Number.isSafeInteger(body.maxCredits) || body.maxCredits < 1 || body.maxCredits > 2_000_000_000) fail(400, '请输入有效的单次生成积分上限。');
  return { name, zone, startsAt: body.startsAt, frequency: body.frequency, publishAt: body.publishAt, policy: body.policy,
    accountId: body.accountId, title: text(body.title, 100, '发布标题'), description: text(body.description ?? '', 1000, '发布描述', true),
    maxCredits: body.maxCredits, video: parameters };
}

export function createAutomation(db, dependencies) {
  const now = dependencies.now || Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS automation_rule (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, spec TEXT NOT NULL, connection TEXT NOT NULL,
    enabled INTEGER NOT NULL, next_at INTEGER, revision INTEGER NOT NULL, updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automation_run (
    id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES automation_rule(id), mode TEXT NOT NULL,
    spec TEXT NOT NULL, connection TEXT NOT NULL, scheduled_at INTEGER NOT NULL, publish_at INTEGER,
    generation_id TEXT NOT NULL, publication_id TEXT NOT NULL, status TEXT NOT NULL,
    error TEXT, credits INTEGER, approval TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS automation_rule_due ON automation_rule(enabled, next_at);
  CREATE INDEX IF NOT EXISTS automation_run_history ON automation_run(mode, created DESC);
  CREATE INDEX IF NOT EXISTS automation_run_publication ON automation_run(publication_id);
  CREATE INDEX IF NOT EXISTS automation_run_work ON automation_run(status, updated);`);
  const ruleById = db.prepare('SELECT * FROM automation_rule WHERE id=? AND mode=?');
  const runById = db.prepare('SELECT * FROM automation_run WHERE id=? AND mode=?');
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const viewRule = row => ({ id: row.id, ...JSON.parse(row.spec), enabled: Boolean(row.enabled), nextAt: row.next_at, revision: row.revision, updated: row.updated });
  const viewRun = row => {
    const rule = JSON.parse(row.spec);
    const video = dependencies.video(row.generation_id, row.mode);
    const publication = ['publication', 'release', 'review'].includes(row.status) ? dependencies.publication(row.publication_id, row.mode) : null;
    const reviewable = publication?.status === 'awaiting_review';
    return { id: row.id, ruleId: row.rule_id, name: rule.name, accountId: rule.accountId, policy: rule.policy, zone: rule.zone,
      title: row.approval ? JSON.parse(row.approval).title : rule.title, description: row.approval ? JSON.parse(row.approval).description : rule.description,
      scheduledAt: row.scheduled_at, publishAt: publication ? publication.planned : row.publish_at, status: publication?.status ?? row.status,
      reviewable, cancelable: !publication && ['pending', 'generating', 'review', 'release'].includes(row.status),
      generationId: video?.id, videoStatus: video?.status, publicationId: publication?.id,
      credits: row.credits, error: publication?.error || row.error || video?.error, updated: row.updated };
  };
  const list = (mode, id = '') => ({
    rules: (id ? [ruleById.get(id, mode)].filter(Boolean) : db.prepare('SELECT * FROM automation_rule WHERE mode=? ORDER BY updated DESC').all(mode)).map(viewRule),
    runs: (id ? db.prepare('SELECT * FROM automation_run WHERE mode=? AND rule_id=? ORDER BY created DESC LIMIT 100').all(mode, id)
      : db.prepare('SELECT * FROM automation_run WHERE mode=? ORDER BY created DESC LIMIT 100').all(mode)).map(viewRun)
  });
  const connection = mode => JSON.stringify(dependencies.connection(mode));
  function requireConnection(row) {
    if (connection(row.mode) !== row.connection) fail(409, '服务连接已变化。请重新保存规则，确认新连接后再安排新的执行。');
  }
  const getRule = (id, mode) => ruleById.get(id || '', mode) || fail(404, '找不到任务规则。');
  const getRun = (id, mode) => runById.get(id || '', mode) || fail(404, '找不到任务执行记录。');
  const checkRevision = (row, revision) => { if (row.revision !== revision) fail(409, '规则已有更新，请刷新后重试。'); };
  function insertRun(row, scheduled, manual = false) {
    const rule = JSON.parse(row.spec);
    const planned = publicationTime(rule, scheduled);
    const missed = !manual && now() - scheduled > startWindow;
    const status = missed ? 'missed' : planned === null ? 'failed' : 'pending';
    const error = missed ? '已错过生成时间。' : planned === null ? '发布时间处于时区切换，请调整规则。' : null;
    const id = randomUUID();
    db.prepare(`INSERT INTO automation_run
      (id,rule_id,mode,spec,connection,scheduled_at,publish_at,generation_id,publication_id,status,error,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, row.id, row.mode, row.spec, row.connection, scheduled, planned,
      randomUUID(), randomUUID(), status, error, now(), now());
    return id;
  }
  async function save(mode, body, confirmation) {
    const captured = connection(mode);
    const parameters = await dependencies.parameters(body.video, mode);
    const rule = validateRule(body, parameters);
    const before = body.id ? getRule(body.id, mode) : null;
    if (before) checkRevision(before, body.revision);
    if (before?.enabled) fail(409, '请先暂停规则，再修改参数。');
    await dependencies.account(mode, rule.accountId);
    if (connection(mode) !== captured) fail(409, '服务连接已变化，请重新保存。');
    return transaction(() => {
      confirmation?.check();
      const id = before?.id || confirmation?.ruleId || randomUUID();
      if (before) {
        checkRevision(getRule(id, mode), body.revision);
        db.prepare('UPDATE automation_rule SET spec=?,connection=?,next_at=NULL,revision=revision+1,updated=? WHERE id=?').run(JSON.stringify(rule), captured, now(), id);
      } else {
        db.prepare('INSERT INTO automation_rule VALUES(?,?,?,?,0,NULL,1,?)').run(id, mode, JSON.stringify(rule), captured, now());
      }
      const saved = viewRule(getRule(id, mode));
      confirmation?.record(saved);
      return saved;
    });
  }
  function manage(mode, body) {
    if (!['enable', 'pause', 'run'].includes(body.action)) fail(400, '请选择规则操作。');
    return transaction(() => {
      const row = getRule(body.id, mode);
      checkRevision(row, body.revision);
      if (body.action !== 'pause') requireConnection(row);
      const rule = JSON.parse(row.spec);
      if (body.action === 'run') {
        if (db.prepare("SELECT 1 FROM automation_run WHERE rule_id=? AND status IN ('pending','generating','release') LIMIT 1").get(row.id)) fail(409, '该规则已有执行中的任务。');
        // Bump the revision so repeating a confirmation cannot spend credits again.
        db.prepare('UPDATE automation_rule SET revision=revision+1,updated=? WHERE id=?').run(now(), row.id);
        return viewRun(getRun(insertRun(row, now(), true), mode));
      }
      const enabled = body.action === 'enable';
      const next = enabled ? nextTime(rule, now()) : null;
      if (enabled && next === null) fail(400, '首次生成时间已过，请修改时间或选择立即执行。');
      db.prepare('UPDATE automation_rule SET enabled=?,next_at=?,revision=revision+1,updated=? WHERE id=?').run(Number(enabled), next, now(), row.id);
      return viewRule(getRule(row.id, mode));
    });
  }
  const setRun = (row, status, error = null, credits = row.credits) => db.prepare(
    'UPDATE automation_run SET status=?,error=?,credits=?,updated=? WHERE id=? AND status=?'
  ).run(status, error, credits, now(), row.id, row.status);
  function review(mode, body) {
    return transaction(() => {
      const row = getRun(body.id, mode), rule = JSON.parse(row.spec);
      const publication = dependencies.publication(row.publication_id, mode);
      if (publication?.status === 'awaiting_review' && ['reject', 'cancel'].includes(body.action)) {
        dependencies.reviewPublication(publication.id, mode, { action: body.action });
      } else if (!publication && body.action === 'cancel' && ['pending', 'generating', 'review', 'release'].includes(row.status)) {
        setRun(row, 'canceled');
      } else if (body.action === 'approve' && publication?.status === 'awaiting_review') {
        requireConnection(row);
        const planned = body.planned == null ? publication.planned : wallTime(body.planned, rule.zone);
        if (!planned || planned <= now()) fail(400, '原发布时间已过，或所选时间无效。请选择未来的发布时间。');
        const video = dependencies.video(row.generation_id, mode);
        if (video?.status !== 'completed' || video.expiresAt && planned >= video.expiresAt) fail(409, '视频在该时间不可用，请调整发布时间。');
        const title = text(body.title ?? rule.title, 100, '发布标题');
        const description = text(body.description ?? rule.description, 1000, '发布描述', true);
        dependencies.reviewPublication(publication.id, mode, { action: 'approve', planned, title, description });
        db.prepare('UPDATE automation_run SET approval=?,publish_at=?,updated=? WHERE id=?')
          .run(JSON.stringify({ title, description }), planned, now(), row.id);
      } else fail(409, '当前状态无法执行此操作，请刷新后重试。');
      return viewRun(getRun(row.id, mode));
    });
  }
  async function advance(row) {
    const rule = JSON.parse(row.spec);
    try {
      if (['release', 'review'].includes(row.status) && dependencies.publication(row.publication_id, row.mode)) {
        setRun(row, 'publication');
        return;
      }
      if (['pending', 'release', 'review'].includes(row.status)) requireConnection(row);
      const video = dependencies.video(row.generation_id, row.mode);
      if (row.status === 'pending') {
        if (now() >= row.publish_at || now() - row.scheduled_at > startWindow) { setRun(row, 'missed', '已错过本次执行时间。'); return; }
        if (video) { setRun(row, 'generating', null, video.credits); return; }
        await dependencies.account(row.mode, rule.accountId);
        if (getRun(row.id, row.mode).status !== 'pending') return;
        requireConnection(row);
        const quote = await dependencies.quote({ ...rule.video, id: row.generation_id }, row.mode);
        if (quote.credits > rule.maxCredits) { setRun(row, 'failed', `报价 ${quote.credits} 积分，超过单次上限 ${rule.maxCredits}。`, quote.credits); return; }
        transaction(() => {
          if (getRun(row.id, row.mode).status !== 'pending') return;
          requireConnection(row);
          if (now() >= row.publish_at) { setRun(row, 'missed', '已错过本次执行时间。'); return; }
          dependencies.generate({ ...quote.parameters, id: row.generation_id, credits: quote.credits }, row.mode);
          setRun(row, 'generating', null, quote.credits);
        });
      } else if (row.status === 'generating') {
        if (['failed', 'expired'].includes(video?.status)) setRun(row, 'failed', video.error || '视频生成失败或已过期。');
        else if (video?.status === 'completed') setRun(row, 'release');
        else db.prepare('UPDATE automation_run SET updated=? WHERE id=? AND status=?').run(now(), row.id, row.status);
      } else {
        const awaitingReview = rule.policy === 'review' && !row.approval;
        if (!awaitingReview && now() >= row.publish_at) { setRun(row, 'missed', '未能在计划时间前排入发布。'); return; }
        const copy = row.approval ? JSON.parse(row.approval) : rule;
        // Use the same publication ID after a restart, including a crash after insertion.
        await dependencies.publish({ id: row.publication_id, generationId: row.generation_id, accountId: rule.accountId,
          title: copy.title, description: copy.description, planned: row.publish_at, zone: rule.zone, ai: true }, row.mode, {
          awaitingReview,
          beforeInsert: () => {
            if (getRun(row.id, row.mode).status !== row.status) fail(409, '本次任务已取消。');
            requireConnection(row);
          }
        });
        setRun(row, 'publication');
      }
    } catch (error) { setRun(row, 'failed', error.status ? error.message : '服务暂时无法完成此任务。'); }
  }
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      transaction(() => {
        for (const row of db.prepare('SELECT * FROM automation_rule WHERE enabled=1 AND next_at<=? ORDER BY next_at LIMIT 20').all(now())) {
          const next = nextTime(JSON.parse(row.spec), now());
          insertRun(row, row.next_at);
          db.prepare('UPDATE automation_rule SET next_at=?,enabled=?,revision=revision+1,updated=? WHERE id=?').run(next, Number(next !== null), now(), row.id);
        }
      });
      const work = db.prepare("SELECT * FROM automation_run WHERE status IN ('pending','generating','release','review') ORDER BY updated LIMIT 20").all();
      await Promise.all(work.map(advance));
    } finally { busy = false; }
  }
  return { list, save, manage, review, tick, rule: (mode, id) => viewRule(getRule(id, mode)), run: (mode, id) => viewRun(getRun(id, mode)) };
}
