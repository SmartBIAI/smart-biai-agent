import { normalizeGenerationIntent } from './generation-models.js';

const icons = {
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m3 17 5-5 4 4 3-3 6 6"/>',
  audio: '<path d="M3 12h2m3-4v8m4-12v16m4-12v8m3-4h2"/>',
  agent: '<path d="M8 10h8m-8 4h5M6 20l3-3h8a4 4 0 0 0 4-4V8a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v5a4 4 0 0 0 3 4z"/>',
  accounts: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2"/>',
  tasks: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4m8-4v4M3 10h18m-13 5h3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M10 3h4l1 3 3 1 3 3v4l-3 3-3 1-1 3h-4l-1-3-3-1-3-3v-4l3-3 3-1z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  send: '<path d="M4 4l17 8-17 8 3-8-3-8zm3 8h14"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 5-3v10l-5-3"/>',
  play: '<path d="m9 5 11 7-11 7z"/>',
  plus: '<path d="M12 5v14m-7-7h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  link: '<path d="M13 11a3 3 0 0 0-4.5 0l-3 3a3 3 0 1 0 4 4l1.5-1.5m0-3a3 3 0 0 0 4.5 0l3-3a3 3 0 1 0-4-4L13 8"/>'
};

const icon = (name, size = 19) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" stroke-linecap="round">${icons[name]}</svg>`;
const appPath = new URL('.', import.meta.url).pathname;
const conversationKey = appPath === '/' ? 'biai' : `biai:${appPath}`;
const pages = { agent: 'BIAI Agent', accounts: '社媒账号', tasks: '发布任务', settings: '连接设置' };
const main = document.querySelector('#main');
const navigation = document.querySelector('#navigation');
const videoDialog = document.querySelector('#video-dialog');
const imageDialog = document.querySelector('#image-dialog');
const zoneLabels = {
  'Asia/Shanghai': '上海', 'Asia/Tokyo': '东京', 'America/New_York': '纽约',
  'America/Los_Angeles': '洛杉矶', 'Europe/London': '伦敦', UTC: 'UTC'
};
const pubStatuses = {
  queued: ['等待发布', 'purple'], scheduled: ['已排期', 'purple'], publishing: ['发布中', 'blue'],
  completed: ['发布完成', 'green'], expired: ['素材已过期', 'red'], missed: ['已错过', 'red'], canceled: ['已取消', 'gray'],
  submitting: ['正在发送', 'blue'], queued_upstream: ['平台处理中', 'blue'], failed: ['发布失败', 'red'], unknown: ['状态待确认', 'orange']
};

const state = {
  page: '', accounts: [], models: [], imageModels: [], settings: {}, generations: [], images: [], publications: [],
  chat: [], drafts: new Map(), intentBusy: false, agentPending: false, formBusy: 0, uploadBusy: false, attachments: [], accountId: '', accountFilter: '', accountSearch: '',
  accountCountry: '', accountRows: 20, workRows: 20, worksAccountId: '',
  taskTab: 'all', taskId: '', taskSearch: '', taskAccount: '', taskRows: 20, loaded: false,
  mode: sessionStorage.getItem(`${conversationKey}-mode`) === 'live' ? 'live' : 'mock', issues: {},
  history: [], conversation: null, historyBusy: false
};
const modeSelect = document.querySelector('#run-mode');
let conversationDirty = false;
let conversationTimer;
let conversationSave = Promise.resolve(true);
const agentControls = new Map();

function setAgentPending(pending) {
  state.agentPending=pending;
  if(pending){
    for(const control of main.querySelectorAll('[data-form="generation"] input,[data-form="generation"] select,[data-form="generation"] textarea,[data-form="generation"] button,[data-form="image-generation"] input,[data-form="image-generation"] select,[data-form="image-generation"] textarea,[data-form="image-generation"] button,[data-form="publication"] input,[data-form="publication"] select,[data-form="publication"] textarea,[data-form="publication"] button')){
      if(!agentControls.has(control))agentControls.set(control,control.disabled);
      control.disabled=true;
    }
  }else{for(const [control,disabled] of agentControls)control.disabled=disabled;agentControls.clear();}
}

function esc(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function selected(option, value) { return option === value ? ' selected' : ''; }
function findAccount(id) { return state.accounts.find(account => account.id === id); }
function taskAccount(task) { return task.account ?? findAccount(task.accountId); }
function findVideo(id) { return state.generations.find(video => video.id === id); }
function findImage(id) { return state.images.find(image => image.id === id); }
function durationLabel(value) { return value === -1 ? '自动时长' : `${value} 秒`; }
function chooseModel(catalog, hint = '', preferred = '') {
  const normalized = hint.toLowerCase().replaceAll(' ', '');
  return catalog.find(model => normalized && [model.id, model.name].some(value => value.toLowerCase().replaceAll(' ', '') === normalized)) || catalog.find(model => model.id === preferred) || catalog[0];
}
function defaultZone() { return state.settings.preferences?.zone || 'Asia/Shanghai'; }
function mayPublish(account) { return account.authStatus === 20 && account.canPublish !== false; }
function badge(label, color = 'gray') { return `<span class="badge ${color}"><span></span>${esc(label)}</span>`; }
function publicationBadge(status) { return badge(...pubStatuses[status]); }

function dateFormat(timestamp, zone = defaultZone()) {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp);
}

function timeParts(timestamp, zone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  return Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
}

