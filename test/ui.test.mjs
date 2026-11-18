import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createMockRequest } from './helpers/mock-api.mjs';
import { normalizeGenerationIntent } from '../generation-models.js';

async function until(check, label) {
  for (let index = 0; index < 150; index++) { const result = check(); if (result) return result; await wait(20); }
  throw new Error(`Timed out: ${label}`);
}

async function app({ agentReply, initialAccounts, initialPublications, initialGenerations, initialImages } = {}) {
  const { window } = new JSDOM('', { url: 'https://example.com/agent/', runScripts: 'outside-only', pretendToBeVisual: true });
  window.HTMLDialogElement.prototype.showModal ||= function () { this.open = true; };
  window.HTMLDialogElement.prototype.close ||= function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.HTMLElement.prototype.scrollTo ||= function () {};
  window.normalizeGenerationIntent = normalizeGenerationIntent;
  let clock = Date.now();
  const requests = [];
  const storage = new Map();
  const request = createMockRequest({ storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, key: 'ui', now: () => clock });
  window.fetch = async (url, options = {}) => {
    const path = String(url).split('/api/')[1];
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    requests.push({ path, body });
    try {
      let data = path === 'files' ? { id: 'ff5a283c-aec3-4c8e-828f-4146cde85334', name: body.name, size: body.size } : path === 'agent' && agentReply ? agentReply : await request(path, body);
      if (path === 'bootstrap' && initialAccounts) data = { ...data, accounts: initialAccounts };
      if (path === 'publications' && !body && initialPublications) data = structuredClone(initialPublications);
      if (path === 'generations' && !body && initialGenerations) data = structuredClone(initialGenerations);
      if (path === 'images' && !body && initialImages) data = structuredClone(initialImages);
      return { ok: true, status: 200, json: async () => data };
    }
    catch (error) { return { ok: false, status: error.status || 500, json: async () => ({ error: error.message }) }; }
  };
  const html = (await readFile(new URL('../web/index.html', import.meta.url), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.document.write(html);
  const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8'))
    .replace("import { normalizeGenerationIntent } from './generation-models.js';", '')
    .replaceAll('import.meta.url', JSON.stringify('https://example.com/agent/app.js'));
  await window.eval(`(async () => { ${source}\n })()`);
  return { window, document: window.document, requests, advance: () => { clock += 2000; },
    change(element, value) { element.value = value; element.dispatchEvent(new window.Event('change', { bubbles: true })); },
    submit(form) { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
    async attach() {
      const input = window.document.querySelector('#attachment-files');
      Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['reference'], 'cap.png', {type:'image/png'})] });
      input.dispatchEvent(new window.Event('change', {bubbles:true}));
      await until(() => window.document.querySelector('#attached .attachment-chip'), 'uploaded reference');
    },
    async close() { await wait(20); window.close(); } };
}

test('Agent image form supports model switching, explicit confirmation, preview and history', async () => {
  const ui = await app(); const { document } = ui;
  try {
    document.querySelector('[data-action="prompt"][data-message*="海报"]').click();
    await until(() => document.querySelector('[data-form="image-generation"]'), 'image draft');
    let form = document.querySelector('[data-form="image-generation"]');
    assert.equal(form.elements.model.options.length, 12);
    const prompt = form.elements.prompt;
    prompt.value = '晨光下的马克杯产品图'; prompt.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    assert.equal(document.querySelector('[data-form="image-generation"] textarea'), prompt);
    ui.change(form.elements.model, 'smartbiai-banana-2');
    form = document.querySelector('[data-form="image-generation"]');
    assert.ok(form.elements.ratio); assert.equal(form.elements.size, undefined);
    ui.change(form.elements.n, '2'); ui.submit(form);
    await until(() => document.querySelector('[data-form="image-generation"] button[type="submit"]')?.textContent === '确认生成图片', 'image quote');
    assert.equal(ui.requests.filter(item => item.path === 'images' && item.body).length, 0);
    form = document.querySelector('[data-form="image-generation"]');
    ui.change(form.elements.model, 'smartbiai-gpt-img-2-6-sunburst');
    form = document.querySelector('[data-form="image-generation"]');
    assert.ok(form.elements.size); assert.equal(form.elements.ratio, undefined);
    assert.equal(form.querySelector('.quote').textContent, '尚未报价');
    ui.submit(form);
    await until(() => document.querySelector('[data-form="image-generation"] button[type="submit"]')?.textContent === '确认生成图片', 'new image quote');
    ui.submit(document.querySelector('[data-form="image-generation"]'));
    await until(() => document.querySelector('[data-image-result]'), 'image task');
    ui.advance();
    await until(() => document.querySelectorAll('[data-image-result] img').length === 2, 'image results');
    document.querySelector('[data-action="preview-image"]').click();
    assert.equal(document.querySelector('#image-dialog').open, true);
    assert.ok(document.querySelector('#image-dialog img').src.endsWith('/demo-assets/sample-cover.jpg'));
    document.querySelector('#image-dialog').close();
    await until(() => document.querySelector('#conversation-history').options.length > 1, 'saved conversation');
    const savedId = document.querySelector('#conversation-history').value;
    document.querySelector('[data-action="new-chat"]').click();
    await until(() => document.querySelector('.welcome'), 'new conversation');
    ui.change(document.querySelector('#conversation-history'), savedId);
    await until(() => document.querySelectorAll('[data-image-result] img').length === 2, 'restored image conversation');
  } finally { await ui.close(); }
});

