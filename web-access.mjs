import { createHash, timingSafeEqual } from 'node:crypto';

export function webAccess(env) {
  const basePath = (env.BIAI_BASE_PATH || '').replace(/\/$/, '');
  if (basePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) {
    throw new Error('BIAI_BASE_PATH must be a URL path such as /smart-biai-agent-app');
  }
  const port = Number(env.PORT || 4173);
  const host = env.BIAI_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('BIAI_HOST must be 127.0.0.1 or 0.0.0.0');
  let publicOrigin;
  if (env.BIAI_PUBLIC_ORIGIN) {
    const url = new URL(env.BIAI_PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('BIAI_PUBLIC_ORIGIN must be an HTTPS origin without a path');
    }
    publicOrigin = url.origin;
  }
  const username = env.BIAI_LOGIN_USER || '';
  const password = env.BIAI_LOGIN_PASSWORD || '';
  const requireAuth = env.BIAI_REQUIRE_AUTH === 'true' || Boolean(username || password);
  if (requireAuth && (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username) || password.length < 16 || /[\r\n]/.test(password) || password === 'CHANGE_ME_BEFORE_START')) {
    throw new Error('Set BIAI_LOGIN_USER and a BIAI_LOGIN_PASSWORD of at least 16 characters before starting');
  }
  const digest = value => createHash('sha256').update(value).digest();
  const expected = digest(`${username}:${password}`);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (env.BIAI_BIND_PORT) {
    const bindPort = Number(env.BIAI_BIND_PORT);
    if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) throw new Error('BIAI_BIND_PORT must be a valid TCP port');
    hosts.add(`127.0.0.1:${bindPort}`);
    hosts.add(`localhost:${bindPort}`);
  }
  const origins = new Set([...hosts].map(value => `http://${value}`));
  if (publicOrigin) {
    hosts.add(new URL(publicOrigin).host);
    origins.add(publicOrigin);
  }
  return {
    basePath, host, port, publicOrigin, requireAuth, username,
    credentialVersion: expected.toString('hex'),
    verifyCredentials(user, pass) {
      return typeof user === 'string' && typeof pass === 'string' && timingSafeEqual(digest(`${user}:${pass}`), expected);
    },
    validHost(value) { return hosts.has(value); },
    validOrigin(value) { return !value || origins.has(value); },
    authorized(header) {
      if (!requireAuth) return true;
      if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
      const supplied = Buffer.from(header.slice(6), 'base64').toString('utf8');
      return timingSafeEqual(digest(supplied), expected);
    },
    path(pathname) {
      if (!basePath) return pathname;
      return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
    }
  };
}
