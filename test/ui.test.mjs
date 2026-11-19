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

async function app({ agentReply, initialAccounts, initialPublications, initialGenerations, initialImages, initialConversations, agentPlanner, agentEnabled } = {}) {
  const { window } = new JSDOM('', { url: 'https://example.com/agent/', runScripts: 'outside-only', pretendToBeVisual: true });
  window.HTMLDialogElement.prototype.showModal ||= function () { this.open = true; };
  window.HTMLDialogElement.prototype.close ||= function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.HTMLElement.prototype.scrollTo ||= function () {};
  window.normalizeGenerationIntent = normalizeGenerationIntent;
  let clock = Date.now();
  window.Date.now = () => clock;
  const requests = [];
  const storage = new Map();
  if(agentEnabled)storage.set('ui',JSON.stringify({generations:initialGenerations||[],images:initialImages||[],publications:initialPublications||[],conversations:initialConversations||[]}));
  const request = createMockRequest({ storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, key: 'ui', now: () => clock, planner:agentPlanner });
  window.fetch = async (url, options = {}) => {
    const path = String(url).split('/api/')[1];
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    requests.push({ path, body });
    try {
      let data = path === 'files' ? { id: 'ff5a283c-aec3-4c8e-828f-4146cde85334', name: body.name, size: body.size } : path === 'agent' && agentReply ? agentReply : await request(path, body);
      if (path === 'bootstrap' && initialAccounts) data = { ...data, accounts: initialAccounts };
      if (path === 'bootstrap' && agentEnabled) data = { ...data, agent:{enabled:true} };
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
  return { window, document: window.document, requests, advance: (milliseconds = 20000) => { clock += milliseconds; },
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

test('Agent protocol restores a failed task, switches model and retains references without submitting generation',async()=>{
  const file={id:'ff5a283c-aec3-4c8e-828f-4146cde85334',name:'original.jpg',size:128,type:'image'};
  const sourceId='308c1704-7a84-4d36-8355-8007b16f4811',conversationId='4c9d4950-50a3-44a8-bcca-d867dd3d0ac2';
  const image={id:sourceId,mode:'mock',status:'failed',created:Date.now(),credits:5,parameters:{model:'smartbiai-gpt-img-2-6-sunburst',prompt:'保留原始参考图中的产品外观和场景构图。',n:1,size:'1024x1024',quality:'auto',fileIds:[file.id],references:[],maskFileId:null},results:[],error:'测试失败记录'};
  const initialConversation={id:conversationId,title:'原始创作',revision:1,updated:Date.now(),chat:[{type:'user',text:'原始需求',files:[file]},{type:'image-result',id:sourceId}],drafts:[]};
  const plans=[];
  const planner=async state=>{
    plans.push(structuredClone(state));
    return state.observations.length?{calls:[{tool:'respond',arguments:{text:'沿用原素材，已准备另一模型的草稿，请确认。'}}]}:
      {calls:[{tool:'prepare_generation',arguments:{kind:'image',source:{kind:'image',id:sourceId},changes:{model:'smartbiai-gpt-img-2'}}}]};
  };
  const ui=await app({agentEnabled:true,agentPlanner:planner,initialImages:[image],initialConversations:[initialConversation]});
  try{
    const composer=ui.document.querySelector('#composer');composer.elements.message.value='保留前面的设置，用另一款已开通模型再试一下。';ui.submit(composer);
    await until(()=>ui.document.querySelector('[data-form="image-generation"]'),'Agent retry draft');
    const form=ui.document.querySelector('[data-form="image-generation"]');
    const messages = [...ui.document.querySelectorAll('.message')];
    assert.ok(messages.findIndex(item => item.textContent.includes('沿用原素材，已准备另一模型的草稿，请确认。')) < messages.findIndex(item => item.contains(form)));
    assert.equal(form.elements.model.value,'smartbiai-gpt-img-2');assert.equal(form.elements.prompt.value,image.parameters.prompt);
    assert.ok(form.textContent.includes(file.name));assert.equal(form.querySelector('button[type=submit]').textContent,'确认生成图片');
    assert.equal(ui.requests.some(request=>request.path==='images'&&request.body),false);
    const request=ui.requests.find(request=>request.path==='agent').body;
    assert.equal(request.protocol,'agent.v1');assert.equal(request.conversationId,conversationId);assert.ok(request.revision>1);
    assert.equal(Object.hasOwn(request,'history'),false);assert.equal(plans[0].context.resources.find(item=>item.id===sourceId).status,'failed');
    assert.ok(ui.document.querySelector(`[data-image-result="${sourceId}"]`));
    ui.submit(form);await until(()=>ui.requests.some(request=>request.path==='images'&&request.body),'confirmed retry submission');
    const submitted=ui.requests.find(request=>request.path==='images'&&request.body).body;
    assert.notEqual(submitted.id,sourceId);assert.deepEqual(submitted.fileIds,[file.id]);
  }finally{await ui.close();}
});

test('the result adjustment button uses a structured tool action and keeps explicit confirmation',async()=>{
  const initialConversation={id:'4c9d4950-50a3-44a8-bcca-d867dd3d0ac2',title:'创作记录',revision:1,updated:Date.now(),chat:[{type:'user',text:'原始创作'},{type:'image-result',id:'308c1704-7a84-4d36-8355-8007b16f4811'}],drafts:[]};
  const image={id:'308c1704-7a84-4d36-8355-8007b16f4811',mode:'mock',status:'failed',created:Date.now(),parameters:{model:'smartbiai-gpt-img-2',prompt:'原始参考场景',n:1,size:'1024x1024',quality:'auto',fileIds:[],references:[],maskFileId:null},results:[]};
  const ui=await app({agentEnabled:true,initialImages:[image],initialConversations:[initialConversation]});
  try{
    ui.document.querySelector('[data-action="agent-adjust"]').click();
    await until(()=>ui.document.querySelector('[data-form="image-generation"]'),'adjustment draft');
    assert.equal(ui.requests.find(request=>request.path==='agent').body.command.tool,'prepare_generation');
    assert.equal(ui.document.querySelector('[data-form="image-generation"]').elements.prompt.value,image.parameters.prompt);
    assert.equal(ui.requests.some(request=>request.path==='images'&&request.body),false);
  }finally{await ui.close();}
});

test('draft controls cannot be edited or confirmed while a multi-turn operation is pending',async()=>{
  const id='308c1704-7a84-4d36-8355-8007b16f4811';let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const conversation={id:'4c9d4950-50a3-44a8-bcca-d867dd3d0ac2',title:'待确认创作',revision:1,updated:Date.now(),chat:[{type:'user',text:'初始创作'},{type:'image-generation',id}],drafts:[{id,kind:'image',parameters:{model:'smartbiai-gpt-img-2',prompt:'初始产品图',n:1,size:'1024x1024',quality:'auto'},links:[],files:[],credits:5}]};
  const planner=async state=>{
    if(state.observations.length)return {calls:[{tool:'respond',arguments:{text:'草稿已更新，请确认。'}}]};
    await gate;return {calls:[{tool:'prepare_generation',arguments:{kind:'image',source:{kind:'draft',id},changes:{n:2}}}]};
  };
  const ui=await app({agentEnabled:true,agentPlanner:planner,initialConversations:[conversation]});
  try{
    const form=ui.document.querySelector('[data-form="image-generation"]'),composer=ui.document.querySelector('#composer');
    composer.elements.message.value='调整当前草稿，其余保留。';ui.submit(composer);
    await until(()=>ui.document.querySelector('[data-form="image-generation"]').elements.prompt.disabled,'pending controls');
    const pendingForm=ui.document.querySelector('[data-form="image-generation"]');
    assert.equal(pendingForm.querySelector('button[type=submit]').disabled,true);ui.submit(pendingForm);
    assert.equal(ui.requests.some(request=>request.path==='images'&&request.body),false);
    release();
    await until(()=>ui.document.querySelector('[data-form="image-generation"]').elements.n.value==='2','updated draft');
    assert.equal(ui.document.querySelector('[data-form="image-generation"]').elements.prompt.disabled,false);
  }finally{release();await ui.close();}
});

test('queued image slots show progress without unavailable-link placeholders and preserve ready image indices', async () => {
  const id = '308c1704-7a84-4d36-8355-8007b16f4811';
  const image = { id, mode: 'mock', status: 'generating', created: Date.now(), parameters: { model: 'smartbiai-gpt-img-2', prompt: '产品场景图', n: 3 }, results: [
    { index: 0, status: 'queued' }, { index: 1, status: 'succeeded', url: 'https://example.com/ready.png' }, { index: 2, status: 'generating' }
  ] };
  const conversation = { id: '4c9d4950-50a3-44a8-bcca-d867dd3d0ac2', title: '图片生成中', revision: 1, chat: [{ type: 'image-result', id }], drafts: [] };
  const ui = await app({ agentEnabled: true, initialImages: [image], initialConversations: [conversation] });
  try {
    const card = ui.document.querySelector('[data-image-result]');
    assert.ok(card.querySelector('.progress i'));
    assert.equal(card.querySelectorAll('.image-placeholder').length, 0);
    assert.ok(!card.textContent.includes('暂无可用链接'));
    const ready = card.querySelector('[data-action="preview-image"]');
    assert.equal(ready.dataset.index, '1');
    ready.click();
    assert.equal(ui.document.querySelector('#image-dialog img').src, 'https://example.com/ready.png');
  } finally { await ui.close(); }
});

test('generation errors retain full safe text in chat, lists and dialogs with keyboard and click details', async () => {
  const reason = '模型返回：<img src=x onerror=alert(1)>\n' + '请更换参考素材，再检查生成参数。'.repeat(120);
  const videoId = '99f3f515-ed67-463d-801a-2f0ba6d151d3', imageId = '308c1704-7a84-4d36-8355-8007b16f4811';
  const video = { id: videoId, mode: 'mock', status: 'failed', error: reason, created: Date.now(), parameters: { model: 'smartbiai-sd-2-0-mini-260619', prompt: '视频测试', duration: 6 } };
  const image = { id: imageId, mode: 'mock', status: 'partial', error: reason, created: Date.now(), parameters: { model: 'smartbiai-gpt-img-2', prompt: '图片测试', n: 2 }, results: [{ index: 0, status: 'failed', error: '第一张校验失败' }] };
  const conversation = { id: '4c9d4950-50a3-44a8-bcca-d867dd3d0ac2', title: '失败原因', revision: 1, chat: [{ type: 'result', id: videoId }, { type: 'image-result', id: imageId }], drafts: [] };
  const ui = await app({ agentEnabled: true, initialImages: [image], initialGenerations: [video], initialConversations: [conversation] });
  try {
    const { document, window } = ui;
    const trigger = document.querySelector('[data-result] [data-error-detail]');
    assert.equal(trigger.querySelector('.error-summary').textContent, reason);
    assert.equal(trigger.querySelector('img'), null);
    trigger.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    const tooltip = document.querySelector('#generation-error-tooltip');
    assert.equal(tooltip.hidden, false); assert.equal(tooltip.textContent, reason); assert.equal(tooltip.querySelector('img'), null);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(tooltip.hidden, true);
    trigger.focus(); assert.equal(tooltip.hidden, false);
    trigger.click(); assert.equal(tooltip.hidden, false);
    trigger.click(); assert.equal(tooltip.hidden, true);
    assert.ok(document.querySelector('[data-image-result]').textContent.includes('第一张校验失败'));
    window.location.hash = '#tasks';
    await until(() => document.querySelector('[data-tab="generation"]'), 'task tabs');
    document.querySelector('[data-tab="generation"]').click();
    assert.equal(document.querySelector('#task-table .error-summary').textContent, reason);
    document.querySelector('[data-action="preview-video"]').click();
    const dialogTrigger = document.querySelector('#video-dialog [data-error-detail]');
    dialogTrigger.click();
    assert.equal(tooltip.closest('dialog')?.id, 'video-dialog');
    assert.equal(tooltip.textContent, reason);
    document.querySelector('#video-dialog').close();
    document.querySelector('[data-tab="image"]').click();
    assert.equal(document.querySelector('#task-table .error-summary').textContent, reason);
  } finally { await ui.close(); }
});

test('background image and video reads follow independent 10-second and 15-second intervals', async () => {
  const ui = await app();
  const count = path => ui.requests.filter(item => item.path === path && !item.body).length;
  try {
    const images = count('images'), videos = count('generations');
    ui.advance(9999); await wait(1100);
    assert.equal(count('images'), images); assert.equal(count('generations'), videos);
    ui.advance(1); await until(() => count('images') === images + 1, '10-second image read');
    assert.equal(count('generations'), videos);
    ui.advance(5000); await until(() => count('generations') === videos + 1, '15-second video read');
    assert.equal(count('images'), images + 1);
  } finally { await ui.close(); }
});

test('historical Agent explanations display before their generation form and remain before it after a new turn', async () => {
  const id = '308c1704-7a84-4d36-8355-8007b16f4811';
  const conversation = { id: '4c9d4950-50a3-44a8-bcca-d867dd3d0ac2', title: '历史草稿', revision: 1,
    chat: [{ type: 'user', text: '创作一个产品图' }, { type: 'image-generation', id }, { type: 'text', agent: true, text: '请先检查这份参数再确认。' }],
    drafts: [{ id, kind: 'image', parameters: { model: 'smartbiai-gpt-img-2', prompt: '产品图', n: 1, size: '1024x1024', quality: 'auto' }, files: [], links: [], credits: 5 }] };
  const ui = await app({ agentEnabled: true, initialConversations: [conversation] });
  try {
    const messages = [...ui.document.querySelectorAll('.message')];
    assert.ok(messages.findIndex(item => item.textContent.includes('请先检查这份参数再确认。')) < messages.findIndex(item => item.querySelector('[data-form="image-generation"]')));
    assert.equal(ui.requests.some(item => item.path === 'images' && item.body), false);
  } finally { await ui.close(); }
});
