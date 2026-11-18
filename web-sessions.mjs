import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

const hash = value => createHash('sha256').update(value).digest('hex');
const hour = 60 * 60 * 1000;

export function createWebSessions(database, access, now = Date.now) {
  database.exec(`CREATE TABLE IF NOT EXISTS web_session (
    token TEXT PRIMARY KEY, credential_version TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_web_session_expires ON web_session(expires);`);
  const cookieName = `biai_session_${hash(access.basePath).slice(0, 12)}`;
  const cookiePath = `${access.basePath}/`;
  const failures = new Map();
  const cookie = (value, age) => `${cookieName}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Lax${access.publicOrigin ? '; Secure' : ''}${age === undefined ? '' : `; Max-Age=${age}`}`;
  const token = request => {
    const value = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value || '') ? value : '';
  };
  const client = request => {
    const remote = request.socket.remoteAddress || '';
    // Only a local reverse proxy may supply the client address. The last value
    // is the one appended by proxy_add_x_forwarded_for, not a client prefix.
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      const forwarded = request.headers['x-forwarded-for']?.split(',').at(-1)?.trim();
      if (isIP(forwarded || '')) return forwarded;
    }
    return remote;
  };
  return {
    safeReturn(value) {
      try {
        const url = new URL(value || cookiePath, 'http://localhost');
        return url.origin === 'http://localhost' && url.pathname === cookiePath ? `${url.pathname}${url.search}${url.hash}` : cookiePath;
      } catch { return cookiePath; }
    },
    authorized(request) {
      if (!access.requireAuth) return true;
      // Retain Basic authentication for scripts; browsers always use sessions.
      if (!request.headers['sec-fetch-site'] && access.authorized(request.headers.authorization)) return true;
      const value = token(request);
      if (!value) return false;
      const row = database.prepare('SELECT credential_version, expires FROM web_session WHERE token = ?').get(hash(value));
      return Boolean(row && row.expires > now() && row.credential_version === access.credentialVersion);
    },
    login(request, user, pass, remember = false) {
      const time = now();
      for (const [key, value] of failures) if (value.until <= time) failures.delete(key);
      const address = client(request);
      const failed = failures.get(address);
      if ((failed?.count || 0) >= 8 || (!failed && failures.size >= 1000)) {
        return { status: 429, retryAfter: Math.ceil(((failed?.until || time + 15 * 60 * 1000) - time) / 1000), error: '尝试次数较多，请稍后再试。' };
      }
      if (!access.verifyCredentials(user, pass)) {
        failures.set(address, { count: (failed?.count || 0) + 1, until: failed?.until || time + 15 * 60 * 1000 });
        return { status: 401, error: '账号或密码不正确，请重新输入。' };
      }
      failures.delete(address);
      const value = randomBytes(32).toString('base64url');
      const duration = remember ? 7 * 24 * hour : 12 * hour;
      database.prepare('DELETE FROM web_session WHERE expires <= ? OR credential_version != ?').run(time, access.credentialVersion);
      database.prepare('DELETE FROM web_session WHERE token = ?').run(hash(token(request)));
      database.exec('DELETE FROM web_session WHERE token IN (SELECT token FROM web_session ORDER BY created DESC LIMIT -1 OFFSET 99)');
      database.prepare('INSERT INTO web_session VALUES (?, ?, ?, ?)').run(hash(value), access.credentialVersion, time + duration, time);
      return { status: 200, cookie: cookie(value, remember ? duration / 1000 : undefined) };
    },
    logout(request) {
      database.prepare('DELETE FROM web_session WHERE token = ?').run(hash(token(request)));
      return cookie('', 0);
    }
  };
}
