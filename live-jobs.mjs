import { mediaUrl, socialClient, videoClient } from './integrations.mjs';

const minute = 60_000;
const statusMap = { 10: 'queued_upstream', 20: 'publishing', 30: 'completed', 40: 'failed', 50: 'canceled' };

export function migrateLive(database) {
  const common = { mode: "TEXT NOT NULL DEFAULT 'mock'", scope: 'TEXT', poll_at: 'INTEGER NOT NULL DEFAULT 0',
    attempts: 'INTEGER NOT NULL DEFAULT 0', error: 'TEXT', upstream_status: 'TEXT' };
  for (const [name, columns] of Object.entries({
    generation: { ...common, state: 'TEXT', payload: 'TEXT', link_expires: 'INTEGER' },
    publication: { ...common, payload: 'TEXT', account_snapshot: 'TEXT', video_scope: 'TEXT' }
  })) {
    const existing = new Set(database.prepare(`PRAGMA table_info(${name})`).all().map(column => column.name));
    for (const [field, type] of Object.entries(columns)) {
      if (!existing.has(field)) database.exec(`ALTER TABLE ${name} ADD COLUMN ${field} ${type}`);
    }
  }
  database.exec(`CREATE TABLE IF NOT EXISTS video_quote (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, parameters TEXT NOT NULL, payload TEXT NOT NULL, credits INTEGER NOT NULL, expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_generation_poll ON generation(mode, poll_at);
  CREATE INDEX IF NOT EXISTS idx_publication_poll ON publication(mode, poll_at);`);
}

function timestamp(value) {
  if (typeof value === 'number' && value > 0) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value) return Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  return null;
}