function dateInput(timestamp, zone) {
  const { year, month, day, hour, minute } = timeParts(timestamp, zone);
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function toTimestamp(value, zone) {
  if (!value) throw new Error('请选择预约时间。');
  const baseline = Date.parse(`${value}Z`);
  if (!Number.isFinite(baseline)) throw new Error('请选择有效时间。');
  const offsets = [-86400000, 0, 86400000].map(delta => {
    const sample = baseline + delta;
    return Date.parse(`${dateInput(sample, zone)}Z`) - sample;
  });
  const candidates = [...new Set(offsets)].map(offset => baseline - offset).filter(candidate => dateInput(candidate, zone) === value);
  if (!candidates.length) throw new Error('该时区的这个时间不存在，请选择其他时间。');
  if (candidates.length > 1) throw new Error('此时间遇到夏令时切换，请改选其他时间。');
  return candidates[0];
}

function scheduleSuggestion(message, zone) {
  const explicit = message.match(/(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)/);
  if (explicit) return `${explicit[1]}T${explicit[2]}`;
  const today = dateInput(Date.now(), zone).slice(0, 10);
  const base = Date.parse(`${today}T00:00Z`);
  let day = /后天/.test(message) ? 2 : /明天|明早/.test(message) ? 1 : /今天/.test(message) ? 0 : null;
  const week = message.match(/(下|本)周([一二三四五六日天])/);
  if (week) {
    const currentWeekday = (new Date(base).getUTCDay() + 6) % 7;
    const targetWeekday = '一二三四五六日'.indexOf(week[2] === '天' ? '日' : week[2]);
    day = targetWeekday - currentWeekday + (week[1] === '下' ? 7 : 0);
  }
  const calendar = message.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]/);
  let next = day === null ? '' : new Date(base + day * 86400000).toISOString().slice(0, 10);
  if (calendar) {
    const year = calendar[1] ?? today.slice(0, 4);
    next = `${year}-${calendar[2].padStart(2, '0')}-${calendar[3].padStart(2, '0')}`;
    const timestamp = Date.parse(`${next}T00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== next) return '';
  }
  if (!next) return '';
  const clock = message.match(/(\d{1,2})\s*(?:[:：](\d{2})|点\s*(\d{1,2})?\s*分?)/);
  if (!clock && !/明早/.test(message)) return '';
  let hour = clock ? Number(clock[1]) : 9;
  const minute = clock ? Number(clock[2] ?? clock[3] ?? 0) : 0;
  if (/下午|晚上/.test(message) && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return '';
  return `${next}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function suggestedZone(message) {
  if (/北京时间|中国时间/.test(message)) return 'Asia/Shanghai';
  return Object.entries(zoneLabels).find(([, label]) => message.includes(label))?.[0] || defaultZone();
}

function zoneOptions(value) {
  return Object.entries(zoneLabels).map(([zone, label]) => `<option value="${zone}"${selected(zone, value)}>${label} · ${zone}</option>`).join('');
}

async function request(path, body, mode = state.mode) {
  const headers = { 'X-BIAI-Mode': mode };
  const response = await fetch(`${appPath}api/${path}`, body === undefined ? { headers } : {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (response.status === 401) return loginRequired();
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? '暂时无法完成操作。'), { status: response.status });
  return data;
}

function loginRequired() {
  location.replace(`${appPath}login?next=${encodeURIComponent(`${appPath}${location.search}${location.hash}`)}`);
  throw Object.assign(new Error('登录已过期，请重新登录。'), { status: 401 });
}

let toastTimer;
function notify(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function navigate() {
  const hash = location.hash.slice(1).split('/');
  state.page = Object.hasOwn(pages, hash[0]) ? hash[0] : 'agent';
  if (state.page === 'tasks' && hash[1]) {
    state.taskId = hash[1] === 'images' ? '' : hash[1];
    state.taskTab = hash[1] === 'images' ? 'image' : 'all';
    state.taskAccount = '';
    state.taskSearch = '';
  }
  if (state.page === 'accounts' && findAccount(hash[1])) {
    state.accountId = hash[1];
    state.accountFilter = '';
    state.accountSearch = '';
    state.accountCountry = '';
  }
  navigation.innerHTML = Object.entries(pages).map(([key, label]) => `<a href="#${key}"${key === state.page ? ' aria-current="page"' : ''}>${icon(key)}<span>${label}</span></a>`).join('');
  document.querySelector('#breadcrumb').textContent = pages[state.page];
  if (!state.loaded) return;
  ({ agent: renderAgent, accounts: renderAccounts, tasks: renderTasks, settings: renderSettings })[state.page]();
}

function heading(title, subtitle) {
  return `<div class="page-title"><h1>${title}</h1><p>${subtitle}</p></div>`;
}

const prompts = [
  ['accounts', '查询社媒账号', '查看美国区 TikTok 账号', '查询美国区的 TikTok 账号'],
  ['video', '生成 AI 视频', '从一段描述创建视频', '生成一支 6 秒竖屏的陶瓷马克杯产品视频'],
  ['image', '生成 AI 图片', '创作产品图、海报或封面', '生成一张简洁的陶瓷马克杯产品海报'],
  ['clock', '安排作品发布', '预览文案并选择发布时间', '生成一支 6 秒竖屏的陶瓷马克杯产品视频，明早 9 点发到品牌主号']
];

function renderAgent() {
  main.innerHTML = `<section class="agent-page">
    <div class="agent-header"><div>${heading('BIAI Agent', '查询社媒账号、生成图片与视频，并安排发布。')}</div><div class="agent-actions"><select id="conversation-history" aria-label="历史对话"></select><button class="button quiet" data-action="new-chat">${icon('plus', 17)} 新对话</button></div></div>
    ${state.issues.ai ? `<div class="agent-issue" role="status">${esc(state.issues.ai)} <a href="#settings">连接设置</a></div>` : ''}
    <div class="chat-scroll" id="chat-scroll" aria-live="polite"></div>
    <div class="composer-wrap"><div id="attached"></div><p id="upload-status" class="field-note" role="status" hidden></p>
    <input type="file" id="attachment-files" accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.mp3,.wav" multiple hidden>
    <form id="composer" class="composer">
      <button type="button" data-action="upload" class="icon-button attach" title="上传图片、视频或音频" aria-label="添加文件">${icon('link', 21)}</button>
      <textarea name="message" rows="1" maxlength="2000" aria-label="给 BIAI Agent 发消息" placeholder="${esc(prompts[0][3])}" aria-describedby="composer-tab-hint"></textarea>
      <span id="composer-tab-hint" class="tab-hint">按 <kbd>Tab</kbd> 填入</span>
      <button class="send" aria-label="发送消息" title="发送消息">${icon('send', 20)}</button>
    </form><div class="compose-foot">${state.mode === 'live' ? '真实模式 · 生成和发布需要分别确认。' : '模拟模式 · 可体验生成和发布流程。'}</div></div>
  </section>`;
  renderChat();
  renderAttached();
  renderConversationHistory();
}

function renderConversationHistory() {
  const control = document.querySelector('#conversation-history');
  if (!control) return;
  control.innerHTML = '<option value="" disabled>历史对话</option>' + state.history.map(item =>
    `<option value="${esc(item.id)}">${esc(item.title)} · ${dateFormat(item.updated)}</option>`).join('');
  control.value = state.conversation?.revision ? state.conversation.id : '';
  control.disabled = state.historyBusy || state.history.length === 0;
}

function activateConversation(saved) {
  state.conversation = saved ? { id: saved.id, revision: saved.revision } : { id: crypto.randomUUID(), revision: 0 };
  const storedDrafts = new Map((saved?.drafts ?? []).map(draft => [draft.id, draft]));
  state.chat = (saved?.chat ?? []).map(entry => {
    if (entry.type === 'generation' && findVideo(entry.id)) return { ...entry, type: 'result', intent: storedDrafts.get(entry.id)?.intent };
    if (entry.type === 'image-generation' && findImage(entry.id)) return { ...entry, type: 'image-result' };
    if (entry.type === 'publication' && state.publications.some(item => item.id === entry.id)) return { ...entry, type: 'confirmed' };
    return entry;
  });
  const draftIds = new Set(state.chat.filter(entry => ['generation', 'image-generation', 'publication'].includes(entry.type)).map(entry => entry.id));
  state.drafts = new Map((saved?.drafts ?? []).filter(draft => draftIds.has(draft.id)).map(draft => [draft.id, draft]));
  state.attachments = [];
  sessionStorage.setItem(`${conversationKey}-conversation-${state.mode}`, saved?.id ?? '');
}

function flushConversation() {
  clearTimeout(conversationTimer);
  conversationSave = conversationSave.then(async () => {
    if (state.agentPending || !conversationDirty || !state.chat.length) return true;
    conversationDirty = false;
    const active = state.conversation;
    const mode = state.mode;
    const body = { revision: active.revision, chat: state.chat.map(entry => entry.type === 'confirmed' ? { type: entry.type, id: entry.id } : entry),
      drafts: [...state.drafts.values()] };
    try {
      let saved;
      try {
        saved = await request(`conversations/${active.id}`, body, mode);
      } catch (error) {
        if (error.status !== 409) throw error;
        saved = await request(`conversations/${crypto.randomUUID()}`, { ...body, revision: 0 }, mode);
        notify('这段对话在另一个页面有更新，当前内容已另存为一段对话。');
      }
      Object.assign(active, { id: saved.id, revision: saved.revision });
      sessionStorage.setItem(`${conversationKey}-conversation-${mode}`, saved.id);
      state.history = [saved, ...state.history.filter(item => item.id !== saved.id)];
      renderConversationHistory();
      return true;
    } catch (error) {
      conversationDirty = true;
      notify(`对话暂未保存。${error.message}`);
      return false;
    }
  });
  return conversationSave;
}

function saveChat(defer = false) {
  if (!state.conversation || !state.chat.length) return;
  conversationDirty = true;
  if (defer) {
    clearTimeout(conversationTimer);
    conversationTimer = setTimeout(() => void flushConversation(), 250);
  } else void flushConversation();
}

async function changeConversation(id) {
  if (state.historyBusy || state.intentBusy || state.formBusy || state.uploadBusy) {
    renderConversationHistory();
    notify('请等待当前操作完成后再切换对话。');
    return;
  }
  state.historyBusy = true;
  renderConversationHistory();
  try {
    if (!await flushConversation()) return;
    activateConversation(id ? await request(`conversations/${id}`) : null);
    if (state.page === 'agent') renderAgent();
  } catch (error) { notify(error.message); }
  finally {
    state.historyBusy = false;
    renderConversationHistory();
  }
}

function renderAttached() {
  const box = document.querySelector('#attached');
  if (box) box.innerHTML = attachmentList(state.attachments, true);
}

function attachmentList(files, removable = false) {
  if (!Array.isArray(files) || !files.length) return '';
  return `<div class="attachment-list">${files.map((file, index) => {
    const url = `${appPath}api/files/${encodeURIComponent(file.id)}`;
    const image = /\.(jpg|jpeg|png|webp)$/i.test(file.name);
    const symbol = image ? 'image' : /\.(mp4|mov)$/i.test(file.name) ? 'video' : /\.(mp3|wav)$/i.test(file.name) ? 'audio' : 'link';
    return `<span class="attachment-chip"><a href="${url}" download><span class="attachment-thumb" aria-hidden="true">${icon(symbol, 18)}${image ? `<img src="${url}/preview" alt="" loading="lazy" decoding="async">` : ''}</span><span>${esc(file.name)}</span></a>${removable ? `<button class="icon-button" type="button" data-action="remove-file" data-index="${index}" aria-label="移除 ${esc(file.name)}">${icon('close', 13)}</button>` : ''}</span>`;
  }).join('')}</div>`;
}

function reportUpload(message) {
  const status = document.querySelector('#upload-status');
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
}

async function uploadAttachments(input) {
  const files = Array.from(input.files);
  input.value = '';
  if (!files.length || state.uploadBusy || state.historyBusy || state.intentBusy || state.formBusy) return;
  if (state.attachments.length + files.length > 9) { reportUpload('每条消息最多添加 9 个文件。'); return; }
  state.uploadBusy = true;
  const errors = [];
  try {
    for (const file of files) {
      reportUpload(`正在上传 ${file.name}…`);
      try {
        if (!file.size || file.size > 100 * 1024 * 1024) throw new Error('请选择非空且不超过 100 MB 的文件。');
        const response = await fetch(`${appPath}api/files`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file
        });
        if (response.status === 401) return loginRequired();
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '上传未完成，请重试。');
        state.attachments.push(result);
        renderAttached();
      } catch (error) { errors.push(`${file.name}：${error.message}`); }
    }
    reportUpload(errors.join(' '));
  } finally { state.uploadBusy = false; }
}

function renderChat() {
  const box = document.querySelector('#chat-scroll');
  if (!box) return;
  if (!state.chat.length) {
    box.innerHTML = `<div class="welcome"><div class="agent-symbol">${icon('agent', 30)}</div><h2>今天想做什么？</h2><p>从查找账号到确认发布，在同一个对话里完成。</p><div class="prompt-grid">${prompts.map(([symbol, title, detail, message]) => `<button class="prompt" data-action="prompt" data-message="${esc(message)}"><span class="prompt-icon">${icon(symbol)}</span><strong>${title}</strong><small>${detail}</small>${icon('arrow', 16)}</button>`).join('')}</div>${recentVideos()}</div>`;
    return;
  }
  box.innerHTML = state.chat.map(entry => {
    if (entry.type === 'user') return `<div class="message user"><div class="bubble">${esc(entry.text)}${attachmentList(entry.files)}</div><div class="avatar user-avatar">${icon('accounts', 17)}</div></div>`;
    if (entry.type === 'generation') return assistant(renderGenerationDraft(state.drafts.get(entry.id)));
    if (entry.type === 'result') return assistant(resultCard(entry.id, entry.intent));
    if (entry.type === 'image-generation') return assistant(renderImageDraft(state.drafts.get(entry.id)));
    if (entry.type === 'image-result') return assistant(imageResultCard(entry.id));
    if (entry.type === 'tasks') return assistant(`<p>最近的发布任务</p><div class="account-cards">${entry.ids.map(id => {
      const task = state.publications.find(item => item.id === id);
      return task ? `<a class="account-card" href="#tasks/${id}">${icon('tasks', 17)}<span><strong>${esc(task.title)}</strong><small>${esc(taskAccount(task)?.name)}</small></span>${publicationBadge(task.status)}${icon('arrow', 15)}</a>` : '';
    }).join('')}</div>`);
    if (entry.type === 'publication') return assistant(renderPublicationDraft(state.drafts.get(entry.id)));
    if (entry.type === 'confirmed') {
      const task = state.publications.find(item => item.id === entry.id);
      if (!task) return assistant('<p>这条发布任务暂不可查看。</p>');
      return assistant(`<div class="confirmed"><span class="confirmed-icon">${icon('check')}</span><div><strong>${task.planned ? '已确认排期' : '已确认发布'}</strong><p>${esc(task.title)} · ${esc(taskAccount(task)?.name)}${task.planned ? ` · ${dateFormat(task.planned, task.zone)} ${zoneLabels[task.zone] ?? esc(task.zone)}` : ''}</p></div><a class="button" href="#tasks/${task.id}">查看任务 ${icon('arrow', 15)}</a></div>`);
    }
    return assistant(`<p>${esc(entry.text)}</p>${entry.mediaChoice ? entry.mediaChoice.chosen ? `<p class="field-note">已选择生成${entry.mediaChoice.chosen === 'image' ? '图片' : '视频'}</p>` : `<div class="detail-actions"><button class="button" data-action="choose-media" data-id="${esc(entry.mediaChoice.id)}" data-media-type="image">${icon('image')} 生成图片</button><button class="button" data-action="choose-media" data-id="${esc(entry.mediaChoice.id)}" data-media-type="video">${icon('video')} 生成视频</button></div>` : ''}${renderAgentTargets(entry.targets)}${entry.accounts?.length ? accountCards(entry.accounts) : ''}${entry.videos ? recentVideos(true, entry.intent) : ''}${entry.images ? '<a class="text-button" href="#tasks/images">查看图片记录</a>' : ''}`);
  }).join('') + (state.intentBusy ? assistant('<p class="muted">正在处理你的请求…</p>') : '');
  box.scrollTop = box.scrollHeight;
  if(state.agentPending)setAgentPending(true);
}

function assistant(content) {
  return `<div class="message assistant"><div class="avatar agent-avatar">${icon('agent', 18)}</div><div class="bubble">${content}</div></div>`;
}

function accountCards(accounts) {
  return `<div class="account-cards">${accounts.map(account => `<a class="account-card" href="#accounts/${esc(account.id)}">${platformIcon(account.platform)}<span><strong>${esc(account.name)}</strong><small>${esc(account.platform)} · ${esc(account.country)} · ID ${esc(account.id)}</small></span>${badge(account.authorization, account.authorization === '已授权' ? 'green' : 'orange')}${icon('arrow', 15)}</a>`).join('')}</div>`;
}

function recentVideos(showMany = false, intent = {}) {
  const videos = state.generations.slice(0, showMany ? 5 : 2);
  if (!videos.length) return '';
  return `<div class="recent"><h3>最近生成</h3>${videos.map(video => `<button class="recent-item" data-action="open-video" data-id="${video.id}" data-intent="${esc(JSON.stringify(intent))}">${icon('video', 17)}<span>${esc(video.parameters.prompt.slice(0, 48))}</span>${generationBadge(video)}${icon('arrow', 15)}</button>`).join('')}</div>`;
}

function generationBadge(video) {
  const states = { queued: ['等待生成', 'purple'], submitting: ['正在发送', 'blue'], generating: ['生成中', 'blue'],
    completed: ['生成完成', 'green'], expired: ['素材已过期', 'red'], failed: ['生成失败', 'red'],
    review: ['生成服务正在检查', 'orange'], unknown: ['状态待确认', 'orange'] };
  return badge(...(states[video.status] ?? states.unknown));
}

function modelName(video) {
  return state.models.find(model => model.id === video.parameters.model)?.name ?? video.parameters.model;
}

function imageModelName(task) { return state.imageModels.find(model => model.id === task.parameters.model)?.name ?? task.parameters.model; }
function imageBadge(task) {
  const statuses = { queued: ['等待生成', 'purple'], submitting: ['正在发送', 'blue'], generating: ['生成中', 'blue'],
    completed: ['生成完成', 'green'], partial: ['部分完成', 'orange'], failed: ['生成失败', 'red'], expired: ['图片已过期', 'red'],
    unknown: ['受理结果查询中', 'orange'], review: ['等待服务确认', 'orange'] };
  return badge(...(statuses[task.status] || statuses.generating));
}
function imageFormData(form) {
  const values = new FormData(form);
  const draft = state.drafts.get(form.dataset.id);
  const model = state.imageModels.find(item => item.id === values.get('model'));
  const maskFileId = values.get('maskFileId') || null;
  return { model: values.get('model'), prompt: values.get('prompt'), n: Number(values.get('n')),
    ...(model?.spec === 'ratio' ? { ratio: values.get('ratio'), resolution: values.get('resolution') } : { size: values.get('size'), quality: values.get('quality') }),
    references: draft.links || [], fileIds: (draft.files || []).map(file => file.id).filter(id => id !== maskFileId), maskFileId };
}
function renderImageDraft(draft) {
  if (!draft) return '<p>这份图片草稿暂不可查看。</p>';
  const p = draft.parameters;
  const model = state.imageModels.find(item => item.id === p.model);
  if (!model) return '<p>当前生图模型不可用，请在连接设置检查生成服务。</p>';
  const options = (items, value) => items.map(item => `<option value="${esc(item)}"${selected(item, value)}>${esc(item)}</option>`).join('');
  const localOnly = state.mode === 'live' && draft.files?.length && !state.settings.storage?.ready;
  const specs = model.spec === 'size' ? `<label>图片尺寸<select name="size">${options(model.sizes, p.size)}</select></label><label>质量<select name="quality">${options(model.qualities, p.quality)}</select></label>` :
    `<label>画幅<select name="ratio">${options(model.ratios, p.ratio)}</select></label><label>清晰度<select name="resolution">${options(model.resolutions, p.resolution)}</select></label>`;
  const pngs = (draft.files || []).filter(file => /\.png$/i.test(file.name));
  return `<form class="inner-card image-generation-form" data-form="image-generation" data-id="${draft.id}">
    <div class="card-header"><span class="card-icon">${icon('image')}</span><div><h3>生成图片</h3><p>${state.mode === 'live' ? '先查看积分报价，再确认生成。' : '模拟生成会展示固定示例图片。'}</p></div></div>
    ${draft.notes?.length ? `<p class="field-note">${draft.notes.map(note=>esc(note)).join(' ')}</p>` : ''}
    <label>图片提示词<textarea name="prompt" rows="3" maxlength="${model.maxPrompt}" required>${esc(p.prompt)}</textarea></label>
    <div class="fields generation-fields"><label>生图模型<select name="model">${state.imageModels.map(item => `<option value="${esc(item.id)}"${selected(item.id, p.model)}>${esc(item.name)}</option>`).join('')}</select></label>
    ${specs}<label>生成张数<select name="n">${options(Array.from({ length: model.maxCount }, (_, index) => index + 1), p.n)}</select></label></div>
    ${attachmentList(draft.files)}
    ${pngs.length && model.mask ? `<label>蒙版（选填）<select name="maskFileId"><option value="">所有附件作为参考图</option>${pngs.map(file => `<option value="${file.id}"${selected(file.id, p.maskFileId)}>${esc(file.name)}</option>`).join('')}</select><span class="field-note">蒙版使用透明 PNG，需与第一张参考图同尺寸；透明区域为编辑区域。</span></label>` : ''}
    ${localOnly ? '<p class="field-note">请到连接设置配置本地文件服务器或 OSS，以便读取参考图片。</p>' : ''}
    <div class="card-actions"><span class="quote">${draft.credits == null ? '尚未报价' : `<strong>${esc(draft.credits)}</strong> ${state.mode === 'live' ? '积分上限' : '模拟积分'}`}</span>
    <button type="submit" class="button${draft.credits == null ? '' : ' primary'}"${localOnly ? ' disabled' : ''}>${draft.credits == null ? '获取报价' : '确认生成图片'}</button></div>
    <p class="form-error" role="alert" hidden></p></form>`;
}
function imageResultCard(id) {
  const task = findImage(id);
  if (!task) return '<p>正在读取图片结果…</p>';
  return `<div class="inner-card image-result-card" data-image-result="${id}"><div class="card-header"><span class="card-icon">${icon('image')}</span><div><h3>图片生成结果</h3><p>${esc(imageModelName(task))} · ${task.parameters.n} 张</p></div>${imageBadge(task)}</div>
    <p class="field-note">${esc(task.parameters.prompt.slice(0, 180))}</p>
    ${task.results.length ? `<div class="image-results">${task.results.map((item, index) => `<div class="image-result-item">${item.url ? `<button type="button" class="image-preview-button" data-action="preview-image" data-id="${id}" data-index="${index}" aria-label="预览第 ${index + 1} 张图片"><img src="${esc(item.url)}" alt="${esc(task.parameters.prompt.slice(0, 100))}" loading="lazy"></button>` : `<div class="image-placeholder">${icon('image', 26)}<span>${item.status === 'failed' ? '这张图片未完成' : item.status === 'expired' ? '图片已过期' : '暂无可用链接'}</span></div>`}
    <small>第 ${index + 1} 张${task.mode === 'mock' ? ' · 示例图片' : item.width && item.height ? ` · ${item.width} × ${item.height}` : ''}</small>
    ${item.url ? `<button class="text-button" type="button" data-action="preview-image" data-id="${id}" data-index="${index}">查看大图</button>` : ''}</div>`).join('')}</div>` : ['queued', 'submitting', 'generating', 'unknown', 'review'].includes(task.status) ? '<div class="progress"><i></i></div>' : ''}
    ${task.error ? `<p class="form-error">${esc(task.error)}</p>` : ''}
    ${task.mode === 'live' ? `<div class="card-actions"><span class="muted">${task.chargedCredits ? `已结算 ${esc(task.chargedCredits)} 积分` : ''}${task.refundedCredits ? ` · 已退回 ${esc(task.refundedCredits)} 积分` : ''}</span>${['completed', 'partial', 'expired'].includes(task.status) ? `<button class="button" data-action="refresh-image" data-id="${id}">刷新图片链接</button>` : ''}</div>` : ''}${agentRetryButton('image',id,task.status)}</div>`;
}

function renderImageDialog(id, index) {
  const task = findImage(id);
  const item = task?.results[index];
  if (!item?.url) { notify('当前没有可用的图片链接，请先刷新。'); return; }
  imageDialog.innerHTML = `<div class="detail-title"><h2 id="image-dialog-title">图片预览</h2><form method="dialog"><button class="icon-button" aria-label="关闭图片预览" autofocus>${icon('close')}</button></form></div>
    <p class="field-note">${esc(imageModelName(task))} · 第 ${index + 1} 张${task.mode === 'mock' ? ' · 示例图片' : ''}</p>
    <img class="image-full-preview" src="${esc(item.url)}" alt="${esc(task.parameters.prompt.slice(0, 160))}">
    <div class="card-actions"><a class="button" href="${esc(item.url)}" target="_blank" rel="noreferrer">打开原图 ↗</a></div>`;
  imageDialog.showModal();
}

function videoPreview(video) {
  return `<div class="media-preview"><video controls playsinline preload="metadata" src="${esc(video.url)}"${video.coverUrl ? ` poster="${esc(video.coverUrl)}"` : ''} aria-label="视频预览"></video><div class="media-meta"><span>${video.mode === 'mock' ? '示例视频' : 'Smart BIAI 生成视频'}</span><a href="${esc(video.url)}" rel="noreferrer" target="_blank">打开视频 ↗</a></div><p class="form-error" data-media-error hidden>浏览器未能加载视频，请检查网络或刷新源链接。</p></div>`;
}

function platformIcon(platform) {
  const symbols = { TikTok: '♪', YouTube: '▶', Instagram: '◎' };
  const known = Object.hasOwn(symbols, platform);
  return `<span aria-hidden="true" class="platform ${known ? platform.toLowerCase() : ''}">${known ? symbols[platform] : '•'}</span>`;
}

function renderGenerationDraft(draft) {
  if (!draft) return '<p>这份生成草稿暂不可查看。</p>';
  const { id, parameters: p, credits } = draft;
  const model = state.models.find(item => item.id === p.model);
  if (!model) return `<p>草稿已保存。当前无法使用这个视频模型，请在<a href="#settings">连接设置</a>检查视频服务。</p><p>${esc(p.prompt)}</p>`;
  const hasFiles = state.mode === 'live' && draft.files?.length > 0;
  const storage = state.settings.storage;
  const localOnly = hasFiles && !storage?.ready;
  return `<form class="inner-card generation-form" data-form="generation" data-id="${id}">
    <div class="card-header"><span class="card-icon">${icon('video')}</span><div><h3>生成视频</h3><p>${state.mode === 'live' ? '先查看积分报价，再确认生成。' : '选好视频设置后，可查看模拟报价。'}</p></div></div>
    ${draft.notes?.length ? `<p class="field-note">${draft.notes.map(note=>esc(note)).join(' ')}</p>` : ''}
    <label>视频提示词<textarea name="prompt" rows="2" required maxlength="${model.maxPrompt || 20000}">${esc(p.prompt)}</textarea></label>
    <div class="fields generation-fields"><label>模型<select name="model">${state.models.map(item => `<option value="${item.id}"${selected(item.id, p.model)}>${item.name}</option>`).join('')}</select></label>
      <label>画幅<select name="ratio">${model.ratios.map(ratio => `<option${selected(ratio, p.ratio)}>${ratio}</option>`).join('')}</select></label>
      <label>清晰度<select name="resolution">${model.resolutions.map(value => `<option${selected(value, p.resolution)}>${value}</option>`).join('')}</select></label>
      <label>时长<select name="duration">${(model.autoDuration ? [-1] : []).concat(model.durations?.length ? model.durations : Array.from({ length: model.max - model.min + 1 }, (_, index) => model.min + index)).map(value => `<option value="${value}"${selected(value, p.duration)}>${durationLabel(value)}</option>`).join('')}</select></label></div>
    <label class="check-field"${model.audio === false ? ' hidden' : ''}><input type="checkbox" name="audio"${p.audio ? ' checked' : ''}> 生成声音</label>
    ${draft.links.length ? `<p class="field-note">参考链接 ${draft.links.length} 条${state.mode === 'mock' ? '（模拟生成）' : ''}</p>` : ''}
    ${attachmentList(draft.files)}
    ${hasFiles ? `<p class="field-note">${localOnly ? '请到连接设置配置本地文件服务器或 OSS，Smart BIAI 才能读取附件。' : storage.provider === 'oss' ? '报价前会把选中的素材上传到 OSS，并提供限时下载链接。' : '报价前会给选中的素材生成限时公网链接。'}</p><button type="button" class="text-button" data-action="without-files">移除参考文件，继续生成</button>` : ''}
    <div class="card-actions"><span class="quote">${credits != null ? `<strong>${esc(credits)}</strong> ${state.mode === 'live' ? '积分上限' : '模拟积分'}` : '尚未报价'}</span>
      <button type="submit" class="button ${credits == null ? '' : 'primary'}"${localOnly ? ' disabled' : ''}>${credits == null ? hasFiles ? '准备素材并报价' : '获取报价' : '确认生成'}</button></div>
    <p class="form-error" role="alert" hidden></p>
  </form>`;
}

function resultCard(id, intent = {}) {
  const video = findVideo(id);
  if (!video) return `<p>正在读取视频结果…</p>`;
  return `<div class="inner-card result-card" data-result="${id}"><div class="card-header"><span class="card-icon">${icon('video')}</span><div><h3>生成结果</h3><p>${esc(video.parameters.prompt.slice(0, 78))}</p></div>${generationBadge(video)}</div>
    ${video.url ? videoPreview(video) : ['generating', 'queued', 'submitting'].includes(video.status) ? '<div class="progress"><i></i></div>' : ''}
    ${video.error ? `<p class="field-note">${esc(video.error)}</p>` : ''}
    ${video.status === 'completed' ? `<div class="card-actions"><span class="muted">视频可用至 ${dateFormat(video.expiresAt)}</span>${state.mode === 'live' ? `<button class="button" data-action="refresh-video" data-id="${id}">刷新链接</button>` : ''}<button class="button primary" data-action="draft-publish" data-id="${id}">${intent.publish ? '继续准备发布' : '准备发布'} ${icon('arrow', 15)}</button></div>` : ''}${agentRetryButton('video',id,video.status)}</div>`;
}

function renderPublicationDraft(draft) {
  if (!draft) return '<p>这份发布草稿暂不可查看。</p>';
  const video = findVideo(draft.generationId);
  const account = findAccount(draft.accountId);
  const live = state.mode === 'live';
  return `<form class="inner-card publish-form" data-id="${draft.id}" data-form="publication">
    <div class="card-header"><span class="card-icon">${icon('tasks')}</span><div><h3>发布确认</h3><p>检查发布账号、标题和时间。</p></div>${badge(live ? '将发布到所选账号' : '待确认', live ? 'orange' : 'purple')}</div>
    <div class="draft-media">${thumbnail(video?.coverUrl)}<span><strong>已选生成视频</strong><small>视频可用至 ${dateFormat(video?.expiresAt, draft.zone)}</small></span></div>
    <label>目标账号<select name="accountId" required><option value="">请选择目标账号</option>${state.accounts.filter(mayPublish).map(item => `<option value="${item.id}"${selected(item.id, draft.accountId)}>${esc(item.platform)} · ${esc(item.name)}</option>`).join('')}</select></label>
    <label><span class="field-heading">发布标题 <button class="text-button" type="button" data-action="fill-title">AI 补齐</button></span><input name="title" maxlength="100" required placeholder="输入发布标题" value="${esc(draft.title)}"></label>
    <label data-description${account?.platform === 'YouTube' ? '' : ' hidden'}>视频描述<textarea name="description" rows="2" maxlength="1000" placeholder="可选">${esc(draft.description)}</textarea></label>
    <p class="field-note">封面 · ${video?.coverUrl ? '使用生成服务返回的封面' : '自动使用生成封面，无封面时留空'}</p>
    <label class="check-field"><input type="checkbox" name="ai"${draft.ai ? ' checked' : ''}> AI 生成内容</label>
    <fieldset class="mode" aria-label="发布方式"><label><input type="radio" name="mode" value="now"${draft.mode === 'now' ? ' checked' : ''}> 立即发布</label><label><input type="radio" name="mode" value="scheduled"${draft.mode === 'scheduled' ? ' checked' : ''}> 定时发布</label></fieldset>
    <div class="fields schedule-fields" data-schedule${draft.mode === 'scheduled' ? '' : ' hidden'}><label>预约时间<input type="datetime-local" name="planned" value="${esc(draft.planned)}"></label><label>时区<select name="zone">${zoneOptions(draft.zone)}</select></label></div>
    <p class="field-note" data-schedule-note${draft.mode === 'scheduled' ? '' : ' hidden'}>请保持工作台运行。到预约时间后，工作台会开始发布。</p>
    <div class="card-actions"><button class="button primary" data-confirm>${draft.mode === 'scheduled' ? '确认排期' : '确认发布'}</button></div>
    <p class="form-error" role="alert" hidden></p>
  </form>`;
}

function thumbnail(url) {
  return `<span class="thumbnail">${icon('video', 21)}${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}</span>`;
}

const listBatchSize = 20;
const countryNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const countryAliases = { 美国: 'US', 英国: 'GB', 日本: 'JP', 德国: 'DE', 法国: 'FR', 中国: 'CN', 加拿大: 'CA', 澳大利亚: 'AU', UK: 'GB', USA: 'US', GBR: 'GB' };
function accountCountry(account) {
  const raw = String(account.country || '').trim();
  if (!raw) return { value: '__unknown__', label: '未设置国家' };
  const code = countryAliases[raw] || countryAliases[raw.toUpperCase()] || (/^[a-z]{2}$/i.test(raw) ? raw.toUpperCase() : '');
  return { value: code || raw, label: code ? `${countryNames.of(code)}（${code}）` : raw };
}

function matchingAccounts() {
  return state.accounts.filter(account => (!state.accountFilter || state.accountFilter === account.platform) &&
    (!state.accountCountry || state.accountCountry === accountCountry(account).value) &&
    `${account.id} ${account.name} ${account.alias}`.toLowerCase().includes(state.accountSearch.trim().toLowerCase()));
}

function accountWorks() {
  return state.publications.filter(item => item.accountId === state.accountId && item.status === 'completed')
    .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
}

function batchFooter(count, total, target) {
  return `<div class="list-progress"><span role="status">${count < total ? `已显示 ${count} / ${total} 条` : `已显示全部 ${total} 条`}</span>${count < total ? `<button type="button" class="text-button" data-action="${target === 'tasks' ? 'load-task-list' : 'load-account-list'}" data-list="${target}">加载更多</button>` : ''}</div>`;
}

function resizeListPanels() {
  const page = document.querySelector('.accounts-page, .tasks-page');
  if (page) {
    page.style.height = `${Math.max(0, window.innerHeight - main.getBoundingClientRect().top - window.scrollY)}px`;
    fillListPanel('account-table', 'accounts');
    fillListPanel('account-works', 'works');
    fillListPanel('task-table', 'tasks');
  }
}

function fillListPanel(id, list) {
  requestAnimationFrame(() => {
    const container = document.getElementById(id);
    if (container?.clientHeight > 0 && container.scrollHeight <= container.clientHeight) {
      if (list === 'tasks') loadTaskBatch();
      else loadAccountBatch(list);
    }
  });
}

function renderAccounts() {
  state.accountRows = listBatchSize;
  state.workRows = listBatchSize;
  state.worksAccountId = '';
  const countries = [...new Map(state.accounts.map(account => { const country = accountCountry(account); return [country.value, country]; })).values()]
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  main.innerHTML = `<section class="page accounts-page">
    ${heading('社媒账号', '查看已连接的海外社媒账号及其发布作品。')}
    ${state.issues.social ? `<p class="page-issue">${esc(state.issues.social)} <a href="#settings">连接设置</a></p>` : ''}
    <div class="account-layout"><div class="panel account-panel"><div class="toolbar"><label class="search">${icon('search', 17)}<input id="account-search" aria-label="搜索账号" placeholder="搜索账号名称、别名或 ID" value="${esc(state.accountSearch)}"></label>
      <select id="account-filter" aria-label="筛选平台"><option value="">全部平台</option>${['TikTok', 'YouTube', 'Instagram'].map(platform => `<option${selected(platform, state.accountFilter)}>${platform}</option>`).join('')}</select>
      <select id="account-country" aria-label="筛选国家"><option value="">全部国家</option>${countries.map(country => `<option value="${esc(country.value)}"${selected(country.value, state.accountCountry)}>${esc(country.label)}</option>`).join('')}</select></div><div id="account-table" class="account-scroll" tabindex="0" role="region" aria-label="社媒账号列表"></div></div><aside id="account-detail" class="panel account-detail"></aside></div>
  </section>`;
  const selectedIndex = matchingAccounts().findIndex(account => account.id === state.accountId);
  if (selectedIndex >= listBatchSize) state.accountRows = Math.ceil((selectedIndex + 1) / listBatchSize) * listBatchSize;
  updateAccounts();
  resizeListPanels();
}

function updateAccounts({ reset = false } = {}) {
  if (reset) { state.accountRows = listBatchSize; state.workRows = listBatchSize; state.worksAccountId = ''; state.accountId = ''; }
  const list = matchingAccounts();
  const account = list.find(item => item.id === state.accountId) ?? list[0];
  state.accountId = account?.id ?? '';
  renderAccountRows(list, reset);
  const changedAccount = state.worksAccountId !== state.accountId;
  const scrollTop = changedAccount ? 0 : document.querySelector('#account-works')?.scrollTop || 0;
  if (changedAccount) state.workRows = listBatchSize;
  state.worksAccountId = state.accountId;
  const detail = document.querySelector('#account-detail');
  if (!account) { detail.innerHTML = empty('选择社媒账号', '账号详情会显示在这里。'); return; }
  const works = accountWorks();
  detail.innerHTML = `<div class="account-summary">${platformIcon(account.platform)}<div><h2>${esc(account.name)}</h2><p>${esc(account.platform)} · 账号 ID ${account.id}</p></div></div>
    <div class="account-meta"><span>服务到期 <strong>${esc(account.expiry || '—')}</strong></span>${badge(account.authorization, account.authorization === '已授权' ? 'green' : 'orange')}</div>
    <div class="section-label">本应用发布作品 <span>${works.length}</span></div><p class="field-note">显示通过本应用确认发布成功的作品。</p>
    <div id="account-works" class="works account-scroll" tabindex="0" role="region" aria-label="账号作品列表"></div>`;
  renderAccountWorks(works);
  document.querySelector('#account-works').scrollTop = scrollTop;
}

function renderAccountRows(list = matchingAccounts(), reset = false) {
  const container = document.querySelector('#account-table');
  const scrollTop = reset ? 0 : container.scrollTop;
  const visible = list.slice(0, state.accountRows);
  container.innerHTML = list.length ? `<table><thead><tr><th>账号</th><th>平台</th><th>国家</th><th>授权状态</th></tr></thead><tbody>${visible.map(item => `<tr${item.id === state.accountId ? ' class="selected-row"' : ''}><td><button class="row-link" data-action="account" data-id="${esc(item.id)}">${platformIcon(item.platform)}<span><strong>${esc(item.name)}</strong><small>${esc(item.alias)}</small></span></button></td><td>${esc(item.platform)}</td><td>${esc(accountCountry(item).label)}</td><td>${badge(item.authorization, item.authorization === '已授权' ? 'green' : 'orange')}</td></tr>`).join('')}</tbody></table>${batchFooter(visible.length, list.length, 'accounts')}` : empty('没有匹配的账号', '试试其他国家、平台、名称或 ID。');
  container.scrollTop = scrollTop;
  fillListPanel('account-table', 'accounts');
}

function renderAccountWorks(works = accountWorks()) {
  const container = document.querySelector('#account-works');
  if (!container) return;
  const scrollTop = container.scrollTop;
  const visible = works.slice(0, state.workRows);
  container.innerHTML = works.length ? `${visible.map(item => `<div class="work-row">${thumbnail(item.coverUrl || findVideo(item.generationId)?.coverUrl)}<div><strong>${esc(item.title)}</strong><small>完成于 ${dateFormat(item.updated, item.zone)}</small></div><a href="#tasks/${encodeURIComponent(item.id)}" class="text-button">查看任务</a></div>`).join('')}${batchFooter(visible.length, works.length, 'works')}` : empty('尚无发布作品', '发布完成后会在此显示。', 'video');
  container.scrollTop = scrollTop;
  fillListPanel('account-works', 'works');
}

function loadAccountBatch(target) {
  if (state.page !== 'accounts') return;
  if (target === 'accounts' && state.accountRows < matchingAccounts().length) {
    state.accountRows += listBatchSize;
    renderAccountRows();
  } else if (target === 'works' && state.workRows < accountWorks().length) {
    state.workRows += listBatchSize;
    renderAccountWorks();
  }
}

function empty(title, detail, symbol = 'search') {
  return `<div class="empty"><span class="card-icon">${icon(symbol, 22)}</span><strong>${title}</strong><p>${detail}</p></div>`;
}

const tabs = { all: '全部', scheduled: '已排期', publishing: '发布中', completed: '已完成', generation: '生成记录', image: '图片记录' };

function taskRecords() {
  if (state.taskTab === 'image') return state.images;
  if (state.taskTab === 'generation') return state.generations;
  return state.publications.filter(item => (state.taskTab === 'all' || item.status === state.taskTab || state.taskTab === 'publishing' && ['queued', 'queued_upstream', 'submitting'].includes(item.status)) &&
    (!state.taskAccount || item.accountId === state.taskAccount) && item.title.toLowerCase().includes(state.taskSearch.trim().toLowerCase()));
}

function renderTasks() {
  const tabScroll = document.querySelector('.task-panel > .tabs')?.scrollLeft || 0;
  state.taskRows = listBatchSize;
  const selectedIndex = taskRecords().findIndex(item => item.id === state.taskId);
  if (selectedIndex >= listBatchSize) state.taskRows = Math.ceil((selectedIndex + 1) / listBatchSize) * listBatchSize;
  main.innerHTML = `<section class="page tasks-page">
    ${heading('发布任务', '查看预约时间和发布结果。')}
    <div class="tasks-layout"><div class="panel task-panel"><div class="tabs" aria-label="筛选任务">${Object.entries(tabs).map(([key, label]) => `<button data-action="task-tab" data-tab="${key}" aria-pressed="${key === state.taskTab}">${label}</button>`).join('')}</div>
    <div class="toolbar"${['generation', 'image'].includes(state.taskTab) ? ' hidden' : ''}><label class="search">${icon('search', 17)}<input id="task-search" aria-label="搜索作品标题" placeholder="搜索作品标题" value="${esc(state.taskSearch)}"></label>
    <select id="task-account" aria-label="筛选目标账号"><option value="">全部账号</option>${state.accounts.map(item => `<option value="${item.id}"${selected(item.id, state.taskAccount)}>${esc(item.name)}</option>`).join('')}</select></div><div id="task-table" class="record-scroll" tabindex="0" role="region" aria-label="任务列表"></div></div><aside id="task-detail" class="panel task-detail" tabindex="0" aria-label="任务详情" hidden></aside></div>
  </section>`;
  document.querySelector('.task-panel > .tabs').scrollLeft = tabScroll;
  document.querySelector('.task-panel > .tabs [aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  updateTasks();
  resizeListPanels();
}

function renderTaskTable(content, count, total, reset) {
  const table = document.querySelector('#task-table');
  const scrollTop = reset ? 0 : table.scrollTop;
  table.setAttribute('aria-label', state.taskTab === 'image' ? '图片记录列表' : state.taskTab === 'generation' ? '视频生成记录列表' : '发布任务列表');
  table.innerHTML = content + (total ? batchFooter(count, total, 'tasks') : '');
  table.scrollTop = scrollTop;
  fillListPanel('task-table', 'tasks');
}

function loadTaskBatch() {
  if (state.page !== 'tasks' || state.taskRows >= taskRecords().length) return;
  state.taskRows += listBatchSize;
  updateTasks();
}

function updateTasks({ reset = false } = {}) {
  const detail = document.querySelector('#task-detail');
  if (!detail) return;
  if (reset) { state.taskRows = listBatchSize; state.taskId = ''; }
  const rows = taskRecords();
  const visible = rows.slice(0, state.taskRows);
  if (state.taskTab === 'image') {
    detail.hidden = true;
    renderTaskTable(rows.length ? `<table><thead><tr><th>图片任务</th><th>生成模型</th><th>张数</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${visible.map(task => `<tr><td><div class="task-work">${thumbnail(task.results.find(item => item.url)?.url)}<strong>${esc(task.parameters.prompt.slice(0, 70))}</strong></div></td><td>${esc(imageModelName(task))}</td><td>${task.parameters.n}</td><td>${dateFormat(task.created)}</td><td>${imageBadge(task)}</td><td><button class="text-button" data-action="open-image-result" data-id="${esc(task.id)}">查看图片</button></td></tr>`).join('')}</tbody></table>` : empty('还没有图片生成记录', '在 BIAI Agent 描述你想生成的图片。', 'image'), visible.length, rows.length, reset);
    return;
  }
  if (state.taskTab === 'generation') {
    detail.hidden = true;
    renderTaskTable(rows.length ? `<table><thead><tr><th>生成任务</th><th>生成模型</th><th>时长</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${visible.map(video => `<tr><td><div class="task-work">${thumbnail(video.coverUrl)}<strong>${esc(video.parameters.prompt.slice(0, 70))}</strong></div></td><td>${esc(modelName(video))}</td><td>${durationLabel(video.parameters.duration)}</td><td>${dateFormat(video.created)}</td><td>${generationBadge(video)}</td><td><button class="text-button" data-action="preview-video" data-id="${esc(video.id)}">查看视频</button></td></tr>`).join('')}</tbody></table>` : empty('还没有生成记录', '在 BIAI Agent 发起视频生成。', 'video'), visible.length, rows.length, reset);
    return;
  }
  renderTaskTable(rows.length ? `<table><thead><tr><th>作品</th><th>目标账号</th><th>预约时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${visible.map(item => {
    const account = taskAccount(item);
    return `<tr${state.taskId === item.id ? ' class="selected-row"' : ''}><td><div class="task-work">${thumbnail(item.coverUrl || findVideo(item.generationId)?.coverUrl)}<strong>${esc(item.title)}</strong></div></td><td>${platformIcon(account?.platform)} ${esc(account?.name ?? item.accountId)}</td><td>${item.planned ? `${dateFormat(item.planned, item.zone)}<small>${zoneLabels[item.zone] || esc(item.zone)}</small>` : '立即'}</td><td>${publicationBadge(item.status)}</td><td><button class="text-button" data-action="task" data-id="${item.id}">详情</button></td></tr>`;
  }).join('')}</tbody></table>` : empty('没有符合条件的发布任务', '确认发布后，可以在这里查看进度。', 'tasks'), visible.length, rows.length, reset);
  const active = rows.find(item => item.id === state.taskId);
  const detailScroll = !detail.hidden && detail.dataset.taskId === active?.id ? detail.scrollTop : 0;
  detail.hidden = !active;
  if (active) { detail.innerHTML = renderTaskDetail(active); detail.dataset.taskId = active.id; detail.scrollTop = detailScroll; }
}

function renderTaskDetail(item) {
  const account = taskAccount(item);
  const video = findVideo(item.generationId);
  const events = [
    ['创建发布任务', item.created],
    [item.planned ? '预约时间' : '等等待发布', item.planned],
    ...(item.submitted ? [[item.mode === 'live' ? '已发送给 Smart BIAI' : '模拟发布已开始', item.submitted]] : []),
    ...(['completed', 'missed', 'expired', 'canceled', 'failed'].includes(item.status) ? [[pubStatuses[item.status][0], item.updated]] : [])
  ];
  return `<div class="detail-title"><h2>任务详情</h2><button class="icon-button" data-action="close-task" aria-label="关闭任务详情">${icon('close', 19)}</button></div>
    <div class="task-work detail-work">${thumbnail(item.coverUrl || video?.coverUrl)}<strong>${esc(item.title)}</strong></div>
    <dl class="details"><div><dt>目标账号</dt><dd>${esc(account?.platform)} · ${esc(account?.name ?? item.accountId)}</dd></div><div><dt>状态</dt><dd>${publicationBadge(item.status)}</dd></div><div><dt>发布时间</dt><dd>${item.planned ? `${dateFormat(item.planned, item.zone)} · ${esc(zoneLabels[item.zone] || item.zone)}` : '立即发布'}</dd></div><div><dt>更新时间</dt><dd>${dateFormat(item.updated, item.zone)}</dd></div>${item.sourceTaskId ? `<div><dt>Smart BIAI 任务编号</dt><dd class="break">${esc(item.sourceTaskId)}</dd></div>` : ''}${item.materialId ? `<div><dt>视频编号</dt><dd class="break">${esc(item.materialId)}</dd></div>` : ''}</dl>
    ${item.error ? `<p class="form-error">${esc(item.error)}</p>` : ''}
    <h3 class="timeline-title">进度记录</h3><ol class="timeline">${events.map(([label, time]) => `<li><strong>${label}</strong><small>${time ? dateFormat(time, item.zone) : '待处理'}</small></li>`).join('')}</ol>
    <div class="detail-actions">${video?.url ? `<a class="text-button" href="${esc(video.url)}" target="_blank" rel="noreferrer">打开源视频 ↗</a>` : ''}${item.status === 'scheduled' ? `<button class="button danger" data-action="cancel" data-id="${item.id}">取消排期</button>` : ''}</div>`;
}

function settingsCard(name, symbol, title, detail, fields) {
  const config = state.settings[name];
  const problem = state.issues[name];
  return `<form class="panel settings-card" data-form="settings" data-name="${name}"><span class="card-icon">${icon(symbol, 22)}</span><h2>${title}</h2><p>${detail}</p>${fields}
    ${name === 'ai' ? '' : '<a class="text-button official" href="https://www.biaibiai.com/" target="_blank" rel="noreferrer">去 Smart BIAI 获取连接信息 ↗</a>'}
    ${problem ? `<p class="field-note">${esc(problem)}</p>` : ''}
    <p class="form-error" role="alert" hidden></p><div class="settings-actions">${config.ready ? badge(config.source === 'env' ? '已从本地文件或环境读取' : '已保存', 'purple') : badge('还未设置')}<button class="button" type="submit">保存</button></div>
    ${config.hasSavedSecret ? '<button class="text-button clear-secret" type="button" data-action="clear-secret">清除已保存密钥</button>' : ''}</form>`;
}

function secret(name, hasSecret, label) {
  return `<label>${label}<input type="password" name="${name}" maxlength="4096" autocomplete="new-password" placeholder="${hasSecret ? '留空可保留当前密钥' : '输入密钥'}"></label>`;
}

function renderStorageSettings(config) {
  const local = config.provider === 'local';
  const field = (name, label, placeholder) => `<label>${label}<input name="${name}" value="${esc(config[name])}" placeholder="${placeholder}"></label>`;
  const localFields = `${field('publicOrigin', '公网 HTTPS 域名', 'https://media.example.com')}${field('localDirectory', '服务器附件目录', '留空使用默认目录')}`;
  const ossFields = `${field('bucket', 'Bucket', '填写 Bucket 名称')}${field('region', '地域', '例如 cn-hangzhou')}${field('endpoint', 'Endpoint（选填）', '留空按地域确定')}${field('customDomain', '下载自定义域名（选填）', '留空用 OSS 公网域名')}${field('prefix', '对象目录（选填）', 'biai-agent/references')}${secret('accessKeyId', config.hasAccessKeyId, 'AccessKey ID')}${secret('accessKeySecret', config.hasSecret, 'AccessKey Secret')}`;
  return `<form class="panel settings-card storage-settings" data-form="settings" data-name="storage">
    <span class="card-icon">${icon('link', 22)}</span><h2>参考素材文件服务</h2><p>让 Smart BIAI 能读取你从对话上传的参考素材。</p>
    <fieldset class="mode" aria-label="文件服务"><label><input type="radio" name="provider" value="local"${local ? ' checked' : ''}> 本地文件服务器</label><label><input type="radio" name="provider" value="oss"${local ? '' : ' checked'}> 阿里云 OSS</label></fieldset>
    <fieldset class="storage-fields" data-storage="local"${local ? '' : ' hidden disabled'}>${localFields}<p class="field-note">需要将域名的 /media/ 转发到工作台。更换附件目录只影响新上传的文件。</p></fieldset>
    <fieldset class="storage-fields" data-storage="oss"${local ? ' hidden disabled' : ''}>${ossFields}<p class="field-note">可读取配置文件中的 OSS 信息，密钥留空保留当前值。</p></fieldset>
    <p class="form-error" role="alert" hidden></p><div class="settings-actions">${badge(config.ready ? '已填写' : '还未设置', config.ready ? 'purple' : 'gray')}<button type="submit" class="button">保存</button></div>
  </form>`;
}

function renderSettings() {
  const { social, video, ai, storage } = state.settings;
  const provider = ai.provider || 'deepseek';
  main.innerHTML = `<section class="page">${heading('连接设置', '连接 Smart BIAI，并选择 Agent 使用的 AI 服务。')}
    <div class="settings-grid">
    ${settingsCard('social', 'accounts', 'Smart BIAI 社媒', '查看已连接的社媒账号并发布视频。', `<label>App ID<input name="appId" required maxlength="160" value="${esc(social.appId)}" placeholder="输入 Smart BIAI App ID"></label>${secret('accessToken', social.hasSecret, 'Access Token')}`)}
    ${settingsCard('video', 'image', 'Smart BIAI 图片与视频生成', '使用同一应用密钥，读取已开通的生图和视频模型。', secret('apiKey', video.hasSecret, 'API Key'))}
    ${settingsCard('ai', 'agent', '对话 AI', '选择帮你理解指令和撰写文案的 AI。', `<fieldset class="mode" aria-label="对话模型服务"><label><input type="radio" name="provider" value="deepseek"${provider === 'deepseek' ? ' checked' : ''}> DeepSeek</label><label><input type="radio" name="provider" value="doubao"${provider === 'doubao' ? ' checked' : ''}> 豆包</label></fieldset><label>模型 ID<input name="model" required maxlength="160" value="${esc(ai.model)}" placeholder="填入账号已开通的模型 ID"></label>${secret('apiKey', ai.hasSecret, 'API Key')}`)}
    </div>${renderStorageSettings(storage)}<form class="panel timezone-card" data-form="settings" data-name="preferences"><div><h2>默认时区</h2><p>新建预约时会默认使用这个时区。</p></div><label class="sr-only" for="zone-setting">默认时区</label><select id="zone-setting" name="zone">${zoneOptions(defaultZone())}</select><button class="button" type="submit">保存</button><p class="form-error" role="alert" hidden></p></form>
  </section>`;
}

function textEntry(text, details = {}) { state.chat.push({ type: 'text', text, ...details }); }

function semanticAgent() { return state.agent?.enabled && state.agent.semantic !== false; }

function agentRetryButton(kind, id, status) {
  return ['completed','partial','failed','expired'].includes(status) ? `<div class="detail-actions agent-result-actions"><button class="button quiet" data-action="agent-adjust" data-kind="${kind}" data-id="${esc(id)}">调整参数</button></div>` : '';
}

function renderAgentTargets(targets) {
  return Array.isArray(targets) ? `<div class="recent">${targets.map(item=>`<button type="button" class="recent-item" data-action="agent-show" data-kind="${esc(item.kind)}" data-id="${esc(item.id)}"><span>${esc(item.label || item.id)}</span>${icon('arrow',15)}</button>`).join('')}</div>` : '';
}

async function applyAgentResponse(response) {
  if(response.protocol!=='agent.v1'||!response.conversation)throw new Error('工作台版本不一致，请刷新页面后重试。');
  for(const name of ['images','generations','publications','accounts'])for(const item of response.updates?.[name]||[])upsert(state[name],item);
  for(const name of ['models','imageModels'])if(Array.isArray(response.updates?.[name]))state[name]=response.updates[name];
  clearTimeout(conversationTimer);conversationDirty=false;
  activateConversation(response.conversation);
  const {id,title,revision,updated}=response.conversation;
  state.history=[{id,title,revision,updated},...state.history.filter(item=>item.id!==id)];
  renderConversationHistory();
}

async function sendMessage(message, { mediaType, referenceFiles, understood, choice, command } = {}) {
  const value = message.trim();
  if ((!value && !state.attachments.length) || state.intentBusy || state.historyBusy || state.uploadBusy || state.formBusy) return;
  if (!semanticAgent() && !command && referenceFiles === undefined && !state.attachments.length && /^(?:生成)?(?:图片|图像|视频)$/.test(value)) {
    const pending = state.chat.at(-1);
    if (pending?.mediaChoice && !pending.mediaChoice.chosen) {
      state.chat.push({ type: 'user', text: value });
      return sendMessage(pending.mediaChoice.message, { mediaType: /视频/.test(value) ? 'video' : 'image', referenceFiles: pending.files || [], understood: pending.mediaChoice.intent, choice: pending });
    }
  }
  const chat = state.chat;
  const history = chat.filter(entry => entry.type === 'user').slice(-5).map(entry => entry.text);
  const files = referenceFiles ?? state.attachments.splice(0);
  if (!choice) chat.push({ type: 'user', text: value, ...(files.length ? { files } : {}) });
  if (!value) textEntry('文件已保存到工作台。');
  saveChat();
  state.intentBusy = Boolean(value);
  renderAttached();
  renderChat();
  if (!value) return;
  let agentApplied=false;
  try {
    if ((semanticAgent() || command) && !understood) {
      if(!await flushConversation())throw new Error('本条消息尚未保存，请稍后重试。');
      const conversationId=state.conversation.id;
      setAgentPending(true);
      try {
        const response=await request('agent',{protocol:'agent.v1',turnId:crypto.randomUUID(),conversationId,revision:state.conversation.revision,message:value,fileIds:files.map(file=>file.id),...(command?{command}:{})});
        await applyAgentResponse(response);
        agentApplied=true;
      } catch(error) {
        if(error.status===409){
          await applyAgentResponse({protocol:'agent.v1',conversation:await request(`conversations/${conversationId}`)});
          textEntry(`${error.message} 请基于最新记录重新发送要求。`);
        }
        throw error;
      }
      return;
    }
    const intent = normalizeGenerationIntent(value, understood ?? await request('agent', { message: value, history, fileIds: files.map(file => file.id) }), { mediaType });
    if (state.chat !== chat) return;
    if (intent.needsMediaChoice) {
      textEntry('这次先生成图片还是视频？请选择，也可以直接回复“图片”或“视频”。原始描述和参考附件会保留。', {
        mediaChoice: { id: crypto.randomUUID(), message: value, intent }, files
      });
      return;
    }
    intent.zone = suggestedZone(value);
    intent.planned = scheduleSuggestion(value, intent.zone);
    if (intent.publish && (intent.planned || /定时|排期|预约|明早|明天|后天|(?:本|下)周/.test(value))) intent.requiresSchedule = true;
    if (intent.accounts?.length && state.mode === 'live') for (const account of intent.accounts) upsert(state.accounts, account);
    if (intent.accountError) textEntry(intent.accountError);
    if (intent.query && !intent.accountError) textEntry(intent.accounts.length ? `找到 ${intent.accounts.length} 个匹配账号。${intent.limited ? '已查前 500 个账号，可用账号 ID 缩小范围。' : ''}` : '没有找到匹配账号，可以换一个平台或名称。', { accounts: intent.accounts });
    if (intent.generateImage) {
      const id = crypto.randomUUID();
      const model = chooseModel(state.imageModels, intent.model);
      if (!model) { textEntry(state.issues.image || '当前没有可用的生图模型，请检查连接设置。'); return; }
      if (files.some(file => !/\.(png|jpg|jpeg|webp)$/i.test(file.name))) { textEntry('生图参考素材请使用 PNG、JPEG 或 WebP 图片。'); return; }
      state.drafts.set(id, { id, kind: 'image', parameters: { model: model.id, prompt: intent.prompt || value, n: intent.n || 1,
        ...(model.spec === 'size' ? { size: model.sizes[0], quality: model.qualities[0] } : { ratio: model.ratios.includes(intent.ratio) ? intent.ratio : model.ratios[0], resolution: model.resolutions[0] }) },
        links: [], files, intent });
      chat.push({ type: 'image-generation', id });
    }
    if (intent.generate) {
      const id = crypto.randomUUID();
      const model = chooseModel(state.models, intent.model, 'smartbiai-sd-2-0-mini-260619');
      if (!model) { textEntry(state.issues.video || '当前没有可用的视频模型，请检查连接设置。'); return; }
      const prompt = intent.prompt || value.split(/[，,。；;]\s*(?=明|今|后|下周|发|定时|排期)/)[0];
      const ratio = model.ratios.includes(intent.ratio) ? intent.ratio : model.ratios.includes('9:16') ? '9:16' : model.ratios[0];
      const seconds = Math.max(model.min, Math.min(model.max, intent.duration ?? 6));
      const duration = intent.duration === -1 && model.autoDuration ? -1 : model.durations?.length && !model.durations.includes(seconds) ? model.durations[0] : seconds;
      const resolution = model.resolutions.includes('720p') ? '720p' : model.resolutions[0];
      state.drafts.set(id, { id, parameters: { prompt, model: model.id, ratio, resolution, duration, audio: false }, links: [], files, intent });
      chat.push({ type: 'generation', id });
    } else if (intent.imageQuery) {
      state.images = await request('images');
      textEntry(state.images.length ? `已有 ${state.images.length} 组图片生成记录。` : '还没有图片生成记录，可以描述你想创作的产品图、海报或封面。', { images: Boolean(state.images.length) });
    } else if (intent.taskQuery) {
      const tasks = await request('publications');
      if (state.chat !== chat) return;
      state.publications = tasks;
      const matching = tasks.filter(task => !intent.targetId || task.accountId === intent.targetId).slice(0, 5);
      if (matching.length) chat.push({ type: 'tasks', ids: matching.map(task => task.id) });
      else textEntry('还没有匹配的发布任务。');
    } else if (intent.publish) {
      if (state.generations.length) textEntry('选一个已生成的视频，我会准备发布草稿。', { videos: true, intent });
      else textEntry('先生成一个视频，再准备发布。可以输入「生成一支 6 秒的竖屏产品视频」。');
    } else if (!intent.query && !intent.generateImage) {
      textEntry(intent.message || '试试「查询 TikTok 账号」、「生成一张产品海报」、「生成一支竖屏产品视频」或「把视频发到品牌主号」。');
    }
    if (choice && (intent.generate || intent.generateImage)) choice.mediaChoice.chosen = mediaType;
  } catch (error) {
    if (state.chat === chat) textEntry(error.message);
  } finally {
    setAgentPending(false);
    state.intentBusy = false;
    if(!agentApplied)saveChat();
    renderChat();
  }
}

function offerVideo(id, intent = {}) {
  state.chat.push({ type: 'result', id, intent });
  saveChat();
  if (state.page !== 'agent') location.hash = '#agent';
  else renderChat();
}

function draftPublication(id, intent) {
  const video = findVideo(id);
  if (video?.status !== 'completed') { notify('请使用已生成且未过期的素材。'); return; }
  if (state.mode === 'live' && !state.accounts.some(mayPublish)) { notify(state.issues.social || '当前没有可用的目标账号。'); return; }
  const key = crypto.randomUUID();
  const zone = intent.zone ?? defaultZone();
  state.drafts.set(key, {
    id: key, generationId: id, accountId: intent.targetId ?? '', title: intent.title ?? '', description: intent.description ?? '',
    ai: true, mode: intent.requiresSchedule ? 'scheduled' : 'now',
    zone, planned: intent.planned ?? ''
  });
  state.chat.push({ type: 'publication', id: key });
  saveChat();
  renderChat();
}

function upsert(list, entry) {
  const index = list.findIndex(item => item.id === entry.id);
  if (index === -1) list.unshift(entry);
  else list[index] = entry;
}

function generationFormData(form) {
  const values = new FormData(form);
  const draft = state.drafts.get(form.dataset.id);
  return { prompt: values.get('prompt'), model: values.get('model'), ratio: values.get('ratio'),
    resolution: values.get('resolution'), duration: Number(values.get('duration')), audio: values.has('audio'),
    references: draft.links || [], fileIds: (draft.files ?? []).map(file => file.id) };
}

function changeDraft(form, target) {
  const draft = state.drafts.get(form.dataset.id);
  if (!draft) return;
  if (form.dataset.form === 'image-generation') {
    const previous = draft.parameters;
    draft.parameters = imageFormData(form);
    if (target.name === 'model') {
      const model = state.imageModels.find(item => item.id === target.value);
      const p = draft.parameters;
      if (model.spec === 'size') { p.size = model.sizes.includes(previous.size) ? previous.size : model.sizes[0]; p.quality = model.qualities.includes(previous.quality) ? previous.quality : model.qualities[0]; delete p.ratio; delete p.resolution; }
      else { p.ratio = model.ratios.includes(previous.ratio) ? previous.ratio : model.ratios[0]; p.resolution = model.resolutions.includes(previous.resolution) ? previous.resolution : model.resolutions[0]; delete p.size; delete p.quality; }
      if (!model.mask) p.maskFileId = null;
    }
    draft.credits = null;
    if (target.name === 'model') {
      form.outerHTML = renderImageDraft(draft);
      document.querySelector(`[data-id="${draft.id}"] [name="model"]`)?.focus();
    } else {
      form.querySelector('.quote').textContent = '尚未报价';
      const button = form.querySelector('button[type="submit"]');
      button.textContent = '获取报价'; button.classList.remove('primary');
    }
  } else if (form.dataset.form === 'generation') {
    draft.parameters = generationFormData(form);
    draft.credits = null;
    form.querySelector('.quote').textContent = '尚未报价';
    const button = form.querySelector('button[type="submit"]');
    button.classList.remove('primary');
    button.textContent = state.mode === 'live' && draft.files?.length ? '准备素材并报价' : '获取报价';
    if (target.name === 'model') {
      const model = state.models.find(item => item.id === target.value);
      const { parameters } = draft;
      if (!model.ratios.includes(parameters.ratio)) parameters.ratio = model.ratios[0];
      if (!model.resolutions.includes(parameters.resolution)) parameters.resolution = model.resolutions[0];
      if (parameters.duration !== -1 || !model.autoDuration) {
        parameters.duration = Math.max(model.min, Math.min(model.max, parameters.duration || model.min));
        if (model.durations?.length && !model.durations.includes(parameters.duration)) parameters.duration = model.durations[0];
      }
      if (model.audio === false) parameters.audio = false;
      form.outerHTML = renderGenerationDraft(draft);
      document.querySelector(`[data-id="${draft.id}"] [name="model"]`)?.focus();
    }
  } else {
    const values = new FormData(form);
    Object.assign(draft, Object.fromEntries(values), { ai: values.has('ai') });
    form.querySelector('[data-description]').hidden = findAccount(draft.accountId)?.platform !== 'YouTube';
    const scheduled = draft.mode === 'scheduled';
    form.querySelector('[data-schedule]').hidden = !scheduled;
    form.querySelector('[data-schedule-note]').hidden = !scheduled;
    form.querySelector('[data-confirm]').textContent = scheduled ? '确认排期' : '确认发布';
  }
  saveChat(true);
}

function setFormError(form, message = '') {
  const field = form.querySelector('.form-error');
  field.textContent = message;
  field.hidden = !message;
}

async function submitForm(form, clearSecret = false) {
  if (form.dataset.pending || state.historyBusy || state.agentPending) return;
  if (['generation', 'image-generation'].includes(form.dataset.form) && state.mode === 'live' && state.drafts.get(form.dataset.id)?.files?.length && !state.settings.storage?.ready) return;
  form.dataset.pending = 'true';
  state.formBusy += 1;
  const button = form.querySelector('button[type="submit"], [data-confirm]');
  const controls = Array.from(form.elements).filter(control => !control.disabled && control !== button);
  const values = Object.fromEntries(new FormData(form));
  const kind = form.dataset.form;
  const draft = state.drafts.get(form.dataset.id);
  const parameters = kind === 'generation' ? generationFormData(form) : kind === 'image-generation' ? imageFormData(form) : null;
  setFormError(form);
  button.disabled = true;
  controls.forEach(control => { control.disabled = true; });
  try {
    if (kind === 'image-generation') {
      if (draft.credits == null) {
        Object.assign(draft, await request('images/quote', { ...parameters, id: draft.id }));
        form.outerHTML = renderImageDraft(draft);
      } else {
        const image = await request('images', { ...parameters, id: draft.id, credits: draft.credits });
        upsert(state.images, image);
        const index = state.chat.findIndex(entry => entry.id === draft.id && entry.type === 'image-generation');
        if (index >= 0) state.chat[index] = { type: 'image-result', id: image.id };
        state.drafts.delete(draft.id);
        renderChat();
      }
      saveChat();
    } else if (kind === 'generation') {
      if (draft.credits == null) {
        const quoted = await request('quote', { ...parameters, id: draft.id });
        Object.assign(draft, quoted);
        form.outerHTML = renderGenerationDraft(draft);
      } else {
        const video = await request('generations', { ...parameters, id: draft.id, credits: draft.credits });
        upsert(state.generations, video);
        const index = state.chat.findIndex(entry => entry.id === draft.id && entry.type === 'generation');
        if (index >= 0) state.chat[index] = { type: 'result', id: video.id, intent: draft.intent };
        state.drafts.delete(draft.id);
        renderChat();
      }
      saveChat();
    } else if (kind === 'publication') {
      const zone = values.zone;
      const planned = values.mode === 'scheduled' ? toTimestamp(values.planned, zone) : null;
      const task = await request('publications', { ...values, id: draft.id, generationId: draft.generationId, zone, planned, ai: Boolean(values.ai) });
      upsert(state.publications, task);
      const index = state.chat.findIndex(entry => entry.id === draft.id && entry.type === 'publication');
      if (index >= 0) state.chat[index] = { id: task.id, type: 'confirmed' };
      state.drafts.delete(draft.id);
      saveChat();
      renderChat();
      notify(planned ? '已保存发布排期。' : '已安排立即发布，可在发布任务中查看进度。');
    } else {
      const name = form.dataset.name;
      state.settings[name] = await request(`settings/${name}`, { ...values, clearSecret });
      if (state.mode === 'live' && !['preferences', 'storage'].includes(name)) {
        const updated = await request('bootstrap');
        Object.assign(state, updated);
      }
      if (state.page === 'settings') {
        const other = Array.from(main.querySelectorAll('[data-form="settings"]')).filter(item => item !== form)
          .map(item => [item.dataset.name, item]);
        renderSettings();
        for (const [key, item] of other) main.querySelector(`[data-name="${key}"]`)?.replaceWith(item);
      }
      notify(clearSecret ? '已清除保存的密钥。' : '设置已保存。');
    }
  } catch (error) {
    if (kind === 'image-generation' && error.status === 409 && /报价/.test(error.message)) {
      draft.credits = null; form.querySelector('.quote').textContent = '尚未报价'; button.textContent = '获取报价'; button.classList.remove('primary'); saveChat();
    }
    if (kind === 'generation' && state.mode === 'live' && error.status === 409 && /报价/.test(error.message)) {
      draft.credits = null;
      form.querySelector('.quote').textContent = '尚未报价';
      button.textContent = draft.files?.length ? '准备素材并报价' : '获取报价';
      button.classList.remove('primary');
      saveChat();
    }
    setFormError(form, error.message);
  } finally {
    state.formBusy -= 1;
    delete form.dataset.pending;
    button.disabled = false;
    controls.forEach(control => { control.disabled = false; });
  }
}

main.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'composer') {
    const field = form.elements.message;
    const value = field.value.trim();
    if ((!value && !state.attachments.length) || state.intentBusy || state.historyBusy || state.uploadBusy) return;
    field.value = '';
    void sendMessage(value);
    return;
  }
  if (form.dataset.form) void submitForm(form);
});

