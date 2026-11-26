const frequencyLabels = { once: '单次', daily: '每天', weekly: '每周' };
const statusLabels = {
  pending: '等待生成', generating: '生成中', review: '准备待审排期', release: '准备排期', awaiting_review: '已排期 · 待审核', scheduled: '已排期',
  queued: '等待发布', submitting: '正在发送', queued_upstream: '平台处理中', publishing: '发布中',
  completed: '发布完成', failed: '失败', expired: '素材已过期', missed: '已错过', rejected: '审核未通过',
  canceled: '已取消', unknown: '状态待确认'
};
const actionLabels = { enable: '启用规则', pause: '暂停规则', run: '立即执行一次' };
const zones = ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Jakarta', 'Asia/Kuala_Lumpur', 'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'UTC'];

export function createAutomationControls({ document, main, context, request, notify, escape, formatDate, preview }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'automation-dialog';
  dialog.setAttribute('aria-labelledby', 'automation-dialog-title');
  document.body.append(dialog);
  const esc = escape;
  let dashboard = { rules: [], runs: [] };
  let displayed = '';
  let filter = '';
  let activeRun = '';
  let loading;
  let busy = false;
  let dialogData;
  const time = (value, zone) => value ? formatDate(value, zone) : '—';
  const policy = value => value === 'auto' ? '自动发布' : '人工审核';
  const status = value => statusLabels[value] ?? value;
  const account = id => context().accounts.find(item => item.id === id);
  const accountName = id => {
    const item = account(id);
    return item ? `${item.platform} · ${item.name}` : `账号 ${id}`;
  };
  const option = (value, label, selected) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
  const button = (action, label, id = '', styling = '') => `<button type="button" class="button${styling ? ' ' + styling : ''}" data-automation-action="${action}" data-id="${esc(id)}">${label}</button>`;
  const link = (id, label) => `<a class="text-button" href="#automation/${String(id).split('/').map(encodeURIComponent).join('/')}">${label}</a>`;

  function paint() {
    const ruleList = main.querySelector('#automation-rules');
    const runList = main.querySelector('#automation-runs');
    if (!ruleList || !runList) return;
    const rules = dashboard.rules.filter(rule => !filter || rule.id === filter);
    const runs = dashboard.runs.filter(run => !filter || run.ruleId === filter);
    const rulesHTML = rules.length ? rules.map(rule => `<article class="automation-rule">
      <div class="detail-title"><h3>${esc(rule.name)}</h3><span class="badge ${rule.enabled ? 'green' : 'gray'}">${rule.enabled ? '已启用' : '未启用'}</span></div>
      <p>${esc(accountName(rule.accountId))} · ${frequencyLabels[rule.frequency]} · ${policy(rule.policy)}</p>
      <p>下次生成 ${esc(time(rule.nextAt, rule.zone))} · 发布时刻 ${esc(rule.publishAt)}（${esc(rule.zone)}）</p>
      <div class="detail-actions">${rule.enabled ? button('pause', '暂停', rule.id) : button('edit', '编辑', rule.id) + button('enable', '启用', rule.id)}
      ${button('run', '执行一次', rule.id)}${filter ? '' : link(rule.id, '查看执行记录')}</div>
    </article>`).join('') : '<p class="empty-note">还没有任务规则。新建规则后可先检查设置，再启用。</p>';
    const runsHTML = runs.length ? runs.map(run => `<article class="automation-run"${run.id === activeRun ? ' data-highlight' : ''}>
      <div class="detail-title"><h3>${esc(run.name)}</h3><span class="badge ${run.reviewable ? 'orange' : run.status === 'completed' ? 'green' : ['failed','expired','missed','rejected'].includes(run.status) ? 'red' : 'gray'}">${esc(status(run.status))}</span></div>
      <p>${esc(accountName(run.accountId))} · ${policy(run.policy)}${run.credits != null ? ` · ${esc(run.credits)} 积分报价` : ''}</p>
      <p>生成 ${esc(time(run.scheduledAt, run.zone))} · 计划发布 ${esc(time(run.publishAt, run.zone))}（${esc(run.zone)}）</p>
      ${run.reviewable && run.publishAt <= Date.now() ? '<p class="field-note">原发布时间已过，请在审核时选择新的时间。</p>' : ''}
      ${run.error ? `<p class="form-error automation-error">${esc(run.error)}</p>` : ''}
      <div class="detail-actions">${run.generationId && run.videoStatus === 'completed' ? button('preview', '预览视频', run.id) : ''}
      ${run.reviewable ? button('review', '审核排期', run.id, 'primary') : ''}
      ${run.cancelable && !run.reviewable ? button('cancel', '取消本次任务', run.id) : ''}
      ${run.publicationId ? `<a class="text-button" href="#tasks/${encodeURIComponent(run.publicationId)}">查看发布任务</a>` : ''}</div>
    </article>`).join('') : '<p class="empty-note">生成、审核及发布进度会显示在这里。</p>';
    const view = rulesHTML + runsHTML;
    if (view !== displayed) { ruleList.innerHTML = rulesHTML; runList.innerHTML = runsHTML; displayed = view; }
  }

  async function refresh() {
    if (context().page !== 'automation') return;
    const mode = context().mode;
    const route = filter;
    if (loading?.mode === mode && loading?.route === route) return;
    const ticket = { mode, route };
    loading = ticket;
    const stillHere = () => loading === ticket && context().page === 'automation' && context().mode === mode && filter === route;
    try {
      const result = await request(route ? `automation/rules/${encodeURIComponent(route)}` : 'automation', undefined, mode);
      if (!stillHere()) return;
      dashboard = result;
      paint();
      const error = main.querySelector('#automation-load-error');
      if (error) error.hidden = true;
      if (activeRun) main.querySelector('[data-highlight]')?.scrollIntoView?.({ block: 'nearest' });
      activeRun = '';
    } catch (error) {
      if (!stillHere()) return;
      const field = main.querySelector('#automation-load-error');
      if (field) { field.hidden = false; field.textContent = error.message; }
    } finally { if (loading === ticket) loading = null; }
  }

  function render(id, runId) {
    filter = id || '';
    activeRun = runId || '';
    displayed = '';
    dashboard = { rules: [], runs: [] };
    main.innerHTML = `<section class="page automation-page"><div class="account-page-heading">
      <div class="page-title"><h1>自动化任务</h1><p>按规则生成视频，再审核或按计划发布。</p></div>
      ${button('new', '新建规则', '', 'primary')}</div>
      <p id="automation-load-error" class="page-issue" role="alert" hidden></p>
      <div class="automation-layout"><section class="panel automation-panel"><div class="detail-title"><h2>任务规则</h2>
      ${filter ? '<a class="text-button" href="#automation">查看全部</a>' : ''}</div><div id="automation-rules" class="automation-scroll"><p class="empty-note">正在读取规则…</p></div></section>
      <section class="panel automation-panel"><div class="detail-title"><h2>执行记录</h2><span class="muted">最近 100 条</span></div>
      <div id="automation-runs" class="automation-scroll"><p class="empty-note">正在读取执行记录…</p></div></section></div></section>`;
    void refresh();
  }

  function show(title, content) {
    dialog.innerHTML = `<div class="detail-title"><h2 id="automation-dialog-title">${title}</h2>
      ${button('close', '关闭')}</div>${content}<p class="form-error" data-automation-error role="alert" hidden></p>`;
    if (!dialog.open) dialog.showModal();
  }

  const fields = (name, label, type, value, attributes = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value ?? '')}" ${attributes}></label>`;
  function modelsHTML(form, video = {}) {
    const model = context().models.find(item => item.id === form.elements.model.value);
    const opts = (values, value, labelFor = item => item) => values.map(item => option(item, labelFor(item), value)).join('');
    const target = form.querySelector('[data-model-fields]');
    if (!model) { target.replaceChildren(); return; }
    const durations = model.durations?.length ? model.durations : Array.from({ length: model.max - model.min + 1 }, (_, index) => model.min + index);
    const choices = model.autoDuration ? [-1, ...durations] : durations;
    target.innerHTML = `<div class="fields generation-fields">
      <label>画幅<select name="ratio">${opts(model.ratios, video.ratio ?? '9:16')}</select></label>
      <label>清晰度<select name="resolution">${opts(model.resolutions, video.resolution ?? '720p')}</select></label>
      <label>时长<select name="duration">${opts(choices, video.duration ?? 6, value => value === -1 ? '自动' : `${value} 秒`)}</select></label>
      </div><label class="check-field"${model.audio ? '' : ' hidden'}><input type="checkbox" name="audio"${model.audio && video.audio ? ' checked' : ''}>生成声音</label>`;
  }
  function editRule(proposal = {}, original = null) {
    if (original?.enabled) { notify('请先暂停规则，再编辑。'); return; }
    dialogData = { type: 'save', id: original?.id, revision: original?.revision, mode: context().mode };
    const value = { ...original, ...proposal, video: { ...original?.video, ...proposal.video } };
    const zone = value.zone || context().zone || 'Asia/Shanghai';
    const available = context().accounts.filter(context().mayPublish);
    const accounts = available.map(item => option(item.id, accountName(item.id), value.accountId)).join('');
    const models = context().models.map(item => option(item.id, item.name, value.video.model)).join('');
    show(original ? '编辑任务规则' : '新建任务规则', `<form data-automation-form="save" class="automation-form">
      ${fields('name','规则名称','text',value.name,'required maxlength="80"')}
      <label>视频提示词<textarea name="prompt" rows="3" maxlength="20000" required>${esc(value.video.prompt || '')}</textarea></label>
      <label>视频模型<select name="model" required>${value.video.model && !context().models.some(model => model.id === value.video.model) ? '<option value="" selected>原模型不可用，请重新选择</option>' : ''}${models || '<option value="">请在连接设置开通视频模型</option>'}</select></label>
      <div data-model-fields></div><section class="automation-form-group"><h3>运行时间与发布方式</h3>
      <div class="fields schedule-fields"><label>执行频率<select name="frequency">${Object.entries(frequencyLabels).map(([key,label]) => option(key,label,value.frequency)).join('')}</select></label>
      <label>时区<select name="zone">${[...new Set([zone, ...zones])].map(item => option(item,item,zone)).join('')}</select></label>
      ${fields('startsAt','首次生成时间','datetime-local',value.startsAt,'required')}
      ${fields('publishAt','发布时间','time',value.publishAt,'required')}</div>
      <p class="field-note">每周任务沿用首次生成的星期。发布时间早于生成时间时，安排在次日。</p>
      <div class="fields schedule-fields"><label>发布方式<select name="policy">${option('review','人工审核',value.policy)}${option('auto','自动发布',value.policy)}</select></label>
      ${fields('maxCredits',context().mode === 'live' ? '单次生成积分上限' : '单次模拟积分上限','number',value.maxCredits,'required min="1" max="2000000000" step="1"')}</div>
      <label>目标账号<select name="accountId" required>${option('', '请选择已授权账号', value.accountId)}${accounts}</select></label>
      ${fields('title','发布标题','text',value.title,'required maxlength="100"')}
      <label>视频描述（可选）<textarea name="description" rows="2" maxlength="1000">${esc(value.description || '')}</textarea></label>
      </section><p class="field-note">保存后到规则列表启用。每次生成先获取报价，超过积分上限时结束本次任务。</p>
      <div class="dialog-actions"><button class="button primary" type="submit">保存规则</button></div></form>`);
    const form = dialog.querySelector('form');
    modelsHTML(form, value.video);
  }

  function confirmRule(rule, action) {
    dialogData = { type: 'manage', id: rule.id, revision: rule.revision, action, mode: context().mode };
    const detail = action === 'pause' ? '暂停后停止安排新的执行。已经开始的任务可在执行记录中单独取消。'
      : action === 'run' ? '立即开始一次生成，并按规则安排下一次到达的发布时刻。已有定时计划继续执行。'
      : '启用后将自动按设置生成视频。';
    show(actionLabels[action], `<form data-automation-form="manage" class="automation-form"><h3>${esc(rule.name)}</h3>
      <p>${detail}</p><p>${esc(accountName(rule.accountId))} · ${policy(rule.policy)} · 单次最多 ${esc(rule.maxCredits)} 积分</p>
      ${rule.policy === 'auto' && action !== 'pause' ? '<p class="field-note">视频完成后，工作台将按计划自动发布到上述账号。</p>' : ''}
      ${action === 'enable' ? `<p class="field-note">${frequencyLabels[rule.frequency]} · 首次生成 ${esc(rule.startsAt.replace('T',' '))} · 发布时刻 ${esc(rule.publishAt)}（${esc(rule.zone)}）</p>` : ''}
      <div class="dialog-actions"><button class="button primary" type="submit">确认${actionLabels[action]}</button></div></form>`);
  }
  function reviewRun(run) {
    if (!run.reviewable) { notify('此执行记录当前无需审核。'); return; }
    dialogData = { type: 'review', id: run.id, mode: context().mode };
    show('审核视频与发布排期', `<form data-automation-form="review" class="automation-form">
      <h3>${esc(run.name)}</h3><p>${esc(accountName(run.accountId))} · 计划发布 ${esc(time(run.publishAt, run.zone))}（${esc(run.zone)}）</p>
      ${run.generationId && run.videoStatus === 'completed' ? `<div>${button('preview-review', '预览视频', run.generationId)}</div>` : ''}
      ${fields('title','发布标题','text',run.title,'required maxlength="100"')}
      <label>视频描述（可选）<textarea name="description" maxlength="1000" rows="2">${esc(run.description || '')}</textarea></label>
      ${fields('planned',`改期（${esc(run.zone)}，可选）`,'datetime-local','')}
      <p class="field-note">通过审核后按排期发布。改期留空则沿用原时间，原时间已过时请选择新的未来时间。</p>
      <div class="dialog-actions"><button class="button" type="submit" name="action" value="reject" formnovalidate>审核不通过</button>
      <button class="button primary" type="submit" name="action" value="approve">通过并确认发布</button></div></form>`);
  }

  function renderAgentCard(card, index, activeDraft) {
    if (!card || typeof card !== 'object') return '';
    if (card.kind === 'saved') {
      return `<div class="inner-card automation-chat-card"><h3>${esc(card.name)}</h3>${link(card.id, '查看规则')}</div>`;
    }
    if (card.kind === 'draft') {
      if (!activeDraft) return '';
      const rule = card.proposal || {}, video = rule.video || {};
      const values = [
        ['规则名称', rule.name], ['执行频率', frequencyLabels[rule.frequency]], ['时区', rule.zone],
        ['首次生成', rule.startsAt?.replace('T', ' ')], ['发布时间', rule.publishAt],
        ['发布方式', rule.policy && policy(rule.policy)], ['目标账号', card.accountName || rule.accountId],
        ['发布标题', rule.title], ['视频描述', rule.description],
        ['模型', card.modelName || video.model], ['画幅', video.ratio], ['清晰度', video.resolution],
        ['时长', video.duration === -1 ? '自动' : video.duration ? `${video.duration} 秒` : ''],
        ['声音', video.model ? video.audio ? '生成声音' : '无声音' : ''],
        ['单次生成上限', rule.maxCredits != null ? `${rule.maxCredits} 积分` : '']
      ];
      const missing = Array.isArray(card.missing) ? card.missing : [];
      const issues = Array.isArray(card.issues) ? card.issues : [];
      return `<div class="inner-card automation-chat-card"><h3>自动化任务草稿</h3>
        <dl class="details automation-draft-summary">${values.filter(([,value]) => value).map(([label,value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
        ${video.prompt ? `<div class="automation-draft-prompt"><strong>视频提示词</strong><p>${esc(video.prompt)}</p></div>` : ''}
        ${missing.length ? `<p class="field-note">待补充 ${esc(missing.join('、'))}</p>` : ''}
        ${issues.map(issue => `<p class="form-error">${esc(issue)}</p>`).join('')}
        ${card.ready ? `<button type="button" class="button primary" data-action="automation-confirm-draft" data-id="${index}">确认任务草稿</button>` : ''}</div>`;
    }
    if (card.kind === 'create' || card.kind === 'edit') return `<div class="inner-card automation-chat-card"><h3>${card.kind === 'create' ? '任务规则草稿' : '规则修改草稿'}</h3>
      <p>${esc(card.proposal?.name || card.name || '请补齐规则设置')}</p>${button('chat-edit', '打开草稿', index)}</div>`;
    if (card.kind === 'action') return `<div class="inner-card automation-chat-card"><h3>${actionLabels[card.action] || '规则操作'}</h3>
      <p>${esc(card.name)}</p>${button('chat-action', '查看并确认', index)}</div>`;
    if (card.kind === 'review') return `<div class="inner-card automation-chat-card"><h3>待审核任务</h3><p>${esc(card.name)}</p>
      ${button('chat-review', '打开审核', index)} ${link(card.id + '/' + card.runId,'查看执行记录')}</div>`;
    if (card.kind === 'list') {
      const rules = Array.isArray(card.rules) ? card.rules : [];
      const runs = Array.isArray(card.runs) ? card.runs : [];
      return `<div class="inner-card automation-chat-card"><h3>自动化任务</h3>
        ${rules.map(rule => `<div class="automation-chat-row">${esc(rule.name)} <span class="muted">${rule.enabled ? '已启用' : '未启用'}</span> ${link(String(rule.id),'查看规则')}</div>`).join('')}
        ${runs.map(run => `<div class="automation-chat-row">${esc(run.name)} · ${esc(status(run.status))} ${link(String(run.ruleId) + '/' + String(run.id),'查看记录')}</div>`).join('')}
        <a class="text-button" href="#automation">打开任务模块</a></div>`;
    }
    return '';
  }

  async function inspect(kind, id, action) {
    const mode = context().mode;
    const current = await request(`automation/${kind === 'review' ? 'runs' : 'rules'}/${encodeURIComponent(id)}`, undefined, mode);
    if (context().mode !== mode) return;
    if (kind === 'review') {
      reviewRun(current);
      return;
    }
    const rule = current.rules.find(item => item.id === id);
    if (!rule) throw Error('找不到任务规则。');
    if (kind === 'edit') editRule(action || {}, rule);
    else confirmRule(rule, action);
  }

  document.addEventListener('click', async event => {
    const control = event.target.closest('[data-automation-action]');
    if (!control || busy || control.disabled) return;
    const { automationAction: action, id } = control.dataset;
    if (action === 'close') { dialog.close(); return; }
    if (action === 'new') { editRule(); return; }
    const run = dashboard.runs.find(item => item.id === id);
    if (action === 'preview' && run?.generationId) { await preview(run.generationId); return; }
    if (action === 'preview-review') { await preview(id); return; }
    control.disabled = true;
    try {
      if (action === 'edit') await inspect('edit', id);
      else if (Object.hasOwn(actionLabels, action)) await inspect('manage', id, action);
      else if (action === 'review') await inspect('review', id);
      else if (action === 'cancel') {
        dialogData = { type: 'review', id, mode: context().mode };
        show('取消本次任务', '<form data-automation-form="review" class="automation-form"><p>本次任务将停止后续安排。已提交的生成请求可能继续完成。</p><div class="dialog-actions"><button class="button primary" type="submit" name="action" value="cancel">确认取消</button></div></form>');
      } else if (action.startsWith('chat-')) {
        const card = context().chat[Number(id)]?.automation;
        if (card?.kind === 'create' && action === 'chat-edit') editRule(card.proposal);
        if (card?.kind === 'edit' && action === 'chat-edit') await inspect('edit', card.id, card.proposal);
        if (card?.kind === 'action' && action === 'chat-action' && Object.hasOwn(actionLabels, card.action)) await inspect('manage', card.id, card.action);
        if (card?.kind === 'review' && action === 'chat-review') await inspect('review', card.runId);
      }
    } catch (error) { notify(error.message); }
    finally { control.disabled = false; }
  });
  dialog.addEventListener('change', event => { if (event.target.name === 'model') modelsHTML(event.target.form); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !dialogData || dialogData.mode !== context().mode) return;
    const form = event.target;
    const values = Object.fromEntries(new document.defaultView.FormData(form, event.submitter || undefined));
    const { type, id, revision, action, mode } = dialogData;
    let body;
    if (type === 'save') {
      const { model, prompt, ratio, resolution, duration, audio, maxCredits, ...rest } = values;
      body = { ...rest, id, revision, maxCredits: Number(maxCredits), video: { model, prompt, ratio, resolution, duration: Number(duration), audio: audio === 'on' } };
    } else if (type === 'manage') body = { id, revision, action };
    else {
      if (!['approve','reject','cancel'].includes(values.action)) return;
      body = { id, action: values.action, title: values.title, description: values.description, planned: values.planned || null };
    }
    busy = true;
    for (const item of dialog.querySelectorAll('button')) item.disabled = true;
    const error = dialog.querySelector('[data-automation-error]');
    error.hidden = true;
    try {
      await request(`automation/${type}`, body, mode);
      dialog.close();
      notify(type === 'save' ? '规则已保存，可在任务模块启用。' : '任务已更新。');
      if (context().page === 'automation') await refresh();
      else if (type !== 'review') document.defaultView.location.hash = '#automation';
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { busy = false; for (const item of dialog.querySelectorAll('button')) item.disabled = false; }
  });
  return { render, refresh, renderAgentCard, isBusy: () => busy, close: () => { if (dialog.open) dialog.close(); } };
}
