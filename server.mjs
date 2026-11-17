import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open, rename, unlink, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { accounts, generationResult, interpret, models } from './mock.mjs';
import { mediaUrl, socialClient, understand, videoClient } from './integrations.mjs';
import { createLiveJobs, migrateLive } from './live-jobs.mjs';
import { httpsOrigin, mediaTypes, normalizeOssRegion, ossEndpoint, ossReferenceLinks, signedLocalMedia, storagePrefix, verifyLocalMedia } from './media-storage.mjs';

const directory = resolve(process.env.BIAI_DATA_DIR || fileURLToPath(new URL('./.data/', import.meta.url)));
const filesDirectory = resolve(directory, 'uploads');
mkdirSync(directory, { recursive: true });
const database = new DatabaseSync(resolve(directory, 'workbench.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS generation (
    id TEXT PRIMARY KEY, parameters TEXT NOT NULL, credits INTEGER NOT NULL, created INTEGER NOT NULL,
    source_id TEXT, url TEXT, cover TEXT, expires INTEGER
  );
  CREATE TABLE IF NOT EXISTS publication (
    id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES generation(id), account TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, cover TEXT, ai INTEGER NOT NULL,
    planned INTEGER, zone TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
    submitted INTEGER, updated INTEGER NOT NULL, source_id TEXT, material_id TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversation (
    mode TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    revision INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (mode, id)
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_updated ON conversation(mode, updated DESC);
  CREATE TABLE IF NOT EXISTS uploaded_file (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL);
`);
migrateLive(database);
if (!database.prepare('PRAGMA table_info(uploaded_file)').all().some(column => column.name === 'folder')) {
  database.exec('ALTER TABLE uploaded_file ADD COLUMN folder TEXT');
}

const getGeneration = database.prepare('SELECT * FROM generation WHERE id = ?');
const getPublication = database.prepare('SELECT * FROM publication WHERE id = ?');
const getSetting = database.prepare('SELECT value FROM settings WHERE name = ?');
const saveSetting = database.prepare('INSERT OR REPLACE INTO settings (name, value) VALUES (?, ?)');
const generationDelay = 1800;
const publishDelay = 3800;
const lateWindow = 15 * 60 * 1000;

function advanceJobs(now = Date.now()) {
  const ready = database.prepare("SELECT id FROM generation WHERE mode = 'mock' AND source_id IS NULL AND created <= ?").all(now - generationDelay);
  for (const { id } of ready) {
    const result = generationResult(id, now);
    database.prepare('UPDATE generation SET source_id = ?, url = ?, cover = ?, expires = ? WHERE id = ? AND source_id IS NULL')
      .run(result.sourceTaskId, result.url, result.coverUrl, result.expiresAt, id);
  }

  database.prepare("UPDATE publication SET status = 'missed', updated = ? WHERE status = 'scheduled' AND payload IS NULL AND planned < ?")
    .run(now, now - lateWindow);
  const due = database.prepare(`SELECT p.id, p.generation_id, g.expires FROM publication p JOIN generation g ON p.generation_id = g.id
    WHERE p.mode = 'mock' AND (p.status = 'queued' OR (p.status = 'scheduled' AND p.planned <= ?))`).all(now);
  for (const row of due) {
    if (row.expires <= now) {
      database.prepare("UPDATE publication SET status = 'expired', updated = ? WHERE id = ? AND status IN ('queued', 'scheduled')").run(now, row.id);
      continue;
    }
    database.prepare(`UPDATE publication SET status = 'publishing', submitted = ?, updated = ?, source_id = ?, material_id = ?
      WHERE id = ? AND status IN ('queued', 'scheduled')`)
      .run(now, now, `mock-pub-${row.id}`, `mock-video-${row.generation_id}`, row.id);
  }
  database.prepare("UPDATE publication SET status = 'completed', updated = ? WHERE mode = 'mock' AND status = 'publishing' AND submitted <= ?")
    .run(now, now - publishDelay);
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function readBody(request, limit = 100_000) {
  if (!request.headers['content-type']?.startsWith('application/json')) fail(415, '请输入 JSON 数据。');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) fail(413, '输入内容过长。');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, '输入格式有误。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '输入格式有误。');
  return body;
}

function validateText(value, max, label, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `请检查${label}。`);
  return value.trim();
}

function validId(id) {
  if (typeof id !== 'string' || !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) fail(400, '请求编号无效。');
  return id;
}

const uploadLimit = 100 * 1024 * 1024;

async function uploadFile(request) {
  if (request.headers['content-type'] !== 'application/octet-stream') fail(415, '无法读取这个文件，请重新选择。');
  const length = Number(request.headers['content-length']);
  if (!Number.isSafeInteger(length) || length <= 0) fail(400, '请选择非空文件。');
  if (length > uploadLimit) fail(413, '单个文件最多 100 MB。');
  let name;
  try {
    name = decodeURIComponent(request.headers['x-file-name'] || '').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  } catch { fail(400, '文件名无法读取。'); }
  if (!name || name.length > 255 || !Object.hasOwn(mediaTypes, extname(name).toLowerCase())) {
    fail(400, '请选择 JPG、PNG、WebP、MP4、MOV、MP3 或 WAV 文件。');
  }
  const settings = storageConfiguration();
  const folder = settings.provider === 'local' ? settings.localDirectory : filesDirectory;
  if (!isAbsolute(folder)) fail(422, '请在连接设置指定服务器上的绝对附件目录。');
  mkdirSync(folder, { recursive: true });
  const id = randomUUID();
  const path = resolve(folder, id);
  const temporary = `${path}.part`;
  try {
    await pipeline(request, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if ((await stat(temporary)).size !== length) fail(400, '文件上传不完整，请重试。');
    await rename(temporary, path);
    database.prepare('INSERT INTO uploaded_file (id, name, size, folder) VALUES (?, ?, ?, ?)').run(id, name, length, folder === filesDirectory ? null : folder);
  } catch (error) {
    await Promise.allSettled([unlink(temporary), unlink(path)]);
    throw error;
  }
  return { id, name, size: length };
}

async function previewImageType(path, name) {
  const file = await open(path, 'r');
  let header;
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
  const ext = extname(name).toLowerCase();
  if (ext === '.png' && header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (['.jpg', '.jpeg'].includes(ext) && header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (ext === '.webp' && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  fail(415, '这个文件无法预览。');
}

async function getUpload(id) {
  const file = database.prepare('SELECT id, name, size, folder FROM uploaded_file WHERE id = ?').get(validId(id));
  const path = resolve(file?.folder ?? filesDirectory, id);
  const info = file && await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== file.size) fail(404, '找不到完整的附件文件。');
  return { id: file.id, name: file.name, size: file.size, path };
}

async function sendUploadedFile(id, response, preview) {
  const file = await getUpload(id);
  if (preview) {
    response.setHeader('Content-Type', await previewImageType(file.path, file.name));
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  } else {
    const filename = encodeURIComponent(file.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  }
  response.setHeader('Content-Length', file.size);
  await pipeline(createReadStream(file.path), response);
}

async function sendSharedMedia(request, response, url, match) {
  if (!verifyLocalMedia(url, directory)) fail(403, '素材链接无效或已过期。');
  const file = await getUpload(match[1]);
  const extension = extname(file.name).toLowerCase();
  if (extension !== match[2] || !Object.hasOwn(mediaTypes, extension)) fail(404, '找不到这个素材。');
  let start = 0;
  let end = file.size - 1;
  if (request.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (range?.[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else if (range?.[2]) start = Math.max(0, file.size - Number(range[2]));
    if (!range || !range[1] && !range[2] || !Number.isSafeInteger(start) || start > end) {
      response.setHeader('Content-Range', `bytes */${file.size}`);
      fail(416, '请求的文件范围无效。');
    }
    response.statusCode = 206;
    response.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
  }
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Type', mediaTypes[extension][1]);
  response.setHeader('Content-Disposition', 'attachment');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Length', end - start + 1);
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(file.path, { start, end }), response);
}

function generationView(row, mode) {
  if (!row || row.mode !== mode) fail(404, '未找到这项生成任务。');
  const now = Date.now();
  const expired = row.expires !== null && row.expires <= now;
  const linkExpired = row.link_expires !== null && row.link_expires <= now;
  return {
    id: row.id, parameters: JSON.parse(row.parameters), credits: row.credits, created: row.created,
    status: expired ? 'expired' : row.mode === 'live' ? row.state : row.source_id ? 'completed' : 'generating', sourceTaskId: row.source_id,
    url: expired || linkExpired ? null : row.url, coverUrl: expired || linkExpired ? null : row.cover,
    expiresAt: row.expires, error: row.error, mode: row.mode
  };
}

function publicationView(row) {
  if (!row) fail(404, '未找到这项发布任务。');
  return {
    id: row.id, generationId: row.generation_id, accountId: row.account, title: row.title,
    description: row.description, coverUrl: row.cover, ai: Boolean(row.ai), planned: row.planned,
    zone: row.zone, status: row.status, created: row.created, submitted: row.submitted, updated: row.updated,
    sourceTaskId: row.source_id, materialId: row.material_id, error: row.error, mode: row.mode,
    account: row.account_snapshot ? JSON.parse(row.account_snapshot) : null
  };
}

function generationParameters(body, catalog, live) {
  const model = catalog.find(item => item.id === body.model);
  if (!model || !model.ratios.includes(body.ratio) || !model.resolutions.includes(body.resolution) ||
      !Number.isInteger(body.duration) || (model.durations?.length ? !model.durations.includes(body.duration) : body.duration < model.min || body.duration > model.max)) {
    fail(400, '请选择模型支持的比例、清晰度和时长。');
  }
  if (typeof body.audio !== 'boolean') fail(400, '请选择是否生成声音。');
  const prompt = validateText(body.prompt, model.maxPrompt ?? (model.name.endsWith('Lite') ? 2000 : 20000), '视频提示词');
  const minPrompt = model.minPrompt ?? (model.name.endsWith('Lite') ? 10 : 1);
  if (prompt.length < minPrompt) fail(400, `所选模型的提示词至少需要 ${minPrompt} 个字符。`);
  const parameters = { prompt, model: model.id, ratio: body.ratio, resolution: body.resolution, duration: body.duration, audio: body.audio };
  if (!live) return parameters;
  if (body.audio && !model.audio) fail(400, '所选模型不支持生成声音。');
  if (body.references != null) {
    if (!Array.isArray(body.references) || body.references.length > 9) fail(400, '请检查参考链接。');
    parameters.references = body.references.map(reference => {
      const url = mediaUrl(reference?.url);
      if (!url || !['image', 'video', 'audio'].includes(reference.type)) fail(400, '请添加可识别类型的公网 HTTPS 参考链接。');
      return { type: reference.type, url };
    });
  } else parameters.references = [];
  if (body.fileIds !== undefined && (!Array.isArray(body.fileIds) || body.fileIds.length + parameters.references.length > 9)) fail(400, '请检查参考素材数量。');
  parameters.fileIds = (body.fileIds ?? []).map(validId);
  return parameters;
}

function mockCredits(body) { return body.duration * (body.resolution === '720p' ? 6 : 4); }

function timezone(value) {
  const zone = validateText(value, 80, '时区');
  try { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
  catch { fail(400, '请选择有效的时区。'); }
}

async function createPublication(body, mode) {
  const id = validId(body.id);
  const generationId = validId(body.generationId);
  const generation = getGeneration.get(generationId);
  if (!generation?.source_id || generation.mode !== mode) fail(409, '请先选择当前模式中已完成的视频。');
  if (typeof body.accountId !== 'string' || !/^[1-9]\d{0,18}$/.test(body.accountId)) fail(400, '请选择目标账号。');
  let existing = getPublication.get(id);
  const live = mode === 'live';
  const connection = live ? configuration('social') : {};
  if (existing && (existing.mode !== mode || existing.generation_id !== generationId || existing.account !== body.accountId ||
      live && existing.scope !== connection.scope)) fail(409, '该任务编号已用于另一份发布草稿。');
  if (live && generation.scope !== configuration('video').scope) fail(409, '视频密钥已更换，请改回生成这条视频时用的密钥。');
  const account = live ? existing ? JSON.parse(existing.account_snapshot) : (await socialClient(connection).accounts({ id: body.accountId })).accounts[0] :
    accounts.find(item => item.id === body.accountId && item.authStatus === 20);
  if (!account || live && !existing && !account.canPublish) fail(400, '请选择仍在有效期内的已授权账号。');
  existing = getPublication.get(id);
  const title = validateText(body.title, 100, '发布标题');
  const description = account.platform === 'YouTube' ? validateText(body.description ?? '', 1000, '视频描述', false) : '';
  const zone = timezone(body.zone);
  const now = Date.now();
  const planned = body.planned ?? null;
  const cover = existing?.cover ?? (live ? null : generation.cover);
  if (typeof body.ai !== 'boolean') fail(400, '请选择 AI 生成标记。');
  const ai = Number(body.ai);
  if (existing) {
    if (existing.mode !== mode || existing.generation_id !== generationId || existing.account !== body.accountId ||
        live && existing.scope !== connection.scope || existing.title !== title ||
        existing.description !== description || existing.cover !== cover || existing.ai !== ai || existing.zone !== zone ||
        existing.planned !== planned) fail(409, '该任务编号已用于另一份发布草稿。');
    return publicationView(existing);
  }
  if (planned !== null && (!Number.isSafeInteger(planned) || planned <= now)) fail(400, '请选择晚于现在的预约时间。');
  if (live && generation.state !== 'completed' || generation.expires !== null && generation.expires <= (planned ?? now)) {
    fail(400, '这个视频在所选时间无法使用，请调整预约时间或更换视频。');
  }
  database.prepare(`INSERT INTO publication
    (id, generation_id, account, title, description, cover, ai, planned, zone, status, created, updated, mode, scope, video_scope, account_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, generationId, account.id, title, description, cover, ai,
    planned, zone, planned === null ? 'queued' : 'scheduled', now, now, mode, connection.scope ?? null,
    generation.scope, live ? JSON.stringify(account) : null);
  return publicationView(getPublication.get(id));
}

const groups = {
  social: { publicFields: ['appId'], secret: 'accessToken' },
  video: { publicFields: [], secret: 'apiKey' },
  ai: { publicFields: ['provider', 'model'], secret: 'apiKey' },
  preferences: { publicFields: ['zone'] }
};

function readSetting(name) {
  return JSON.parse(getSetting.get(name)?.value ?? '{}');
}

function currentEnv() {
  let local = {};
  try { local = parseEnv(readFileSync(new URL('./doc/.env.local', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') fail(422, '无法读取 doc/.env.local，请检查文件格式和权限。'); }
  return (...names) => names.map(name => process.env[name] || local[name]).find(value => value?.trim())?.trim() ?? '';
}

function unseal(encoded) {
  if (!encoded) return '';
  try {
    const bytes = Buffer.from(encoded, 'base64');
    const decoder = createDecipheriv('aes-256-gcm', readFileSync(resolve(directory, '.credentials-key')), bytes.subarray(0, 12));
    decoder.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decoder.update(bytes.subarray(28)), decoder.final()]).toString('utf8');
  } catch { fail(422, '无法读取已保存的密钥，请在连接设置重新保存。'); }
}

function configuration(name, saved = readSetting(name)) {
  const env = currentEnv();
  const savedKey = unseal(saved.encrypted);
  let fields;
  let fallback;
  if (name === 'social') {
    fields = { appId: saved.appId || env('BIAI_SOCIAL_APP_ID', 'BIAI_APP_ID', 'biai_app_id', 'biai_api_app_id') };
    fallback = env('BIAI_SOCIAL_ACCESS_TOKEN', 'BIAI_ACCESS_TOKEN', 'biai_access_token', 'biai_api_key');
  } else if (name === 'video') {
    fields = {};
    fallback = env('BIAI_VIDEO_API_KEY', 'biai_video_api_key', 'biai_video_key');
  } else {
    const deepseek = env('DEEPSEEK_API_KEY', 'deepseek_api_key', 'dp_api_key');
    const doubao = env('ARK_API_KEY', 'DOUBAO_API_KEY', 'doubao_api_key');
    const deepseekModel = env('DEEPSEEK_MODEL', 'deepseek_model', 'dp_model');
    const doubaoModel = env('DOUBAO_MODEL', 'ARK_MODEL', 'doubao_model');
    const provider = saved.provider || env('BIAI_AI_PROVIDER') || (deepseek && deepseekModel ? 'deepseek' : doubao && doubaoModel ? 'doubao' :
      deepseek ? 'deepseek' : doubao ? 'doubao' : '');
    fields = { provider, model: saved.model || (provider === 'deepseek' ? deepseekModel : doubaoModel) };
    fallback = provider === 'deepseek' ? deepseek : provider === 'doubao' ? doubao : '';
  }
  const key = savedKey || fallback;
  const ready = Boolean(key && (name === 'social' ? fields.appId : name === 'ai' ? fields.model && ['deepseek', 'doubao'].includes(fields.provider) : true));
  const scope = ready ? createHash('sha256').update(JSON.stringify([name, fields, key])).digest('hex') : null;
  return { ...fields, key, scope, ready, source: savedKey ? 'saved' : fallback ? 'env' : '' };
}

function settingView(name) {
  const saved = readSetting(name);
  if (name === 'preferences') return saved;
  const { key, scope, ...config } = configuration(name, saved);
  return { ...config, hasSecret: Boolean(key), hasSavedSecret: Boolean(saved.encrypted) };
}

function storageConfiguration(saved = readSetting('storage')) {
  const env = currentEnv();
  const accessKeyId = unseal(saved.encryptedId) || env('OSS_ACCESS_KEY_ID');
  const accessKeySecret = unseal(saved.encrypted) || env('OSS_ACCESS_KEY_SECRET');
  return {
    provider: saved.provider ?? (env('BIAI_STORAGE_PROVIDER') === 'oss' ? 'oss' : 'local'),
    publicOrigin: saved.publicOrigin ?? env('BIAI_MEDIA_PUBLIC_ORIGIN'),
    localDirectory: saved.localDirectory || env('BIAI_MEDIA_DIRECTORY') || filesDirectory,
    bucket: saved.bucket ?? env('OSS_BUCKET'), region: saved.region ?? env('OSS_REGION'),
    endpoint: saved.endpoint ?? env('OSS_ENDPOINT'), customDomain: saved.customDomain ?? env('OSS_CUSTOM_DOMAIN'),
    prefix: saved.prefix ?? env('OSS_FILE_DIR'), accessKeyId, accessKeySecret, securityToken: env('OSS_SECURITY_TOKEN')
  };
}

function storageView() {
  const { accessKeyId, accessKeySecret, securityToken, ...config } = storageConfiguration();
  const ready = config.provider === 'local' ? Boolean(config.publicOrigin) : Boolean(accessKeyId && accessKeySecret && config.bucket && config.region);
  return { ...config, hasAccessKeyId: Boolean(accessKeyId), hasSecret: Boolean(accessKeySecret), ready };
}

function configureStorage(body) {
  if (!['local', 'oss'].includes(body.provider)) fail(400, '请选择一种文件服务。');
  const saved = readSetting('storage');
  const next = { ...saved, provider: body.provider };
  const field = name => validateText(body[name] ?? '', 4096, name, false);
  if (body.provider === 'local') {
    next.publicOrigin = httpsOrigin(field('publicOrigin'));
    const folder = field('localDirectory');
    if (folder && !isAbsolute(folder)) fail(400, '请输入服务器上的绝对目录。');
    next.localDirectory = folder ? resolve(folder) : '';
  } else {
    next.bucket = field('bucket');
    if (next.bucket && !/^[a-z\d][a-z\d-]{1,61}[a-z\d]$/.test(next.bucket)) fail(400, '请检查 OSS Bucket 名称。');
    next.region = field('region') ? normalizeOssRegion(field('region')) : '';
    next.endpoint = ossEndpoint(field('endpoint'));
    next.customDomain = httpsOrigin(field('customDomain'));
    next.prefix = storagePrefix(field('prefix'));
    if (field('accessKeyId')) next.encryptedId = seal(field('accessKeyId'));
    if (field('accessKeySecret')) next.encrypted = seal(field('accessKeySecret'));
  }
  saveSetting.run('storage', JSON.stringify(next));
  return storageView();
}

async function attachmentReferences(ids) {
  if (!ids.length) return [];
  const config = storageConfiguration();
  const files = await Promise.all(ids.map(getUpload));
  if (config.provider === 'local') {
    const origin = httpsOrigin(config.publicOrigin);
    if (!origin) fail(422, '请在连接设置填写文件服务的公网 HTTPS 域名，或改用 OSS。');
    return files.map(file => ({ type: mediaTypes[extname(file.name).toLowerCase()][0], url: signedLocalMedia(file, origin, directory) }));
  }
  if (!config.accessKeyId || !config.accessKeySecret || !config.bucket || !config.region) fail(422, '请补齐 OSS 密钥、Bucket 和地域。');
  return ossReferenceLinks({ ...config, endpoint: ossEndpoint(config.endpoint), customDomain: httpsOrigin(config.customDomain), prefix: storagePrefix(config.prefix) }, files);
}

function seal(value) {
  const file = resolve(directory, '.credentials-key');
  try { writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', readFileSync(file), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

function configure(name, body) {
  const group = groups[name];
  if (!group) fail(404, '设置项不存在。');
  const previous = readSetting(name);
  const next = Object.fromEntries(group.publicFields.map(field => [field, validateText(body[field], 160, field)]));
  if (name === 'ai' && !['deepseek', 'doubao'].includes(next.provider)) fail(400, '请选择 DeepSeek 或豆包。');
  if (name === 'preferences') next.zone = timezone(next.zone);
  if (group.secret) {
    const input = validateText(body[group.secret] ?? '', 4096, 'API 凭证', false);
    const canKeep = name !== 'ai' || previous.provider === next.provider;
    next.encrypted = body.clearSecret === true ? null : input ? seal(input) : canKeep ? previous.encrypted ?? null : null;
  }
  saveSetting.run(name, JSON.stringify(next));
  return settingView(name);
}

const liveJobs = createLiveJobs(database, configuration, lateWindow);
let modelCache;

async function liveModels(connection = configuration('video')) {
  if (modelCache?.scope === connection.scope && modelCache.until > Date.now()) return modelCache.list;
  const list = await videoClient(connection).models();
  modelCache = { scope: connection.scope, list, until: Date.now() + 60_000 };
  return list;
}

async function bootstrap(mode) {
  const settings = Object.fromEntries(Object.keys(groups).map(name => [name, settingView(name)]));
  settings.storage = storageView();
  if (mode === 'mock') return { mode, accounts, models, settings, issues: {} };
  const [social, video] = await Promise.allSettled([Promise.resolve().then(() => socialClient(configuration('social')).accounts()), liveModels()]);
  const found = social.status === 'fulfilled' ? social.value.accounts : [];
  const catalog = video.status === 'fulfilled' ? video.value : [];
  return {
    mode, accounts: found, models: catalog, settings,
    issues: {
      social: social.status === 'rejected' ? social.reason.message : social.value.limited ? '当前已加载前 500 个账号，可在 Agent 按账号 ID 或平台查询。' : '',
      video: video.status === 'rejected' ? video.reason.message : catalog.length ? '' : '已连接视频服务，请在 Smart BIAI 开通 Mini 或 Lite 模型。',
      ai: settings.ai.ready ? '' : '请在连接设置填写 DeepSeek 或豆包的模型 ID 和 API Key。'
    }
  };
}

async function agent(body, mode) {
  const message = validateText(body.message, 2000, '消息');
  if (mode === 'mock') return interpret(message);
  const history = Array.isArray(body.history) ? body.history.slice(-5).filter(item => typeof item === 'string').map(item => item.slice(0, 1000)) : [];
  const intent = await understand(configuration('ai'), message, history);
  let found = [];
  let accountError;
  let limited;
  if (intent.query || intent.publish && (intent.accountId || intent.keyword || intent.platform || intent.country)) {
    try {
      const result = await socialClient(configuration('social')).accounts({
        id: intent.accountId, keyword: intent.keyword, platform: intent.platform, country: intent.country
      });
      found = result.accounts;
      limited = result.limited;
    } catch (error) { accountError = error.message; }
  }
  return { ...intent, accounts: found, targetId: found.length === 1 && found[0].canPublish ? found[0].id : '', accountError, limited };
}

async function estimate(body, mode) {
  if (mode === 'mock') return { parameters: generationParameters(body, models, false), credits: mockCredits(body) };
  const id = validId(body.id);
  if (getGeneration.get(id)) fail(409, '该草稿已有生成任务，请查看生成记录。');
  const connection = configuration('video');
  const catalog = await liveModels(connection);
  if (!catalog.length) fail(422, '当前无法使用 Mini 或 Lite，请在 Smart BIAI 开通其中一个模型。');
  const parameters = generationParameters(body, catalog, true);
  const model = catalog.find(item => item.id === parameters.model);
  const payload = { prompt: parameters.prompt, model: parameters.model, aspect_ratio: parameters.ratio, resolution: parameters.resolution, duration: parameters.duration };
  if (model.audio) payload.generate_audio = parameters.audio;
  if (model.lastFrame) payload.return_last_frame = true;
  const references = [...parameters.references, ...await attachmentReferences(parameters.fileIds)];
  if (references.length) payload.references = references;
  const credits = await videoClient(connection).quote(payload);
  if (credits < 1 || credits > 2_000_000_000) fail(422, '本次报价无法建立明确的费用上限，请调整生成参数。');
  const now = Date.now();
  database.prepare('DELETE FROM video_quote WHERE expires <= ?').run(now);
  database.prepare('INSERT OR REPLACE INTO video_quote (id, scope, parameters, payload, credits, expires) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, connection.scope, JSON.stringify(parameters), JSON.stringify(payload), credits, now + 5 * 60_000);
  return { parameters, credits };
}

function createGeneration(body, mode) {
  const id = validId(body.id);
  const live = mode === 'live';
  const existing = getGeneration.get(id);
  if (existing && existing.mode !== mode) fail(409, '该编号属于另一种运行模式。');
  const now = Date.now();
  if (live) {
    const connection = configuration('video');
    const estimate = existing || database.prepare('SELECT * FROM video_quote WHERE id = ? AND expires > ?').get(id, now);
    if (!estimate || estimate.scope !== connection.scope || estimate.credits !== body.credits) fail(409, '请重新获取并确认视频报价。');
    const prior = JSON.parse(estimate.parameters);
    if (typeof body.prompt !== 'string' || prior.prompt !== body.prompt.trim() || prior.model !== body.model || prior.ratio !== body.ratio || prior.resolution !== body.resolution ||
        prior.duration !== body.duration || prior.audio !== body.audio || JSON.stringify(prior.references) !== JSON.stringify(body.references ?? []) ||
        JSON.stringify(prior.fileIds ?? []) !== JSON.stringify(body.fileIds ?? [])) {
      fail(409, '生成参数已修改，请重新获取报价。');
    }
    if (!existing) database.prepare(`INSERT INTO generation (id, parameters, credits, created, mode, scope, state, payload)
      VALUES (?, ?, ?, ?, 'live', ?, 'queued', ?)`).run(id, estimate.parameters, estimate.credits, now, estimate.scope,
      JSON.stringify({ ...JSON.parse(estimate.payload), request_id: id, max_credits: estimate.credits }));
  } else {
    const parameters = JSON.stringify(generationParameters(body, models, false));
    const credits = mockCredits(body);
    if (credits !== body.credits) fail(409, '报价已变化，请重新确认。');
    if (existing && existing.parameters !== parameters) fail(409, '该任务编号已用于另一份生成草稿。');
    if (!existing) database.prepare('INSERT INTO generation (id, parameters, credits, created) VALUES (?, ?, ?, ?)')
      .run(id, parameters, credits, now);
  }
  return generationView(getGeneration.get(id), mode);
}

function conversationView(row) {
  if (!row) fail(404, '找不到这段对话。');
  const { content, ...summary } = row;
  return { ...summary, ...JSON.parse(content) };
}

function validateAttachedFiles(files) {
  if (files === undefined) return;
  if (!Array.isArray(files) || files.length > 9 || files.some(file => typeof file?.name !== 'string')) fail(400, '无法保存文件附件。');
  for (const file of files) validId(file.id);
}

function saveConversation(mode, id, body) {
  const { revision, chat, drafts } = body;
  if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(chat) || !chat.length || !Array.isArray(drafts)) {
    fail(400, '对话内容有误，无法保存。');
  }
  for (const entry of chat) {
    if (!entry || !['user', 'text', 'generation', 'result', 'publication', 'confirmed', 'tasks'].includes(entry.type)) fail(400, '无法保存这条对话消息。');
    if (['generation', 'result', 'publication', 'confirmed'].includes(entry.type)) validId(entry.id);
    if (entry.type === 'tasks' && (!Array.isArray(entry.ids) || entry.ids.some(taskId => typeof taskId !== 'string'))) fail(400, '无法保存任务卡片。');
    if (entry.accounts !== undefined && (!Array.isArray(entry.accounts) || entry.accounts.some(account => !account || typeof account.id !== 'string'))) fail(400, '无法保存账号卡片。');
    validateAttachedFiles(entry.files);
  }
  for (const draft of drafts) {
    validId(draft?.id);
    validateAttachedFiles(draft.files);
    if (draft.generationId) {
      validId(draft.generationId);
      timezone(draft.zone);
    } else if (!draft.parameters || typeof draft.parameters.model !== 'string' || !Array.isArray(draft.links)) fail(400, '无法保存视频生成草稿。');
  }
  const firstMessage = chat.find(item => item.type === 'user');
  const subject = (typeof firstMessage?.text === 'string' ? firstMessage.text.trim() : '') || firstMessage?.files?.[0]?.name;
  const title = subject?.replace(/\s+/g, ' ').trim().slice(0, 48) || '视频和发布草稿';
  const content = JSON.stringify({ chat, drafts });
  const now = Date.now();
  const result = revision === 0
    ? database.prepare(`INSERT OR IGNORE INTO conversation (mode, id, title, content, revision, updated)
        VALUES (?, ?, ?, ?, 1, ?)`).run(mode, id, title, content, now)
    : database.prepare(`UPDATE conversation SET title = ?, content = ?, revision = revision + 1, updated = ?
        WHERE mode = ? AND id = ? AND revision = ?`).run(title, content, now, mode, id, revision);
  if (!result.changes) fail(409, '这段对话已在另一个页面更新。');
  return { id, title, revision: revision + 1, updated: now };
}

async function api(request, path) {
  const { method } = request;
  const mode = request.headers['x-biai-mode'] ?? 'mock';
  if (!['mock', 'live'].includes(mode)) fail(400, '运行模式无效。');
  const conversation = path.match(/^\/api\/conversations\/([a-f\d-]+)$/i);
  if (method === 'GET') {
    if (path === '/api/conversations') return database.prepare('SELECT id, title, revision, updated FROM conversation WHERE mode = ? ORDER BY updated DESC').all(mode);
    if (conversation) return conversationView(database.prepare('SELECT * FROM conversation WHERE mode = ? AND id = ?').get(mode, validId(conversation[1])));
    if (path === '/api/bootstrap') return bootstrap(mode);
    if (path === '/api/generations') return database.prepare('SELECT * FROM generation WHERE mode = ? ORDER BY created DESC').all(mode).map(row => generationView(row, mode));
    if (path.startsWith('/api/generations/')) return generationView(getGeneration.get(path.slice(17)), mode);
    if (path === '/api/publications') return database.prepare('SELECT * FROM publication WHERE mode = ? ORDER BY created DESC').all(mode).map(publicationView);
  }
  if (method === 'POST') {
    const body = await readBody(request, conversation ? 2_000_000 : undefined);
    if (conversation) return saveConversation(mode, validId(conversation[1]), body);
    if (path === '/api/settings/storage') return configureStorage(body);
    if (path === '/api/agent') return agent(body, mode);
    if (path === '/api/quote') return estimate(body, mode);
    if (path === '/api/generations') return createGeneration(body, mode);
    const refresh = path.match(/^\/api\/generations\/([a-f\d-]+)\/refresh$/i);
    if (refresh) {
      const row = getGeneration.get(validId(refresh[1]));
      const view = generationView(row, mode);
      if (mode === 'mock' || row.state !== 'completed' || view.status === 'expired') return view;
      if (row.scope !== configuration('video').scope) fail(409, '视频密钥已更换，请改回原密钥再打开此视频。');
      return generationView(await liveJobs.refreshVideo(row), mode);
    }
    if (path === '/api/copywriting' && mode === 'live') {
      const row = getGeneration.get(validId(body.generationId));
      const view = generationView(row, mode);
      return understand(configuration('ai'), view.parameters.prompt, [], true);
    }
    if (path === '/api/publications') return createPublication(body, mode);
    const cancel = path.match(/^\/api\/publications\/([a-f\d-]+)\/cancel$/i);
    if (cancel) {
      const id = validId(cancel[1]);
      const row = getPublication.get(id);
      if (!row || row.mode !== mode) fail(404, '未找到这项发布任务。');
      const result = database.prepare("UPDATE publication SET status = 'canceled', updated = ? WHERE id = ? AND status = 'scheduled' AND payload IS NULL").run(Date.now(), id);
      if (!result.changes && row.status !== 'canceled') fail(409, '这条任务已开始发布，无法取消预约。');
      return publicationView(getPublication.get(id));
    }
    const settings = path.match(/^\/api\/settings\/(social|video|ai|preferences)$/);
    if (settings) return configure(settings[1], body);
  }
  fail(404, '未找到请求的资源。');
}

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']]
]);
const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1';
const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; img-src 'self' https: data:; media-src https:; form-action 'self'");
  try {
    if (!allowedHosts.has(request.headers.host)) fail(403, '请通过本机地址访问。');
    if (request.method === 'POST' && request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
      fail(403, '请求来源无效。');
    }
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    const shared = path.match(/^\/media\/([a-f\d-]+)(\.[a-z0-9]+)$/);
    if (shared && ['GET', 'HEAD'].includes(request.method)) {
      await sendSharedMedia(request, response, url, shared);
      return;
    }
    const upload = path.match(/^\/api\/files\/([a-f\d-]+)(\/preview)?$/i);
    if (request.method === 'GET' && upload) {
      response.setHeader('Cache-Control', 'no-store');
      await sendUploadedFile(upload[1], response, Boolean(upload[2]));
      return;
    }
    if (request.method === 'GET' && assets.has(path)) {
      const [file, type] = assets.get(path);
      response.setHeader('Content-Type', `${type}; charset=utf-8`);
      response.end(readFileSync(new URL(`./web/${file}`, import.meta.url)));
      return;
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'POST' && path === '/api/files') {
      response.statusCode = 201;
      response.end(JSON.stringify(await uploadFile(request)));
      return;
    }
    advanceJobs();
    response.end(JSON.stringify(await api(request, path)));
  } catch (error) {
    if (response.headersSent || response.destroyed) { response.destroy(); return; }
    response.statusCode = error.status || 500;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: error.status ? error.message : '本地服务暂时无法完成请求。' }));
    if (!error.status) console.error('Workbench request failed:', error.code || error.name);
  }
});

server.listen(port, host, () => console.log(`BIAI Agent · http://${host}:${port}`));
setInterval(() => {
  try { advanceJobs(); }
  catch (error) { console.error('Worker update failed:', error.code || error.name); }
  void liveJobs.run().catch(error => console.error('Live Worker update failed:', error.code || error.name));
}, 1000).unref();