main.addEventListener('keydown', event => {
  const input = event.target;
  if (input.form?.id !== 'composer' || input.name !== 'message' || event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !input.value && input.placeholder) {
    event.preventDefault();
    input.value = input.placeholder;
    input.setSelectionRange(input.value.length, input.value.length);
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    input.form.requestSubmit();
  }
});

function handleMediaError(event) {
  if (event.target instanceof HTMLVideoElement) {
    const hint = event.target.parentElement.querySelector('[data-media-error]');
    if (hint) hint.hidden = false;
  } else if (event.target instanceof HTMLImageElement && event.target.closest('.thumbnail, .attachment-thumb')) {
    event.target.hidden = true;
  }
}
main.addEventListener('error', handleMediaError, true);
videoDialog.addEventListener('error', handleMediaError, true);

function renderVideoDialog(video) {
  const activeUrl = videoDialog.querySelector('video')?.getAttribute('src');
  if (activeUrl && activeUrl === video.url) return;
  videoDialog.innerHTML = `<div class="detail-title"><h2 id="video-dialog-title">视频预览</h2><form method="dialog"><button class="icon-button" aria-label="关闭视频预览" autofocus>${icon('close')}</button></form></div>
    <div class="video-dialog-info"><span>${esc(modelName(video))} · ${durationLabel(video.parameters.duration)}</span>${generationBadge(video)}</div>
    ${video.url ? videoPreview(video) : `<p class="empty-note">${esc(video.error || (video.status === 'completed' ? '视频链接已失效，请刷新链接。' : '当前暂无可播放的视频。'))}</p>`}
    ${video.mode === 'live' && video.status === 'completed' ? `<button type="button" class="button" data-refresh-preview>刷新链接</button>` : ''}`;
}

