import { randomUUID } from 'node:crypto';
import { wallTime } from './automation.mjs';

const fields = {
  name: [80, '规则名称'], frequency: [10, '执行频率（单次、每天或每周）'], startsAt: [16, '首次生成日期和时刻'],
  publishAt: [5, '发布时间'], zone: [80, '时区'], policy: [10, '发布方式（人工审核或自动发布）'],
  accountId: [19, '已授权的目标账号'], title: [100, '发布标题'], description: [1000, '视频描述']
};
const videoFields = { model: [180, '视频模型'], prompt: [20000, '视频提示词'], ratio: [16, '画幅'], resolution: [20, '清晰度'] };

function validateString(value, max, label) {
  if (typeof value !== 'string' || value.trim().length > max) throw Object.assign(new Error(`请检查${label}。`), { status: 400 });
  return value.trim();
}

export function automationDraftChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw Object.assign(new Error('请提供规则参数。'), { status: 400 });
  const values = {};
  for (const [key, [max, label]] of Object.entries(fields)) {
    if (Object.hasOwn(changes, key)) values[key] = validateString(changes[key], max, label);
  }
  if (Object.hasOwn(changes, 'maxCredits')) {
    if (!Number.isSafeInteger(changes.maxCredits)) throw Object.assign(new Error('请提供整数积分上限。'), { status: 400 });
    values.maxCredits = changes.maxCredits;
  }
  if (changes.video && typeof changes.video === 'object' && !Array.isArray(changes.video)) {
    values.video = {};
    for (const [key, [max, label]] of Object.entries(videoFields)) {
      if (Object.hasOwn(changes.video, key)) values.video[key] = validateString(changes.video[key], max, label);
    }
    if (Number.isInteger(changes.video.duration)) values.video.duration = changes.video.duration;
    if (typeof changes.video.audio === 'boolean') values.video.audio = changes.video.audio;
  }
  return values;
}

export async function collectAutomationDraft(previous, changes, { zone, modelCatalog, findAccount, now = Date.now() }) {
  const patch = automationDraftChanges(changes);
  const answers = { ...previous?.answers, ...patch, video: { ...previous?.answers?.video, ...patch.video } };
  const proposal = { ...answers, zone: answers.zone || zone, video: { audio: false, ...answers.video } };
  const missing = [];
  for (const key of ['name', 'frequency', 'startsAt', 'publishAt', 'policy', 'accountId', 'title']) {
    if (!proposal[key]) missing.push(fields[key][1]);
  }
  for (const key of ['model', 'prompt']) if (!proposal.video[key]) missing.push(videoFields[key][1]);
  if (proposal.maxCredits == null) missing.push('单次生成积分上限');
  const issues = [];
  if (proposal.frequency && !['once', 'daily', 'weekly'].includes(proposal.frequency)) issues.push('请选择单次、每天或每周。');
  if (proposal.policy && !['review', 'auto'].includes(proposal.policy)) issues.push('请选择人工审核或自动发布。');
  if (proposal.maxCredits != null && (proposal.maxCredits < 1 || proposal.maxCredits > 2_000_000_000)) issues.push('单次生成积分上限须为正整数，且不超过 20 亿。');
  let zoneValid = true;
  try { new Intl.DateTimeFormat('en', { timeZone: proposal.zone }); } catch { zoneValid = false; issues.push('请选择有效的时区。'); }
  if (proposal.startsAt && zoneValid) {
    const starts = wallTime(proposal.startsAt, proposal.zone);
    if (starts === null || starts <= now) issues.push('请选择有效且晚于当前的首次生成时间。');
  }
  if (proposal.publishAt && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(proposal.publishAt) || proposal.publishAt === proposal.startsAt?.slice(11))) {
    issues.push('发布时间使用 24 小时制，且需与生成时刻不同。');
  }
  let modelName, accountName;
  if (proposal.video.model) {
    try {
      const models = await modelCatalog();
      const model = models.find(item => item.id === proposal.video.model);
      if (!model) issues.push('所选模型当前不可用，请选择已授权的视频模型。');
      else {
        modelName = model.name;
        const video = proposal.video;
        video.ratio ||= model.ratios.includes('9:16') ? '9:16' : model.ratios[0];
        video.resolution ||= model.resolutions.includes('720p') ? '720p' : model.resolutions[0];
        const durations = model.durations?.length ? model.durations : Array.from({ length: model.max - model.min + 1 }, (_, index) => model.min + index);
        video.duration ??= durations.includes(6) ? 6 : durations[0];
        if (!model.ratios.includes(video.ratio) || !model.resolutions.includes(video.resolution) ||
            !(video.duration === -1 && model.autoDuration) && !durations.includes(video.duration) || video.audio && !model.audio) {
          issues.push('画幅、清晰度、时长或声音设置与所选模型不兼容，请调整参数。');
        }
        if (video.prompt?.length > model.maxPrompt) issues.push('视频提示词超过该模型的长度限制。');
      }
    } catch (error) { issues.push(error.message || '无法读取视频模型，请检查生成服务连接。'); }
  }
  if (proposal.accountId) {
    if (!/^[1-9]\d{0,18}$/.test(proposal.accountId)) issues.push('请选择明确的已授权账号。');
    else {
      try {
        const account = await findAccount(proposal.accountId);
        if (account?.authStatus !== 20 || account.canPublish === false) issues.push('所选账号当前无法发布，请更换已授权账号。');
        else accountName = `${account.platform} · ${account.name}`;
      } catch (error) { issues.push(error.message || '无法核对目标账号，请检查社媒连接。'); }
    }
  }
  return { kind: 'draft', id: previous?.id || randomUUID(), version: randomUUID(), answers, proposal,
    modelName, accountName, missing, issues, ready: !missing.length && !issues.length };
}
