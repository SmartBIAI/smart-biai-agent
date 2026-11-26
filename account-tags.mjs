import { createHash, randomUUID } from 'node:crypto';
import { tagColors, validateAccountFilters, matchesAccount } from './web/account-properties.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const normalizedName = name => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export function accountTagScope(mode, appId = '') {
  if (!['mock', 'live'].includes(mode)) fail(400, '运行模式无效。');
  if (mode === 'live' && !appId.trim()) fail(422, '请先配置社媒 App ID，再维护账号标签。');
  return createHash('sha256').update(JSON.stringify(['account-tags', mode, mode === 'live' ? appId.trim() : 'demo'])).digest('hex');
}

export function createAccountTags(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_tag (
    scope TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
    color TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    PRIMARY KEY(scope,id), UNIQUE(scope,normalized_name)
  );
  CREATE TABLE IF NOT EXISTS account_tag_account (
    scope TEXT NOT NULL, account_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,account_id)
  );
  CREATE TABLE IF NOT EXISTS account_tag_link (
    scope TEXT NOT NULL, account_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY(scope,account_id,tag_id),
    FOREIGN KEY(scope,tag_id) REFERENCES account_tag(scope,id) ON DELETE CASCADE,
    FOREIGN KEY(scope,account_id) REFERENCES account_tag_account(scope,account_id)
  ); CREATE INDEX IF NOT EXISTS idx_account_tag_link ON account_tag_link(scope,tag_id);`);
  const row = (scope, id) => db.prepare('SELECT * FROM account_tag WHERE scope=? AND id=?').get(scope, id);
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function snapshot(scope) {
    const tags = db.prepare(`SELECT t.id,t.name,t.color,t.revision,COUNT(l.account_id) AS count FROM account_tag t
      LEFT JOIN account_tag_link l ON t.scope=l.scope AND t.id=l.tag_id WHERE t.scope=? GROUP BY t.id ORDER BY t.created,t.id`).all(scope);
    const assignments = Object.create(null), revisions = Object.create(null);
    for (const link of db.prepare('SELECT account_id,tag_id FROM account_tag_link WHERE scope=? ORDER BY tag_id').all(scope)) (assignments[link.account_id] ||= []).push(link.tag_id);
    for (const account of db.prepare('SELECT account_id,revision FROM account_tag_account WHERE scope=?').all(scope)) revisions[account.account_id] = account.revision;
    return { scope, tags, assignments, revisions };
  }
  function remember(scope, accounts) {
    const insert = db.prepare('INSERT OR IGNORE INTO account_tag_account(scope,account_id) VALUES(?,?)');
    transaction(() => { for (const account of accounts) insert.run(scope, String(account.id)); });
  }
  function enrich(scope, accounts) {
    remember(scope, accounts);
    const data = snapshot(scope), byId = new Map(data.tags.map(tag => [tag.id, tag]));
    return accounts.map(account => ({ ...account, tagScope: scope, tags: (data.assignments[account.id] || []).map(id => byId.get(id)).filter(Boolean) }));
  }
  function save(scope, body) {
    if (body.id !== undefined && (typeof body.id !== 'string' || !/^[a-f\d-]{36}$/i.test(body.id))) fail(400, '标签编号无效。');
    if (typeof body.name !== 'string') fail(400, '请输入标签名称。');
    const name = body.name.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!name || [...name].length > 20 || /[\u0000-\u001f\u007f]/.test(body.name)) fail(400, '标签名称需为 1～20 个字符。');
    if (typeof body.color !== 'string' || !Object.hasOwn(tagColors, body.color)) fail(400, '请选择标签颜色。');
    const id = body.id || randomUUID(), now = Date.now();
    transaction(() => {
      const existing = row(scope, id);
      if (body.id && !existing) fail(404, '标签已不存在，请刷新后重试。');
      if (existing && body.revision !== existing.revision) fail(409, '标签已被修改，请刷新后重试。');
      const duplicate = db.prepare('SELECT id FROM account_tag WHERE scope=? AND normalized_name=?').get(scope, normalizedName(name));
      if (duplicate && duplicate.id !== id) fail(409, '已存在同名标签，请直接选择或换个名称。');
      if (existing) db.prepare('UPDATE account_tag SET name=?,normalized_name=?,color=?,revision=revision+1,updated=? WHERE scope=? AND id=?').run(name, normalizedName(name), body.color, now, scope, id);
      else db.prepare('INSERT INTO account_tag(scope,id,name,normalized_name,color,created,updated) VALUES(?,?,?,?,?,?,?)').run(scope, id, name, normalizedName(name), body.color, now, now);
    });
    return { ...snapshot(scope), tagId: id };
  }
  function remove(scope, body) {
    if (typeof body.id !== 'string' || !Number.isSafeInteger(body.revision) || !Number.isSafeInteger(body.expectedCount) || body.expectedCount < 0) fail(400, '请检查待删除标签及关联账号数。');
    transaction(() => {
      const tag = row(scope, body.id);
      if (!tag) fail(404, '标签已不存在，请刷新后重试。');
      const count = db.prepare('SELECT COUNT(*) AS count FROM account_tag_link WHERE scope=? AND tag_id=?').get(scope, body.id).count;
      if (tag.revision !== body.revision || count !== body.expectedCount) fail(409, '标签或关联账号数已变化，请刷新后重新确认删除。');
      db.prepare('UPDATE account_tag_account SET revision=revision+1 WHERE scope=? AND account_id IN (SELECT account_id FROM account_tag_link WHERE scope=? AND tag_id=?)').run(scope, scope, body.id);
      db.prepare('DELETE FROM account_tag_link WHERE scope=? AND tag_id=?').run(scope, body.id);
      db.prepare('DELETE FROM account_tag WHERE scope=? AND id=?').run(scope, body.id);
    });
    return snapshot(scope);
  }
  function assign(scope, body) {
    const { accountIds, tagIds, action } = body;
    if (!['add', 'remove', 'replace'].includes(action) || !Array.isArray(accountIds) || !accountIds.length || accountIds.length > 500 ||
      !Array.isArray(tagIds) || tagIds.length > 50 || accountIds.some(id => typeof id !== 'string' || !id || id.length > 100) || tagIds.some(id => typeof id !== 'string') ||
      action === 'replace' && accountIds.length !== 1 || action !== 'replace' && !tagIds.length) fail(400, '请选择账号、标签和有效操作。');
    transaction(() => {
      for (const id of tagIds) if (!row(scope, id)) fail(404, '所选标签已不存在，请刷新后重试。');
      for (const accountId of new Set(accountIds)) {
        const account = db.prepare('SELECT revision FROM account_tag_account WHERE scope=? AND account_id=?').get(scope, accountId);
        if (!account) fail(404, '所选账号不属于当前账号列表，请刷新后重试。');
        if (action === 'replace' && body.revision !== account.revision) fail(409, '该账号标签已更新，请重新打开编辑窗口。');
        const before = db.prepare('SELECT tag_id FROM account_tag_link WHERE scope=? AND account_id=?').all(scope, accountId).map(item => item.tag_id);
        const next = new Set(action === 'replace' ? tagIds : action === 'add' ? [...before, ...tagIds] : before.filter(id => !tagIds.includes(id)));
        if (next.size > 10) fail(422, '每个账号最多添加 10 个标签，请减少标签后重试；本次操作尚未保存。');
        if (next.size === before.length && before.every(id => next.has(id))) continue;
        db.prepare('DELETE FROM account_tag_link WHERE scope=? AND account_id=?').run(scope, accountId);
        for (const tagId of next) db.prepare('INSERT INTO account_tag_link VALUES(?,?,?)').run(scope, accountId, tagId);
        db.prepare('UPDATE account_tag_account SET revision=revision+1 WHERE scope=? AND account_id=?').run(scope, accountId);
      }
    });
    return snapshot(scope);
  }
  function filter(scope, accounts, input) {
    validateAccountFilters(input);
    const catalog = snapshot(scope).tags;
    const tags = (input.tags || []).map(value => {
      const match = catalog.find(tag => tag.id === value || normalizedName(tag.name) === normalizedName(value));
      if (!match) fail(422, `未找到标签“${value.slice(0, 20)}”，请先查询可用标签。`);
      return match.id;
    });
    return enrich(scope, accounts).filter(account => matchesAccount(account, { ...input, tags }));
  }
  return { snapshot, remember, enrich, save, remove, assign, filter };
}
