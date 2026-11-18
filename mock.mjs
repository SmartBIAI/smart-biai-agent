import { models, imageModels, normalizeGenerationIntent } from './generation-models.js';
export { models, imageModels };

export const accounts = [
  { id: '101', platform: 'TikTok', name: '品牌主号', alias: 'Brand Main', country: '美国', authStatus: 20, authorization: '已授权', expiry: '2028-01-14' },
  { id: '102', platform: 'YouTube', name: '品牌视频频道', alias: 'Brand Studio', country: '美国', authStatus: 20, authorization: '已授权', expiry: '2028-03-20' },
  { id: '103', platform: 'Instagram', name: '品牌生活馆', alias: 'Brand Life', country: '英国', authStatus: 40, authorization: '授权异常', expiry: null }
];

export function generationResult(id, completedAt) {
  return {
    sourceTaskId: `mock-gen-${id}`,
    url: './demo-assets/sample-video.mp4',
    coverUrl: './demo-assets/sample-cover.jpg',
    expiresAt: completedAt + 7 * 24 * 60 * 60 * 1000
  };
}

export function interpret(message) {
  const platform = accounts.find(account => message.toLowerCase().includes(account.platform.toLowerCase()))?.platform;
  const account = accounts.find(item => message.includes(item.name) || message.toLowerCase().includes(item.alias.toLowerCase()));
  const country = ['美国', '英国'].find(value => message.includes(value));
  const id = message.match(/(?:ID\s*[:：]?\s*|账号\s*)(\d+)/i)?.[1];
  const imageQuery = /(?:查看|查询|打开).*(?:图片|生图|图像|海报)/.test(message);
  const generateImage = !imageQuery && /生图|画一|画张|画个|(?:生成|做一|创作|制作|设计).*(?:图片|图像|海报|插画|封面|张图)/.test(message) && !/图生视频/.test(message);
  const generate = !imageQuery && /生成|做一|创作|制作|文生视频|图生视频/.test(message) && (!generateImage || /(?:生成|制作|做一).*视频/.test(message));
  const selectedModel = [...models, ...imageModels].filter(model => message.toLowerCase().includes(model.id.toLowerCase()) || message.toLowerCase().replaceAll(' ', '').includes(model.name.toLowerCase().replaceAll(' ', ''))).sort((a, b) => b.name.length - a.name.length)[0];
  const publish = /发布|发到|发给|排期|定时|安排.*发/.test(message);
  const taskQuery = /(?:查询|查看|跟踪).*(?:任务|发布状态)|发布进度|发成功了吗/.test(message) && !generate;
  const query = !taskQuery && (/查|列出|有哪些|几个|账号列表/.test(message) || /账号信息|我的账号|账号状态/.test(message));
  const matches = accounts.filter(item => (!platform || item.platform === platform) &&
    (!country || item.country === country) && (!account || item.id === account.id) && (!id || item.id === id));
  const target = account || ((platform || country || id) && matches.length === 1 ? matches[0] : null);
  const requiresSchedule = /定时|排期|明早|明天|后天|下周|今天|上午|下午|晚上|\d{1,2}[:：]\d{2}|\d{1,2}点/.test(message);
  const title = message.match(/(?:标题(?:为|是)?[：:\s]+|标题[「“])([^」”\n，。]+)/)?.[1]?.trim();
  const count = message.match(/([1-8一二两三四五六七八])\s*张/)?.[1];
  const n = Number(count) || ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 }[count]) || 1;
  return normalizeGenerationIntent(message, {
    generate, generateImage, imageQuery, model: selectedModel?.id || '', n,
    publish, query: !imageQuery && query, taskQuery, targetId: target?.id ?? '', requiresSchedule, title,
    accounts: query ? matches : [],
    ratio: /横屏|16:9/.test(message) ? '16:9' : /方形|1:1/.test(message) ? '1:1' : '9:16',
    duration: /自动时长/.test(message) ? -1 : Number(message.match(/(\d{1,2})\s*秒/)?.[1]) || 6
  });
}