test('video form shows all models and updates resolution and duration options', async () => {
  const ui = await app(); const { document } = ui;
  try {
    document.querySelector('[data-action="prompt"][data-message*="产品视频"]').click();
    await until(() => document.querySelector('[data-form="generation"]'), 'video draft');
    let form = document.querySelector('[data-form="generation"]');
    assert.equal(form.elements.model.options.length, 8);
    assert.equal(form.elements.model.value, 'smartbiai-sd-2-0-mini-260619');
    ui.change(form.elements.model, 'smartbiai-sd-2-5-260719');
    form = document.querySelector('[data-form="generation"]');
    assert.ok([...form.elements.duration.options].some(option => option.value === '30'));
    assert.ok([...form.elements.duration.options].some(option => option.value === '-1'));
    assert.ok([...form.elements.resolution.options].some(option => option.value === '1080p'));
    ui.change(form.elements.duration, '30');
    ui.change(form.elements.resolution, '1080p');
    ui.change(form.elements.model, 'smartbiai-sd-2-0-lite-260722');
    form = document.querySelector('[data-form="generation"]');
    assert.equal(form.elements.resolution.value, '720p');
    assert.equal(form.elements.duration.value, '15');
    assert.ok(![...form.elements.duration.options].some(option => option.value === '-1'));
    assert.equal(form.elements.prompt.value.includes('马克杯'), true);
  } finally { await ui.close(); }
});

test('an explicit image request cannot open a video form even if an older AI reply selects video', async () => {
  const ui = await app({ agentReply: { generate: true, generateImage: false, prompt: '生成一段视频', accounts: [] } });
  try {
    const form = ui.document.querySelector('#composer');
    form.elements.message.value = '生成图片'; ui.submit(form);
    await until(() => ui.document.querySelector('[data-form="image-generation"]'), 'image form after stale video intent');
    assert.equal(ui.document.querySelector('[data-form="generation"]'), null);
    assert.equal(ui.document.querySelector('[data-form="image-generation"]').elements.prompt.value, '生成图片');
    assert.equal(ui.requests.filter(request => request.path === 'images' && request.body).length, 0);
  } finally { await ui.close(); }
});

test('uploaded reference and the reported product usage prompt open an image draft and retain its attachment', async () => {
  const ui = await app({ agentReply: { mediaType: 'video', generate: true, generateImage: false, prompt: '生成一段视频', accounts: [] } });
  try {
    await ui.attach();
    const message = '用参考图中的挡水帽，生成一张产品使用图，小孩在浴盆带着图中挡水帽洗头。';
    const composer = ui.document.querySelector('#composer'); composer.elements.message.value = message; ui.submit(composer);
    await until(() => ui.document.querySelector('[data-form="image-generation"]'), 'referenced product image draft');
    const form = ui.document.querySelector('[data-form="image-generation"]');
    assert.equal(form.elements.prompt.value, message);
    assert.equal(form.elements.n.value, '1'); assert.ok(form.textContent.includes('cap.png'));
    assert.equal(ui.document.querySelector('[data-form="generation"]'), null);
    assert.deepEqual(ui.requests.find(item => item.path === 'agent').body.fileIds, ['ff5a283c-aec3-4c8e-828f-4146cde85334']);
    ui.submit(form);
    await until(() => ui.requests.some(item => item.path === 'images/quote'), 'referenced image quote');
    assert.deepEqual(ui.requests.find(item => item.path === 'images/quote').body.fileIds, ['ff5a283c-aec3-4c8e-828f-4146cde85334']);
    assert.equal(ui.requests.some(item => item.path === 'images' && item.body), false);
  } finally { await ui.close(); }
});