async function refreshDialogVideo() {
  const id = videoDialog.dataset.videoId;
  const mode = state.mode;
  const button = videoDialog.querySelector('[data-refresh-preview]');
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    const video = await request(`generations/${id}/refresh`, {}, mode);
    if (state.mode !== mode) return;
    upsert(state.generations, video);
    if (videoDialog.open && videoDialog.dataset.videoId === id) renderVideoDialog(video);
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
}

videoDialog.addEventListener('click', event => {
  if (event.target.closest('[data-refresh-preview]')) void refreshDialogVideo();
});
videoDialog.addEventListener('close', () => {
  if (videoDialog.open) return;
  videoDialog.replaceChildren();
  delete videoDialog.dataset.videoId;
});
imageDialog.addEventListener('close', () => { if (!imageDialog.open) imageDialog.replaceChildren(); });

main.addEventListener('input', event => {
  const { target } = event;
  if (target.id === 'account-search') { state.accountSearch = target.value; updateAccounts({ reset: true }); }
  if (target.id === 'task-search') { state.taskSearch = target.value; updateTasks({ reset: true }); }
  if (target.form?.dataset.id && target.tagName !== 'SELECT' && !['checkbox', 'radio'].includes(target.type)) changeDraft(target.form, target);
});

main.addEventListener('change', event => {
  const { target } = event;
  if (target.id === 'attachment-files') void uploadAttachments(target);
  if (target.id === 'conversation-history' && target.value) void changeConversation(target.value);
  if (target.id === 'account-filter') { state.accountFilter = target.value; updateAccounts({ reset: true }); }
  if (target.id === 'account-country') { state.accountCountry = target.value; updateAccounts({ reset: true }); }
  if (target.id === 'task-account') { state.taskAccount = target.value; updateTasks({ reset: true }); }
  if (target.form?.dataset.id) changeDraft(target.form, target);
  if (target.name === 'provider') {
    if (target.form.dataset.name === 'storage') {
      for (const fields of target.form.querySelectorAll('[data-storage]')) fields.hidden = fields.disabled = fields.dataset.storage !== target.value;
      return;
    }
    target.form.elements.model.value = target.value === state.settings.ai.provider ? state.settings.ai.model || '' : '';
    target.form.elements.apiKey.value = '';
    target.form.elements.apiKey.placeholder = target.value === state.settings.ai.provider && state.settings.ai.hasSecret ? '留空可保留当前密钥' : '输入密钥';
  }
});

