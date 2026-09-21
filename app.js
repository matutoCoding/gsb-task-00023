const STORAGE_KEY = 'archive-sorting-bench-v1';
const SHELF_CAPACITY = 60;
const TEMP_CAPACITY = 30;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function pad(number) {
  return String(number).padStart(3, '0');
}

function defaultRule() {
  return {
    year: '2026',
    separator: '-',
    retentions: [
      { id: 'ret_permanent', name: '永久', code: 'Y' },
      { id: 'ret_30', name: '30年', code: 'D30' },
      { id: 'ret_10', name: '10年', code: 'D10' }
    ],
    categories: [
      { id: 'cat_ws', name: '文书', code: 'WS' },
      { id: 'cat_kj', name: '科技', code: 'KJ' },
      { id: 'cat_kuai', name: '会计', code: 'KU' },
      { id: 'cat_yx', name: '音像', code: 'YX' }
    ]
  };
}

function initialState() {
  const rule = defaultRule();
  return {
    rule,
    draftRule: clone(rule),
    volumes: [],
    activeCategoryId: rule.categories[0].id,
    selectedVolumeId: null,
    lastPlacedVolumeId: null,
    lastRearrangement: null,
    comparison: null,
    logs: []
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw);
    const state = initialState();
    const merged = { ...state, ...parsed };
    merged.rule = { ...defaultRule(), ...(parsed.rule || {}) };
    merged.draftRule = clone(merged.rule);
    if (!Array.isArray(merged.rule.retentions) || !merged.rule.retentions.length) merged.rule.retentions = defaultRule().retentions;
    if (!Array.isArray(merged.rule.categories) || !merged.rule.categories.length) merged.rule.categories = defaultRule().categories;
    if (!merged.rule.categories.some((item) => item.id === merged.activeCategoryId)) {
      merged.activeCategoryId = merged.rule.categories[0].id;
    }
    return merged;
  } catch (error) {
    return initialState();
  }
}

let state = loadState();

