(function () {
  'use strict';

  const core = window.CatalogCore;
  const storage = window.localStorage;
  let state = loadState();
  let toastMessage = '';
  let toastTone = 'ok';
  let saveTimer = null;

  const $ = (selector) => document.querySelector(selector);

  const refs = {
    saveState: $('#saveState'),
    resetDemo: $('#resetDemo'),
    yearForm: $('#yearForm'),
    yearInput: $('#yearInput'),
    codePreview: $('#codePreview'),
    retentionList: $('#retentionList'),
    retentionForm: $('#retentionForm'),
    categoryList: $('#categoryList'),
    categoryForm: $('#categoryForm'),
    volumeForm: $('#volumeForm'),
    pendingQueues: $('#pendingQueues'),
    currentWork: $('#currentWork'),
    selectedPanel: $('#selectedPanel'),
    shelves: $('#shelves'),
    diffPanel: $('#diffPanel')
  };

  function loadState() {
    try {
      const raw = storage.getItem(core.STORAGE_KEY);
      return core.normalizeState(raw ? JSON.parse(raw) : core.demoState());
    } catch (error) {
      return core.normalizeState(core.demoState());
    }
  }

  function persist(immediate) {
    clearTimeout(saveTimer);
    const write = () => {
      state.lastSavedAt = new Date().toISOString();
      storage.setItem(core.STORAGE_KEY, JSON.stringify(state));
      refs.saveState.textContent = `已自动保存 ${new Date(state.lastSavedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    };
    if (immediate) write();
    else saveTimer = setTimeout(write, 120);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function categoryName(id) {
    const category = state.rule.categories.find((item) => item.id === id);
    return category ? category.name : '未知门类';
  }

  function retentionName(id) {
    const retention = state.rule.retentions.find((item) => item.id === id);
    return retention ? retention.name : '未知期限';
  }

  function retentionCode(id) {
    const retention = state.rule.retentions.find((item) => item.id === id);
    return retention ? retention.code : '?';
  }

  function volumeById(id) {
    return state.volumes.find((item) => item.id === id);
  }

  function setToast(message, tone) {
    toastMessage = message;
    toastTone = tone || 'ok';
  }

  function applyResult(result) {
    if (!result.ok) {
      setToast(result.error, 'error');
      render();
      return false;
    }
    state = result.state;
    setToast(result.message, 'ok');
    persist(true);
    render();
    return true;
  }

  function locationText(location) {
    if (!location) return '待归区';
    const area = location.area === 'formal' ? '正式架' : '暂存格';
    return `${area} ${location.layer}层-${location.slot}位`;
  }

  function diffTypeLabel(type) {
    return {
      added: '新增',
      shelved: '新摆入',
      moved: '换位置',
      'returned-pending': '退回待归',
      unchanged: '没动',
      pending: '仍待归'
    }[type] || type;
  }

  function render() {
    renderRules();
    renderPending();
    renderCurrent();
    renderSelected();
    renderShelves();
    renderDiff();
    renderToast();
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    render();
    persist(true);
  });

  function bindEvents() {
    refs.resetDemo.addEventListener('click', () => {
      if (window.confirm('恢复演示数据会覆盖当前工作台，确定继续吗？')) {
        applyResult(core.resetDemo());
      }
    });

    refs.yearForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const year = refs.yearInput.value;
      if (window.confirm(`把年度改成 ${year} 后，已摆卷宗会全部退回待归区，确定吗？`)) {
        applyResult(core.changeYear(state, year));
      }
    });

    refs.retentionForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const result = core.addRetention(state, form.get('code'), form.get('name'));
      if (applyResult(result)) event.currentTarget.reset();
    });

    refs.categoryForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const result = core.addCategory(state, form.get('code'), form.get('name'));
      if (applyResult(result)) event.currentTarget.reset();
    });

    refs.volumeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const result = core.addVolume(state, {
        title: form.get('title'),
        retentionId: form.get('retentionId'),
        categoryId: form.get('categoryId')
      });
      if (applyResult(result)) event.currentTarget.reset();
    });

    document.body.addEventListener('click', handleAction);
  }

  function handleAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const categoryId = button.dataset.categoryId;
    const volumeId = button.dataset.volumeId;
    const retentionId = button.dataset.retentionId;

    if (action === 'select-layer') applyResult(core.selectLayer(state, categoryId));
    if (action === 'pick-pending') applyResult(core.selectLayer(state, categoryId, volumeId));
    if (action === 'place-next') applyResult(core.placeNext(state, categoryId, { volumeId }));
    if (action === 'place-all') applyResult(core.placeAll(state, categoryId));
    if (action === 'return-temp') applyResult(core.returnTemp(state, categoryId));
    if (action === 'select-volume') applyResult(core.selectLayer(state, volumeById(volumeId)?.categoryId || categoryId, volumeId));
    if (action === 'clear-baseline') applyResult(core.clearReshelfBaseline(state));

    if (action === 'transfer') {
      const choices = state.rule.categories
        .filter((category) => category.id !== volumeById(volumeId).categoryId)
        .map((category, index) => `${index + 1}. ${category.name}`)
        .join('\n');
      const answer = window.prompt(`调入哪个门类？会重排落脚层及以下。\n${choices}`, '1');
      const index = Number(answer) - 1;
      const target = state.rule.categories.filter((category) => category.id !== volumeById(volumeId).categoryId)[index];
      if (target) applyResult(core.transferVolume(state, volumeId, target.id));
    }

    if (action === 'edit-retention') {
      const current = state.rule.retentions.find((item) => item.id === retentionId);
      const code = window.prompt('保管期限代码（已摆卷宗的档号不会变）', current.code);
      if (code === null) return;
      const name = window.prompt('保管期限名称', current.name);
      if (name !== null) applyResult(core.updateRetention(state, retentionId, { code, name }));
    }

    if (action === 'edit-category') {
      const current = state.rule.categories.find((item) => item.id === categoryId);
      const code = window.prompt('门类代码（已摆卷宗的档号不会变）', current.code);
      if (code === null) return;
      const name = window.prompt('门类名称', current.name);
      if (name !== null) applyResult(core.updateCategory(state, categoryId, { code, name }));
    }
  }

  function renderRules() {
    refs.yearInput.value = state.rule.year;
    refs.codePreview.textContent = core.codePreview(state);

    refs.retentionList.innerHTML = state.rule.retentions.map((retention) => {
      const used = state.volumes.some((volume) => volume.retentionId === retention.id);
      return `
        <li>
          <span><code>${escapeHtml(retention.code)}</code> ${escapeHtml(retention.name)}</span>
          <span class="row-actions">
            <button type="button" class="link-btn" data-action="edit-retention" data-retention-id="${retention.id}">改</button>
            ${used ? '<em>已用</em>' : ''}
          </span>
        </li>`;
    }).join('');

    refs.categoryList.innerHTML = state.rule.categories.map((category, index) => `
      <li class="${state.cursor.categoryId === category.id ? 'active' : ''}">
        <span><b>${index + 1}层</b> <code>${escapeHtml(category.code)}</code> ${escapeHtml(category.name)}</span>
        <span class="row-actions">
          <button type="button" class="link-btn" data-action="select-layer" data-category-id="${category.id}">停在此层</button>
          <button type="button" class="link-btn" data-action="edit-category" data-category-id="${category.id}">改</button>
        </span>
      </li>
    `).join('');

    const retentionOptions = state.rule.retentions.map((retention) =>
      `<option value="${retention.id}">${escapeHtml(retention.name)}（${escapeHtml(retention.code)}）</option>`
    ).join('');
    const categoryOptions = state.rule.categories.map((category) =>
      `<option value="${category.id}">${escapeHtml(category.name)}（${escapeHtml(category.code)}）</option>`
    ).join('');
    refs.volumeForm.retentionId.innerHTML = retentionOptions;
    refs.volumeForm.categoryId.innerHTML = categoryOptions;
    refs.volumeForm.categoryId.value = state.cursor.categoryId;
  }

  function renderPending() {
    refs.pendingQueues.innerHTML = state.rule.categories.map((category) => {
      const pending = state.volumes
        .filter((volume) => volume.categoryId === category.id && volume.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt);
      return `
        <details class="pending-group ${state.cursor.categoryId === category.id ? 'active' : ''}" ${state.cursor.categoryId === category.id ? 'open' : ''}>
          <summary>${escapeHtml(category.name)}待归 <span>${pending.length}</span> 卷</summary>
          <div class="pending-list">
            ${pending.length === 0 ? '<p class="muted">暂无待归卷宗。</p>' : pending.slice(0, 8).map((volume) => `
              <button type="button" class="pending-item ${state.cursor.volumeId === volume.id ? 'current' : ''}"
                data-action="pick-pending" data-category-id="${category.id}" data-volume-id="${volume.id}">
                <span>${escapeHtml(volume.title)}</span>
                <small>${escapeHtml(retentionName(volume.retentionId))}</small>
              </button>
            `).join('')}
            ${pending.length > 8 ? `<p class="muted">另有 ${pending.length - 8} 卷，可直接连续摆架。</p>` : ''}
          </div>
        </details>`;
    }).join('');
  }

  function renderCurrent() {
    const category = state.rule.categories.find((item) => item.id === state.cursor.categoryId);
    const current = volumeById(state.cursor.volumeId);
    const pendingCount = state.volumes.filter((volume) => volume.categoryId === category?.id && volume.status === 'pending').length;
    if (!category) {
      refs.currentWork.innerHTML = '<h2>当前工作层</h2><p>请先添加门类。</p>';
      return;
    }
    refs.currentWork.innerHTML = `
      <h2>当前停在：${escapeHtml(category.name)}层</h2>
      ${current ? `
        <div class="hand-volume">
          <div>
            <span class="eyebrow">手上这一卷</span>
            <strong>${escapeHtml(current.title)}</strong>
            <p>${escapeHtml(retentionName(current.retentionId))} · 下一档号 <code>${escapeHtml(core.codePreview(state, category.id, current.retentionId))}</code></p>
          </div>
          <button type="button" class="btn btn-primary" data-action="place-next"
            data-category-id="${category.id}" data-volume-id="${current.id}">摆上下一卷</button>
        </div>` : `
        <div class="hand-volume empty-hand">
          <div><span class="eyebrow">本层进度</span><strong>没有停在手上的卷宗</strong></div>
        </div>`}
      <div class="work-actions">
        <button type="button" class="btn" data-action="place-all" data-category-id="${category.id}">连续摆完本层可摆部分</button>
        <button type="button" class="btn" data-action="return-temp" data-category-id="${category.id}">暂存格顶部回正式架</button>
      </div>
      <p class="hint">待归 ${pendingCount} 卷。关闭页面后会恢复到这一层和这卷。</p>`;
  }

  function renderSelected() {
    const volume = volumeById(state.selectedVolumeId);
    if (!volume) {
      refs.selectedPanel.innerHTML = '<h2>卷宗详情</h2><p class="muted">点击任意卷宗查看档号和位置。</p>';
      return;
    }
    refs.selectedPanel.innerHTML = `
      <h2>卷宗详情</h2>
      <h3>${escapeHtml(volume.title)}</h3>
      <dl class="detail-grid">
        <dt>门类</dt><dd>${escapeHtml(categoryName(volume.categoryId))}</dd>
        <dt>保管期限</dt><dd>${escapeHtml(retentionName(volume.retentionId))}</dd>
        <dt>档号</dt><dd>${volume.code ? `<code>${escapeHtml(volume.code)}</code>${volume.codeLocked ? '<span class="lock-badge">已落定锁定</span>' : ''}` : '未落号'}</dd>
        <dt>位置</dt><dd>${locationText(volume.location)}</dd>
        <dt>原暂存层号</dt><dd>${volume.originLayer ? `${volume.originLayer}层` : '无'}</dd>
      </dl>
      ${volume.status === 'pending' ? `<button type="button" class="btn" data-action="transfer" data-volume-id="${volume.id}">调入其他门类</button>` :
        `<button type="button" class="btn" data-action="transfer" data-volume-id="${volume.id}">调到其他门类并重排</button>`}`;
  }

  function volumeCell(volume, area) {
    if (!volume) {
      return '<div class="slot empty"><span>空</span></div>';
    }
    const selected = state.selectedVolumeId === volume.id ? 'selected' : '';
    const current = state.cursor.volumeId === volume.id ? 'cursor' : '';
    return `
      <button type="button" class="slot occupied ${area} ${selected} ${current}"
        data-action="select-volume" data-volume-id="${volume.id}" data-category-id="${volume.categoryId}"
        title="${escapeHtml(volume.title)}&#10;${escapeHtml(volume.code || '')}&#10;${locationText(volume.location)}">
        <span>${escapeHtml(volume.title.slice(0, 4))}</span>
        <small>${volume.location.slot}</small>
      </button>`;
  }

  function renderShelf(category, layer) {
    const active = state.cursor.categoryId === category.id;
    const items = core.layerVolumes(state, category.id);
    const counts = core.countsOf(items);
    const formal = Array.from({ length: core.FORMAL_LIMIT }, (_, index) =>
      items.find((volume) => volume.status === 'formal' && volume.location.slot === index + 1)
    );
    const temp = Array.from({ length: core.TEMP_LIMIT }, (_, index) =>
      items.find((volume) => volume.status === 'temp' && volume.location.slot === index + 1)
    );
    const blockedReason = counts.temp >= core.TEMP_LIMIT
      ? '暂存格已满，拒收新卷宗'
      : counts.formal < core.FORMAL_LIMIT && counts.temp > 0
        ? '请先回架暂存格顶部卷宗'
        : '';

    return `
      <section class="shelf ${active ? 'active-shelf' : ''}" data-layer="${layer}">
        <div class="shelf-header">
          <div>
            <h3>${layer}层 · ${escapeHtml(category.name)} <code>${escapeHtml(category.code)}</code></h3>
            <p>正式架 ${counts.formal}/60 · 暂存格 ${counts.temp}/30 ${blockedReason ? `<b class="warning">${blockedReason}</b>` : ''}</p>
          </div>
          <div class="shelf-actions">
            <button type="button" class="btn btn-small" data-action="select-layer" data-category-id="${category.id}">停到本层</button>
            <button type="button" class="btn btn-small" data-action="return-temp" data-category-id="${category.id}">回架</button>
          </div>
        </div>
        <div class="rack-wrap">
          <section class="rack-section">
            <h4>正式架 60 位</h4>
            <div class="rack formal-rack" aria-label="${layer}层正式架">
              ${formal.map((volume) => volumeCell(volume, 'formal')).join('')}
            </div>
          </section>
          <section class="rack-section temp-section">
            <h4>旁边暂存格 30 卷（顶部先回架，层号随卷带走）</h4>
            <div class="rack temp-rack" aria-label="${layer}层暂存格">
              ${temp.map((volume) => volumeCell(volume, 'temp')).join('')}
            </div>
          </section>
        </div>
      </section>`;
  }

  function renderShelves() {
    refs.shelves.innerHTML = state.rule.categories.map((category, index) => renderShelf(category, index + 1)).join('');
  }

  function diffRow(item) {
    const volume = volumeById(item.volumeId);
    return `
      <tr class="diff-${item.type}">
        <td><span class="pill">${diffTypeLabel(item.type)}</span></td>
        <td>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(locationText(item.from))}</td>
        <td>${escapeHtml(locationText(item.to))}</td>
        <td>${item.newCode ? `<code>${escapeHtml(item.newCode)}</code>` : volume?.code ? `<code>${escapeHtml(volume.code)}</code>` : '—'}</td>
      </tr>`;
  }

  function renderDiff() {
    const baseline = core.baselineComparison(state);
    const latest = state.lastDiff;
    const latestRows = latest ? latest.items.map(diffRow).join('') : '';
    const baselineRows = baseline
      ? baseline.items.filter((item) => item.type !== 'pending').map((item) => {
          const mapped = {
            volumeId: item.volumeId,
            title: item.title,
            type: item.type,
            from: item.from,
            to: item.to,
            newCode: item.newCode
          };
          return diffRow(mapped);
        }).join('')
      : '';

    refs.diffPanel.innerHTML = `
      ${baseline ? `
        <div class="baseline-box">
          <div>
            <h3>年度重摆总览</h3>
            <p>换位置 <b>${baseline.moved}</b> 卷 · 没动 <b>${baseline.unchanged}</b> 卷 · 新增已摆 <b>${baseline.added}</b> 卷 · 仍待归 <b>${baseline.pending}</b> 卷</p>
          </div>
          <button type="button" class="btn btn-small" data-action="clear-baseline">确认并清除总览</button>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>状态</th><th>卷宗</th><th>原位置</th><th>当前位置</th><th>新档号</th></tr></thead>
            <tbody>${baselineRows || '<tr><td colspan="5">还没有重新摆入。</td></tr>'}</tbody>
          </table>
        </div>` : ''}
      <h3>${latest ? escapeHtml(latest.label) : '尚无操作'}</h3>
      ${latest ? `
        <p class="hint">${new Date(latest.at).toLocaleString('zh-CN')}；下表列出最近一轮中变动和未动的卷宗。</p>
        <div class="table-scroll">
          <table>
            <thead><tr><th>状态</th><th>卷宗</th><th>原位置</th><th>新位置</th><th>档号</th></tr></thead>
            <tbody>${latestRows || '<tr><td colspan="5">没有比对项。</td></tr>'}</tbody>
          </table>
        </div>` : '<p class="muted">摆架、调卷或回暂存后会显示比对结果。</p>'}`;
  }

  function renderToast() {
    let element = document.querySelector('.toast');
    if (!toastMessage) {
      if (element) element.remove();
      return;
    }
    if (!element) {
      element = document.createElement('div');
      element.className = 'toast';
      document.body.appendChild(element);
    }
    element.textContent = toastMessage;
    element.classList.toggle('error', toastTone === 'error');
  }
})();
