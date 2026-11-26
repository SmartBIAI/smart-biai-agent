import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open, rename, unlink, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { accounts, generationResult, interpret, models, imageModels } from './mock.mjs';
import { socialClient, understand, videoClient, imageClient, planAgent } from './integrations.mjs';
import { runConversationAgent, agentProtocol } from './agent.mjs';
import { mockAgentPlanner } from './agent-mock.mjs';
import { videoParameters, validateVideoReferences, mockVideoCredits } from './generation-models.js';
import { createImageJobs } from './image-jobs.mjs';
import { createLiveJobs, migrateLive } from './live-jobs.mjs';
import { webAccess } from './web-access.mjs';
import { createWebSessions } from './web-sessions.mjs';
import { accountTagScope, createAccountTags } from './account-tags.mjs';
import { createAutomation, wallTime } from './automation.mjs';
import { automationDraftChanges, collectAutomationDraft } from './automation-draft.mjs';
import { validateAccountFilters } from './web/account-properties.js';
import { httpsOrigin, mediaTypes, normalizeOssRegion, ossEndpoint, ossReferenceLinks, signedLocalMedia, storagePrefix, verifyLocalMedia } from './media-storage.mjs';

const access = webAccess(process.env);
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const directory = resolve(process.env.BIAI_DATA_DIR || fileURLToPath(new URL('./.data/', import.meta.url)));
const filesDirectory = resolve(directory, 'uploads');
mkdirSync(directory, { recursive: true });
const database = new DatabaseSync(resolve(directory, 'workbench.sqlite'));
const sessions = createWebSessions(database, access);
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
database.exec(`CREATE TABLE IF NOT EXISTS agent_turn (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, conversation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_turn_conversation ON agent_turn(mode, conversation_id, created DESC);
CREATE TABLE IF NOT EXISTS agent_lineage (
  mode TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL, source TEXT, created INTEGER NOT NULL,
  PRIMARY KEY(mode,id)
);`);
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
const accountTags = createAccountTags(database);

function tagScope(mode) { return accountTagScope(mode, mode === 'live' ? configuration('social').appId : ''); }
function tagWriteScope(mode, body) {
  const scope = tagScope(mode);
  if (body.scope !== scope) fail(409, '账号连接或运行模式已变化，请刷新后再维护标签。');
  return scope;
}
async function queryAccounts(mode, filters = {}) {
  validateAccountFilters(filters);
  const config = mode === 'live' ? configuration('social') : null;
  const scope = accountTagScope(mode, config?.appId || '');
  const platform = filters.platforms?.length === 1 ? filters.platforms[0] : filters.platform;
  const result = mode === 'live' ? await socialClient(config).accounts({ id: filters.id, platform }) : { accounts, limited: false };
  return { ...result, accounts: accountTags.filter(scope, result.accounts, filters) };
}

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
  return sendMediaFile(request, response, file, extension);
}

async function sendMediaFile(request, response, file, extension, disposition = 'attachment') {
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
  response.setHeader('Content-Disposition', disposition);
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
  const sample = row.mode === 'mock' && row.source_id ? generationResult(row.id, row.created) : null;
  return {
    id: row.id, parameters: JSON.parse(row.parameters), credits: row.credits, created: row.created,
    status: expired ? 'expired' : row.mode === 'live' ? row.state : row.source_id ? 'completed' : 'generating', sourceTaskId: row.source_id,
    url: expired || linkExpired ? null : sample?.url ?? row.url, coverUrl: expired || linkExpired ? null : sample?.coverUrl ?? row.cover,
    expiresAt: row.expires, error: row.error, mode: row.mode
  };
}

function publicationView(row) {
  if (!row) fail(404, '未找到这项发布任务。');
  const awaitingReview = row.status === 'awaiting_review';
  return {
    id: row.id, generationId: row.generation_id, accountId: row.account, title: row.title,
    description: row.description, coverUrl: row.mode === 'mock' ? generationResult(row.generation_id, row.created).coverUrl : row.cover, ai: Boolean(row.ai), planned: row.planned,
    zone: row.zone, status: row.status, created: row.created, submitted: row.submitted, updated: row.updated,
    sourceTaskId: row.source_id, materialId: row.material_id, error: row.error, mode: row.mode,
    account: row.account_snapshot ? JSON.parse(row.account_snapshot) : null,
    ...(awaitingReview ? {
      automationRunId: database.prepare('SELECT id FROM automation_run WHERE publication_id=? AND mode=?').get(row.id, row.mode)?.id
    } : {})
  };
}