export function createLiveJobs(database, configuration, lateWindow) {
  const getVideo = database.prepare('SELECT * FROM generation WHERE id = ?');
  const getPublication = database.prepare('SELECT * FROM publication WHERE id = ?');
  const refreshes = new Map();
  let running = false;

  function saveVideo(row, state, next = 0, error = null, details = {}) {
    database.prepare(`UPDATE generation SET state = ?, poll_at = ?, error = ?, source_id = ?, upstream_status = ?,
      url = ?, cover = ?, expires = ?, link_expires = ? WHERE id = ?`).run(state, next, error,
      details.id ?? row.source_id, details.status ?? row.upstream_status,
      Object.hasOwn(details, 'url') ? details.url : row.url, Object.hasOwn(details, 'cover') ? details.cover : row.cover,
      details.expires ?? row.expires, Object.hasOwn(details, 'linkExpires') ? details.linkExpires : row.link_expires, row.id);
  }

  function videoInfo(row, task) {
    const id = row.source_id ?? task?.id;
    if (typeof id !== 'string' || !id || task.id !== id || task.request_id && task.request_id !== row.id ||
        task.model && task.model !== JSON.parse(row.parameters).model) throw Object.assign(new Error('暂时无法确认这条视频的生成结果。'), { uncertain: true });
    const status = typeof task.status === 'string' ? task.status : '';
    if (status === 'succeeded') {
      const url = task.file_expired ? null : mediaUrl(task.video_url);
      const cover = task.file_expired ? null : mediaUrl(task.last_frame_url) || mediaUrl(task.cover_url);
      const expires = timestamp(task.file_expires_at);
      const linkExpires = timestamp(task.video_url_expires_at ?? task.url_expires_at ?? task.download_url_expires_at) ?? (url ? Date.now() + 10 * minute : null);
      const state = url ? 'completed' : task.file_expired ? 'expired' : 'generating';
      saveVideo(row, state, state === 'generating' ? Date.now() + 10_000 : 0, state === 'generating' ? '视频完成，等待可用的预览地址。' : null,
        { id, status, url, cover, expires, linkExpires });
    } else if (status === 'failed') {
      saveVideo(row, 'failed', 0, 'Smart BIAI 未能生成视频。', { id, status });
    } else {
      saveVideo(row, status === 'review' ? 'review' : 'generating', Date.now() + (status === 'review' ? minute : 4500), null, { id, status });
    }
    return getVideo.get(row.id);
  }

  function matches(conn, scope) { return Boolean(conn.scope && conn.scope === scope); }

  async function refreshVideo(row) {
    const existing = refreshes.get(row.id);
    if (existing) return existing;
    const current = configuration('video');
    if (!matches(current, row.scope)) throw new Error('视频密钥已更换，请改回生成这条视频时用的密钥，再刷新链接。');
    if (!row.source_id) throw new Error('Smart BIAI 还在处理，请稍后查看。');
    const pending = videoClient(current).detail(row.source_id).then(task => videoInfo(getVideo.get(row.id), task));
    refreshes.set(row.id, pending);
    try { return await pending; }
    finally { refreshes.delete(row.id); }
  }

  async function generate(row) {
    const conn = configuration('video');
    if (!matches(conn, row.scope)) {
      saveVideo(row, row.state, Date.now() + minute, '视频密钥已更换，改回原密钥后才会继续处理。');
      return;
    }
    const client = videoClient(conn);
    try {
      if (row.source_id) { await refreshVideo(row); return; }
      if (row.state !== 'queued') {
        const task = await client.recover(row.id);
        if (task) { videoInfo(row, task); return; }
        saveVideo(row, 'unknown', Date.now() + minute, 'Smart BIAI 还未返回结果，工作台会继续查询这条视频。');
        return;
      }
      database.prepare("UPDATE generation SET state = 'submitting', attempts = attempts + 1 WHERE id = ?").run(row.id);
      const task = await client.create(JSON.parse(row.payload));
      videoInfo(row, task);
    } catch (error) {
      if (row.source_id) saveVideo(row, row.state, Date.now() + Math.max(error.retryAfter || 0, 20_000), error.message);
      else if (row.state !== 'queued' || error.uncertain) saveVideo(row, 'unknown', Date.now() + Math.max(error.retryAfter || 0, 10_000), error.message);
      else if (error.retryable && row.attempts < 2) saveVideo(row, 'queued', Date.now() + Math.max(error.retryAfter || 0, 10_000), error.message);
      else saveVideo(row, 'failed', 0, error.message);
    }
  }

  function savePublication(row, status, pollAt = 0, error = null, task = null) {
    database.prepare(`UPDATE publication SET status = ?, poll_at = ?, error = ?, updated = ?,
      source_id = ?, material_id = ?, upstream_status = ?, payload = CASE WHEN ? THEN NULL ELSE payload END
      WHERE id = ? AND status NOT IN ('canceled','missed')`).run(status, pollAt, error, Date.now(),
      task?.id ?? row.source_id, task?.videoId ? String(task.videoId) : row.material_id,
      task ? String(task.status ?? '') : row.upstream_status, Number(Boolean(task?.id) || status === 'failed'), row.id);
  }

  function publicationInfo(row, task) {
    if (!task || typeof task.id !== 'string' || !task.id || row.source_id && task.id !== row.source_id ||
        task.clientTaskId && task.clientTaskId !== row.id || task.accountId != null && String(task.accountId) !== row.account) {
      throw Object.assign(new Error('暂时无法确认这条作品的发布结果。'), { uncertain: true });
    }
    const status = statusMap[task.status];
    const terminal = ['completed', 'failed', 'canceled'].includes(status);
    savePublication(row, status ?? 'unknown', terminal ? 0 : Date.now() + (status ? 5000 : minute),
      status === 'failed' ? 'Smart BIAI 未能发布这条视频。' : status ? null : '发布结果暂未确认，工作台会继续查询。', task);
  }

  async function publish(row) {
    const conn = configuration('social');
    if (!matches(conn, row.scope)) {
      savePublication(row, row.status, Date.now() + minute, '社媒连接信息已更换，改回原来的信息后才会继续发布。');
      return;
    }
    const client = socialClient(conn);
    try {
      if (row.source_id) { publicationInfo(row, await client.status(row.source_id)); return; }
      if (row.payload && (row.attempts >= 3 || Date.now() - row.submitted > minute)) {
        savePublication(row, 'unknown', 0, '发布结果暂未确认，请先到 Smart BIAI 查看这条作品的发布记录。');
        return;
      }
      if (!row.payload) {
        if (row.planned && Date.now() - row.planned > lateWindow) { savePublication(row, 'missed'); return; }
        const video = getVideo.get(row.generation_id);
        if (!video || !matches(configuration('video'), row.video_scope) || video.scope !== row.video_scope) {
          savePublication(row, row.status, Date.now() + minute, '视频密钥已更换，改回原密钥后才会继续处理。');
          return;
        }
        const { accounts } = await client.accounts({ id: row.account });
        if (!accounts[0]?.canPublish) { savePublication(row, 'failed', 0, '该账号当前无法发布，请检查授权状态和有效期。'); return; }
        const fresh = await refreshVideo(video);
        if (row.planned && Date.now() - row.planned > lateWindow) { savePublication(row, 'missed'); return; }
        if (fresh.state !== 'completed' || !fresh.url || fresh.expires && fresh.expires <= Date.now() ||
            fresh.link_expires && fresh.link_expires <= Date.now()) {
          savePublication(row, 'expired', 0, '这条视频已过期或暂时无法打开，请先预览视频。');
          return;
        }
        const payload = client.publishBody({ ...row, cover: fresh.cover }, fresh.url);
        const changed = database.prepare(`UPDATE publication SET payload = ?, status = 'submitting', submitted = ?, updated = ?
          WHERE id = ? AND status IN ('queued','scheduled') AND payload IS NULL`).run(payload, Date.now(), Date.now(), row.id);
        if (!changed.changes) return;
        row = getPublication.get(row.id);
      }
      database.prepare('UPDATE publication SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      const task = await client.publish(row);
      publicationInfo(row, task);
    } catch (error) {
      if (row.source_id) savePublication(row, row.status, Date.now() + Math.max(error.retryAfter || 0, 20_000), error.message);
      else if (row.payload && error.retryable && row.attempts < 2 && Date.now() + (error.retryAfter || 0) - row.submitted < minute) {
        savePublication(row, 'submitting', Date.now() + Math.max(error.retryAfter || 0, 5000), error.message);
      } else if (row.payload && error.uncertain) savePublication(row, 'unknown', 0, error.message);
      else if (!row.payload && error.retryable) savePublication(row, row.status, Date.now() + Math.max(error.retryAfter || 0, 20_000), error.message);
      else savePublication(row, 'failed', 0, error.message);
    }
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const generations = database.prepare(`SELECT * FROM generation WHERE mode = 'live' AND state IN ('queued','submitting','generating','review','unknown')
        AND poll_at <= ? ORDER BY poll_at, created LIMIT 4`).all(now);
      const publications = database.prepare(`SELECT * FROM publication WHERE mode = 'live' AND poll_at <= ? AND
        (status IN ('queued','submitting','queued_upstream','publishing') OR status = 'unknown' AND source_id IS NOT NULL
        OR status = 'scheduled' AND planned <= ?) ORDER BY poll_at, created LIMIT 4`).all(now, now);
      const lease = now + 120_000;
      const claimed = (table, row) => database.prepare(`UPDATE ${table} SET poll_at = ? WHERE id = ? AND poll_at = ?`).run(lease, row.id, row.poll_at).changes;
      await Promise.allSettled([
        ...generations.filter(row => claimed('generation', row)).map(generate),
        ...publications.filter(row => claimed('publication', row)).map(publish)
      ]);
    } finally { running = false; }
  }
  return { run, refreshVideo };
}
