export const accounts = [
  { id: '101', platform: 'TikTok', name: '品牌主号', alias: 'Brand Main', country: '美国', authStatus: 20, authorization: '已授权', expiry: '2028-01-14' },
  { id: '102', platform: 'YouTube', name: '品牌视频频道', alias: 'Brand Studio', country: '美国', authStatus: 20, authorization: '已授权', expiry: '2028-03-20' },
  { id: '103', platform: 'Instagram', name: '品牌生活馆', alias: 'Brand Life', country: '英国', authStatus: 40, authorization: '授权异常', expiry: null }
];

export const models = [
  { id: 'smartbiai-sd-2-0-mini-260619', name: 'Seedance 2.0 Mini', min: 4, max: 15, ratios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9', 'adaptive'], resolutions: ['480p', '720p'] },
  { id: 'smartbiai-sd-2-0-lite-260722', name: 'Seedance 2.0 Lite', min: 5, max: 15, ratios: ['9:16'], resolutions: ['720p'] }
];

const sampleRoot = 'https://storage.googleapis.com/gtv-videos-bucket/sample';

export function generationResult(id, completedAt) {
  return {
    sourceTaskId: `mock-gen-${id}`,
    url: `${sampleRoot}/ForBiggerJoyrides.mp4`,
    coverUrl: `${sampleRoot}/images/ForBiggerJoyrides.jpg`,
    expiresAt: completedAt + 7 * 24 * 60 * 60 * 1000
  };
}

export function interpret(message) {
  const platform = accounts.find(account => message.toLowerCase().includes(account.platform.toLowerCase()))?.platform;
  const account = accounts.find(item => message.includes(item.name) || message.toLowerCase().includes(item.alias.toLowerCase()));
  const country = ['美国', '英国'].find(value => message.includes(value));
  const id = message.match(/(?:ID\s*[:：]?\s*|账号\s*)(\d+)/i)?.[1];
  const generate = /生成|做一|创作|制作|文生视频/.test(message);
  const publish = /发布|发到|发给|排期|定时|安排.*发/.test(message);
  const taskQuery = /(?:查询|查看|跟踪).*(?:任务|发布状态)|发布进度|发成功了吗/.test(message) && !generate;
  const query = !taskQuery && (/查|列出|有哪些|几个|账号列表/.test(message) || /账号信息|我的账号|账号状态/.test(message));
  const matches = accounts.filter(item => (!platform || item.platform === platform) &&
    (!country || item.country === country) && (!account || item.id === account.id) && (!id || item.id === id));
  const target = account || ((platform || country || id) && matches.length === 1 ? matches[0] : null);
  const requiresSchedule = /定时|排期|明早|明天|后天|下周|今天|上午|下午|晚上|\d{1,2}[:：]\d{2}|\d{1,2}点/.test(message);
  const title = message.match(/(?:标题(?:为|是)?[：:\s]+|标题[「“])([^」”\n，。]+)/)?.[1]?.trim();
  return {
    generate, publish, query, taskQuery, targetId: target?.id ?? '', requiresSchedule, title,
    accounts: query ? matches : [],
    ratio: /横屏|16:9/.test(message) ? '16:9' : /方形|1:1/.test(message) ? '1:1' : '9:16',
    duration: Number(message.match(/(\d{1,2})\s*秒/)?.[1]) || 6
  };
}