function generationParameters(body, catalog) {
  return videoParameters(body, catalog, true);
}

function mockCredits(body) { return mockVideoCredits(body); }

function timezone(value) {
  const zone = validateText(value, 80, '时区');
  try { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
  catch { fail(400, '请选择有效的时区。'); }
}

async function createPublication(body, mode, { beforeInsert, awaitingReview = false } = {}) {
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
  if (awaitingReview && planned === null || planned !== null && (!Number.isSafeInteger(planned) || !awaitingReview && planned <= now)) fail(400, '请选择有效的预约时间。');
  if (live && generation.state !== 'completed' || generation.expires !== null && generation.expires <= Math.max(planned ?? now, now)) {
    fail(400, '这个视频在所选时间无法使用，请调整预约时间或更换视频。');
  }
  beforeInsert?.();
  database.prepare(`INSERT INTO publication
    (id, generation_id, account, title, description, cover, ai, planned, zone, status, created, updated, mode, scope, video_scope, account_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, generationId, account.id, title, description, cover, ai,
    planned, zone, awaitingReview ? 'awaiting_review' : planned === null ? 'queued' : 'scheduled', now, now, mode, connection.scope ?? null,
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
    return files.map(file => ({ type: mediaTypes[extname(file.name).toLowerCase()][0], url: signedLocalMedia(file, origin, directory, access.basePath) }));
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
let imageModelCache;

async function liveModels(connection = configuration('video')) {
  if (modelCache?.scope === connection.scope && modelCache.until > Date.now()) return modelCache.list;
  const list = await videoClient(connection).models();
  modelCache = { scope: connection.scope, list, until: Date.now() + 60_000 };
  return list;
}

async function liveImageModels(connection = configuration('video')) {
  if (imageModelCache?.scope === connection.scope && imageModelCache.until > Date.now()) return imageModelCache.list;
  const list = await imageClient(connection).models();
  imageModelCache = { scope: connection.scope, list, until: Date.now() + 60_000 };
  return list;
}

const imageJobs = createImageJobs(database, {
  connection: () => configuration('video'), models: liveImageModels,
  async prepareFiles(ids, model, mask = false) {
    for (const id of ids) {
      const file = await getUpload(id);
      const extension = extname(file.name).toLowerCase().slice(1);
      const format = extension === 'jpg' ? 'jpeg' : extension;
      if (!['png', 'jpeg', 'webp'].includes(format) || mask && format !== 'png' ||
          model.capabilities.input_formats?.length && !model.capabilities.input_formats.includes(format)) fail(400, mask ? '蒙版请使用带透明区域的 PNG 图片。' : '参考图片请使用模型支持的 PNG、JPEG 或 WebP 文件。');
      if (file.size > (model.capabilities.image_max_mb ?? 50) * 1024 * 1024) fail(400, '参考图片超过所选模型的文件大小限制。');
      await previewImageType(file.path, file.name);
    }
    return attachmentReferences(ids);
  }
});

async function bootstrap(mode) {
  const settings = Object.fromEntries(Object.keys(groups).map(name => [name, settingView(name)]));
  settings.storage = storageView();
  if (mode === 'mock') return { mode, version: appVersion, agent: {enabled:true,semantic:false}, accounts: accountTags.enrich(tagScope(mode), accounts), accountTags: accountTags.snapshot(tagScope(mode)), models, imageModels, settings, issues: {} };
  const [social, video, image] = await Promise.allSettled([queryAccounts(mode), liveModels(), liveImageModels()]);
  const found = social.status === 'fulfilled' ? social.value.accounts : [];
  const catalog = video.status === 'fulfilled' ? video.value : [];
  return {
    mode, version: appVersion, agent: {enabled:true,semantic:true}, accounts: found, accountTags: settings.social.appId ? accountTags.snapshot(tagScope(mode)) : { scope: '', tags: [], assignments: {}, revisions: {} }, models: catalog, imageModels: image.status === 'fulfilled' ? image.value : [], settings,
    issues: {
      social: social.status === 'rejected' ? social.reason.message : social.value.limited ? '当前已加载前 500 个账号，可在 Agent 按账号 ID 或平台查询。' : '',
      video: video.status === 'rejected' ? video.reason.message : catalog.length ? '' : '已连接生成服务，请在 Smart BIAI 开通视频模型。',
      image: image.status === 'rejected' ? image.reason.message : image.value.length ? '' : '当前应用尚无可用的生图模型，请在 Smart BIAI 开通图片模型。',
      ai: settings.ai.ready ? '' : '请在连接设置填写 DeepSeek 或豆包的模型 ID 和 API Key。'
    }
  };
}

async function agent(body, mode) {
  if (body.protocol === agentProtocol) return conversationAgent(body, mode);
  if(body.protocol)fail(400,'Agent 协议版本不受支持，请刷新工作台。');
  const message = validateText(body.message, 2000, '消息');
  const fileIds = body.fileIds ?? [];
  if (!Array.isArray(fileIds) || fileIds.length > 9) fail(400, '每条消息最多添加 9 个文件。');
  const attachments = fileIds.map(id => {
    validId(id);
    const file = database.prepare('SELECT name FROM uploaded_file WHERE id = ?').get(id);
    if (!file) fail(404, '找不到参考附件，请重新上传。');
    return { type: mediaTypes[extname(file.name).toLowerCase()][0] };
  });
  if (mode === 'mock') return interpret(message);
  const history = Array.isArray(body.history) ? body.history.slice(-5).filter(item => typeof item === 'string').map(item => item.slice(0, 1000)) : [];
  const intent = await understand(configuration('ai'), message, history, false, { attachments });
  let found = [];
  let accountError;
  let limited;
  if (intent.query || intent.publish && (intent.accountId || intent.keyword || intent.platform || intent.country)) {
    try {
      const result = await queryAccounts(mode, {
        id: intent.accountId, keyword: intent.keyword, platform: intent.platform, country: intent.country
      });
      found = result.accounts;
      limited = result.limited;
    } catch (error) { accountError = error.message; }
  }
  return { ...intent, accounts: found, targetId: found.length === 1 && found[0].canPublish ? found[0].id : '', accountError, limited };
}

const agentTurns = new Map();
function currentAgentUpdates(updates,mode){
  const current={...updates};
  for(const [name,read] of [['images',id=>imageJobs.get(id,mode)],['generations',id=>generationView(getGeneration.get(id),mode)],['publications',id=>{const row=getPublication.get(id);if(row?.mode!==mode)fail(404,'记录不存在');return publicationView(row);}]] )
    current[name]=(updates?.[name]||[]).flatMap(item=>{try{return [read(item.id)];}catch{return [];}});
  return current;
}
async function conversationAgent(body, mode) {
  const id=validId(body.turnId), conversationId=validId(body.conversationId), message=validateText(body.message,2000,'消息');
  const fileIds=body.fileIds ?? [];
  if(!Array.isArray(fileIds)||fileIds.length>9)fail(400,'请检查本条消息的附件。');
  fileIds.forEach(validId);
  if(!Number.isSafeInteger(body.revision)||body.revision<1)fail(400,'请先保存对话。');
  const fingerprint=createHash('sha256').update(JSON.stringify({mode,conversationId,message,fileIds,command:body.command||null})).digest('hex');
  const previous=database.prepare('SELECT * FROM agent_turn WHERE id=?').get(id);
  const readConversation=()=>conversationView(database.prepare('SELECT * FROM conversation WHERE mode=? AND id=?').get(mode,conversationId));
  if(previous){
    if(previous.fingerprint!==fingerprint)fail(409,'该轮编号已用于另一项请求。');
    const data=JSON.parse(previous.data);
    return {protocol:agentProtocol,conversation:readConversation(),updates:currentAgentUpdates(data.updates,mode),turnId:id};
  }
  if(agentTurns.has(id)){
    const pending=agentTurns.get(id);
    if(pending.fingerprint!==fingerprint)fail(409,'该轮编号已用于另一项请求。');
    return pending.promise;
  }
  const work=async()=>{
    const snapshot=readConversation();
    if(snapshot.revision!==body.revision)fail(409,'对话已有更新，请基于最新记录重新操作。');
    const last=snapshot.chat.at(-1);
    if(last?.type!=='user'||last.text?.trim()!==message||fileIds.some(fileId=>!last.files?.some(file=>file.id===fileId)))fail(409,'本条消息尚未保存到当前对话，请重新发送。');
    const recent=database.prepare('SELECT data FROM agent_turn WHERE mode=? AND conversation_id=? ORDER BY created DESC LIMIT 3').all(mode,conversationId).map(row=>JSON.parse(row.data));
    const zone=readSetting('preferences').zone||'Asia/Shanghai';
    const accountQuery=filters=>queryAccounts(mode,filters);
    let automationDraft = latestAutomationDraft(snapshot.chat);
    const resource=async(kind,targetId,refresh=false)=>{
      validId(targetId);
      let result;
      if(kind==='image')result=refresh?await imageJobs.refresh(targetId,mode):imageJobs.get(targetId,mode);
      else if(kind==='video'){
        let row=getGeneration.get(targetId);
        generationView(row,mode);
        if(refresh&&mode==='live'&&row.source_id)row=await liveJobs.refreshVideo(row);
        result=generationView(row,mode);
      } else {
        const row=getPublication.get(targetId);
        if(!row||row.mode!==mode)fail(404,'未找到当前模式中的发布任务。');
        if(refresh&&mode==='live'&&row.source_id){
          // The existing scheduler queries confirmed publishing jobs. This tool never resubmits them.
          result=publicationView(row);
        }else result=publicationView(row);
      }
      const lineage=database.prepare('SELECT source FROM agent_lineage WHERE mode=? AND id=?').get(mode,targetId);
      return {...result,...(lineage?.source?{source:JSON.parse(lineage.source)}:{})};
    };
    const result=await runConversationAgent({conversation:snapshot,message,fileIds,mode,zone,memory:recent[0]?.memory||'',
      recentActions:recent.flatMap(turn=>(turn.observations||[]).map(step=>({tool:step.tool,ok:step.ok,error:step.error,target:step.result?.target,status:step.result?.status,credits:step.result?.credits})))}, {
      plan:body.command||mode==='mock'?mockAgentPlanner(message,body.command):state=>planAgent(configuration('ai'),state),
      uuid:randomUUID,
      models:kind=>mode==='mock'?(kind==='image'?imageModels:models):kind==='image'?liveImageModels():liveModels(),
      task:resource,
      list:kind=>kind==='image'?imageJobs.list(mode):kind==='video'?database.prepare('SELECT * FROM generation WHERE mode=? ORDER BY created DESC').all(mode).map(row=>generationView(row,mode)):database.prepare('SELECT * FROM publication WHERE mode=? ORDER BY created DESC').all(mode).map(publicationView),
      file:async fileId=>{const file=await getUpload(fileId);return {id:file.id,name:file.name,size:file.size,type:mediaTypes[extname(file.name).toLowerCase()][0]};},
      accounts:accountQuery,
      accountTags:async()=>accountTags.snapshot(tagScope(mode)).tags,
      automationDraft: () => automationDraft,
      automation: async (tool, args) => {
        const result = await automationAgentCard(mode, tool, args, automationDraft, zone);
        if (result.card.kind === 'draft') automationDraft = result.card;
        return result;
      },
      quote:(kind,parameters)=>kind==='image'?imageJobs.quote(parameters,mode):estimate(parameters,mode),
      outputUrl:url=>mode==='mock'?new URL(url,'https://demo.invalid/').href:url
    });
    database.exec('BEGIN IMMEDIATE');
    try{
      for(const changedId of result.changedIds){
        if(getGeneration.get(changedId)||getPublication.get(changedId)||database.prepare('SELECT id FROM image_generation WHERE id=?').get(changedId))fail(409,'该草稿已在其他页面确认，请先刷新当前对话。');
        const draft=result.drafts.find(item=>item.id===changedId);
        if(!draft.generationId&&draft.credits==null){database.prepare('DELETE FROM image_quote WHERE id=?').run(changedId);database.prepare('DELETE FROM video_quote WHERE id=?').run(changedId);}
        database.prepare('INSERT OR REPLACE INTO agent_lineage VALUES(?,?,?,?,?)').run(mode,changedId,conversationId,draft.source?JSON.stringify(draft.source):null,Date.now());
      }
      const committed=new Map();
      for(const draft of result.drafts){
        if(getGeneration.get(draft.id)?.mode===mode)committed.set(draft.id,'result');
        else if(getPublication.get(draft.id)?.mode===mode)committed.set(draft.id,'confirmed');
        else if(database.prepare('SELECT mode FROM image_generation WHERE id=?').get(draft.id)?.mode===mode)committed.set(draft.id,'image-result');
      }
      saveConversation(mode,conversationId,{revision:snapshot.revision,chat:result.chat.map(entry=>committed.has(entry.id)&&['generation','image-generation','publication'].includes(entry.type)?{...entry,type:committed.get(entry.id)}:entry),drafts:result.drafts.filter(draft=>!committed.has(draft.id))});
      const observations=result.observations.map(step=>({tool:step.tool,ok:step.ok,error:step.error,result:step.result?{
        target:step.result.target,id:step.result.id,status:step.result.status,credits:step.result.credits,total:step.result.total,
        model:step.result.parameters?.model,n:step.result.parameters?.n,requiresConfirmation:step.result.requiresConfirmation,
        adjustments:step.result.adjustments,quoteError:step.result.quoteError
      }:undefined}));
      const replayUpdates={...result.updates};
      for(const group of ['images','generations','publications'])replayUpdates[group]=(result.updates[group]||[]).map(item=>({id:item.id}));
      database.prepare('INSERT INTO agent_turn VALUES(?,?,?,?,?,?)').run(id,mode,conversationId,fingerprint,JSON.stringify({memory:result.memory,observations,notes:result.notes,updates:replayUpdates}),Date.now());
      database.exec('COMMIT');
    }catch(error){database.exec('ROLLBACK');throw error;}
    return {protocol:agentProtocol,conversation:readConversation(),updates:result.updates,turnId:id};
  };
  const promise=work();agentTurns.set(id,{fingerprint,promise});
  try{return await promise;}finally{agentTurns.delete(id);}
}

async function estimate(body, mode) {
  if (mode === 'mock') return { parameters: generationParameters(body, models, false), credits: mockCredits(body) };
  const id = validId(body.id);
  if (getGeneration.get(id)) fail(409, '该草稿已有生成任务，请查看视频生成任务。');
  const connection = configuration('video');
  const catalog = await liveModels(connection);
  if (!catalog.length) fail(422, '当前应用没有可用的视频模型，请在 Smart BIAI 开通视频模型。');
  const parameters = generationParameters(body, catalog, true);
  const model = catalog.find(item => item.id === parameters.model);
  const payload = { prompt: parameters.prompt, model: parameters.model, aspect_ratio: parameters.ratio, resolution: parameters.resolution, duration: parameters.duration };
  if (model.audio) payload.generate_audio = parameters.audio;
  if (model.lastFrame) payload.return_last_frame = true;
  const references = [...parameters.references, ...await attachmentReferences(parameters.fileIds)];
  validateVideoReferences(references, model, parameters.ratio);
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

const automation = createAutomation(database, {
  connection: mode => {
    if (mode === 'mock') return 'mock';
    const video = configuration('video'), social = configuration('social');
    if (!video.ready || !social.ready) fail(422, '请先配置视频生成和社媒连接。');
    return [video.scope, social.scope];
  },
  parameters: async (video, mode) => {
    if (!video || typeof video !== 'object' || Array.isArray(video)) fail(400, '请填写视频生成参数。');
    const { model, prompt, ratio, resolution, duration, audio } = video;
    return videoParameters({ model, prompt, ratio, resolution, duration, audio }, mode === 'mock' ? models : await liveModels(), mode === 'live');
  },
  account: async (mode, id) => {
    const account = mode === 'mock' ? accounts.find(item => item.id === id && item.authStatus === 20)
      : (await socialClient(configuration('social')).accounts({ id })).accounts.find(item => item.id === id && item.canPublish);
    if (!account) fail(422, '目标账号当前无法发布，请检查授权和服务有效期。');
    return account;
  },
  video: (id, mode) => {
    const row = getGeneration.get(id);
    return row?.mode === mode ? generationView(row, mode) : null;
  },
  publication: (id, mode) => {
    const row = getPublication.get(id);
    return row?.mode === mode ? publicationView(row) : null;
  },
  reviewPublication: (id, mode, { action, planned, title, description }) => {
    const row = getPublication.get(id);
    if (!row || row.mode !== mode || row.status !== 'awaiting_review') fail(409, '排期已更新，请刷新后重试。');
    if (action === 'approve') {
      const platform = row.account_snapshot ? JSON.parse(row.account_snapshot).platform : accounts.find(account => account.id === row.account)?.platform;
      database.prepare("UPDATE publication SET status='scheduled',planned=?,title=?,description=?,updated=? WHERE id=?")
        .run(planned, title, platform === 'YouTube' ? description : '', Date.now(), id);
    } else {
      database.prepare('UPDATE publication SET status=?,updated=? WHERE id=?')
        .run(action === 'reject' ? 'rejected' : 'canceled', Date.now(), id);
    }
  },
  quote: estimate, generate: createGeneration, publish: createPublication
});

function latestAutomationDraft(chat) {
  const last = chat.findLast(entry => ['draft', 'saved'].includes(entry.automation?.kind))?.automation;
  return last?.kind === 'draft' ? last : null;
}

async function automationAgentCard(mode, tool, args, currentDraft, zone) {
  if (tool === 'list_automations') {
    const keyword = validateText(args.keyword ?? '', 80, '规则名称', false).toLowerCase();
    const data = automation.list(mode, args.ruleId ? validId(args.ruleId) : '');
    const rules = data.rules.filter(rule => !keyword || rule.name.toLowerCase().includes(keyword));
    const ids = new Set(rules.map(rule => rule.id));
    const runs = data.runs.filter(run => ids.has(run.ruleId) && (!args.reviewOnly || run.reviewable));
    return { text: `匹配 ${rules.length} 条规则，最近记录中有 ${runs.length} 次执行。`,
      card: { kind: 'list', rules: rules.slice(0, 12).map(({ id, name, enabled, frequency, policy, nextAt, zone }) => ({ id, name, enabled, frequency, policy, nextAt, zone })),
        runs: runs.slice(0, 12).map(({ id, ruleId, name, status, reviewable, scheduledAt, publishAt, error }) => ({ id, ruleId, name, status, reviewable, scheduledAt, publishAt, error })) } };
  }
  const action = args.action;
  if (!['create', 'edit', 'enable', 'pause', 'run', 'review'].includes(action)) fail(400, '请选择支持的规则操作。');
  if (action === 'review') {
    const run = automation.run(mode, validId(args.runId));
    if (!run.reviewable) fail(409, '该任务当前无需审核。');
    return { text: '这条视频已排期并等待人工审核。打开卡片可预览视频、检查文案并确认发布。', card: { kind: 'review', id: run.ruleId, runId: run.id, name: run.name } };
  }
  const rule = action === 'create' ? null : automation.rule(mode, validId(args.ruleId));
  if (action === 'edit' && rule.enabled) fail(409, '请先暂停规则，再准备修改。');
  if (action === 'create') {
    const card = await collectAutomationDraft(args.newDraft === true ? null : currentDraft, args.changes ?? {}, {
      zone, modelCatalog: () => mode === 'mock' ? models : liveModels(),
      findAccount: async id => (await queryAccounts(mode, { id })).accounts[0]
    });
    const text = card.ready ? '规则参数已齐全，请检查并确认草稿。'
      : card.issues.length ? '我已保留本轮参数，草稿中列出了需要调整的内容。'
      : '我已记录当前信息，可以继续在对话中补充。';
    return { text, card };
  }
  if (action === 'edit') {
    return { text: '规则修改草稿已准备，请检查参数后保存。', card: {
      kind: action, id: rule.id, name: rule.name, proposal: automationDraftChanges(args.changes ?? {})
    } };
  }
  return { text: '请打开卡片检查规则，确认后执行此操作。', card: { kind: 'action', action, id: rule.id, name: rule.name } };
}

async function confirmAutomationDraft(mode, body) {
  const conversationId = validId(body.conversationId), id = validId(body.id), version = validId(body.version);
  const read = () => conversationView(database.prepare('SELECT * FROM conversation WHERE mode=? AND id=?').get(mode, conversationId));
  const snapshot = read();
  if (snapshot.chat.some(entry => entry.automation?.kind === 'saved' && entry.automation.id === id && entry.automation.version === version)) {
    return { rule: automation.rule(mode, id), conversation: snapshot };
  }
  const draft = latestAutomationDraft(snapshot.chat);
  if (snapshot.revision !== body.revision || draft?.id !== id || draft.version !== version) fail(409, '任务草稿已有更新，请查看最新卡片。');
  if (!draft.ready) fail(400, '请先在对话中补齐任务参数。');
  const rule = await automation.save(mode, { ...draft.proposal, id: undefined, revision: undefined }, {
    ruleId: id,
    check() {
      if (read().revision !== snapshot.revision) fail(409, '任务草稿已有更新，请查看最新卡片。');
      if (wallTime(draft.proposal.startsAt, draft.proposal.zone) <= Date.now()) fail(400, '首次生成时间已过，请在对话中更新后确认。');
    },
    record(saved) {
      const index = snapshot.chat.findLastIndex(entry => entry.automation?.kind === 'draft' && entry.automation.version === version);
      const chat = [...snapshot.chat];
      chat[index] = { type: 'text', text: '规则已保存。可前往自动化任务确认启用。', automation: { kind: 'saved', id, version, name: saved.name } };
      saveConversation(mode, conversationId, { revision: snapshot.revision, chat, drafts: snapshot.drafts });
    }
  });
  return { rule, conversation: read() };
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
    if (!entry || !['user', 'text', 'generation', 'result', 'image-generation', 'image-result', 'publication', 'confirmed', 'tasks'].includes(entry.type)) fail(400, '无法保存这条对话消息。');
    if (['generation', 'result', 'image-generation', 'image-result', 'publication', 'confirmed'].includes(entry.type)) validId(entry.id);
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
  const title = subject?.replace(/\s+/g, ' ').trim().slice(0, 48) || '图片、视频和发布草稿';
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
    if (path === '/api/automation') return automation.list(mode);
    const automationRule = path.match(/^\/api\/automation\/rules\/([a-f\d-]+)$/i);
    if (automationRule) return automation.list(mode, validId(automationRule[1]));
    const automationRun = path.match(/^\/api\/automation\/runs\/([a-f\d-]+)$/i);
    if (automationRun) return automation.run(mode, validId(automationRun[1]));
    if (path === '/api/conversations') return database.prepare('SELECT id, title, revision, updated FROM conversation WHERE mode = ? ORDER BY updated DESC').all(mode);
    if (conversation) return conversationView(database.prepare('SELECT * FROM conversation WHERE mode = ? AND id = ?').get(mode, validId(conversation[1])));
    if (path === '/api/bootstrap') return bootstrap(mode);
    if (path === '/api/account-tags') return accountTags.snapshot(tagScope(mode));
    if (path === '/api/images') return imageJobs.list(mode);
    if (/^\/api\/images\/[a-f\d-]+$/i.test(path)) return imageJobs.get(path.split('/').at(-1), mode);
    if (path === '/api/generations') return database.prepare('SELECT * FROM generation WHERE mode = ? ORDER BY created DESC').all(mode).map(row => generationView(row, mode));
    if (path.startsWith('/api/generations/')) return generationView(getGeneration.get(path.slice(17)), mode);
    if (path === '/api/publications') return database.prepare('SELECT * FROM publication WHERE mode = ? ORDER BY created DESC').all(mode).map(publicationView);
  }
  if (method === 'POST') {
    const body = await readBody(request, conversation ? 2_000_000 : undefined);
    if (path === '/api/automation/save') return automation.save(mode, { ...body, ...(body.id ? { id: validId(body.id) } : {}) });
    if (path === '/api/automation/confirm-draft') return confirmAutomationDraft(mode, body);
    if (path === '/api/automation/manage') return automation.manage(mode, { ...body, id: validId(body.id) });
    if (path === '/api/automation/review') return automation.review(mode, { ...body, id: validId(body.id) });
    if (path === '/api/account-tags') return accountTags.save(tagWriteScope(mode, body), body);
    if (path === '/api/account-tags/delete') return accountTags.remove(tagWriteScope(mode, body), body);
    if (path === '/api/account-tags/assign') return accountTags.assign(tagWriteScope(mode, body), body);
    if (conversation) return saveConversation(mode, validId(conversation[1]), body);
    if (path === '/api/settings/storage') return configureStorage(body);
    if (path === '/api/agent') return agent(body, mode);
    if (path === '/api/quote') return estimate(body, mode);
    if (path === '/api/images/quote') return imageJobs.quote(body, mode);
    if (path === '/api/images') return imageJobs.create(body, mode);
    const imageRefresh = path.match(/^\/api\/images\/([a-f\d-]+)\/refresh$/i);
    if (imageRefresh) return imageJobs.refresh(imageRefresh[1], mode);
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
      const result = database.prepare("UPDATE publication SET status = 'canceled', updated = ? WHERE id = ? AND status IN ('scheduled','awaiting_review') AND payload IS NULL").run(Date.now(), id);
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
  ['/styles.css', ['styles.css', 'text/css']],
  ['/generation-models.js', ['../generation-models.js', 'text/javascript']],
  ['/account-properties.js', ['account-properties.js', 'text/javascript']],
  ['/account-tag-controls.js', ['account-tag-controls.js', 'text/javascript']],
  ['/automation.js', ['automation.js', 'text/javascript']]
]);
const demoAssets = new Set(['/demo-assets/sample-video.mp4', '/demo-assets/sample-cover.jpg']);
const loginAssets = new Map([
  ['/login', ['login.html', 'text/html']],
  ['/login.js', ['login.js', 'text/javascript']],
  ['/login.css', ['login.css', 'text/css']]
]);
const { port, host } = access;

const server = createServer(async (request, response) => {
  response.setHeader('X-BIAI-Version', appVersion);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; img-src 'self' https: data:; media-src 'self' https:; form-action 'self'");
  try {
    if (!access.validHost(request.headers.host)) fail(403, '访问域名与工作台配置不一致。');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/healthz' && request.method === 'GET') {
      database.prepare('SELECT 1').get();
      response.setHeader('Content-Type', 'application/json');
      response.end('{"status":"ok"}');
      return;
    }
    const path = access.path(url.pathname);
    if (access.basePath && url.pathname === access.basePath && request.method === 'GET') {
      response.writeHead(301, { Location: `${access.basePath}/${url.search}` });
      response.end();
      return;
    }
    if (path === null) fail(404, '找不到这个页面。');
    const shared = path.match(/^\/media\/([a-f\d-]+)(\.[a-z0-9]+)$/);
    if (shared && ['GET', 'HEAD'].includes(request.method)) {
      await sendSharedMedia(request, response, url, shared);
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    const authorized = sessions.authorized(request);
    if (['GET', 'HEAD'].includes(request.method) && loginAssets.has(path)) {
      if (path === '/login' && authorized) {
        response.writeHead(303, { Location: sessions.safeReturn(url.searchParams.get('next')) });
        response.end();
        return;
      }
      const [file, type] = loginAssets.get(path);
      response.setHeader('Content-Type', `${type}; charset=utf-8`);
      response.end(request.method === 'HEAD' ? undefined : readFileSync(new URL(`./web/${file}`, import.meta.url), 'utf8').replaceAll('__BIAI_VERSION__', appVersion));
      return;
    }
    if (request.method === 'POST' && ['/auth/login', '/auth/logout'].includes(path)) {
      if (!request.headers.origin || !access.validOrigin(request.headers.origin)) fail(403, '请求来源无效。');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (path === '/auth/logout') {
        response.setHeader('Set-Cookie', sessions.logout(request));
        response.end(JSON.stringify({ redirect: `${access.basePath}/login` }));
        return;
      }
      const body = await readBody(request, 4096);
      if (!access.requireAuth) { response.end(JSON.stringify({ redirect: `${access.basePath}/` })); return; }
      const result = sessions.login(request, body.username, body.password, body.remember === true);
      response.statusCode = result.status;
      if (result.cookie) response.setHeader('Set-Cookie', result.cookie);
      if (result.retryAfter) response.setHeader('Retry-After', result.retryAfter);
      response.end(JSON.stringify(result.error ? { error: result.error } : { redirect: sessions.safeReturn(body.next) }));
      return;
    }
    if (!authorized) {
      if (path === '/' && ['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(303, { Location: `${access.basePath}/login?next=${encodeURIComponent(`${access.basePath}/${url.search}`)}` });
        response.end();
      } else {
        response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: '登录已过期，请重新登录工作台。' }));
      }
      return;
    }
    if (request.method === 'POST' && !access.validOrigin(request.headers.origin)) fail(403, '请求来源无效。');
    if (['GET', 'HEAD'].includes(request.method) && demoAssets.has(path)) {
      const file = fileURLToPath(new URL(`./web${path}`, import.meta.url));
      return await sendMediaFile(request, response, { path: file, size: (await stat(file)).size }, extname(file), 'inline');
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
      response.setHeader('Cache-Control', 'no-store');
      response.end(readFileSync(new URL(`./web/${file}`, import.meta.url), 'utf8').replaceAll('__BIAI_VERSION__', appVersion));
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
    const result = await api(request, path);
    if (path === '/api/bootstrap') result.access = { required: access.requireAuth, username: access.requireAuth ? access.username : '' };
    response.end(JSON.stringify(result));
  } catch (error) {
    if (response.headersSent || response.destroyed) { response.destroy(); return; }
    response.statusCode = error.status || 500;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: error.status ? error.message : '本地服务暂时无法完成请求。' }));
    if (!error.status) console.error('Workbench request failed:', error.code || error.name);
  }
});

server.listen(port, host, () => console.log(`BIAI Agent · http://${host}:${port}${access.basePath}/`));
setInterval(() => {
  try { advanceJobs(); }
  catch (error) { console.error('Worker update failed:', error.code || error.name); }
  void liveJobs.run().catch(error => console.error('Live Worker update failed:', error.code || error.name));
  void imageJobs.run().catch(error => console.error('Image Worker update failed:', error.code || error.name));
  void automation.tick().catch(error => console.error('Automation Worker update failed:', error.code || error.name));
}, 1000).unref();
