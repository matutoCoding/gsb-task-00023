(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CatalogCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAL_LIMIT = 60;
  const TEMP_LIMIT = 30;
  const STORAGE_KEY = 'archive-catalog-station-v1';

  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const ok = (state, message) => ({ ok: true, state: clone(state), message, diff: state.lastDiff });
  const fail = (message) => ({ ok: false, error: message });
  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  function normalizeYear(year) {
    const value = String(year == null ? '' : year).trim();
    if (!/^\d{4}$/.test(value)) throw new Error('年度必须是四位数字。');
    return value;
  }

  function layerOf(rule, categoryId) {
    const index = rule.categories.findIndex((item) => item.id === categoryId);
    return index >= 0 ? index + 1 : null;
  }

  function getCategory(state, categoryId) {
    return state.rule.categories.find((item) => item.id === categoryId);
  }

  function getRetention(state, retentionId) {
    return state.rule.retentions.find((item) => item.id === retentionId);
  }

  function getVolume(state, volumeId) {
    return state.volumes.find((item) => item.id === volumeId);
  }

  function locationOf(volume) {
    if (!volume || volume.status === 'pending' || !volume.location) return null;
    return { area: volume.location.area, layer: volume.location.layer, slot: volume.location.slot };
  }

  function sameLocation(a, b) {
    return !!a && !!b && a.area === b.area && a.layer === b.layer && a.slot === b.slot;
  }

  function placedVolumes(state) {
    return state.volumes.filter((volume) => volume.status !== 'pending');
  }

  function layerVolumes(state, categoryId) {
    return state.volumes.filter((volume) => volume.categoryId === categoryId && volume.status !== 'pending');
  }

  function firstPending(state, categoryId) {
    return state.volumes
      .filter((volume) => volume.categoryId === categoryId && volume.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  }

  function countsOf(items) {
    return {
      formal: items.filter((item) => item.status === 'formal').length,
      temp: items.filter((item) => item.status === 'temp').length
    };
  }

  function validateRule(rule) {
    if (!Array.isArray(rule.retentions) || rule.retentions.length === 0) throw new Error('至少需要一个保管期限。');
    if (!Array.isArray(rule.categories) || rule.categories.length === 0) throw new Error('至少需要一个门类。');
    normalizeYear(rule.year);
  }

  function ensureCursor(state) {
    if (!state.cursor) state.cursor = { categoryId: null, volumeId: null };
    if (!getCategory(state, state.cursor.categoryId)) {
      state.cursor.categoryId = state.rule.categories[0] ? state.rule.categories[0].id : null;
    }
    const selected = state.cursor.volumeId ? getVolume(state, state.cursor.volumeId) : null;
    if (!selected || selected.status !== 'pending' || selected.categoryId !== state.cursor.categoryId) {
      state.cursor.volumeId = firstPending(state, state.cursor.categoryId)?.id || null;
    }
  }

  function demoState() {
    const retentions = [
      { id: 'ret_yong', code: 'Y', name: '永久' },
      { id: 'ret_d30', code: 'D30', name: '定期30年' },
      { id: 'ret_d10', code: 'D10', name: '定期10年' }
    ];
    const categories = [
      { id: 'cat_ws', code: 'WS', name: '文书' },
      { id: 'cat_kj', code: 'KJ', name: '科技' },
      { id: 'cat_cw', code: 'CW', name: '财务' }
    ];
    const samples = [
      ['年度综合计划', 'ret_yong', 'cat_ws'],
      ['会议记录汇编', 'ret_d30', 'cat_ws'],
      ['合同审批附件', 'ret_d30', 'cat_ws'],
      ['项目立项材料', 'ret_yong', 'cat_kj'],
      ['设备验收记录', 'ret_d30', 'cat_kj'],
      ['专利申报底稿', 'ret_yong', 'cat_kj'],
      ['年度决算报表', 'ret_yong', 'cat_cw'],
      ['经费报销凭证', 'ret_d10', 'cat_cw'],
      ['预算调整说明', 'ret_d10', 'cat_cw'],
      ['审计整改台账', 'ret_d30', 'cat_cw']
    ];
    const state = {
      version: 1,
      rule: { year: '2026', retentions, categories },
      counters: {},
      volumes: [],
      cursor: { categoryId: 'cat_ws', volumeId: null },
      selectedVolumeId: null,
      lastDiff: null,
      reshelfBaseline: null,
      lastSavedAt: new Date().toISOString()
    };
    samples.forEach(([title, retentionId, categoryId], index) => {
      state.volumes.push({
        id: `vol_demo_${index + 1}`,
        title,
        retentionId,
        categoryId,
        status: 'pending',
        code: null,
        codeLocked: false,
        location: null,
        originLayer: null,
        createdAt: index
      });
    });
    ensureCursor(state);
    return state;
  }

  function normalizeState(input) {
    const state = input && input.version === 1 ? clone(input) : demoState();
    validateRule(state.rule);
    if (!state.counters) state.counters = {};
    if (!state.volumes) state.volumes = [];
    if (!state.cursor) state.cursor = { categoryId: null, volumeId: null };
    ensureCursor(state);
    state.lastSavedAt = new Date().toISOString();
    return state;
  }

  function snapshot(state, ids) {
    const wanted = new Set(ids || state.volumes.map((volume) => volume.id));
    const result = {};
    state.volumes.filter((volume) => wanted.has(volume.id)).forEach((volume) => {
      result[volume.id] = { code: volume.code, status: volume.status, location: locationOf(volume) };
    });
    return result;
  }

  function buildDiff(state, label, before, ids, options) {
    const settings = Object.assign({ added: false, pending: false }, options || {});
    const wanted = new Set(ids || state.volumes.map((volume) => volume.id));
    const order = { added: 0, shelved: 1, moved: 2, 'returned-pending': 3, unchanged: 4 };
    const items = state.volumes.filter((volume) => wanted.has(volume.id)).map((volume) => {
      const old = before[volume.id];
      const currentLocation = locationOf(volume);
      let type = 'unchanged';
      if (!old && settings.added) type = 'added';
      if (old && old.status === 'pending' && volume.status !== 'pending') type = 'shelved';
      if (old && old.status !== 'pending' && volume.status === 'pending') {
        type = settings.pending ? 'returned-pending' : 'moved';
      }
      if (old && old.status !== 'pending' && volume.status !== 'pending' && !sameLocation(old.location, currentLocation)) {
        type = 'moved';
      }
      return {
        volumeId: volume.id,
        title: volume.title,
        type,
        from: old ? old.location : null,
        to: currentLocation,
        oldCode: old ? old.code : null,
        newCode: volume.code
      };
    });
    items.sort((a, b) => order[a.type] - order[b.type] || (a.to?.slot || 999) - (b.to?.slot || 999) || a.title.localeCompare(b.title, 'zh-Hans-CN'));
    state.lastDiff = { id: uid('diff'), label, at: new Date().toISOString(), items };
    return state.lastDiff;
  }

  function counterKey(year, categoryId) {
    return `${year}:${categoryId}`;
  }

  function nextSequence(state, categoryId) {
    return (state.counters[counterKey(state.rule.year, categoryId)] || 0) + 1;
  }

  function assignCode(state, volume) {
    const retention = getRetention(state, volume.retentionId);
    const category = getCategory(state, volume.categoryId);
    if (!retention) throw new Error('卷宗使用的保管期限已不存在。');
    if (!category) throw new Error('卷宗使用的门类已不存在。');
    const key = counterKey(state.rule.year, volume.categoryId);
    const sequence = (state.counters[key] || 0) + 1;
    volume.code = `${state.rule.year}-${retention.code}-${category.code}-${String(sequence).padStart(4, '0')}`;
    volume.codeLocked = true;
    state.counters[key] = sequence;
  }

  function freeFormalSlot(items) {
    const used = new Set(items.filter((item) => item.status === 'formal').map((item) => item.location.slot));
    for (let slot = 1; slot <= FORMAL_LIMIT; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return null;
  }

  function freeTempOrder(items) {
    const used = new Set(items.filter((item) => item.status === 'temp').map((item) => item.location.slot));
    for (let slot = 1; slot <= TEMP_LIMIT; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return null;
  }

  function placeReady(state, categoryId) {
    const counts = countsOf(layerVolumes(state, categoryId));
    if (counts.temp >= TEMP_LIMIT) return { ok: false, error: '暂存格已放满三十卷，不再接收新卷宗。' };
    if (counts.formal < FORMAL_LIMIT && counts.temp > 0) {
      return { ok: false, error: '正式架空位必须先由暂存格卷宗带回原层号，暂不接收新卷宗。' };
    }
    if (counts.formal + counts.temp >= FORMAL_LIMIT + TEMP_LIMIT) {
      return { ok: false, error: '本层正式架和暂存格均已放满。' };
    }
    return { ok: true };
  }

  function settleVolume(state, volume, relockCode) {
    const layer = layerOf(state.rule, volume.categoryId);
    const items = layerVolumes(state, volume.categoryId);
    const counts = countsOf(items);
    let area;
    let slot;
    if (counts.formal < FORMAL_LIMIT && counts.temp === 0) {
      area = 'formal';
      slot = freeFormalSlot(items);
    } else if (counts.formal >= FORMAL_LIMIT && counts.temp < TEMP_LIMIT) {
      area = 'temp';
      slot = freeTempOrder(items);
      if (slot == null) throw new Error('暂存格已放满三十卷。');
      if (!volume.originLayer) volume.originLayer = layer;
    } else {
      throw new Error('请先把暂存格卷宗挪回正式架。');
    }
    if (!volume.codeLocked || relockCode) assignCode(state, volume);
    volume.status = area;
    volume.location = { layer, area, slot };
  }

  function compactLayer(state, categoryId) {
    const layer = layerOf(state.rule, categoryId);
    let formal = layerVolumes(state, categoryId)
      .filter((volume) => volume.status === 'formal')
      .sort((a, b) => a.location.slot - b.location.slot || a.createdAt - b.createdAt);
    let temp = layerVolumes(state, categoryId)
      .filter((volume) => volume.status === 'temp')
      .sort((a, b) => a.location.slot - b.location.slot || a.createdAt - b.createdAt);
    if (formal.length > FORMAL_LIMIT) {
      temp = formal.slice(FORMAL_LIMIT).concat(temp);
      formal = formal.slice(0, FORMAL_LIMIT);
    }
    if (temp.length > TEMP_LIMIT) throw new Error('暂存格超过三十卷，无法完成重排。');
    formal.forEach((volume, index) => {
      volume.status = 'formal';
      volume.location = { layer, area: 'formal', slot: index + 1 };
    });
    temp.forEach((volume, index) => {
      volume.status = 'temp';
      volume.location = { layer, area: 'temp', slot: index + 1 };
      if (!volume.originLayer) volume.originLayer = layer;
    });
  }

  function setCursorToNext(state, categoryId, currentVolumeId) {
    const ordered = state.volumes
      .filter((volume) => volume.categoryId === categoryId && volume.status === 'pending' && volume.id !== currentVolumeId)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    state.cursor.categoryId = categoryId;
    state.cursor.volumeId = ordered ? ordered.id : null;
  }

  function placeNext(input, categoryId, options) {
    const state = normalizeState(input);
    const settings = options || {};
    const category = getCategory(state, categoryId);
    if (!category) return fail('请选择有效门类。');
    const guard = placeReady(state, categoryId);
    if (!guard.ok) return fail(guard.error);
    const volumeId = settings.volumeId;
    const volume = volumeId
      ? getVolume(state, volumeId)
      : (state.cursor.categoryId === categoryId && state.cursor.volumeId
        ? getVolume(state, state.cursor.volumeId)
        : firstPending(state, categoryId));
    if (!volume || volume.status !== 'pending' || volume.categoryId !== categoryId) {
      return fail('手上这一卷不在该门类待归区。');
    }
    const before = snapshot(state, [volume.id]);
    settleVolume(state, volume, false);
    state.selectedVolumeId = volume.id;
    setCursorToNext(state, categoryId, volume.id);
    buildDiff(state, settings.label || '摆上架', before, [volume.id], { added: false });
    return ok(state, `已摆入：${volume.title}`);
  }

  function placeAll(input, categoryId) {
    let current = normalizeState(input);
    let result = null;
    let guard = placeReady(current, categoryId);
    while (guard.ok && firstPending(current, categoryId)) {
      result = placeNext(current, categoryId, { label: '连续摆架' });
      if (!result.ok) break;
      current = result.state;
      guard = placeReady(current, categoryId);
    }
    if (!result) return fail('该门类没有待归卷宗。');
    if (!result.ok) return result;
    const remaining = firstPending(current, categoryId);
    return ok(result.state, remaining ? `已停下：${guard.error || '暂不能继续摆架。'}` : '该门类待归卷宗已全部摆完。');
  }

  function returnTemp(input, categoryId) {
    const state = normalizeState(input);
    if (!getCategory(state, categoryId)) return fail('请选择有效门类。');
    const items = layerVolumes(state, categoryId);
    const counts = countsOf(items);
    if (counts.temp === 0) return fail('暂存格上没有卷宗。');
    if (counts.formal >= FORMAL_LIMIT) return fail('正式架已满六十卷，暂无空位。');
    const before = snapshot(state, items.map((volume) => volume.id));
    const top = items.filter((volume) => volume.status === 'temp').sort((a, b) => b.location.slot - a.location.slot)[0];
    top.status = 'formal';
    top.location = { layer: layerOf(state.rule, categoryId), area: 'formal', slot: FORMAL_LIMIT + 1 };
    compactLayer(state, categoryId);
    buildDiff(state, '暂存卷宗回正式架', before, items.map((volume) => volume.id));
    state.selectedVolumeId = top.id;
    ensureCursor(state);
    return ok(state, `已将暂存格顶部卷宗带回原层号：${top.title}`);
  }

  function transferVolume(input, volumeId, targetCategoryId) {
    const state = normalizeState(input);
    const volume = getVolume(state, volumeId);
    const target = getCategory(state, targetCategoryId);
    if (!volume) return fail('找不到这卷卷宗。');
    if (!target) return fail('目标门类不存在。');
    if (volume.categoryId === targetCategoryId) return fail('这卷卷宗已经在该门类。');

    const sourceCategoryId = volume.categoryId;
    const sourceIndex = state.rule.categories.findIndex((item) => item.id === sourceCategoryId);
    const targetIndex = state.rule.categories.findIndex((item) => item.id === targetCategoryId);
    const affectedIds = state.volumes
      .filter((item) => {
        const index = state.rule.categories.findIndex((category) => category.id === item.categoryId);
        return item.status !== 'pending' && (index === sourceIndex || index >= targetIndex);
      })
      .map((item) => item.id);
    if (volume.status !== 'pending') affectedIds.push(volume.id);
    const before = snapshot(state, Array.from(new Set(affectedIds)));

    if (volume.status !== 'pending') {
      volume.status = 'pending';
      volume.location = null;
      compactLayer(state, sourceCategoryId);
    }

    state.rule.categories.slice(targetIndex).forEach((category) => compactLayer(state, category.id));

    const targetItems = layerVolumes(state, targetCategoryId);
    const targetCounts = countsOf(targetItems);
    if (targetCounts.formal + targetCounts.temp >= FORMAL_LIMIT + TEMP_LIMIT) {
      return fail('落脚层及暂存格已满，不能接收调入卷宗。');
    }
    if (targetCounts.formal < FORMAL_LIMIT && targetCounts.temp > 0) {
      return fail('落脚层暂存格尚未回架，不能承接调入卷宗。');
    }

    volume.categoryId = targetCategoryId;
    settleVolume(state, volume, volume.codeLocked);
    state.rule.categories.slice(targetIndex).forEach((category) => compactLayer(state, category.id));

    state.selectedVolumeId = volume.id;
    state.cursor.categoryId = targetCategoryId;
    state.cursor.volumeId = firstPending(state, targetCategoryId)?.id || null;
    buildDiff(state, `调入${target.name}门类并连带重排`, before, Array.from(new Set(affectedIds.concat([volume.id]))));
    return ok(state, `已调入：${volume.title}，落脚层及以下已重排。`);
  }

  function changeYear(input, newYear) {
    const state = normalizeState(input);
    let year;
    try {
      year = normalizeYear(newYear);
    } catch (errorDetail) {
      return fail(errorDetail.message);
    }
    if (year === state.rule.year) return fail('年度没有变化。');
    const before = snapshot(state);
    state.rule.year = year;
    state.counters = {};
    state.volumes.forEach((volume) => {
      if (volume.status !== 'pending') {
        volume.status = 'pending';
        volume.location = null;
        volume.code = null;
        volume.codeLocked = false;
        volume.originLayer = null;
      }
    });
    state.reshelfBaseline = {
      at: new Date().toISOString(),
      label: `年度改为 ${year} 前的位置`,
      locations: Object.fromEntries(Object.entries(before).map(([id, item]) => [id, clone(item)]))
    };
    ensureCursor(state);
    buildDiff(state, '修改年度，已摆卷宗全部回到待归区', before, state.volumes.map((volume) => volume.id), { pending: true });
    return ok(state, '年度已修改，全部卷宗已回到待归区重摆。');
  }

  function clearReshelfBaseline(input) {
    const state = normalizeState(input);
    state.reshelfBaseline = null;
    return ok(state, '已清除重摆前位置。');
  }

  function baselineComparison(input) {
    const state = normalizeState(input);
    if (!state.reshelfBaseline) return null;
    const items = state.volumes.map((volume) => {
      const old = state.reshelfBaseline.locations[volume.id];
      const current = locationOf(volume);
      let type = 'pending';
      if (!old && volume.status !== 'pending') {
        type = 'added';
      } else if (old && volume.status !== 'pending') {
        type = sameLocation(old.location, current) ? 'unchanged' : 'moved';
      }
      return {
        volumeId: volume.id,
        title: volume.title,
        type,
        from: old ? old.location : null,
        to: current,
        newCode: volume.code
      };
    });
    return {
      label: state.reshelfBaseline.label,
      at: state.reshelfBaseline.at,
      moved: items.filter((item) => item.type === 'moved').length,
      unchanged: items.filter((item) => item.type === 'unchanged').length,
      added: items.filter((item) => item.type === 'added').length,
      pending: items.filter((item) => item.type === 'pending').length,
      items
    };
  }

  function addVolume(input, draft) {
    const state = normalizeState(input);
    const title = String(draft.title || '').trim();
    if (!title) return fail('请填写卷宗题名。');
    if (!getRetention(state, draft.retentionId)) return fail('请选择有效保管期限。');
    if (!getCategory(state, draft.categoryId)) return fail('请选择有效门类。');
    const volume = {
      id: uid('vol'),
      title,
      retentionId: draft.retentionId,
      categoryId: draft.categoryId,
      status: 'pending',
      code: null,
      codeLocked: false,
      location: null,
      originLayer: null,
      createdAt: Date.now() + state.volumes.length
    };
    state.volumes.push(volume);
    state.cursor.categoryId = volume.categoryId;
    state.cursor.volumeId = volume.id;
    state.selectedVolumeId = volume.id;
    return ok(state, `已送入待归区：${title}`);
  }

  function selectLayer(input, categoryId, volumeId) {
    const state = normalizeState(input);
    if (!getCategory(state, categoryId)) return fail('请选择有效门类。');
    state.cursor.categoryId = categoryId;
    if (volumeId) {
      const volume = getVolume(state, volumeId);
      if (!volume) return fail('找不到这卷卷宗。');
      state.selectedVolumeId = volumeId;
      if (volume.status === 'pending' && volume.categoryId === categoryId) state.cursor.volumeId = volumeId;
    } else {
      state.cursor.volumeId = firstPending(state, categoryId)?.id || null;
    }
    return ok(state, '已切换当前层。');
  }

  function codePreview(input, categoryId, retentionId) {
    const state = normalizeState(input);
    const category = getCategory(state, categoryId || state.cursor.categoryId);
    const retention = getRetention(state, retentionId) || state.rule.retentions[0];
    if (!category || !retention) return '';
    const sequence = nextSequence(state, category.id);
    return `${state.rule.year}-${retention.code}-${category.code}-${String(sequence).padStart(4, '0')}`;
  }

  function addRetention(input, code, name) {
    const state = normalizeState(input);
    const normalizedCode = String(code || '').trim();
    const normalizedName = String(name || '').trim();
    if (!normalizedCode || !normalizedName) return fail('请填写保管期限代码和名称。');
    if (state.rule.retentions.some((item) => item.code === normalizedCode)) return fail('保管期限代码已存在。');
    state.rule.retentions.push({ id: uid('ret'), code: normalizedCode, name: normalizedName });
    return ok(state, '已添加保管期限；已锁定档号不变。');
  }

  function updateRetention(input, retentionId, patch) {
    const state = normalizeState(input);
    const retention = getRetention(state, retentionId);
    if (!retention) return fail('保管期限不存在。');
    const code = String(patch.code || '').trim();
    const name = String(patch.name || '').trim();
    if (!code || !name) return fail('代码和名称不能为空。');
    if (state.rule.retentions.some((item) => item.id !== retentionId && item.code === code)) return fail('保管期限代码已存在。');
    retention.code = code;
    retention.name = name;
    return ok(state, '保管期限已更新；已落定档号保持不变。');
  }

  function removeRetention(input, retentionId) {
    const state = normalizeState(input);
    if (!getRetention(state, retentionId)) return fail('保管期限不存在。');
    if (state.volumes.some((volume) => volume.retentionId === retentionId)) {
      return fail('已有卷宗使用该保管期限，不能删除。');
    }
    state.rule.retentions = state.rule.retentions.filter((item) => item.id !== retentionId);
    return ok(state, '已删除保管期限。');
  }

  function addCategory(input, code, name) {
    const state = normalizeState(input);
    const normalizedCode = String(code || '').trim();
    const normalizedName = String(name || '').trim();
    if (!normalizedCode || !normalizedName) return fail('请填写门类代码和名称。');
    if (state.rule.categories.some((item) => item.code === normalizedCode)) return fail('门类代码已存在。');
    state.rule.categories.push({ id: uid('cat'), code: normalizedCode, name: normalizedName });
    ensureCursor(state);
    return ok(state, '已在末尾追加一层；原有层号不变。');
  }

  function updateCategory(input, categoryId, patch) {
    const state = normalizeState(input);
    const category = getCategory(state, categoryId);
    if (!category) return fail('门类不存在。');
    const code = String(patch.code || '').trim();
    const name = String(patch.name || '').trim();
    if (!code || !name) return fail('代码和名称不能为空。');
    if (state.rule.categories.some((item) => item.id !== categoryId && item.code === code)) return fail('门类代码已存在。');
    category.code = code;
    category.name = name;
    return ok(state, '门类已更新；架层和已落定档号不变。');
  }

  function resetDemo() {
    return ok(demoState(), '已恢复演示数据。');
  }

  return {
    FORMAL_LIMIT,
    TEMP_LIMIT,
    STORAGE_KEY,
    demoState,
    normalizeState,
    layerOf,
    layerVolumes,
    countsOf,
    codePreview,
    placeNext,
    placeAll,
    returnTemp,
    transferVolume,
    changeYear,
    clearReshelfBaseline,
    baselineComparison,
    addVolume,
    selectLayer,
    addRetention,
    updateRetention,
    removeRetention,
    addCategory,
    updateCategory,
    resetDemo
  };
});
