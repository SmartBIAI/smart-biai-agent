import { accounts, models, interpret, generationResult } from './mock.js';

const generationDelay = 1800;
const publicationDelay = 3800;
const lateWindow = 15 * 60 * 1000;

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

function estimate(body) {
  const model = models.find(item => item.id === body.model);
  if (!model || !model.ratios.includes(body.ratio) || !model.resolutions.includes(body.resolution) ||
      !Number.isInteger(body.duration) || body.duration < model.min || body.duration > model.max) fail(400, '请选择模型支持的视频参数。');
  const prompt = body.prompt?.trim();
  const lite = model.name.endsWith('Lite');
  if (!prompt || prompt.length < (lite ? 10 : 1) || prompt.length > (lite ? 2000 : 20000)) fail(400, '请检查视频提示词的长度。');
  return {
    parameters: { model: model.id, prompt, ratio: body.ratio, resolution: body.resolution, duration: body.duration, audio: Boolean(body.audio) },
    credits: body.duration * (body.resolution === '720p' ? 6 : 4)
  };
}

export function createDemoRequest({ storage, key, sampleVideo, sampleCover, now = Date.now }) {
  return async (path, body) => {
    const data = JSON.parse(storage.getItem(key) || '{"generations":[],"publications":[],"conversations":[]}');
    const time = now();
    let changed = false;
    const save = result => { storage.setItem(key, JSON.stringify(data)); return result; };
    const reply = result => changed ? save(result) : result;
    for (const video of data.generations) {
      if (video.status === 'generating' && time >= video.created + generationDelay) {
        Object.assign(video, generationResult(video.id, video.created + generationDelay), { status: 'completed' });
        if (sampleVideo) Object.assign(video, { url: sampleVideo, coverUrl: sampleCover || null });
        changed = true;
      }
      if (video.status === 'completed' && time >= video.expiresAt) {
        Object.assign(video, { status: 'expired', url: null, coverUrl: null });
        changed = true;
      }
    }
    for (const task of data.publications) {
      if (task.status === 'queued' || task.status === 'scheduled' && time >= task.planned) {
        const video = data.generations.find(item => item.id === task.generationId);
        const status = task.planned && time - task.planned > lateWindow ? 'missed' : video?.status !== 'completed' ? 'expired' : 'publishing';
        Object.assign(task, { status, updated: time, ...(status === 'publishing' ? { submitted: time, sourceTaskId: `demo-pub-${task.id}` } : {}) });
        changed = true;
      } else if (task.status === 'publishing' && time >= task.submitted + publicationDelay) {
        Object.assign(task, { status: 'completed', updated: task.submitted + publicationDelay });
        changed = true;
      }
    }

    if (path === 'bootstrap') return reply({ mode: 'mock', accounts, models, settings: { preferences: {} }, issues: {} });
    if (path === 'agent') return reply(interpret(body.message.trim()));
    if (path === 'quote') return reply(estimate(body));
    if (path === 'generations') {
      if (!body) return reply(data.generations);
      const quote = estimate(body);
      if (quote.credits !== body.credits) fail(409, '请重新获取报价。');
      const existing = data.generations.find(item => item.id === body.id);
      if (existing) return reply(existing);
      const video = { ...quote, id: body.id, mode: 'mock', created: time, status: 'generating' };
      data.generations.unshift(video);
      return save(video);
    }

    if (path === 'publications') {
      if (!body) return reply(data.publications);
      const existing = data.publications.find(task => task.id === body.id);
      if (existing) return reply(existing);
      const account = accounts.find(item => item.id === body.accountId && item.authStatus === 20);
      const video = data.generations.find(item => item.id === body.generationId && item.status === 'completed');
      if (!account || !video || !body.title?.trim()) fail(400, '请检查发布账号、视频和标题。');
      if (body.planned != null && body.planned <= time) fail(400, '请选择晚于现在的预约时间。');
      if (body.planned && body.planned >= video.expiresAt) fail(400, '视频在预约时间已过期，请调整时间。');
      const task = {
        id: body.id, mode: 'mock', generationId: video.id, accountId: account.id, title: body.title.trim(),
        coverUrl: video.coverUrl, planned: body.planned, zone: body.zone, status: body.planned ? 'scheduled' : 'queued', created: time, updated: time
      };
      data.publications.unshift(task);
      return save(task);
    }
    const cancel = path.match(/^publications\/([^/]+)\/cancel$/);
    if (cancel) {
      const task = data.publications.find(item => item.id === cancel[1]);
      if (task?.status !== 'scheduled') fail(409, '这条任务的预约无法取消。');
      Object.assign(task, { status: 'canceled', updated: time });
      return save(task);
    }

    const summaries = data.conversations.map(({ chat, drafts, ...summary }) => summary);
    if (path === 'conversations') return reply(summaries);
    const route = path.match(/^conversations\/([^/]+)$/);
    if (route) {
      const id = route[1];
      const existing = data.conversations.find(item => item.id === id);
      if (!body) {
        if (!existing) fail(404, '找不到这段对话。');
        return reply(existing);
      }
      if ((existing?.revision ?? 0) !== body.revision) fail(409, '这段对话已在另一个页面更新。');
      const title = body.chat.find(entry => entry.type === 'user' && entry.text)?.text.slice(0, 48) || '视频和发布草稿';
      const summary = { id, title, updated: time, revision: body.revision + 1 };
      data.conversations = [{ ...summary, chat: body.chat, drafts: body.drafts }, ...data.conversations.filter(item => item.id !== id)];
      return save(summary);
    }
    fail(404, '公开体验仅支持模拟操作。');
  };
}
