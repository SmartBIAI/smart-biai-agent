import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

export const mediaTypes = {
  '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.png': ['image', 'image/png'], '.webp': ['image', 'image/webp'],
  '.mp4': ['video', 'video/mp4'], '.mov': ['video', 'video/quicktime'], '.mp3': ['audio', 'audio/mpeg'], '.wav': ['audio', 'audio/wav']
};

const ttlSeconds = 24 * 60 * 60;

function invalid(message) { return Object.assign(new Error(message), { status: 422 }); }

export function httpsOrigin(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); }
  catch { throw invalid('请输入有效的公网 HTTPS 域名。'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !url.hostname.includes('.') || /^(?:\d+\.|localhost|.*\.local$)/i.test(url.hostname)) throw invalid('请输入公网 HTTPS 域名，无需附加目录或端口。');
  return url.origin;
}

export function normalizeOssRegion(value) {
  const region = value.startsWith('oss-') ? value : `oss-${value}`;
  if (!/^oss-[a-z0-9-]+$/.test(region) || !value) throw invalid('请填写 OSS 地域，例如 cn-hangzhou。');
  return region;
}

export function ossEndpoint(value) {
  if (!value) return '';
  const origin = httpsOrigin(value);
  if (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(new URL(origin).hostname)) throw invalid('请输入阿里云 OSS 地域 Endpoint。');
  return origin;
}

export function storagePrefix(value) {
  const normalized = value.replace(/^\/+|\/+$/g, '');
  if (normalized && !normalized.split('/').every(segment => /^[\w.\p{L}-]+$/u.test(segment) && segment !== '.' && segment !== '..')) {
    throw invalid('OSS 目录请使用普通目录名，例如 biai-agent/references。');
  }
  return normalized || 'biai-agent/references';
}

function mediaPath(file) { return `/media/${file.id}${extname(file.name).toLowerCase()}`; }

function signingKey(directory, create) {
  const path = resolve(directory, '.media-link-key');
  if (create) {
    try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  try { return readFileSync(path); } catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
}

function signature(key, path, expires) {
  return createHmac('sha256', key).update(`${path}:\n${expires}`).digest('hex');
}

export function signedLocalMedia(file, origin, directory) {
  const path = mediaPath(file);
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signature(signingKey(directory, true), path, expires);
  return `${origin}${path}?expires=${expires}&sig=${sig}`;
}

export function verifyLocalMedia(url, directory) {
  const expires = url.searchParams.get('expires') ?? '';
  const sig = url.searchParams.get('sig') ?? '';
  const now = Math.floor(Date.now() / 1000);
  if (!/^\d{10}$/.test(expires) || Number(expires) <= now || Number(expires) > now + ttlSeconds || !/^[a-f0-9]{64}$/.test(sig)) return false;
  const key = signingKey(directory, false);
  return Boolean(key && timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(signature(key, url.pathname, expires), 'hex')));
}

export async function ossReferenceLinks(config, files) {
  const { default: OSS } = await import('ali-oss').catch(() => { throw invalid('请先运行 npm ci 安装 OSS 支持。'); });
  const options = {
    region: normalizeOssRegion(config.region), bucket: config.bucket,
    accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret,
    ...(config.securityToken ? { stsToken: config.securityToken } : {}), secure: true, authorizationV4: true, timeout: 60_000
  };
  const uploader = new OSS({ ...options, ...(config.endpoint ? { endpoint: config.endpoint } : {}) });
  const publicClient = new OSS({ ...options, ...(config.customDomain ? { endpoint: config.customDomain, cname: true } : {}) });
  const links = [];
  for (const file of files) {
    const ext = extname(file.name).toLowerCase();
    const name = `${config.prefix}/${file.id}${ext}`;
    const [type, mime] = mediaTypes[ext];
    try {
      try {
        await uploader.put(name, file.path, { headers: { 'Content-Type': mime, 'x-oss-forbid-overwrite': 'true' } });
      } catch (error) {
        if (error.code !== 'FileAlreadyExists' && error.status !== 409) throw error;
        const existing = await uploader.head(name);
        if (Number(existing.res.headers['content-length']) !== file.size) throw error;
      }
      const url = await publicClient.signatureUrlV4('GET', ttlSeconds, { headers: {} }, name);
      links.push({ type, url });
    } catch (error) {
      if ([401, 403].includes(error.status)) throw invalid('OSS 拒绝访问，请检查密钥和指定目录的上传、读取权限。');
      throw invalid('无法将素材上传到 OSS，请检查 Bucket、地域和网络后再试。');
    }
  }
  return links;
}