main.addEventListener('scroll', event => {
  const target = event.target;
  if (target.id === 'task-table' && target.clientHeight > 0 && target.scrollHeight - target.clientHeight - target.scrollTop <= 24) loadTaskBatch();
  const list = target.id === 'account-table' ? 'accounts' : target.id === 'account-works' ? 'works' : '';
  if (list && target.clientHeight > 0 && target.scrollHeight - target.clientHeight - target.scrollTop <= 24) loadAccountBatch(list);
}, true);
window.addEventListener('resize', resizeListPanels);

main.addEventListener('click', async event => {
  const control = event.target.closest('[data-action]');
  if (!control || state.historyBusy) return;
  const { action, id } = control.dataset;
  switch (action) {
    case 'agent-adjust': void sendMessage('调整这条创作的参数',{command:{tool:'prepare_generation',arguments:{kind:control.dataset.kind,source:{kind:control.dataset.kind,id},changes:{}}}}); break;
    case 'agent-show': void sendMessage('查看这条记录',{command:{tool:'get_task',arguments:{target:{kind:control.dataset.kind,id},refresh:true,show:true}}}); break;
    case 'load-account-list': loadAccountBatch(control.dataset.list); break;
    case 'load-task-list': loadTaskBatch(); break;
    case 'prompt': void sendMessage(control.dataset.message); break;
    case 'choose-media': {
      const entry = state.chat.find(item => item.mediaChoice?.id === id && !item.mediaChoice.chosen);
      if (entry && ['image', 'video'].includes(control.dataset.mediaType)) void sendMessage(entry.mediaChoice.message, {
        mediaType: control.dataset.mediaType, referenceFiles: entry.files || [], understood: entry.mediaChoice.intent, choice: entry
      });
      break;
    }
    case 'new-chat': void changeConversation(); break;
    case 'upload': if (!state.uploadBusy) document.querySelector('#attachment-files').click(); break;
    case 'remove-file': state.attachments.splice(Number(control.dataset.index), 1); renderAttached(); break;
    case 'without-files': {
      const draft = state.drafts.get(control.form.dataset.id);
      draft.files = [];
      draft.credits = null;
      control.form.outerHTML = renderGenerationDraft(draft);
      saveChat();
      break;
    }
    case 'open-video': offerVideo(id, JSON.parse(control.dataset.intent || '{}')); break;
    case 'preview-image': renderImageDialog(id, Number(control.dataset.index)); break;
    case 'open-image-result':
      state.chat.push({ type: 'image-result', id }); saveChat();
      if (state.page !== 'agent') location.hash = '#agent'; else renderChat();
      break;
    case 'refresh-image': {
      control.disabled = true;
      const mode = state.mode;
      try {
        const task = await request(`images/${id}/refresh`, {}, mode);
        if (state.mode !== mode) break;
        upsert(state.images, task);
        for (const card of main.querySelectorAll(`[data-image-result="${id}"]`)) card.outerHTML = imageResultCard(id);
      } catch (error) { notify(error.message); }
      finally { control.disabled = false; }
      break;
    }
    case 'preview-video': {
      const video = findVideo(id);
      if (!video) break;
      videoDialog.dataset.videoId = id;
      renderVideoDialog(video);
      videoDialog.showModal();
      if (!video.url) void refreshDialogVideo();
      break;
    }
    case 'refresh-video': {
      control.disabled = true;
      const mode = state.mode;
      try {
        const video = await request(`generations/${id}/refresh`, {}, mode);
        if (state.mode !== mode) break;
        upsert(state.generations, video);
        renderChat();
      } catch (error) { notify(error.message); }
      finally { control.disabled = false; }
      break;
    }
    case 'draft-publish': {
      const mode = state.mode;
      if (mode === 'live' && !findVideo(id)?.url) {
        control.disabled = true;
        try {
          const refreshed = await request(`generations/${id}/refresh`, {}, mode);
          if (state.mode !== mode) break;
          upsert(state.generations, refreshed);
          if (!refreshed.url) { notify('尚未获得可用的视频链接。'); break; }
        } catch (error) { notify(error.message); break; }
        finally { control.disabled = false; }
      }
      draftPublication(id, state.chat.findLast(item => item.type === 'result' && item.id === id)?.intent ?? {});
      break;
    }
    case 'fill-title': {
      const form = control.form;
      const draft = state.drafts.get(form.dataset.id);
      const video = findVideo(draft.generationId);
      if (state.mode === 'live') {
        control.disabled = true;
        setFormError(form);
        try {
          const suggestion = await request('copywriting', { generationId: draft.generationId });
          if (!form.isConnected) break;
          if (suggestion.title) form.elements.title.value = suggestion.title;
          if (suggestion.description && !form.elements.description.value) form.elements.description.value = suggestion.description;
        } catch (error) { setFormError(form, error.message); }
        finally { control.disabled = false; }
      } else {
        const subject = video.parameters.prompt.match(/陶瓷马克杯|[「“]([^」”]+)[」”]/)?.[0]?.replace(/[「“」”]/g, '');
        form.elements.title.value = subject ? `新品上架｜${subject}使用场景` : `新品上架｜${video.parameters.prompt.replace(/^生成|^制作/, '').trim().slice(0, 32)}`;
        if (findAccount(form.elements.accountId.value)?.platform === 'YouTube' && !form.elements.description.value) {
          form.elements.description.value = `通过这支短片了解${subject || '产品'}，欢迎留言交流。`;
        }
      }
      changeDraft(form, form.elements.title);
      break;
    }
    case 'account': state.accountId = id; updateAccounts(); break;
    case 'task-tab': state.taskTab = control.dataset.tab; state.taskId = ''; renderTasks(); break;
    case 'task': state.taskId = id; updateTasks(); break;
    case 'close-task': state.taskId = ''; updateTasks(); break;
    case 'cancel':
      if (!window.confirm('取消这条发布排期？')) break;
      control.disabled = true;
      try {
        upsert(state.publications, await request(`publications/${id}/cancel`, {}));
        updateTasks();
        notify('已取消排期。');
      } catch (error) { notify(error.message); control.disabled = false; }
      break;
    case 'clear-secret':
      if (window.confirm('清除此服务保存的密钥？')) void submitForm(control.form, true);
      break;
  }
});

