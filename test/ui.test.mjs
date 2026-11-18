import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { createDemoRequest } from '../dist/demo/demo.js';

async function until(check, label) {
  for (let index = 0; index < 150; index++) { const result = check(); if (result) return result; await wait(20); }
  throw new Error(`Timed out: ${label}`);
}

async function app() {
  const { window } = new JSDOM('', { url: 'https://example.com/agent/', runScripts: 'outside-only', pretendToBeVisual: true });
  window.HTMLDialogElement.prototype.showModal ||= function () { this.open = true; };
  window.HTMLDialogElement.prototype.close ||= function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.HTMLElement.prototype.scrollTo ||= function () {};
  let clock = Date.now();
  const requests = [];
  const storage = new Map();
  const request = createDemoRequest({ storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, key: 'ui', now: () => clock });
  window.fetch = async (url, options = {}) => {
    const path = String(url).split('/api/')[1];
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, body });
    try { const data = await request(path, body); return { ok: true, status: 200, json: async () => data }; }
    catch (error) { return { ok: false, status: error.status || 500, json: async () => ({ error: error.message }) }; }
  };
  const html = (await readFile(new URL('../web/index.html', import.meta.url), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.document.write(html);
  const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replaceAll('import.meta.url', JSON.stringify('https://example.com/agent/app.js'));
  await window.eval(`(async () => { ${source}\n })()`);
  return { window, document: window.document, requests, advance: () => { clock += 2000; },
    change(element, value) { element.value = value; element.dispatchEvent(new window.Event('change', { bubbles: true })); },
    submit(form) { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
    async close() { window.close(); } };
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