test('unclear requests keep references across history and resolve once after a user media choice', async () => {
  const ui = await app({ agentReply: { mediaType: 'video', generate: true, generateImage: false, accounts: [] } });
  try {
    await ui.attach();
    const composer = ui.document.querySelector('#composer'); composer.elements.message.value = '用参考图生成一个'; ui.submit(composer);
    await until(() => ui.document.querySelector('[data-action="choose-media"]'), 'media clarification');
    assert.equal(ui.document.querySelector('[data-form="generation"]'), null);
    assert.equal(ui.document.querySelector('[data-form="image-generation"]'), null);
    await until(() => ui.document.querySelector('#conversation-history').options.length > 1, 'saved clarification');
    const saved = ui.document.querySelector('#conversation-history').value;
    ui.document.querySelector('[data-action="new-chat"]').click();
    await until(() => ui.document.querySelector('.welcome'), 'new conversation');
    ui.change(ui.document.querySelector('#conversation-history'), saved);
    await until(() => ui.document.querySelector('[data-action="choose-media"]'), 'restored clarification');
    const button = ui.document.querySelector('[data-action="choose-media"][data-media-type="image"]');
    button.click(); button.click();
    await until(() => ui.document.querySelector('[data-form="image-generation"]'), 'chosen image draft');
    assert.equal(ui.document.querySelectorAll('[data-form="image-generation"]').length, 1);
    assert.ok(ui.document.querySelector('[data-form="image-generation"]').textContent.includes('cap.png'));
    assert.equal(ui.requests.filter(item => item.path === 'agent').length, 1);
    assert.equal(ui.requests.some(item => (item.path === 'images' || item.path === 'generations') && item.body), false);
  } finally { await ui.close(); }
});

test('a text reply can choose video for an unclear referenced request', async () => {
  const ui = await app();
  try {
    await ui.attach();
    let composer = ui.document.querySelector('#composer'); composer.elements.message.value = '用参考图生成一个'; ui.submit(composer);
    await until(() => ui.document.querySelector('[data-action="choose-media"]'), 'media clarification');
    composer = ui.document.querySelector('#composer'); composer.elements.message.value = '视频'; ui.submit(composer);
    await until(() => ui.document.querySelector('[data-form="generation"]'), 'chosen video draft');
    const form = ui.document.querySelector('[data-form="generation"]');
    assert.equal(form.elements.prompt.value, '用参考图生成一个'); assert.ok(form.textContent.includes('cap.png'));
    assert.equal(ui.document.querySelector('[data-form="image-generation"]'), null);
  } finally { await ui.close(); }
});

const manyAccounts = Array.from({ length: 65 }, (_, index) => ({
  id: String(1000 + index), name: `品牌${index}`, alias: `Brand ${index}`, platform: index % 2 ? 'YouTube' : 'TikTok',
  country: index < 45 ? index % 2 ? '美国' : 'US' : index < 60 ? 'GB' : '', authStatus: 20, authorization: '已授权'
}));
const manyWorks = [1000, 1001].flatMap(accountId => Array.from({ length: accountId === 1000 ? 47 : 21 }, (_, index) => ({
  id: `work-${accountId}-${index}`, accountId: String(accountId), title: `作品${accountId}-${index}`, status: 'completed', updated: 1000000 + index, zone: 'UTC'
})));
function scrollBottom(ui, container) {
  Object.defineProperties(container, {clientHeight: {configurable:true,value:300},scrollHeight:{configurable:true,value:2000}});
  container.scrollTop = 1700;
  container.dispatchEvent(new ui.window.Event('scroll'));
}
async function accountPage() {
  const ui = await app({ initialAccounts: manyAccounts, initialPublications: manyWorks });
  ui.window.location.hash = '#accounts';
  await until(() => ui.document.querySelector('#account-country'), 'accounts page');
  return ui;
}