async function sync() {
  const mode = state.mode;
  const [generations, publications, images] = await Promise.all([request('generations', undefined, mode), request('publications', undefined, mode), request('images', undefined, mode)]);
  if (mode !== state.mode) return;
  const videoChanges = generations.filter(next => {
    const prior = findVideo(next.id);
    return !prior || prior.status !== next.status || prior.url !== next.url || prior.error !== next.error;
  });
  const tasksChanged = JSON.stringify(publications) !== JSON.stringify(state.publications);
  const imageChanges = images.filter(next => JSON.stringify(next) !== JSON.stringify(findImage(next.id)));
  state.generations = generations;
  state.publications = publications;
  state.images = images;
  if (videoDialog.open) {
    const preview = videoChanges.find(video => video.id === videoDialog.dataset.videoId);
    if (preview) renderVideoDialog(preview);
  }
  if (state.page === 'tasks' && (tasksChanged || videoChanges.length || imageChanges.length)) updateTasks();
  if (state.page === 'accounts' && tasksChanged && document.querySelector('#account-table')) updateAccounts();
  if (state.page === 'agent' && videoChanges.length) {
    if (!state.chat.length) { renderChat(); return; }
    for (const video of videoChanges) {
      const entries = state.chat.filter(entry => entry.type === 'result' && entry.id === video.id);
      const cards = main.querySelectorAll(`[data-result="${video.id}"]`);
      cards.forEach((card, index) => { card.outerHTML = resultCard(video.id, entries[index]?.intent); });
      if (cards.length) document.querySelector('#chat-scroll')?.scrollTo(0, document.querySelector('#chat-scroll').scrollHeight);
    }
  }
  if (state.page === 'agent' && imageChanges.length) {
    for (const task of imageChanges) for (const card of main.querySelectorAll(`[data-image-result="${task.id}"]`)) card.outerHTML = imageResultCard(task.id);
  }
}

