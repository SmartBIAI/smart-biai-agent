import { accountCountry, matchesAccount, tagColors } from './account-properties.js';

export function createAccountTagControls({ document, request, notify, changed, getMode, getAccounts }) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let data = { scope: '', tags: [], assignments: {}, revisions: {} };
  const filters = { platforms: [], countries: [], tags: [], tagMatch: 'any', untagged: false };
  const selection = new Set();
  let busy = false, dialogState = null;
  const dialog = document.createElement('dialog');
  dialog.id = 'account-tags-dialog'; dialog.className = 'account-tags-dialog'; dialog.setAttribute('aria-labelledby', 'account-tags-title');
  document.body.append(dialog);
  const tagsFor = account => account.tagScope && account.tagScope !== data.scope ? [] : !Object.hasOwn(data.revisions, account.id) && account.tags ? account.tags : (data.assignments[account.id] || []).map(id => data.tags.find(tag => tag.id === id)).filter(Boolean);
  const badge = tag => `<span class="account-tag tag-${Object.hasOwn(tagColors, tag.color) ? tag.color : 'gray'}">${esc(tag.name)}</span>`;
  function badges(account, limit = 2) {
    const tags = tagsFor(account);
    return tags.length ? `<span class="account-tag-list">${tags.slice(0, limit).map(badge).join('')}${tags.length > limit ? `<span class="tag-overflow" hidden>${tags.slice(limit).map(badge).join('')}</span><button type="button" class="tag-more" data-tag-action="expand" aria-expanded="false" aria-label="展开其余 ${tags.length - limit} 个标签">＋${tags.length - limit}</button>` : ''}</span>` : '<span class="muted account-untagged">未打标签</span>';
  }
  function setData(next) {
    next ||= { scope: '', tags: [], assignments: {}, revisions: {} };
    if (data.scope !== next.scope) { resetFilters(); if (dialog.open) dialog.close(); }
    data = { ...next, tags: next.tags || [], assignments: next.assignments || {}, revisions: next.revisions || {} };
    filters.tags = filters.tags.filter(id => data.tags.some(tag => tag.id === id));
  }
  function resetFilters() { Object.assign(filters, { platforms: [], countries: [], tags: [], tagMatch: 'any', untagged: false }); selection.clear(); }
  function menu(key, label, options) {
    return `<details class="account-filter" data-filter-menu="${key}"><summary><span data-filter-title="${key}">${label}</span><span aria-hidden="true">⌄</span></summary><div class="account-filter-popover"><input type="search" data-filter-search="${key}" aria-label="搜索${label}" placeholder="搜索${label}"><div class="filter-options">${key === 'tags' ? '<label class="filter-option"><input type="checkbox" data-untagged>未打标签</label>' : ''}${options.map(option => `<label class="filter-option" data-option-label="${esc(option.label.toLowerCase())}"><input type="checkbox" data-account-filter="${key}" value="${esc(option.value)}"${filters[key].includes(option.value) ? ' checked' : ''}>${option.html || esc(option.label)}</label>`).join('')}${options.length ? '' : '<p class="field-note">暂无可选项</p>'}</div>${key === 'tags' ? '<label class="filter-match">多个标签<select data-tag-match aria-label="标签匹配方式"><option value="any">匹配任一</option><option value="all">包含全部</option></select></label>' : ''}</div></details>`;
  }
  function filtersHTML() {
    const accounts = getAccounts();
    const platforms = [...new Set(accounts.map(account => account.platform).filter(Boolean))].sort();
    const countries = [...new Map(accounts.map(account => { const country = accountCountry(account); return [country.value, country]; })).values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
    return `${menu('platforms', '平台', platforms.map(value => ({ value, label: value })))}${menu('countries', '国家', countries.map(country => ({ value: country.value, label: country.label })))}${menu('tags', '标签', data.tags.map(tag => ({ value: tag.id, label: tag.name, html: badge(tag) })))}<button type="button" class="text-button" data-tag-action="clear-filters">清空筛选</button><div id="account-filter-chips" class="account-filter-chips" hidden></div>`;
  }
  function syncDOM(visible = []) {
    for (const [key, label] of Object.entries({ platforms: '平台', countries: '国家', tags: '标签' })) {
      const title = document.querySelector(`[data-filter-title="${key}"]`);
      if (title) title.textContent = `${label}${filters[key].length ? ` · ${filters[key].length}` : key === 'tags' && filters.untagged ? ' · 未打标签' : ''}`;
    }
    for (const input of document.querySelectorAll('[data-account-filter]')) input.checked = filters[input.dataset.accountFilter].includes(input.value);
    const untagged = document.querySelector('[data-untagged]'); if (untagged) untagged.checked = filters.untagged;
    const match = document.querySelector('[data-tag-match]'); if (match) match.value = filters.tagMatch;
    const chips = document.querySelector('#account-filter-chips');
    if (chips) {
      const items = Object.entries(filters).flatMap(([key, values]) => Array.isArray(values) ? values.map(value => ({ key, value, label: key === 'countries' ? accountCountry({ country: value === '__unknown__' ? '' : value }).label : key === 'tags' ? data.tags.find(tag => tag.id === value)?.name || value : value })) : []);
      if (filters.untagged) items.push({ key: 'untagged', value: '', label: '未打标签' });
      chips.hidden = !items.length;
      chips.innerHTML = items.map(item => `<button type="button" class="filter-chip" data-tag-action="remove-filter" data-key="${item.key}" data-value="${esc(item.value)}">${esc(item.label)}<span aria-hidden="true">×</span></button>`).join('');
    }
    const bar = document.querySelector('#account-batch-bar');
    if (bar) { bar.hidden = !selection.size; bar.querySelector('[data-selection-count]').textContent = `已选 ${selection.size} 个账号`; }
    const all = document.querySelector('[data-select-accounts]');
    if (all) { all.checked = Boolean(visible.length) && visible.every(account => selection.has(account.id)); all.indeterminate = visible.some(account => selection.has(account.id)) && !all.checked; all.setAttribute('aria-label', `选择已加载的 ${visible.length} 个账号`); }
  }
  function selectionHTML(id) { return `<input type="checkbox" data-select-account="${esc(id)}" aria-label="选择账号 ${esc(id)}"${selection.has(id) ? ' checked' : ''}>`; }
  function batchHTML() { return '<div id="account-batch-bar" class="account-batch-bar" hidden><strong data-selection-count></strong><button type="button" class="text-button" data-tag-action="bulk-add">添加标签</button><button type="button" class="text-button" data-tag-action="bulk-remove">移除标签</button><button type="button" class="text-button" data-tag-action="clear-selection">取消选择</button></div>'; }
  function detailHTML(account) {
    return `<div class="account-properties"><span>平台<strong>${esc(account.platform)}</strong></span><span>国家<strong>${esc(accountCountry(account).label)}</strong></span></div><div class="account-label-heading"><strong>账号标签</strong><button type="button" class="text-button" data-tag-action="edit-account" data-account-id="${esc(account.id)}"${data.scope ? '' : ' disabled'}>编辑标签</button></div><div class="account-detail-tags">${badges(account, 10)}</div>`;
  }
  const colorOptions = color => Object.entries(tagColors).map(([value, name]) => `<option value="${value}"${value === color ? ' selected' : ''}>${name}</option>`).join('');
  function tagForm(tag, inline = false) {
    return `<form data-tag-form="${inline ? 'quick-create' : 'save-tag'}" class="tag-create-form"><label>${inline ? '新建标签' : tag ? '编辑标签' : '新建标签'}<input name="name" required maxlength="40" placeholder="1～20 个字符" value="${esc(tag?.name || '')}"></label><label>颜色<select name="color">${colorOptions(tag?.color || 'purple')}</select></label><button class="button${inline ? '' : ' primary'}" type="submit">${tag ? '保存修改' : '创建标签'}</button>${tag ? '<button type="button" class="text-button" data-tag-action="cancel-edit">取消编辑</button>' : ''}</form>`;
  }
  function renderDialog() {
    const current = dialogState;
    if (!current) return;
    const manager = current.kind === 'manager';
    const title = manager ? '管理账号标签' : current.kind === 'delete' ? '删除账号标签' : current.kind === 'edit' ? '编辑账号标签' : current.action === 'add' ? '批量添加标签' : '批量移除标签';
    let content;
    if (manager) {
      content = `<p class="field-note">标签仅保存在本工作台，供当前应用的账号分类使用。</p>${tagForm(data.tags.find(tag => tag.id === current.editing))}<label class="tag-search-label">查找标签<input type="search" data-tag-search placeholder="搜索标签名称" value="${esc(current.search || '')}"></label><div class="tag-manager-list">${data.tags.map(tag => `<div class="tag-manager-row" data-tag-name="${esc(tag.name.toLowerCase())}">${badge(tag)}<span class="muted">${tag.count} 个账号</span><button class="text-button" type="button" data-tag-action="rename" data-tag-id="${esc(tag.id)}">编辑</button><button class="text-button danger" type="button" data-tag-action="delete" data-tag-id="${esc(tag.id)}">删除</button></div>`).join('') || '<p class="empty-note">还没有标签，创建后即可为账号分类。</p>'}</div>`;
    } else if (current.kind === 'delete') {
      content = `<p>删除 ${badge(current.tag)}？</p><p class="field-note">该标签关联 ${current.tag.count} 个账号，删除后会从这些账号中移除。账号和发布任务会保留。</p><div class="dialog-actions"><button class="button" type="button" data-tag-action="cancel-delete">返回</button><button class="button danger" type="button" data-tag-action="confirm-delete">确认删除</button></div>`;
    } else {
      const name = current.kind === 'edit' ? getAccounts().find(account => account.id === current.accountIds[0])?.name || current.accountIds[0] : `${current.accountIds.length} 个已选账号`;
      content = `<p class="field-note">${esc(name)} · ${current.kind === 'edit' ? '每个账号最多 10 个标签，保存后生效。' : `仅对这些账号${current.action === 'add' ? '添加' : '移除'}所选标签，其他标签保留。`}</p><label>查找标签<input type="search" data-tag-search placeholder="搜索标签名称" value="${esc(current.search || '')}"></label><form data-tag-form="assign"><div class="tag-choice-list">${data.tags.map(tag => `<label class="tag-choice" data-tag-name="${esc(tag.name.toLowerCase())}"><input type="checkbox" name="tag" value="${esc(tag.id)}"${current.selected.has(tag.id) ? ' checked' : ''}>${badge(tag)}<span class="muted">${tag.count} 个账号</span></label>`).join('') || '<p class="empty-note">还没有可选标签，可在下方新建。</p>'}</div><div class="dialog-actions"><button type="button" class="button" data-tag-action="close">取消</button><button type="submit" class="button primary">${current.kind === 'edit' ? '保存标签' : '确认' + (current.action === 'add' ? '添加' : '移除')}</button></div></form>${current.action !== 'remove' ? tagForm(null, true) : ''}`;
    }
    dialog.innerHTML = `<div class="detail-title"><h2 id="account-tags-title">${title}</h2><button type="button" class="icon-button" data-tag-action="close" aria-label="关闭标签窗口">×</button></div>${content}<p class="form-error" data-tag-error role="alert" hidden></p>`;
    applyTagSearch(current.search || '');
    if (busy) for (const field of dialog.querySelectorAll('button,input,select')) field.disabled = true;
  }
  function applyTagSearch(value) { for (const row of dialog.querySelectorAll('[data-tag-name]')) row.hidden = !row.dataset.tagName.includes(value.trim().toLowerCase()); }
  function showError(message) { const error = dialog.querySelector('[data-tag-error]'); if (error) { error.textContent = message; error.hidden = false; } else notify(message); }
  async function run(work) {
    if (busy) return;
    busy = true;
    for (const field of dialog.querySelectorAll('button,input,select')) field.disabled = true;
    try { await work(); } catch (error) { showError(error.message); }
    finally { busy = false; for (const field of dialog.querySelectorAll('button,input,select')) field.disabled = false; }
  }
  async function mutate(path, body) {
    const scope = data.scope, mode = getMode();
    const next = await request(path, { ...body, scope }, mode);
    if (mode !== getMode() || scope !== next.scope || data.scope !== scope) throw new Error('账号连接已变化，请刷新工作台后重试。');
    setData(next); changed({ reset: false, metadata: true });
    return next;
  }
  async function open(kind, accountIds = [], action = 'replace') {
    if (!data.scope) { notify('请先连接社媒服务并加载账号。'); return; }
    await run(async () => {
      const mode = getMode(), scope = data.scope;
      const latest = await request('account-tags');
      if (mode !== getMode() || scope !== latest.scope) throw new Error('账号连接已变化，请刷新工作台后重试。');
      setData(latest);
      dialogState = { kind, accountIds, action, selected: new Set(kind === 'edit' ? data.assignments[accountIds[0]] || [] : []), revision: data.revisions[accountIds[0]] || 0 };
      renderDialog(); if (!dialog.open) dialog.showModal();
      dialog.querySelector('input')?.focus();
    });
  }
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialogState = null; dialog.replaceChildren(); });
  dialog.addEventListener('input', event => { if (event.target.matches('[data-tag-search]')) { dialogState.search = event.target.value; applyTagSearch(event.target.value); } });
  dialog.addEventListener('change', event => { if (event.target.name === 'tag') { if (event.target.checked) dialogState.selected.add(event.target.value); else dialogState.selected.delete(event.target.value); } });
  dialog.addEventListener('submit', event => {
    const form = event.target.closest('[data-tag-form]'); if (!form) return;
    event.preventDefault();
    const kind = form.dataset.tagForm;
    const body = kind === 'assign' ? { accountIds: dialogState.accountIds, action: dialogState.action, tagIds: [...dialogState.selected], revision: dialogState.revision } : { name: form.elements.name.value, color: form.elements.color.value };
    if (kind === 'save-tag' && dialogState.editing) { const tag = data.tags.find(tag => tag.id === dialogState.editing); Object.assign(body, { id: tag.id, revision: tag.revision }); }
    void run(async () => {
      const next = await mutate(kind === 'assign' ? 'account-tags/assign' : 'account-tags', body);
      if (kind === 'assign') { dialog.close(); notify('账号标签已保存。'); }
      else { if (kind === 'quick-create') dialogState.selected.add(next.tagId); else dialogState.editing = ''; renderDialog(); notify('标签已保存。'); }
    });
  });
  dialog.addEventListener('click', event => {
    const button = event.target.closest('[data-tag-action]'); if (!button || busy) return;
    const action = button.dataset.tagAction;
    if (action === 'close') { dialog.close(); return; }
    if (action === 'rename') dialogState.editing = button.dataset.tagId;
    if (action === 'cancel-edit') dialogState.editing = '';
    if (action === 'delete') dialogState = { kind: 'delete', tag: { ...data.tags.find(tag => tag.id === button.dataset.tagId) } };
    if (action === 'cancel-delete') dialogState = { kind: 'manager' };
    if (action === 'confirm-delete') {
      const tag = dialogState.tag;
      void run(async () => { await mutate('account-tags/delete', { id: tag.id, revision: tag.revision, expectedCount: tag.count }); dialogState = { kind: 'manager' }; renderDialog(); notify('标签已删除。'); });
      return;
    }
    renderDialog();
  });
  document.addEventListener('input', event => {
    if (!event.target.matches('[data-filter-search]')) return;
    const term = event.target.value.trim().toLowerCase();
    for (const option of event.target.closest('.account-filter').querySelectorAll('[data-option-label]')) option.hidden = !option.dataset.optionLabel.includes(term);
  });
  document.addEventListener('change', event => {
    const input = event.target;
    if (input.matches('[data-account-filter]')) {
      const key = input.dataset.accountFilter;
      filters[key] = input.checked ? [...new Set([...filters[key], input.value])] : filters[key].filter(value => value !== input.value);
      if (key === 'tags') filters.untagged = false;
    } else if (input.matches('[data-untagged]')) { filters.untagged = input.checked; if (input.checked) filters.tags = []; }
    else if (input.matches('[data-tag-match]')) filters.tagMatch = input.value;
    else if (input.matches('[data-select-account]')) { if (input.checked) selection.add(input.dataset.selectAccount); else selection.delete(input.dataset.selectAccount); changed({ selectionOnly: true }); return; }
    else if (input.matches('[data-select-accounts]')) { for (const row of document.querySelectorAll('[data-select-account]')) { if (input.checked) selection.add(row.dataset.selectAccount); else selection.delete(row.dataset.selectAccount); } changed({ selectionOnly: true }); return; }
    else return;
    selection.clear(); changed({ reset: true });
  });
  document.addEventListener('click', event => {
    for (const menu of document.querySelectorAll('.account-filter[open]')) if (!menu.contains(event.target)) menu.open = false;
    if (dialog.contains(event.target)) return;
    const button = event.target.closest('[data-tag-action]'); if (!button || busy) return;
    switch (button.dataset.tagAction) {
      case 'manage': void open('manager'); return;
      case 'edit-account': void open('edit', [button.dataset.accountId]); return;
      case 'bulk-add': case 'bulk-remove': void open('bulk', [...selection], button.dataset.tagAction === 'bulk-add' ? 'add' : 'remove'); return;
      case 'clear-selection': selection.clear(); changed({ selectionOnly: true }); return;
      case 'clear-filters': resetFilters(); changed({ reset: true, clearSearch: true }); return;
      case 'remove-filter': if (button.dataset.key === 'untagged') filters.untagged = false; else filters[button.dataset.key] = filters[button.dataset.key].filter(value => value !== button.dataset.value); selection.clear(); changed({ reset: true }); return;
      case 'expand': { const overflow = button.parentElement.querySelector('.tag-overflow'); overflow.hidden = !overflow.hidden; button.setAttribute('aria-expanded', String(!overflow.hidden)); button.textContent = overflow.hidden ? `＋${overflow.querySelectorAll('.account-tag').length}` : '收起'; return; }
    }
  });
  return { setData, filtersHTML, syncDOM, badges, tagsFor, detailHTML, selectionHTML, batchHTML, resetFilters,
    clearSelection: () => selection.clear(), isBusy: () => busy,
    matches: (account, keyword) => matchesAccount({ ...account, tags: tagsFor(account) }, { ...filters, keyword }) };
}