function persist() {
  const stored = { ...state, draftRule: undefined };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function addLog(message) {
  state.logs.unshift({
    id: uid('log'),
    at: new Date().toISOString(),
    message
  });
  state.logs = state.logs.slice(0, 80);
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

function categoryById(id) {
  return state.rule.categories.find((item) => item.id === id);
}

function retentionById(id) {
  return state.rule.retentions.find((item) => item.id === id);
}

function layerNoForCategory(categoryId, rule = state.rule) {
  return rule.categories.findIndex((item) => item.id === categoryId) + 1;
}

function officialVolumes(categoryId) {
  return state.volumes
    .filter((volume) => volume.status === 'official' && volume.categoryId === categoryId)
    .sort((a, b) => a.slot - b.slot);
}

function tempVolumes() {
  return state.volumes
    .filter((volume) => volume.status === 'temp')
    .sort((a, b) => a.tempOrder - b.tempOrder);
}

function pendingVolumes(categoryId) {
  return state.volumes.filter((volume) => volume.status === 'pending' && volume.categoryId === categoryId);
}

function formatPhysicalPosition(volume) {
  if (volume.status === 'official') {
    return `第${layerNoForCategory(volume.categoryId)}层-第${volume.slot}格`;
  }
  if (volume.status === 'temp') {
    return `暂存格#${volume.tempOrder}（来自第${volume.originLayerNo}层）`;
  }
  return '待归区';
}

function previewArchiveCode(volume) {
  const category = categoryById(volume.categoryId);
  const retention = retentionById(volume.retentionId);
  if (!category || !retention) return '待补齐规矩';
  const sequence = nextSequence(volume.categoryId);
  return [state.rule.year, retention.code, category.code, pad(sequence)].join(state.rule.separator);
}

function lockedOrPreviewCode(volume) {
  return volume.status === 'official' && volume.archiveCode ? volume.archiveCode : previewArchiveCode(volume);
}

function nextSequence(categoryId) {
  const used = state.volumes
    .filter((volume) => volume.status === 'official' && volume.categoryId === categoryId && volume.sequence)
    .map((volume) => volume.sequence);
  return (Math.max(0, ...used) + 1);
}

function createArchiveCode(volume) {
  const category = categoryById(volume.categoryId);
  const retention = retentionById(volume.retentionId);
  const sequence = nextSequence(volume.categoryId);
  volume.sequence = sequence;
  volume.archiveCode = [state.rule.year, retention.code, category.code, pad(sequence)].join(state.rule.separator);
}

function positionSnapshot() {
  const snapshot = {};
  for (const volume of state.volumes) {
    snapshot[volume.id] = {
      status: volume.status,
      categoryId: volume.categoryId,
      layerNo: volume.status === 'official' ? layerNoForCategory(volume.categoryId) : null,
      slot: volume.slot ?? null,
      tempOrder: volume.tempOrder ?? null,
      originLayerNo: volume.originLayerNo ?? null,
      archiveCode: volume.archiveCode ?? null
    };
  }
  return snapshot;
}

function currentPositionForCompare(volume) {
  return {
    status: volume.status,
    categoryId: volume.categoryId,
    layerNo: volume.status === 'official' ? layerNoForCategory(volume.categoryId) : null,
    slot: volume.slot ?? null,
    tempOrder: volume.tempOrder ?? null,
    originLayerNo: volume.originLayerNo ?? null
  };
}

function positionText(snapshot) {
  if (!snapshot || snapshot.status === 'pending') return '待归区';
  if (snapshot.status === 'temp') return `暂存格${snapshot.tempOrder ? `#${snapshot.tempOrder}` : ''}（来自第${snapshot.originLayerNo || '?'}层）`;
  return `第${snapshot.layerNo}层-第${snapshot.slot}格`;
}

function compactCategory(categoryId) {
  const volumes = officialVolumes(categoryId);
  volumes.forEach((volume, index) => {
    volume.slot = index + 1;
  });
}

function assignTempPosition(volume) {
  const count = state.volumes.filter((item) => item.status === 'temp').length;
  volume.status = 'temp';
  volume.tempOrder = count + 1;
  volume.originLayerNo = layerNoForCategory(volume.categoryId);
  volume.slot = null;
}

function placeVolume(volume, options = {}) {
  if (!volume || volume.status === 'official') return { ok: false, message: '这卷已经在正式架上。' };
  const tempCount = state.volumes.filter((item) => item.status === 'temp').length;
  const shelfCount = officialVolumes(volume.categoryId).length;
  const wasTemp = volume.status === 'temp';

  if (shelfCount >= SHELF_CAPACITY) {
    if (tempCount >= TEMP_CAPACITY) {
      return { ok: false, message: '暂存格已满30卷，不能再接收新卷。' };
    }
    if (!wasTemp) {
      assignTempPosition(volume);
      state.lastPlacedVolumeId = volume.id;
      state.activeCategoryId = volume.categoryId;
      addLog(`《${volume.title}》超过第${layerNoForCategory(volume.categoryId)}层容量，进入暂存格第${volume.tempOrder}格。`);
      return { ok: true, destination: 'temp' };
    }
    return { ok: false, message: '原层仍然满员，暂不能挪回正式架。' };
  }

  if (wasTemp) {
    volume.carriedOriginLayerNo = volume.originLayerNo;
    volume.tempOrder = null;
  }
  volume.status = 'official';
  volume.slot = shelfCount + 1;
  if (!volume.archiveCode) createArchiveCode(volume);
  volume.placedAt = volume.placedAt || new Date().toISOString();
  state.lastPlacedVolumeId = volume.id;
  state.activeCategoryId = volume.categoryId;
  renumberTemp();
  if (options.fromRestore) {
    addLog(`《${volume.title}》从暂存格挪回第${layerNoForCategory(volume.categoryId)}层，并带来原层号：第${volume.carriedOriginLayerNo}层。`);
  } else if (wasTemp) {
    addLog(`《${volume.title}》回到第${layerNoForCategory(volume.categoryId)}层。`);
  } else {
    addLog(`《${volume.title}》以档号 ${volume.archiveCode} 摆上第${layerNoForCategory(volume.categoryId)}层第${volume.slot}格，档号已落定。`);
  }
  return { ok: true, destination: 'official' };
}

function renumberTemp() {
  tempVolumes().forEach((volume, index) => {
    volume.tempOrder = index + 1;
  });
}

function markMoved(ids, reason, startLayerNo, before) {
  state.movedVolumeIds = Array.from(new Set(ids));
  state.lastRearrangement = {
    reason,
    startLayerNo,
    at: new Date().toISOString(),
    positionsBefore: before || {}
  };
}

function rearrangeFromLayer(startIndex, reason, before, forcedIds = []) {
  for (let index = startIndex; index < state.rule.categories.length; index += 1) {
    const category = state.rule.categories[index];
    const volumes = officialVolumes(category.id);
    volumes.forEach((volume, volumeIndex) => {
      volume.slot = volumeIndex + 1;
    });
  }

  const affectedIds = [...forcedIds];
  if (before) {
    for (const volume of state.volumes) {
      const oldPosition = before[volume.id];
      if (!oldPosition) continue;
      if (volume.status === 'official') {
        const layerNo = layerNoForCategory(volume.categoryId);
        if (oldPosition.status !== 'official' || oldPosition.layerNo !== layerNo || oldPosition.slot !== volume.slot) {
          affectedIds.push(volume.id);
        }
      } else if (oldPosition.status !== volume.status) {
        affectedIds.push(volume.id);
      }
    }
  }
  markMoved(affectedIds, reason, startIndex + 1, before);
}

function transferSelectedVolume(targetCategoryId) {
  const volume = state.volumes.find((item) => item.id === state.selectedVolumeId);
  if (!volume) return { ok: false, message: '请先点击选择一卷。' };
  if (volume.status === 'pending') return { ok: false, message: '待归卷请直接选择门类后摆入，不算调层。' };

  const target = categoryById(targetCategoryId);
  if (!target) return { ok: false, message: '目标门类不存在。' };
  if (volume.status === 'temp') return { ok: false, message: '请先用暂存卡上的“挪回正式架”。' };

  const sourceCategoryId = volume.categoryId;
  if (sourceCategoryId === targetCategoryId) return { ok: false, message: '目标门类与当前门类相同。' };

  const before = positionSnapshot();
  const sourceIndex = layerNoForCategory(sourceCategoryId) - 1;
  const targetIndex = layerNoForCategory(targetCategoryId) - 1;
  const targetCount = officialVolumes(targetCategoryId).length;
  const tempCount = state.volumes.filter((item) => item.status === 'temp').length;
  const lockedCode = volume.archiveCode;

  if (targetCount >= SHELF_CAPACITY) {
    if (tempCount >= TEMP_CAPACITY) {
      return { ok: false, message: '目标层已满，且暂存格已满30卷，无法调入。' };
    }
    compactCategory(sourceCategoryId);
    volume.categoryId = targetCategoryId;
    volume.slot = null;
    assignTempPosition(volume);
    renumberTemp();
    rearrangeFromLayer(targetIndex, `《${volume.title}》从${categoryById(sourceCategoryId).name}调入`, before, [volume.id]);
    addLog(`《${volume.title}》调入${target.name}，目标层已满，暂存时保留锁定档号 ${lockedCode}。`);
    return { ok: true };
  }

  compactCategory(sourceCategoryId);
  volume.categoryId = targetCategoryId;
  volume.status = 'official';
  volume.slot = targetCount + 1;
  volume.tempOrder = null;
  volume.placedAt = volume.placedAt || new Date().toISOString();
  state.activeCategoryId = targetCategoryId;
  state.lastPlacedVolumeId = volume.id;

  const sweepIndex = Math.min(
    targetIndex,
    sourceIndex < targetIndex ? sourceIndex : targetIndex
  );
  rearrangeFromLayer(sweepIndex, `《${volume.title}》调入${target.name}`, before, [volume.id]);
  addLog(`《${volume.title}》调入第${targetIndex + 1}层，落第${volume.slot}格；第${sweepIndex + 1}层及以下已连带重排，原档号 ${lockedCode} 不变。`);
  return { ok: true };
}

function applyRule(nextRule) {
  const normalized = normalizeRule(nextRule);
  if (!normalized.ok) return normalized;
  const oldRule = state.rule;
  const rule = normalized.rule;
  const yearChanged = oldRule.year !== rule.year;
  const hadPlaced = state.volumes.some((volume) => volume.status !== 'pending');
  const before = positionSnapshot();

  if (yearChanged && hadPlaced) {
    const confirmed = window.confirm(`年度将从 ${oldRule.year} 改为 ${rule.year}。已经摆上的卷宗会全部回到待归区重摆，是否继续？`);
    if (!confirmed) return { ok: false, silent: true };
  }

  state.rule = rule;
  state.draftRule = clone(rule);
  state.selectedVolumeId = null;

  if (yearChanged && hadPlaced) {
    const oldCategoryOrder = oldRule.categories.map((item) => item.id);
    for (const volume of state.volumes) {
      volume.status = 'pending';
      volume.slot = null;
      volume.tempOrder = null;
      volume.originLayerNo = null;
      volume.carriedOriginLayerNo = null;
      volume.archiveCode = null;
      volume.sequence = null;
      volume.placedAt = null;
      if (volume.preResetCategoryId) volume.categoryId = volume.preResetCategoryId;
    }
    state.comparison = {
      triggeredAt: new Date().toISOString(),
      oldYear: oldRule.year,
      newYear: rule.year,
      before
    };
    state.lastPlacedVolumeId = null;
    state.lastRearrangement = null;
    state.movedVolumeIds = [];
    if (!rule.categories.some((item) => item.id === state.activeCategoryId)) state.activeCategoryId = rule.categories[0].id;
    addLog(`年度规矩改为${rule.year}，全部卷宗回到待归区，等待重摆比对。`);
    toast('已回到待归区，重摆时逐卷比对位置。');
  } else {
    reconcileCategoryOrder(oldRule, rule, before);
    if (!rule.categories.some((item) => item.id === state.activeCategoryId)) state.activeCategoryId = rule.categories[0].id;
    addLog('档号规矩已保存；已上架卷宗的档号继续锁定。');
    toast('规矩已保存，已落定档号不会改动。');
  }
  return { ok: true };
}

function reconcileCategoryOrder(oldRule, nextRule, before) {
  const oldOrder = oldRule.categories.map((item) => item.id);
  const nextOrder = nextRule.categories.map((item) => item.id);
  let changed = false;
  for (let index = 0; index < nextOrder.length; index += 1) {
    if (oldOrder[index] !== nextOrder[index]) changed = true;
  }
  for (let index = nextOrder.length; index < oldOrder.length; index += 1) changed = true;

  if (changed) {
    const movedIds = [];
    for (const volume of state.volumes) {
      if (volume.status !== 'official') continue;
      const oldLayer = oldOrder.indexOf(volume.categoryId) + 1;
      const newLayer = nextOrder.indexOf(volume.categoryId) + 1;
      if (oldLayer !== newLayer) movedIds.push(volume.id);
    }
    state.movedVolumeIds = movedIds;
    state.lastRearrangement = {
      reason: '门类顺序调整',
      startLayerNo: 1,
      at: new Date().toISOString(),
      positionsBefore: before
    };
    addLog('门类顺序变化，正式架层号已重排；已上架档号保持不变。');
  }
}

function normalizeRule(rule) {
  const year = String(rule.year || '').trim();
  if (!/^\d{4}$/.test(year)) return { ok: false, message: '年度必须是4位数字。' };
  const separator = rule.separator || '-';
  const retentions = rule.retentions
    .map((item) => ({ ...item, name: String(item.name || '').trim(), code: String(item.code || '').trim() }))
    .filter((item) => item.name || item.code);
  const categories = rule.categories
    .map((item) => ({ ...item, name: String(item.name || '').trim(), code: String(item.code || '').trim() }))
    .filter((item) => item.name || item.code);

  if (!retentions.length) return { ok: false, message: '至少保留一个保管期限。' };
  if (!categories.length) return { ok: false, message: '至少保留一个门类。' };
  if (state.volumes.some((volume) => !retentions.some((item) => item.id === volume.retentionId))) {
    return { ok: false, message: '不能删除仍有卷宗使用的保管期限。' };
  }
  if (state.volumes.some((volume) => !categories.some((item) => item.id === volume.categoryId))) {
    return { ok: false, message: '不能删除仍有卷宗使用的门类。' };
  }
  for (const group of [['保管期限', retentions], ['门类', categories]]) {
    const names = new Set();
    const codes = new Set();
    for (const item of group[1]) {
      if (!item.name || !item.code) return { ok: false, message: `${group[0]}的名称和代码都不能为空。` };
      if (names.has(item.name)) return { ok: false, message: `${group[0]}名称不能重复：${item.name}` };
      if (codes.has(item.code)) return { ok: false, message: `${group[0]}代码不能重复：${item.code}` };
      names.add(item.name);
      codes.add(item.code);
      if (/[\s]/.test(item.code)) return { ok: false, message: `${group[0]}代码不能含空格。` };
    }
  }
  return { ok: true, rule: { year, separator, retentions, categories } };
}

function makeVolume(title, retentionId, categoryId) {
  return {
    id: uid('vol'),
    title,
    retentionId,
    categoryId,
    status: 'pending',
    slot: null,
    tempOrder: null,
    originLayerNo: null,
    carriedOriginLayerNo: null,
    archiveCode: null,
    sequence: null,
    placedAt: null,
    createdAt: new Date().toISOString()
  };
}

function addVolume(title, retentionId, categoryId) {
  const volume = makeVolume(title, retentionId, categoryId);
  state.volumes.push(volume);
  state.activeCategoryId = categoryId;
  addLog(`《${title}》登记到待归区。`);
  return volume;
}

function loadSamples() {
  const rule = state.rule;
  const samples = [
    ['年度工作总结汇编', rule.retentions[0].id, rule.categories[0].id],
    ['基建项目验收材料', rule.retentions[1].id, rule.categories[1].id],
    ['年度决算报表', rule.retentions[0].id, rule.categories[2].id],
    ['重要会议录音', rule.retentions[2].id, rule.categories[3].id],
    ['人事任免通知', rule.retentions[0].id, rule.categories[0].id]
  ];
  samples.forEach(([title, retentionId, categoryId]) => addVolume(title, retentionId, categoryId));
  toast('已载入5卷示例待归卷宗。');
}

function addPressureBatch() {
  const category = state.rule.categories[0];
  const retention = state.rule.retentions[1] || state.rule.retentions[0];
  for (let index = 1; index <= 95; index += 1) {
    addVolume(`${category.name}容量测试第${index}卷`, retention.id, category.id);
  }
  state.activeCategoryId = category.id;
  toast('已加入95卷，可连续测试60卷入架、30卷暂存及满额拒收。');
}

function render() {
  renderRuleRows();
  renderSelects();
  renderWorkArea();
  renderTempArea();
  renderShelves();
  renderComparison();
  renderLogs();
}

function renderRuleRows() {
  const retentionHtml = state.draftRule.retentions.map((item, index) => `
    <div class="rule-row" data-kind="retention" data-id="${escapeHtml(item.id)}">
      <input data-field="name" value="${escapeHtml(item.name)}" placeholder="名称">
      <input data-field="code" value="${escapeHtml(item.code)}" placeholder="代码">
      <button type="button" class="secondary small" data-move="${index}" data-dir="up" title="上移">↑</button>
      <button type="button" class="secondary small" data-remove="${escapeHtml(item.id)}">删</button>
    </div>
  `).join('');
  const categoryHtml = state.draftRule.categories.map((item, index) => `
    <div class="rule-row" data-kind="category" data-id="${escapeHtml(item.id)}">
      <input data-field="name" value="${escapeHtml(item.name)}" placeholder="名称">
      <input data-field="code" value="${escapeHtml(item.code)}" placeholder="代码">
      <button type="button" class="secondary small" data-move="${index}" data-dir="up" title="上移">↑</button>
      <button type="button" class="secondary small" data-remove="${escapeHtml(item.id)}">删</button>
    </div>
  `).join('');
  $('#retentionRows').innerHTML = retentionHtml || '<div class="empty-state">请新增保管期限</div>';
  $('#categoryRows').innerHTML = categoryHtml || '<div class="empty-state">请新增门类</div>';
  $('#ruleYear').value = state.draftRule.year;
  $('#ruleSeparator').value = state.draftRule.separator;
}

function renderSelects() {
  const retentionOptions = state.rule.retentions.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  const categoryOptions = state.rule.categories.map((item) => `<option value="${escapeHtml(item.id)}">第${layerNoForCategory(item.id)}层 · ${escapeHtml(item.name)}</option>`).join('');
  $('#volumeForm').retentionId.innerHTML = retentionOptions;
  $('#volumeForm').categoryId.innerHTML = categoryOptions;
  $('#activeCategory').innerHTML = categoryOptions;
  $('#activeCategory').value = state.activeCategoryId;
  $('#transferTarget').innerHTML = categoryOptions;
}

function renderWorkArea() {
  const activeCategory = categoryById(state.activeCategoryId);
  const activeLayerNo = layerNoForCategory(state.activeCategoryId);
  const pending = pendingVolumes(state.activeCategoryId);
  const next = pending[0];
  const last = state.volumes.find((volume) => volume.id === state.lastPlacedVolumeId);
  const shelfCount = officialVolumes(state.activeCategoryId).length;
  const tempCount = tempVolumes().length;

  $('#resumeHint').textContent = `续存位置：第${activeLayerNo}层（${activeCategory?.name || '未命名门类'}）` +
    (last ? `，上次摆到《${last.title}》${last.status === 'official' ? `第${last.slot}格` : '（暂存中）'}` : '，本层还没有摆卷。');

  $('#nextVolume').innerHTML = next ? `
    <div>
      <strong>下一卷：</strong>${escapeHtml(next.title)}
      <div class="pending-meta">预计档号：<strong>${escapeHtml(previewArchiveCode(next))}</strong></div>
    </div>
  ` : '<div><strong>本层待归区已空。</strong></div>';

  $('#placeNext').disabled = !next || tempCount >= TEMP_CAPACITY && shelfCount >= SHELF_CAPACITY;
  $('#placeAll').disabled = !next;
  $('#pendingCount').textContent = `${state.volumes.filter((volume) => volume.status === 'pending').length} 卷待归`;

  const pendingHtml = state.volumes
    .filter((volume) => volume.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((volume) => {
      const category = categoryById(volume.categoryId);
      const retention = retentionById(volume.retentionId);
      return `
        <div class="pending-item">
          <div>
            <div class="pending-title">${escapeHtml(volume.title)}</div>
            <div class="pending-meta">${escapeHtml(retention?.name || '未知期限')} · 第${layerNoForCategory(volume.categoryId)}层 ${escapeHtml(category?.name || '')} · 预计 ${escapeHtml(previewArchiveCode(volume))}</div>
          </div>
          <span class="chip blue">待归</span>
        </div>
      `;
    }).join('');
  $('#pendingList').innerHTML = pendingHtml || '<div class="empty-state">待归区没有卷宗。</div>';

  const selected = state.volumes.find((volume) => volume.id === state.selectedVolumeId);
  if (selected && selected.status === 'official') {
    $('#selectedVolumeText').textContent = `已选《${selected.title}》，当前为${formatPhysicalPosition(selected)}，档号 ${selected.archiveCode}。`;
    $('#transferTarget').value = selected.categoryId;
    $('#transferVolume').disabled = $('#transferTarget').value === selected.categoryId;
  } else {
    $('#selectedVolumeText').textContent = '点击正式架上任一卷宗，再选择要调入的门类。';
    $('#transferVolume').disabled = true;
  }
}

function renderTempArea() {
  const volumes = tempVolumes();
  const cards = volumes.map((volume) => {
    const category = categoryById(volume.categoryId);
    const retention = retentionById(volume.retentionId);
    const preview = volume.archiveCode || [
      state.rule.year,
      retention?.code || '?',
      category?.code || '?',
      pad(nextSequence(volume.categoryId))
    ].join(state.rule.separator);
    return `
      <div class="temp-card">
        <div class="volume-code">${escapeHtml(preview)}</div>
        <div class="volume-title">${escapeHtml(volume.title)}</div>
        <div class="volume-position">暂存#${volume.tempOrder} · 来自第${volume.originLayerNo}层</div>
        <div class="chip-row">
          <span class="chip amber">原层号随卷</span>
          <button type="button" class="secondary small" data-restore="${escapeHtml(volume.id)}">挪回正式架</button>
        </div>
      </div>
    `;
  }).join('');

  $('#tempArea').innerHTML = `
    <div class="temp-bin">
      <div class="temp-header">
        <div>
          <h3>暂存格 <span class="count-badge">${volumes.length}/${TEMP_CAPACITY}</span></h3>
          <div class="pending-meta">满30卷后不再接收；每卷均记录并携带来源层号。</div>
        </div>
        <button type="button" class="secondary small" id="restoreEligible" ${volumes.length ? '' : 'disabled'}>挪回可归位卷</button>
      </div>
      <div class="progress"><span style="width:${Math.min(100, volumes.length / TEMP_CAPACITY * 100)}%"></span></div>
      <div class="temp-grid" style="margin-top:0.65rem">${cards || '<div class="empty-state">暂存格为空。</div>'}</div>
    </div>
  `;
}

function volumeCardHtml(volume) {
  const moved = state.movedVolumeIds?.includes(volume.id);
  const isLast = state.lastPlacedVolumeId === volume.id;
  const selected = state.selectedVolumeId === volume.id;
  const retention = retentionById(volume.retentionId);
  return `
    <button type="button" class="volume-card ${moved ? 'moved' : ''} ${isLast ? 'last' : ''} ${selected ? 'selected' : ''}" data-select="${escapeHtml(volume.id)}">
      <div class="volume-code">${escapeHtml(volume.archiveCode)}</div>
      <div class="volume-title">${escapeHtml(volume.title)}</div>
      <div class="volume-position">第${layerNoForCategory(volume.categoryId)}层 · 第${volume.slot}格</div>
      <div class="chip-row">
        <span class="chip">${escapeHtml(retention?.name || '期限')}</span>
        ${isLast ? '<span class="chip blue">上次摆到</span>' : ''}
        ${moved ? '<span class="chip green">重排移动</span>' : ''}
        ${volume.carriedOriginLayerNo ? `<span class="chip amber">来自暂存·原第${volume.carriedOriginLayerNo}层</span>` : ''}
      </div>
    </button>
  `;
}

function renderShelves() {
  const tempCount = tempVolumes().length;
  const html = state.rule.categories.map((category, index) => {
    const volumes = officialVolumes(category.id);
    const active = state.activeCategoryId === category.id;
    const full = volumes.length >= SHELF_CAPACITY;
    const overflow = tempVolumes().filter((volume) => volume.categoryId === category.id).length;
    const cards = volumes.map(volumeCardHtml).join('');
    return `
      <section class="shelf ${active ? 'active' : ''} ${full ? 'full' : ''}">
        <div class="shelf-header">
          <div class="shelf-title">
            <span class="layer-tag">第${index + 1}层</span>
            <h3>${escapeHtml(category.name)} <span class="pending-meta">${escapeHtml(category.code)}</span></h3>
            ${active ? '<span class="chip blue">当前手层</span>' : `<button type="button" class="secondary small" data-active="${escapeHtml(category.id)}">切到本层</button>`}
          </div>
          <div class="shelf-meta">
            <div>${volumes.length}/${SHELF_CAPACITY} 格</div>
            <div class="progress" style="width:130px"><span style="width:${volumes.length / SHELF_CAPACITY * 100}%"></span></div>
            ${overflow ? `<div>本门类暂存 ${overflow} 卷</div>` : ''}
            ${full ? '<div class="status-pending">本层已满</div>' : ''}
          </div>
        </div>
        <div class="shelf-grid">${cards || '<div class="empty-state">本层还没有卷宗。</div>'}</div>
      </section>
    `;
  }).join('');
  $('#shelves').innerHTML = html;
}

function renderComparison() {
  if (!state.comparison) {
    $('#comparisonSummary').innerHTML = '<div class="empty-state">尚未发生年度规矩变更。年度改动后，这里显示换位与未动的卷宗。</div>';
    $('#comparisonList').innerHTML = '';
    return;
  }

  const before = state.comparison.before;
  let moved = 0;
  let same = 0;
  let stillPending = 0;

  const rows = state.volumes.map((volume) => {
    const old = before[volume.id];
    const now = currentPositionForCompare(volume);
    const oldText = positionText(old);
    const nowText = positionText(now);
    let status = '待重摆';
    let className = 'status-pending';
    if (volume.status === 'pending') {
      stillPending += 1;
    } else if (old?.status === volume.status && old?.layerNo === now.layerNo && old?.slot === now.slot && old?.tempOrder === now.tempOrder) {
      status = '位置未动';
      className = 'status-same';
      same += 1;
    } else {
      status = '换了位置';
      className = 'status-moved';
      moved += 1;
    }
    return `
      <div class="comparison-item">
        <div>
          <div class="comparison-title">${escapeHtml(volume.title)}</div>
          <div class="comparison-meta">原：${escapeHtml(oldText)} → 现：${escapeHtml(nowText)}</div>
        </div>
        <span class="${className}">${status}</span>
      </div>
    `;
  }).join('');

  $('#comparisonSummary').innerHTML = `
    <div class="summary-row">
      <div class="summary-pill"><strong>${moved}</strong>换了位置</div>
      <div class="summary-pill"><strong>${same}</strong>没有移动</div>
      <div class="summary-pill"><strong>${stillPending}</strong>仍待重摆</div>
    </div>
  `;
  $('#comparisonList').innerHTML = rows;
}

function renderLogs() {
  $('#logList').innerHTML = state.logs.length ? state.logs.map((log) => {
    const time = new Date(log.at).toLocaleString('zh-CN', { hour12: false });
    return `<li><strong>${escapeHtml(time)}</strong> ${escapeHtml(log.message)}</li>`;
  }).join('') : '<li class="empty-state">暂无操作记录。</li>';
}

function commitAndRender(message) {
  persist();
  render();
  if (message) toast(message);
}

function bindEvents() {
  $('#ruleYear').addEventListener('input', (event) => {
    state.draftRule.year = event.target.value;
  });

  $('#ruleSeparator').addEventListener('change', (event) => {
    state.draftRule.separator = event.target.value;
  });

  $('#saveRule').addEventListener('click', () => {
    const result = applyRule(state.draftRule);
    if (result.ok) {
      persist();
      render();
    } else if (!result.silent) {
      toast(result.message);
    }
  });

  $('#retentionRows, #categoryRows').addEventListener('click', (event) => {
    const row = event.target.closest('.rule-row');
    if (!row) return;
    const kind = row.dataset.kind;
    const list = state.draftRule[kind === 'retention' ? 'retentions' : 'categories'];
    const item = list.find((entry) => entry.id === row.dataset.id);

    if (event.target.matches('[data-remove]')) {
      const usedIds = new Set(state.volumes.map((volume) => kind === 'retention' ? volume.retentionId : volume.categoryId));
      if (usedIds.has(item.id)) {
        toast(kind === 'retention' ? '不能删除仍有卷宗使用的保管期限。' : '不能删除仍有卷宗使用的门类。');
        return;
      }
      const index = list.indexOf(item);
      list.splice(index, 1);
      renderRuleRows();
      return;
    }

    if (event.target.matches('[data-move]')) {
      const index = Number(event.target.dataset.move);
      const direction = event.target.dataset.dir;
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= list.length) return;
      [list[index], list[targetIndex]] = [list[targetIndex], list[index]];
      renderRuleRows();
    }
  });

  $('#retentionRows, #categoryRows').addEventListener('input', (event) => {
    const row = event.target.closest('.rule-row');
    if (!row) return;
    const kind = row.dataset.kind;
    const list = state.draftRule[kind === 'retention' ? 'retentions' : 'categories'];
    const item = list.find((entry) => entry.id === row.dataset.id);
    if (item) item[event.target.dataset.field] = event.target.value;
  });

  $$('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const kind = button.dataset.add;
      const listKey = kind === 'retention' ? 'retentions' : 'categories';
      const prefix = kind === 'retention' ? 'ret' : 'cat';
      state.draftRule[listKey].push({
        id: uid(prefix),
        name: kind === 'retention' ? '新期限' : '新门类',
        code: `X${state.draftRule[listKey].length + 1}`
      });
      renderRuleRows();
    });
  });

  $('#volumeForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') || '').trim();
    const retentionId = String(form.get('retentionId'));
    const categoryId = String(form.get('categoryId'));
    if (!title) return;
    addVolume(title, retentionId, categoryId);
    event.currentTarget.title.value = '';
    commitAndRender('已登记到待归区。');
  });

  $('#activeCategory').addEventListener('change', (event) => {
    state.activeCategoryId = event.target.value;
    state.selectedVolumeId = null;
    persist();
    render();
  });

  $('#placeNext').addEventListener('click', () => {
    const volume = pendingVolumes(state.activeCategoryId)[0];
    const result = placeVolume(volume);
    if (!result.ok) {
      toast(result.message);
      return;
    }
    persist();
    render();
    toast(result.destination === 'temp' ? '本层已满，已摞到暂存格。' : '已摆上正式架，档号落定。');
  });

  $('#placeAll').addEventListener('click', () => {
    let officialCount = 0;
    let tempCount = 0;
    let blocked = null;
    while (true) {
      const volume = pendingVolumes(state.activeCategoryId)[0];
      if (!volume) break;
      const result = placeVolume(volume);
      if (!result.ok) {
        blocked = result.message;
        break;
      }
      if (result.destination === 'temp') tempCount += 1;
      else officialCount += 1;
    }
    persist();
    render();
    toast(blocked || `本层入架${officialCount}卷，暂存${tempCount}卷。`);
  });

  $('#tempArea').addEventListener('click', (event) => {
    const restoreId = event.target.dataset.restore;
    if (restoreId) {
      const volume = state.volumes.find((item) => item.id === restoreId);
      const result = placeVolume(volume, { fromRestore: true });
      if (!result.ok) toast(result.message);
      else commitAndRender('已挪回正式架，原暂存来源层号随卷显示。');
      return;
    }
    if (event.target.id === 'restoreEligible') {
      let restored = 0;
      for (const volume of tempVolumes()) {
        const room = officialVolumes(volume.categoryId).length < SHELF_CAPACITY;
        if (room) {
          const result = placeVolume(volume, { fromRestore: true });
          if (result.ok) restored += 1;
        }
      }
      commitAndRender(restored ? `已挪回${restored}卷，并携带原层号。` : '原层仍无空位。');
    }
  });

  $('#shelves').addEventListener('click', (event) => {
    const activeId = event.target.closest('[data-active]')?.dataset.active;
    if (activeId) {
      state.activeCategoryId = activeId;
      state.selectedVolumeId = null;
      persist();
      render();
      return;
    }
    const selectedId = event.target.closest('[data-select]')?.dataset.select;
    if (selectedId) {
      state.selectedVolumeId = selectedId;
      state.activeCategoryId = state.volumes.find((volume) => volume.id === selectedId)?.categoryId || state.activeCategoryId;
      persist();
      render();
    }
  });

  $('#transferTarget').addEventListener('change', (event) => {
    const selected = state.volumes.find((volume) => volume.id === state.selectedVolumeId);
    $('#transferVolume').disabled = !selected || selected.status !== 'official' || selected.categoryId === event.target.value;
  });

  $('#transferVolume').addEventListener('click', () => {
    const result = transferSelectedVolume($('#transferTarget').value);
    if (!result.ok) {
      toast(result.message);
      return;
    }
    state.selectedVolumeId = null;
    persist();
    render();
    toast('已调入，落脚层及下方层位完成连带重排。');
  });

  $('#loadSamples').addEventListener('click', () => {
    loadSamples();
    commitAndRender();
  });

  $('#addPressureBatch').addEventListener('click', () => {
    addPressureBatch();
    commitAndRender();
  });

  $('#clearAll').addEventListener('click', () => {
    if (!window.confirm('确定清空全部卷宗、规矩和比对记录吗？')) return;
    localStorage.removeItem(STORAGE_KEY);
    state = initialState();
    render();
    toast('已清空，可以重新开始。');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  render();
  document.querySelector('.volume-card.last')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