window.addEventListener('hashchange', navigate);
async function loadMode() {
  if (imageDialog.open) imageDialog.close();
  if (videoDialog.open) videoDialog.close();
  modeSelect.disabled = true;
  modeSelect.value = state.mode;
  modeSelect.dataset.live = String(state.mode === 'live');
  state.loaded = false;
  navigate();
  main.innerHTML = '<p class="loading">正在打开工作台…</p>';
  try {
    const [boot, conversations] = await Promise.all([request('bootstrap'), request('conversations'), sync()]);
    Object.assign(state, boot);
    const logout = document.querySelector('#logout');
    if (logout) { logout.hidden = !boot.access?.required; logout.title = boot.access?.username ? `当前账号：${boot.access.username}` : ''; }
    state.history = conversations;
    const remembered = sessionStorage.getItem(`${conversationKey}-conversation-${state.mode}`);
    const active = remembered === null ? conversations[0] : conversations.find(item => item.id === remembered);
    activateConversation(active ? await request(`conversations/${active.id}`) : null);
    state.loaded = true;
    navigate();
  } catch (error) {
    main.innerHTML = `<section class="page">${empty('工作台连接失败', `${esc(error.message)} 请确认工作台服务已启动，再刷新页面。`)}</section>`;
  } finally { modeSelect.disabled = false; }
}