test('account and work lists independently add 20 rows on scroll and reset works when changing accounts', async () => {
  const ui = await accountPage(); const {document} = ui;
  try {
    const left = document.querySelector('#account-table');
    assert.equal(left.querySelectorAll('tbody tr').length,20);
    assert.equal(document.querySelectorAll('#account-works .work-row').length,20);
    scrollBottom(ui,left);
    assert.equal(left.querySelectorAll('tbody tr').length,40); assert.equal(left.scrollTop,1700);
    assert.equal(document.querySelectorAll('#account-works .work-row').length,20);
    scrollBottom(ui,left); assert.equal(left.querySelectorAll('tbody tr').length,60);
    scrollBottom(ui,left); assert.equal(left.querySelectorAll('tbody tr').length,65);
    assert.equal(left.querySelector('[data-action="load-account-list"]'),null);
    const right = document.querySelector('#account-works');
    scrollBottom(ui,right); assert.equal(right.querySelectorAll('.work-row').length,40);
    assert.equal(left.querySelectorAll('tbody tr').length,65); assert.equal(right.scrollTop,1700);
    scrollBottom(ui,right); assert.equal(right.querySelectorAll('.work-row').length,47);
    assert.equal(right.querySelector('[data-action="load-account-list"]'),null);
    assert.equal(right.querySelector('.work-row strong').textContent,'作品1000-46');
    document.querySelector('[data-action="account"][data-id="1001"]').click();
    assert.equal(document.querySelectorAll('#account-works .work-row').length,20);
    assert.equal(document.querySelector('#account-works').scrollTop,0); assert.equal(left.scrollTop,1700);
  } finally { await ui.close(); }
});

test('country, platform and search filters combine across the whole loaded account catalog and restart at 20', async () => {
  const ui = await accountPage(); const {document} = ui;
  try {
    const country = document.querySelector('#account-country');
    assert.equal([...country.options].filter(option => option.value==='US').length,1);
    assert.ok([...country.options].some(option => option.value==='__unknown__'));
    ui.change(country,'US');
    let left = document.querySelector('#account-table');
    assert.equal(left.querySelectorAll('tbody tr').length,20); assert.ok(left.textContent.includes('20 / 45'));
    assert.ok([...left.querySelectorAll('tbody tr')].every(row => row.children[2].textContent==='美国（US）'));
    left.querySelector('[data-action="load-account-list"]').click();
    assert.equal(left.querySelectorAll('tbody tr').length,40);
    ui.change(document.querySelector('#account-filter'),'YouTube');
    assert.equal(left.querySelectorAll('tbody tr').length,20); assert.equal(left.scrollTop,0);
    assert.ok([...left.querySelectorAll('tbody tr')].every(row => row.children[1].textContent==='YouTube'));
    const search = document.querySelector('#account-search'); search.value='Brand 43'; search.dispatchEvent(new ui.window.Event('input',{bubbles:true}));
    assert.equal(left.querySelectorAll('tbody tr').length,1); assert.ok(left.textContent.includes('品牌43'));
    search.value='missing'; search.dispatchEvent(new ui.window.Event('input',{bubbles:true}));
    assert.equal(left.querySelectorAll('tbody tr').length,0); assert.ok(document.querySelector('#account-detail').textContent.includes('选择社媒账号'));
    search.value=''; search.dispatchEvent(new ui.window.Event('input',{bubbles:true}));
    ui.change(document.querySelector('#account-filter'),''); ui.change(country,'__unknown__');
    assert.equal(left.querySelectorAll('tbody tr').length,5); assert.ok(left.textContent.includes('品牌64'));
    assert.ok(document.querySelector('#account-works').textContent.includes('尚无发布作品'));
  } finally { await ui.close(); }
});

function taskFixtures() {
  const publications = Array.from({length:83}, (_,index) => ({id:`task-${index}`,accountId:String(1000+index%2),title:`发布标题${index}`,status:['completed','scheduled','queued'][index%3],created:1000000+index,updated:2000000+index,zone:'UTC'}));
  const generations = Array.from({length:57}, (_,index) => ({id:`video-${index}`,mode:'mock',status:'completed',created:1000000+index,expiresAt:Date.now()+86400000,
    url:'https://example.com/video.mp4',parameters:{model:'smartbiai-sd-2-0-mini-260619',prompt:`视频创作${index}`,duration:6}}));
  const images = Array.from({length:43}, (_,index) => ({id:`image-${index}`,mode:'mock',status:'completed',created:1000000+index,
    parameters:{model:'smartbiai-gpt-img-2',prompt:`图片创作${index}`,n:1},results:[{index:0,status:'succeeded',url:'https://example.com/image.png'}]}));
  return {publications,generations,images};
}

async function taskPage() {
  const fixtures=taskFixtures();
  const ui=await app({initialAccounts:manyAccounts,initialPublications:fixtures.publications,initialGenerations:fixtures.generations,initialImages:fixtures.images});
  ui.window.location.hash='#tasks';
  await until(()=>ui.document.querySelector('#task-table.record-scroll'),'task page');
  return {...ui,fixtures};
}

test('publication, video and image tabs each append 20 records until the final partial batch', async () => {
  const ui=await taskPage(); const {document}=ui;
  try {
    for(const [tab,total] of [['all',83],['scheduled',28],['publishing',27],['completed',28],['generation',57],['image',43]]) {
      document.querySelector(`[data-action="task-tab"][data-tab="${tab}"]`).click();
      const container=document.querySelector('#task-table');
      assert.equal(container.querySelectorAll('tbody tr').length,20,tab);
      for(let count=40;count<total+20;count+=20){
        scrollBottom(ui,container);
        assert.equal(container.querySelectorAll('tbody tr').length,Math.min(count,total),tab);
        assert.equal(container.scrollTop,1700,tab);
      }
      assert.equal(container.querySelector('[data-action="load-task-list"]'),null,tab);
      assert.ok(container.textContent.includes(`已显示全部 ${total} 条`),tab);
      assert.equal(document.querySelector('.task-panel > .toolbar').hidden,['generation','image'].includes(tab));
    }
  } finally { await ui.close(); }
});

test('task filtering resets batches and live updates preserve list and detail scroll positions', async () => {
  const ui=await taskPage();const {document}=ui;
  try {
    const container=document.querySelector('#task-table');
    scrollBottom(ui,container); assert.equal(container.querySelectorAll('tbody tr').length,40);
    document.querySelector('[data-action="task"][data-id="task-21"]').click();
    assert.equal(document.querySelector('#task-detail').hidden,false);
    document.querySelector('#task-detail').scrollTop=75;
    ui.fixtures.publications[21].title='更新后的发布标题';
    await until(()=>container.textContent.includes('更新后的发布标题'),'background task update');
    assert.equal(container.querySelectorAll('tbody tr').length,40);
    assert.equal(container.scrollTop,1700);assert.equal(document.querySelector('#task-detail').scrollTop,75);
    document.querySelector('[data-action="close-task"]').click();
    assert.equal(container.scrollTop,1700);assert.equal(document.querySelector('#task-detail').hidden,true);
    document.querySelector('[data-action="task"][data-id="task-21"]').click();
    assert.equal(document.querySelector('#task-detail').scrollTop,0);
    document.querySelector('[data-action="close-task"]').click();
    ui.change(document.querySelector('#task-account'),'1001');
    assert.equal(container.querySelectorAll('tbody tr').length,20);assert.equal(container.scrollTop,0);
    container.querySelector('[data-action="load-task-list"]').click();assert.equal(container.querySelectorAll('tbody tr').length,40);
    const search=document.querySelector('#task-search');search.value='发布标题81';search.dispatchEvent(new ui.window.Event('input',{bubbles:true}));
    assert.equal(container.querySelectorAll('tbody tr').length,1);assert.ok(container.textContent.includes('发布标题81'));
    search.value='not found';search.dispatchEvent(new ui.window.Event('input',{bubbles:true}));
    assert.equal(container.querySelectorAll('tbody tr').length,0);assert.ok(container.textContent.includes('没有符合条件的发布任务'));
  } finally { await ui.close(); }
});

test('video and image actions remain available after loading later batches', async () => {
  const ui=await taskPage();const {document}=ui;
  try {
    document.querySelector('[data-tab="generation"]').click();scrollBottom(ui,document.querySelector('#task-table'));
    document.querySelector('[data-action="preview-video"][data-id="video-35"]').click();
    assert.equal(document.querySelector('#video-dialog').open,true);
    assert.ok(document.querySelector('#video-dialog video').src.includes('example.com/video.mp4'));
    document.querySelector('#video-dialog').close();
    document.querySelector('[data-tab="image"]').click();scrollBottom(ui,document.querySelector('#task-table'));
    document.querySelector('[data-action="open-image-result"][data-id="image-35"]').click();
    await until(()=>document.querySelector('[data-image-result="image-35"]'),'image result from a later page');
    document.querySelector('[data-action="preview-image"][data-id="image-35"]').click();
    assert.equal(document.querySelector('#image-dialog').open,true);
  } finally { await ui.close(); }
});