modeSelect.addEventListener('change', async () => {
  const nextMode = modeSelect.value;
  if (state.intentBusy || state.formBusy || state.historyBusy || state.uploadBusy) {
    modeSelect.value = state.mode;
    notify('请等待当前请求完成后再切换。');
    return;
  }
  state.historyBusy = true;
  if (!await flushConversation()) {
    modeSelect.value = state.mode;
    state.historyBusy = false;
    return;
  }
  state.mode = nextMode;
  sessionStorage.setItem(`${conversationKey}-mode`, state.mode);
  Object.assign(state, { chat: [], drafts: new Map(), history: [], conversation: null, generations: [], images: [], models: [], imageModels: [], publications: [], accounts: [], attachments: [], accountId: '', accountFilter: '', accountSearch: '', accountCountry: '', accountRows: 20, workRows: 20, worksAccountId: '', taskId: '', taskTab: 'all', taskSearch: '', taskAccount: '', taskRows: 20 });
  await loadMode();
  state.historyBusy = false;
  renderConversationHistory();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && conversationDirty) void flushConversation();
});

document.querySelector('#logout')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await flushConversation();
    const response = await fetch(`${appPath}auth/logout`, { method: 'POST' });
    if (!response.ok) throw new Error('暂时无法退出，请稍后重试。');
    location.replace(`${appPath}login`);
  } catch (error) { notify(error.message); button.disabled = false; }
});
window.addEventListener('pageshow', event => { if (event.persisted) void request('bootstrap').catch(() => {}); });

await loadMode();
const poll = async () => {
  if (state.loaded) try { await sync(); } catch { /* The next poll will reconnect to the local server. */ }
  setTimeout(poll, 1000);
};
setTimeout(poll, 1000);
