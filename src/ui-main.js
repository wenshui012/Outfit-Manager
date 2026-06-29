// ── 穿搭管理器 · 主界面 v2 ──────────────────────────────────
// 全屏弹窗、视角切换、分类栏、穿搭网格、底栏状态、详情面板
// v2: 使用分包存储 API (loadMeta/loadCurrent/saveCurrent/etc.)
//     角色管理仍经由兼容层 load()/save() 处理 charIndex ↔ charNames 翻译

import {
    load, save,
    loadMeta, saveMeta,
    loadCurrent, saveCurrent,
    loadPartition, savePartition, ensurePartition, deletePartition,
    currentPartKey, currentUserPartKey,
    syncActivePartitions, syncCurrentUserActivePartition,
    loadActivePartitions,
    charNameById, charIdByName, charPartKey,
    isServerMode, resolveImageForExternal, getImageUrlPrefix
} from './db.js';
import {
    getCatNames, getSubCats, hasSubCats,
    partGetById, partIsActive, partGetAccById,
    getActiveKit, getKitAccessories, ensureOutfitKits, cleanAccIdFromKits,
    SHARED_CHAR_KEY, SHARED_CHAR_LABEL
} from './data.js';
import { genId, esc, toast, getPopupLayer } from './utils.js';
import { injectStyles } from './styles.js';
import { state, fn } from './bridge.js';

// ── 预解析活跃穿搭图片（server模式下）──────────────────
function preResolveActiveImages() {
    if (!isServerMode()) return;
    var prefix = getImageUrlPrefix();
    var activeParts = loadActivePartitions();

    function resolveForPartition(part) {
        if (!part || !part.activeIds || !part.outfits) return;
        part.activeIds.forEach(function (id) {
            var o = partGetById(part, id);
            if (!o || !o.imageData || typeof o.imageData !== 'string') return;
            if (o.imageData.indexOf(prefix) !== 0) return;
            if (state.resolvedImages[o.id] && state.resolvedImages[o.id].url === o.imageData) return;
            (function (outfit) {
                resolveImageForExternal(outfit.imageData, function (dataUrl) {
                    state.resolvedImages[outfit.id] = { url: outfit.imageData, dataUrl: dataUrl };
                });
            })(o);
        });
    }

    for (var pk in activeParts) {
        resolveForPartition(activeParts[pk]);
    }
}

var SCRIPT_NAME = '穿搭管理';

// ── 弹窗状态 ──────────────────────────────────────────────
var detailPanelOpen = false;

// ── 懒加载 ──────────────────────────────────────────────
var gridImageObserver = null;
var OM_TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function uniqueIds(ids) {
    var result = [];
    var seen = {};
    (ids || []).forEach(function (id) {
        if (!id || seen[id]) return;
        seen[id] = true;
        result.push(id);
    });
    return result;
}

function clearKitDraft() {
    state.kitFocusPartKey = null;
    state.kitFocusOutfitId = null;
    state.kitDraftAccIds = [];
    state.kitDraftSourceKitId = null;
    state.kitDraftDirty = false;
}

function isCurrentKitFocus(partKey, outfitId) {
    return state.kitFocusPartKey === partKey && state.kitFocusOutfitId === outfitId;
}

function getCurrentFocusContext() {
    if (!state.kitFocusPartKey || !state.kitFocusOutfitId) return null;
    var part = loadPartition(state.kitFocusPartKey);
    var outfit = partGetById(part, state.kitFocusOutfitId);
    if (!part || !outfit || (part.activeIds || []).indexOf(outfit.id) === -1) {
        clearKitDraft();
        return null;
    }
    ensureOutfitKits(outfit);
    return { partKey: state.kitFocusPartKey, part: part, outfit: outfit };
}

function setKitFocus(partKey, outfitId) {
    var part = loadPartition(partKey);
    var outfit = partGetById(part, outfitId);
    if (!part || !outfit || (part.activeIds || []).indexOf(outfitId) === -1) return false;
    ensureOutfitKits(outfit);
    var kit = getActiveKit(outfit);
    state.kitFocusPartKey = partKey;
    state.kitFocusOutfitId = outfitId;
    state.kitDraftAccIds = kit ? uniqueIds(kit.accIds || []) : [];
    state.kitDraftSourceKitId = kit ? kit.id : null;
    state.kitDraftDirty = false;
    return true;
}

function ensureKitFocusForAccMode(showToast) {
    if (!state.accMode) return false;
    var pk = currentPartKey();
    var ctx = getCurrentFocusContext();
    if (ctx && ctx.partKey === pk) return true;

    clearKitDraft();
    var part = loadCurrent();
    var active = (part.activeIds || []).filter(function (id) { return !!partGetById(part, id); });
    if (active.length === 1) return setKitFocus(pk, active[0]);
    if (showToast) {
        toast(active.length === 0 ? '请先选择一套穿搭' : '当前衣柜有多套已选穿搭，请在底栏点一个主体', true);
    }
    return false;
}

function draftHasAcc(accId) {
    if (state.kitFocusPartKey !== currentPartKey()) return false;
    return (state.kitDraftAccIds || []).indexOf(accId) !== -1;
}

function refreshDetailPanel() {
    if (!detailPanelOpen) return;
    var groups = buildDetailGroups();
    if (groups.length === 0) { closeDetailPanel(); return; }
    openDetailPanel(groups);
}

function toggleDraftAcc(accId) {
    if (!ensureKitFocusForAccMode(true)) {
        refreshDetailPanel();
        return;
    }
    var ids = uniqueIds(state.kitDraftAccIds || []);
    var idx = ids.indexOf(accId);
    if (idx !== -1) ids.splice(idx, 1);
    else ids.push(accId);
    state.kitDraftAccIds = ids;
    state.kitDraftDirty = true;
    renderGrid();
    refreshDetailPanel();
}

function nextKitName(kits) {
    var n = (kits || []).length + 1;
    var used = {};
    (kits || []).forEach(function (kit) { if (kit && kit.name) used[kit.name] = true; });
    while (used['套装' + n]) n++;
    return '套装' + n;
}

function saveFocusedKitDraft() {
    if (!ensureKitFocusForAccMode(true)) return;
    var ctx = getCurrentFocusContext();
    if (!ctx || ctx.partKey !== currentPartKey()) { toast('请先在当前衣柜选择主体', true); return; }
    ensureOutfitKits(ctx.outfit);
    var draft = uniqueIds(state.kitDraftAccIds || []).filter(function (id) { return !!partGetAccById(ctx.part, id); });
    var kit = getActiveKit(ctx.outfit);

    if (!kit) {
        if (draft.length === 0) { toast('请先选择配饰', true); return; }
        var autoName = nextKitName(ctx.outfit.kits);
        var rawName = prompt('套装名称（留空自动命名）：', autoName);
        if (rawName === null) return;
        kit = { id: 'k_' + genId(), name: rawName.trim() || autoName, accIds: draft, disabledAccIds: [] };
        ctx.outfit.kits.push(kit);
        ctx.outfit.activeKitId = kit.id;
    } else {
        kit.accIds = draft;
        if (!Array.isArray(kit.disabledAccIds)) kit.disabledAccIds = [];
        kit.disabledAccIds = kit.disabledAccIds.filter(function (id) { return draft.indexOf(id) !== -1; });
    }

    ensureOutfitKits(ctx.outfit);
    savePartition(ctx.partKey, ctx.part);
    setKitFocus(ctx.partKey, ctx.outfit.id);
    state.kitDraftDirty = false;
    renderGrid();
    renderBottomStatus();
    refreshDetailPanel();
    toast('已保存套装');
}

function toggleDisabledAcc(partKey, outfitId, accId) {
    var part = loadPartition(partKey);
    var outfit = partGetById(part, outfitId);
    if (!part || !outfit) return;
    ensureOutfitKits(outfit);
    var kit = getActiveKit(outfit);
    if (!kit || (kit.accIds || []).indexOf(accId) === -1) return;
    if (!Array.isArray(kit.disabledAccIds)) kit.disabledAccIds = [];
    var idx = kit.disabledAccIds.indexOf(accId);
    if (idx !== -1) kit.disabledAccIds.splice(idx, 1);
    else kit.disabledAccIds.push(accId);
    ensureOutfitKits(outfit);
    savePartition(partKey, part);
    renderBottomStatus();
    refreshDetailPanel();
}

function filterActiveForCurrentMode() {
    return state.accMode ? (state.filterNoCat || state.filterNoDesc) : (state.filterNoCat || state.filterNoTag || state.filterNoDesc);
}

function updateSearchPlaceholder() {
    var inp = document.getElementById('om-search-inp');
    if (inp) inp.placeholder = state.accMode ? '搜索配饰…' : '搜索穿搭…';
}

function updateFilterBarForMode() {
    var tagChip = document.getElementById('om-filter-notag');
    if (tagChip) tagChip.style.display = state.accMode ? 'none' : '';
    var fbtn = document.getElementById('om-filter-toggle');
    if (fbtn) fbtn.classList.toggle('om-filter-active', filterActiveForCurrentMode());
}

function updateBatchButtonState() {
    var btn = document.getElementById('om-batch-toggle');
    if (btn) btn.classList.toggle('on', state.batchMode);
}

function batchDeleteAccessories(accIds) {
    accIds = uniqueIds(accIds || []);
    if (accIds.length === 0) { toast('请先选择配饰', true); return; }
    if (!confirm('确定删除 ' + accIds.length + ' 个配饰？引用它们的套装方案将自动更新。')) return;
    var part = loadCurrent();
    part.accessories = (part.accessories || []).filter(function (acc) {
        return accIds.indexOf(acc.id) === -1;
    });
    accIds.forEach(function (id) { cleanAccIdFromKits(part, id); });
    if (state.kitFocusPartKey === currentPartKey()) {
        state.kitDraftAccIds = (state.kitDraftAccIds || []).filter(function (id) { return accIds.indexOf(id) === -1; });
    }
    saveCurrent(part);
    state.batchSelected = [];
    state.batchMode = false;
    updateBatchButtonState();
    fn.renderAccCatbar();
    renderGrid();
    renderBottomStatus();
    toast('已删除 ' + accIds.length + ' 个配饰');
}

function setupGridLazyImages(area) {
    if (gridImageObserver) { gridImageObserver.disconnect(); gridImageObserver = null; }

    var imgs = area.querySelectorAll('img.om-lazy-img[data-outfit-id]');
    if (!imgs.length) return;

    function loadImg(img) {
        if (!img || img.dataset.loaded === '1') return;
        var id = img.getAttribute('data-outfit-id');
        var part = loadCurrent();
        var o = partGetById(part, id);
        if (!o || !o.imageData) return;
        img.dataset.loaded = '1';
        img.onload = function () { img.classList.add('om-loaded'); };
        img.onerror = function () { img.classList.add('om-loaded'); };
        img.src = o.imageData;
        img.removeAttribute('data-outfit-id');
        if (img.complete && img.naturalWidth) img.classList.add('om-loaded');
    }

    if (!('IntersectionObserver' in window)) { imgs.forEach(loadImg); return; }

    gridImageObserver = new IntersectionObserver(function (entries, observer) {
        entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            loadImg(entry.target);
            observer.unobserve(entry.target);
        });
    }, { root: area, rootMargin: '400px 0px', threshold: 0.01 });

    imgs.forEach(function (img) { gridImageObserver.observe(img); });
}

// ── 打开全屏主界面 ────────────────────────────────────────
function openPopup() {
    if (document.querySelector('.om-overlay')) return;
    var shield = document.createElement('div');
    shield.setAttribute('style', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;');
    shield.addEventListener('touchstart', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    shield.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    document.body.appendChild(shield);
    setTimeout(function () { if (shield.parentNode) shield.parentNode.removeChild(shield); }, 400);

    injectStyles();
    state.batchMode = false; state.batchSelected = []; state.searchQuery = ''; state.searchOpen = false; detailPanelOpen = false;
    state.catDrillParent = null; state.curSubCat = null;
    state.filterOpen = false; state.filterNoCat = false; state.filterNoTag = false; state.filterNoDesc = false;
    state.accMode = false; state.accCat = '__all__'; state.accDrillParent = null; state.accSubCat = null;
    clearKitDraft();

    var meta = loadMeta();
    var isUser = meta.currentView !== 'char';

    var ov = document.createElement('div');
    ov.className = 'om-overlay ' + (state.darkMode ? 'om-dark' : 'om-light');
    ov.setAttribute('style', 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;z-index:2147483647 !important;');

    ov.innerHTML =
        '<div class="om-box">' +
        '<div class="om-head">' +
        '<div class="om-head-title"><i class="fa-solid fa-shirt"></i>' + SCRIPT_NAME + '</div>' +
        '<div class="om-head-actions">' +
        '<button class="om-icon-btn" id="om-search-toggle" title="搜索"><i class="fa-solid fa-magnifying-glass"></i></button>' +
        '<button class="om-icon-btn" id="om-filter-toggle" title="筛选"><i class="fa-solid fa-filter"></i></button>' +
        '<button class="om-icon-btn" id="om-view-toggle" title="' + (isUser ? '切换到角色衣柜' : '切换到User衣柜') + '"><i class="fa-solid ' + (isUser ? 'fa-user' : 'fa-masks-theater') + '"></i></button>' +
        '<button class="om-icon-btn" id="om-theme-toggle"><i class="fa-solid fa-circle-half-stroke"></i></button>' +
        '<button class="om-icon-btn" id="om-x" title="关闭"><i class="fa-solid fa-xmark"></i></button>' +
        '</div></div>' +
        '<div class="om-search-bar" id="om-search-bar">' +
        '<div class="om-search-wrap"><i class="fa-solid fa-magnifying-glass"></i>' +
        '<input class="om-search-inp" id="om-search-inp" type="text" placeholder="搜索名称或标签…" autocomplete="off" /></div>' +
        '<button class="om-search-clear" id="om-search-clear" title="关闭搜索"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        '<div class="om-filter-bar" id="om-filter-bar">' +
        '<button class="om-filter-chip" id="om-filter-nocat">未分类</button>' +
        '<button class="om-filter-chip" id="om-filter-notag">无标签</button>' +
        '<button class="om-filter-chip" id="om-filter-nodesc">无描述</button>' +
        '</div>' +
        '<div class="om-viewbar" id="om-viewbar"></div>' +
        '<div class="om-catbar-wrap">' +
        '<div class="om-catbar" id="om-catbar"></div>' +
        '<button class="om-acc-toggle" id="om-acc-toggle" title="配饰"><i class="fa-solid fa-chevron-down"></i></button>' +
        '</div>' +
        '<div class="om-acc-catbar" id="om-acc-catbar"></div>' +
        '<div class="om-batch-area" id="om-batch-area"></div>' +
        '<div class="om-grid-area" id="om-grid-area"></div>' +
        '<div class="om-bottombar" id="om-bottombar" style="position:relative;">' +
        '<div class="om-bottom-status" id="om-bottom-status"></div>' +
        '<button class="om-bottom-btn" id="om-batch-toggle" title="多选"><i class="fa-solid fa-list-check"></i></button>' +
        '<button class="om-bottom-btn" id="om-bottom-presets" title="预设"><i class="fa-solid fa-bookmark"></i></button>' +
        '<button class="om-bottom-btn" id="om-bottom-settings" title="设置"><i class="fa-solid fa-sliders"></i></button>' +
        '</div>' +
        '</div>' +
        '<div id="om-popup-slot" style="position:absolute;inset:0;z-index:999;pointer-events:none;"></div>';

    document.body.appendChild(ov);

    // 绑定顶栏
    ov.querySelector('#om-x').addEventListener('click', closePopup);
    ov.querySelector('#om-theme-toggle').addEventListener('click', function () {
        state.darkMode = !state.darkMode;
        var overlay = document.querySelector('.om-overlay');
        if (overlay) {
            overlay.classList.toggle('om-dark', state.darkMode);
            overlay.classList.toggle('om-light', !state.darkMode);
        }
        var btn = ov.querySelector('#om-theme-toggle');
        if (btn) btn.innerHTML = state.darkMode
            ? '<i class="fa-solid fa-circle-half-stroke"></i>'
            : '<i class="fa-regular fa-sun"></i>';
    });
    // 视角切换
    ov.querySelector('#om-view-toggle').addEventListener('click', function () {
        var m = loadMeta();
        m.currentView = m.currentView === 'char' ? 'user' : 'char';
        saveMeta(m);
        charPanelExpanded = false;
        state.curCat = '__all__'; state.catDrillParent = null; state.curSubCat = null;
        clearKitDraft();
        closeDetailPanel();
        var isNowUser = m.currentView !== 'char';
        var vBtn = ov.querySelector('#om-view-toggle');
        if (vBtn) {
            vBtn.innerHTML = '<i class="fa-solid ' + (isNowUser ? 'fa-user' : 'fa-masks-theater') + '"></i>';
            vBtn.title = isNowUser ? '切换到角色衣柜' : '切换到User衣柜';
        }
        renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
    });
    // 搜索
    ov.querySelector('#om-search-toggle').addEventListener('click', function () {
        state.searchOpen = !state.searchOpen;
        var bar = document.getElementById('om-search-bar');
        bar.classList.toggle('open', state.searchOpen);
        if (state.searchOpen) { setTimeout(function () { var i = document.getElementById('om-search-inp'); if (i) i.focus(); }, 50); }
        else { state.searchQuery = ''; renderGrid(); }
    });
    ov.querySelector('#om-search-clear').addEventListener('click', function () {
        state.searchOpen = false;
        state.searchQuery = '';
        var bar = document.getElementById('om-search-bar');
        bar.classList.remove('open');
        renderGrid();
    });
    var sinp = ov.querySelector('#om-search-inp');
    updateSearchPlaceholder();
    sinp.addEventListener('input', function () { state.searchQuery = sinp.value; renderGrid(); });
    sinp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { state.searchOpen = false; state.searchQuery = ''; ov.querySelector('#om-search-bar').classList.remove('open'); renderGrid(); } });
    // 筛选
    ov.querySelector('#om-filter-toggle').addEventListener('click', function () {
        state.filterOpen = !state.filterOpen;
        var fbar = document.getElementById('om-filter-bar');
        updateFilterBarForMode();
        fbar.classList.toggle('open', state.filterOpen);
    });
    function bindFilterChip(id, key) {
        ov.querySelector(id).addEventListener('click', function () {
            if (state.accMode && key === 'filterNoTag') return;
            state[key] = !state[key];
            this.classList.toggle('on', state[key]);
            updateFilterBarForMode();
            renderGrid();
        });
    }
    bindFilterChip('#om-filter-nocat', 'filterNoCat');
    bindFilterChip('#om-filter-notag', 'filterNoTag');
    bindFilterChip('#om-filter-nodesc', 'filterNoDesc');

    // 绑定底栏
    ov.querySelector('#om-bottom-status').addEventListener('click', function () { toggleDetailPanel(); });
    ov.querySelector('#om-batch-toggle').addEventListener('click', function () {
        state.batchMode = !state.batchMode; state.batchSelected = [];
        updateBatchButtonState();
        renderGrid();
    });
    ov.querySelector('#om-bottom-presets').addEventListener('click', function () { fn.openPresetsSheet(); });
    ov.querySelector('#om-bottom-settings').addEventListener('click', function () { fn.openSettingsSheet(); });

    // 配饰栏展开/折叠
    ov.querySelector('#om-acc-toggle').addEventListener('click', function () {
        state.accMode = !state.accMode;
        state.batchMode = false;
        state.batchSelected = [];
        if (state.accMode) ensureKitFocusForAccMode(false);
        else clearKitDraft();
        updateBatchButtonState();
        updateSearchPlaceholder();
        updateFilterBarForMode();
        var btn = ov.querySelector('#om-acc-toggle');
        if (btn) {
            btn.classList.toggle('open', state.accMode);
            btn.innerHTML = state.accMode
                ? '<i class="fa-solid fa-chevron-up"></i>'
                : '<i class="fa-solid fa-chevron-down"></i>';
        }
        renderAccCatbar();
        renderGrid();
        renderBottomStatus();
        if (state.accMode) {
            var groups = buildDetailGroups();
            if (groups.length > 0) openDetailPanel(groups);
        } else {
            closeDetailPanel();
        }
    });

    renderViewbar();
    renderCatbar();
    renderGrid();
    renderBottomStatus();
}

function closePopup() {
    if (gridImageObserver) { gridImageObserver.disconnect(); gridImageObserver = null; }
    clearKitDraft();
    var ov = document.querySelector('.om-overlay'); if (ov) ov.parentNode.removeChild(ov);
}

// ── 视角切换栏渲染 ──────────────────────────────────────────
// 角色管理（添加/重命名/删除/收藏/分组）仍使用 load()/save() 兼容层
// 因为这些操作涉及 charNames ↔ charIndex 双向翻译，兼容层已处理
var charPanelExpanded = false;
var collapsedGroups = {};

function renderViewbar() {
    var vbar = document.getElementById('om-viewbar'); if (!vbar) return;
    var meta = loadMeta();
    var isUser = meta.currentView !== 'char';
    vbar.style.position = 'relative';

    if (isUser) {
        vbar.style.display = 'none';
        return;
    }

    vbar.style.display = '';
    var currentCharName = '';
    if (meta.currentChar) {
        if (meta.currentChar === SHARED_CHAR_KEY) currentCharName = SHARED_CHAR_LABEL;
        else currentCharName = charNameById(meta.currentChar) || '';
    }
    var charLabel = currentCharName || '搜索角色…';

    var html = '<input type="text" class="om-char-input" id="om-char-input" placeholder="' + esc(charLabel) + '" autocomplete="off" />' +
        '<button class="om-char-add-btn" id="om-char-add" title="添加角色">+</button>';

    vbar.innerHTML = html;

    var inp = vbar.querySelector('#om-char-input');
    inp.addEventListener('focus', function () {
        charPanelExpanded = true;
        renderCharDropdown(vbar, load(), '');
    });
    inp.addEventListener('input', function () {
        charPanelExpanded = true;
        renderCharDropdown(vbar, load(), this.value.trim().toLowerCase());
    });
    vbar.querySelector('#om-char-add').addEventListener('click', function () { addCharPrompt(); });
    if (charPanelExpanded) renderCharDropdown(vbar, load(), '');
}

// renderCharDropdown 继续使用 load() 返回的旧格式（d.chars/d.charNames/d.charFavorites/d.charGroups）
// 因为角色管理操作（重命名/删除/分组/收藏）全部通过 save(d) 的兼容层处理 charIndex 翻译
function renderCharDropdown(vbar, d, query) {
    var old = vbar.querySelector('.om-char-dropdown');
    if (old) old.parentNode.removeChild(old);

    var favs = d.charFavorites || [];
    var groups = d.charGroups || {};
    var allNames = d.charNames || [];
    var matchedGroupKeys = {};
    if (query) { for (var gg in groups) { if (gg.toLowerCase().indexOf(query) !== -1) matchedGroupKeys[gg] = true; } }

    function visible(cn) {
        if (!query) return true;
        if (cn.toLowerCase().indexOf(query) !== -1) return true;
        for (var gg2 in matchedGroupKeys) { if ((groups[gg2] || []).indexOf(cn) !== -1) return true; }
        return false;
    }

    var inGroup = {};
    for (var gn in groups) { (groups[gn] || []).forEach(function (n) { inGroup[n] = true; }); }

    function makeRow(cn) {
        if (!visible(cn)) return '';
        var isFav = favs.indexOf(cn) !== -1;
        var isActive = d.currentChar === cn;
        var cd = d.chars && d.chars[cn] ? d.chars[cn] : { outfits: [] };
        var count = (cd.outfits || []).length;
        return '<div class="om-char-row' + (isActive ? ' active' : '') + '" data-cn="' + esc(cn) + '">' +
            '<i class="fa-' + (isFav ? 'solid' : 'regular') + ' fa-star om-char-star' + (isFav ? ' on' : '') + '" data-cn="' + esc(cn) + '"></i>' +
            '<span class="om-char-rname">' + esc(cn) + '</span>' +
            '<span class="om-char-count">' + count + '套</span>' +
            '<div class="om-char-actions">' +
            '<button class="om-char-act om-char-rename" data-cn="' + esc(cn) + '" title="重命名"><i class="fa-solid fa-pen"></i></button>' +
            '<button class="om-char-act om-char-move-group" data-cn="' + esc(cn) + '" title="分组"><i class="fa-solid fa-folder"></i></button>' +
            '<button class="om-char-act om-char-delete" data-cn="' + esc(cn) + '" title="删除" style="color:#e57373"><i class="fa-solid fa-trash"></i></button>' +
            '</div></div>';
    }

    function makeSection(title, iconClass, names, gkey) {
        var visNames = names.filter(visible);
        if (visNames.length === 0) return '';
        var isCollapsed = collapsedGroups[gkey];
        var html = '<div class="om-char-group-hdr" data-gkey="' + esc(gkey) + '">' +
            '<i class="fa-solid fa-chevron-down om-g-arrow' + (isCollapsed ? ' collapsed' : '') + '"></i>' +
            '<i class="' + iconClass + ' om-g-icon"></i> ' + esc(title) +
            ' <span style="opacity:.4">(' + visNames.length + ')</span></div>';
        if (!isCollapsed) { visNames.forEach(function (cn) { html += makeRow(cn); }); }
        return html;
    }

    var listHtml = '';
    // 通用衣柜
    var sharedPartKey = 'char:' + SHARED_CHAR_KEY;
    var sharedCd = d.chars && d.chars[SHARED_CHAR_KEY] ? d.chars[SHARED_CHAR_KEY] : { outfits: [] };
    var sharedCount = (sharedCd.outfits || []).length;
    var sharedActive = d.currentChar === SHARED_CHAR_KEY;
    if (!query || SHARED_CHAR_LABEL.toLowerCase().indexOf(query) !== -1 || '通用'.indexOf(query) !== -1) {
        listHtml += '<div class="om-char-row' + (sharedActive ? ' active' : '') + '" data-cn="' + SHARED_CHAR_KEY + '" style="border-bottom:1px solid rgba(127,127,127,.1)">' +
            '<i class="fa-solid fa-globe om-char-star on" style="cursor:default"></i>' +
            '<span class="om-char-rname">' + SHARED_CHAR_LABEL + '</span>' +
            '<span class="om-char-count">' + sharedCount + '套</span>' +
            '<div class="om-char-actions"></div></div>';
    }
    var favNames = allNames.filter(function (n) { return favs.indexOf(n) !== -1; });
    listHtml += makeSection('收藏', 'fa-solid fa-star', favNames, '__fav__');
    for (var gn2 in groups) {
        var gNames = (groups[gn2] || []).filter(function (n) { return allNames.indexOf(n) !== -1; });
        listHtml += makeSection(gn2, 'fa-solid fa-folder', gNames, 'g_' + gn2);
    }
    var ungrouped = allNames.filter(function (n) { return !inGroup[n] && favs.indexOf(n) === -1; });
    if (ungrouped.length > 0) {
        var ugLabel = (favNames.length > 0 || Object.keys(groups).length > 0) ? '未分组' : '全部角色';
        listHtml += makeSection(ugLabel, 'fa-regular fa-folder-open', ungrouped, '__ungrouped__');
    }
    if (allNames.length === 0) listHtml = '<div class="om-char-empty">还没有角色，点 + 添加</div>';

    var dropdown = document.createElement('div');
    dropdown.className = 'om-char-dropdown';
    dropdown.innerHTML = listHtml;
    vbar.appendChild(dropdown);

    // 分组折叠
    dropdown.querySelectorAll('.om-char-group-hdr').forEach(function (hdr) {
        hdr.addEventListener('click', function () {
            collapsedGroups[hdr.dataset.gkey] = !collapsedGroups[hdr.dataset.gkey];
            renderCharDropdown(vbar, load(), query);
        });
    });
    // 选中角色
    dropdown.querySelectorAll('.om-char-row').forEach(function (row) {
        row.addEventListener('click', function (e) {
            if (e.target.closest('.om-char-star') || e.target.closest('.om-char-actions')) return;
            var dd = load(); dd.currentChar = row.dataset.cn; save(dd);
            charPanelExpanded = false;
            state.curCat = '__all__'; state.catDrillParent = null; state.curSubCat = null;
            renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
        });
    });
    // 收藏
    dropdown.querySelectorAll('.om-char-star').forEach(function (star) {
        star.addEventListener('click', function (e) {
            e.stopPropagation();
            var dd = load(); if (!dd.charFavorites) dd.charFavorites = [];
            var cn = star.dataset.cn; var idx = dd.charFavorites.indexOf(cn);
            if (idx !== -1) dd.charFavorites.splice(idx, 1); else dd.charFavorites.push(cn);
            save(dd); renderCharDropdown(vbar, load(), query);
        });
    });
    // 重命名
    dropdown.querySelectorAll('.om-char-rename').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation(); var cn = btn.dataset.cn;
            var nw = prompt('重命名角色「' + cn + '」：', cn);
            if (!nw || !nw.trim() || nw.trim() === cn) return; nw = nw.trim();
            var dd = load();
            if (dd.charNames.indexOf(nw) !== -1) { toast('角色「' + nw + '」已存在', true); return; }
            var idx = dd.charNames.indexOf(cn); if (idx !== -1) dd.charNames[idx] = nw;
            if (dd.chars && dd.chars[cn]) { dd.chars[nw] = dd.chars[cn]; delete dd.chars[cn]; }
            if (dd.charFavorites) { var fi = dd.charFavorites.indexOf(cn); if (fi !== -1) dd.charFavorites[fi] = nw; }
            if (dd.charGroups) { for (var g in dd.charGroups) { var gi = dd.charGroups[g].indexOf(cn); if (gi !== -1) dd.charGroups[g][gi] = nw; } }
            if (dd.currentChar === cn) dd.currentChar = nw;
            save(dd); renderViewbar(); renderCatbar(); renderGrid(); toast('已重命名为「' + nw + '」');
        });
    });
    // 分组移动
    dropdown.querySelectorAll('.om-char-move-group').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation(); var cn = btn.dataset.cn; var dd = load();
            if (!dd.charGroups) dd.charGroups = {};
            var gNamesList = Object.keys(dd.charGroups);
            if (gNamesList.length === 0) {
                var gname = prompt('还没有分组，输入新分组名称：');
                if (!gname || !gname.trim()) return;
                dd.charGroups[gname.trim()] = [cn]; save(dd); renderCharDropdown(vbar, load(), query);
                toast('已创建分组并移入'); return;
            }
            var currentGroup = '';
            for (var g in dd.charGroups) { if ((dd.charGroups[g] || []).indexOf(cn) !== -1) { currentGroup = g; break; } }
            var msg = '将「' + cn + '」移到：\n0. 不分组' + (currentGroup ? '（当前：' + currentGroup + '）' : '') + '\n';
            gNamesList.forEach(function (g, i) { msg += (i + 1) + '. ' + g + '\n'; });
            msg += (gNamesList.length + 1) + '. 新建分组';
            var choice = prompt(msg); if (choice === null) return;
            var ci = parseInt(choice);
            for (var g2 in dd.charGroups) { var ri = dd.charGroups[g2].indexOf(cn); if (ri !== -1) dd.charGroups[g2].splice(ri, 1); }
            if (ci > 0 && ci <= gNamesList.length) { dd.charGroups[gNamesList[ci - 1]].push(cn); toast('已移入「' + gNamesList[ci - 1] + '」'); }
            else if (ci === gNamesList.length + 1) { var ng = prompt('新分组名称：'); if (ng && ng.trim()) { dd.charGroups[ng.trim()] = [cn]; toast('已创建分组并移入'); } }
            else { toast('已移出分组'); }
            save(dd); renderCharDropdown(vbar, load(), query);
        });
    });
    // 删除
    dropdown.querySelectorAll('.om-char-delete').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation(); var cn = btn.dataset.cn;
            if (!confirm('删除角色「' + cn + '」及其所有穿搭？')) return;
            var dd = load();
            if (dd.chars) delete dd.chars[cn];
            var idx = dd.charNames.indexOf(cn); if (idx !== -1) dd.charNames.splice(idx, 1);
            if (dd.charFavorites) { var fi = dd.charFavorites.indexOf(cn); if (fi !== -1) dd.charFavorites.splice(fi, 1); }
            if (dd.charGroups) { for (var g in dd.charGroups) { var gi = dd.charGroups[g].indexOf(cn); if (gi !== -1) dd.charGroups[g].splice(gi, 1); } }
            if (dd.currentChar === cn) dd.currentChar = '';
            save(dd); renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus(); toast('已删除角色「' + cn + '」');
        });
    });
    // 点击外部关闭
    function closeOnOutside(e) {
        if (!vbar.contains(e.target)) {
            charPanelExpanded = false;
            var dd2 = vbar.querySelector('.om-char-dropdown');
            if (dd2) dd2.parentNode.removeChild(dd2);
            document.removeEventListener('click', closeOnOutside, true);
        }
    }
    setTimeout(function () { document.addEventListener('click', closeOnOutside, true); }, 50);
}

function addCharPrompt() {
    var name = prompt('输入角色名：');
    if (!name || !name.trim()) return; name = name.trim();
    if (name === SHARED_CHAR_KEY) { toast('此名称为系统保留，请换一个', true); return; }
    var dd = load();
    if (!dd.charNames) dd.charNames = [];
    if (dd.charNames.indexOf(name) !== -1) { toast('角色「' + name + '」已存在', true); return; }
    dd.charNames.push(name); dd.currentChar = name; save(dd);
    charPanelExpanded = false;
    renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
    toast('✅ 已添加角色「' + name + '」');
}

function renderCharPanel() { /* 兼容 */ }

// ── 分类栏渲染（使用新 API）────────────────────────────────
function renderCatbar() {
    var catbar = document.getElementById('om-catbar'); if (!catbar) return;
    // Guard: 角色视角未选角色时不显示分类栏
    var meta = loadMeta();
    if (meta.currentView === 'char' && !meta.currentChar) {
        catbar.style.display = 'none';
        state.catDrillParent = null; state.curSubCat = null; state.curCat = '__all__';
        return;
    }
    var part = loadCurrent();
    var cats = part.categories || [];
    var catNames = getCatNames(cats);
    if (catNames.length === 0) { catbar.style.display = 'none'; state.catDrillParent = null; state.curSubCat = null; state.curCat = '__all__'; return; }
    catbar.style.display = '';

    var html = '';

    if (state.catDrillParent) {
        var subCats = getSubCats(cats, state.catDrillParent);
        html += '<button class="om-catbtn om-catbtn-back" id="om-cat-back" title="返回上级"><i class="fa-solid fa-chevron-left"></i></button>';
        html += '<button class="om-catbtn' + (state.curSubCat === null ? ' on' : '') + '" data-sub="__all__">' + esc(state.catDrillParent) + '</button>';
        subCats.forEach(function (sc) {
            html += '<button class="om-catbtn' + (state.curSubCat === sc ? ' on' : '') + '" data-sub="' + esc(sc) + '">' + esc(sc) + '</button>';
        });
    } else {
        html += '<button class="om-catbtn' + (state.curCat === '__all__' ? ' on' : '') + '" data-c="__all__">全部</button>';
        catNames.forEach(function (c) {
            html += '<button class="om-catbtn' + (state.curCat === c ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</button>';
        });
    }

    catbar.innerHTML = html;

    if (state.catDrillParent) {
        catbar.querySelector('#om-cat-back').addEventListener('click', function () {
            state.catDrillParent = null; state.curSubCat = null; state.curCat = '__all__';
            renderCatbar(); renderGrid();
        });
        catbar.querySelectorAll('.om-catbtn[data-sub]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var sub = btn.dataset.sub;
                if (sub === '__all__') state.curSubCat = null;
                else state.curSubCat = sub;
                renderCatbar(); renderGrid();
            });
        });
    } else {
        catbar.querySelectorAll('.om-catbtn[data-c]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var c = btn.dataset.c;
                if (c === '__all__') {
                    state.curCat = '__all__'; state.catDrillParent = null; state.curSubCat = null;
                    renderCatbar(); renderGrid();
                } else {
                    if (hasSubCats(cats, c)) {
                        state.catDrillParent = c; state.curCat = c; state.curSubCat = null;
                        renderCatbar(); renderGrid();
                    } else {
                        state.curCat = c; state.catDrillParent = null; state.curSubCat = null;
                        renderCatbar(); renderGrid();
                    }
                }
            });
        });
    }

    // 电脑端：鼠标滚轮横向滚动 + 拖拽
    if (!catbar._wheelBound) {
        catbar.addEventListener('wheel', function (e) {
            if (Math.abs(e.deltaY) > 0) {
                e.preventDefault();
                catbar.scrollLeft += e.deltaY;
            }
        }, { passive: false });
        var _drag = { down: false, startX: 0, scrollL: 0 };
        catbar.addEventListener('mousedown', function (e) {
            _drag.down = true; _drag.startX = e.pageX; _drag.scrollL = catbar.scrollLeft;
            catbar.style.cursor = 'grabbing'; catbar.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', function (e) {
            if (!_drag.down) return;
            catbar.scrollLeft = _drag.scrollL - (e.pageX - _drag.startX);
        });
        document.addEventListener('mouseup', function () {
            if (_drag.down) { _drag.down = false; catbar.style.cursor = ''; catbar.style.userSelect = ''; }
        });
        catbar._wheelBound = true;
    }
}

// ── 配饰分类栏渲染 ─────────────────────────────────────────
function renderAccCatbar() {
    var accbar = document.getElementById('om-acc-catbar'); if (!accbar) return;

    if (!state.accMode) {
        accbar.style.display = 'none';
        return;
    }

    var meta = loadMeta();
    if (meta.currentView === 'char' && !meta.currentChar) {
        accbar.style.display = 'none';
        return;
    }

    var part = loadCurrent();
    var cats = part.accCategories || [];
    var catNames = getCatNames(cats);

    accbar.style.display = 'flex';
    var html = '<span class="om-acc-catbar-label"><i class="fa-solid fa-gem"></i></span>';

    if (state.accDrillParent) {
        var subCats = getSubCats(cats, state.accDrillParent);
        html += '<button class="om-catbtn om-catbtn-back" id="om-acc-cat-back"><i class="fa-solid fa-chevron-left"></i></button>';
        html += '<button class="om-catbtn' + (state.accSubCat === null ? ' on' : '') + '" data-asub="__all__">' + esc(state.accDrillParent) + '</button>';
        subCats.forEach(function (sc) {
            html += '<button class="om-catbtn' + (state.accSubCat === sc ? ' on' : '') + '" data-asub="' + esc(sc) + '">' + esc(sc) + '</button>';
        });
    } else {
        html += '<button class="om-catbtn' + (state.accCat === '__all__' ? ' on' : '') + '" data-ac="__all__">全部</button>';
        catNames.forEach(function (c) {
            html += '<button class="om-catbtn' + (state.accCat === c ? ' on' : '') + '" data-ac="' + esc(c) + '">' + esc(c) + '</button>';
        });
    }
    html += '<button class="om-catbtn om-acc-manage-btn" id="om-acc-cats-manage" title="管理配饰分类"><i class="fa-solid fa-tags"></i></button>';

    accbar.innerHTML = html;
    var manageBtn = accbar.querySelector('#om-acc-cats-manage');
    if (manageBtn) manageBtn.addEventListener('click', function () {
        fn.openCatsSheet(true);
    });

    // 事件绑定
    if (state.accDrillParent) {
        accbar.querySelector('#om-acc-cat-back').addEventListener('click', function () {
            state.accDrillParent = null; state.accSubCat = null; state.accCat = '__all__';
            renderAccCatbar(); renderGrid();
        });
        accbar.querySelectorAll('.om-catbtn[data-asub]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var sub = btn.dataset.asub;
                state.accSubCat = (sub === '__all__') ? null : sub;
                renderAccCatbar(); renderGrid();
            });
        });
    } else {
        accbar.querySelectorAll('.om-catbtn[data-ac]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var c = btn.dataset.ac;
                if (c === '__all__') {
                    state.accCat = '__all__'; state.accDrillParent = null; state.accSubCat = null;
                } else if (hasSubCats(cats, c)) {
                    state.accDrillParent = c; state.accCat = c; state.accSubCat = null;
                } else {
                    state.accCat = c; state.accDrillParent = null; state.accSubCat = null;
                }
                renderAccCatbar(); renderGrid();
            });
        });
    }

    // 滚轮横向滚动
    if (!accbar._wheelBound) {
        accbar.addEventListener('wheel', function (e) {
            if (Math.abs(e.deltaY) > 0) { e.preventDefault(); accbar.scrollLeft += e.deltaY; }
        }, { passive: false });
        accbar._wheelBound = true;
    }
}

// ── 网格区渲染（使用新 API）────────────────────────────────
function renderGrid() {
    var area = document.getElementById('om-grid-area'); if (!area) return;
    var meta = loadMeta();

    // 角色视角但没选角色
    if (meta.currentView === 'char' && !meta.currentChar) {
        area.innerHTML = '<div class="om-empty"><i class="fa-solid fa-masks-theater"></i><span>请先选择或添加一个角色</span></div>';
        return;
    }

    var part = loadCurrent();

    // ── 配饰模式：显示配饰卡片 ──
    if (state.accMode) {
        renderAccGrid(area, part);
        return;
    }

    var allOutfits = part.outfits || [];

    // 按分类过滤
    var list;
    if (state.catDrillParent) {
        var parentCat = state.catDrillParent;
        var inParent = allOutfits.filter(function (o) { return o.category === parentCat; });
        if (state.curSubCat === null) list = inParent;
        else list = inParent.filter(function (o) { return o.subCategory === state.curSubCat; });
    } else if (state.curCat === '__all__') {
        list = allOutfits;
    } else {
        list = allOutfits.filter(function (o) { return o.category === state.curCat; });
    }
    if (state.searchQuery) {
        var q = state.searchQuery.toLowerCase();
        list = list.filter(function (o) {
            return (o.name && o.name.toLowerCase().indexOf(q) !== -1) ||
                (o.category && o.category.toLowerCase().indexOf(q) !== -1) ||
                (o.sceneTag && o.sceneTag.toLowerCase().indexOf(q) !== -1) ||
                (o.description && o.description.toLowerCase().indexOf(q) !== -1);
        });
    }
    // 筛选过滤
    if (state.filterNoCat) {
        if (state.curCat === '__all__' && !state.catDrillParent) {
            list = list.filter(function (o) { return !o.category || !o.category.trim(); });
        } else {
            var curCatKey = state.catDrillParent || state.curCat;
            var cats = part.categories || [];
            if (hasSubCats(cats, curCatKey)) {
                list = list.filter(function (o) { return !o.subCategory || !o.subCategory.trim(); });
            }
        }
    }
    if (state.filterNoTag) { list = list.filter(function (o) { return !o.sceneTag || !o.sceneTag.trim(); }); }
    if (state.filterNoDesc) { list = list.filter(function (o) { return !o.description || !o.description.trim(); }); }
    var imgOutfits = list.filter(function (o) { return !!o.imageData; });

    // 批量操作栏
    var batchArea = document.getElementById('om-batch-area');
    if (batchArea) {
        if (state.batchMode) {
            batchArea.style.display = '';
            batchArea.innerHTML = '<div class="om-batch-bar">' +
                '<span class="om-batch-info">已选&nbsp;<b id="om-batch-count">' + state.batchSelected.length + '</b>&nbsp;套</span>' +
                '<div class="om-batch-divider" style="width:1px;height:16px;background:rgba(127,127,127,.25);flex-shrink:0;margin:0 2px;"></div>' +
                '<div class="om-batch-acts">' +
                '<button class="om-batch-btn" id="om-batch-selall">全选</button>' +
                '<button class="om-batch-btn" id="om-batch-none">取消</button>' +
                '<button class="om-batch-btn" id="om-batch-cat"><i class="fa-solid fa-folder"></i> 分类</button>' +
                '<button class="om-batch-btn" id="om-batch-move"><i class="fa-solid fa-arrow-right-arrow-left"></i> 移动</button>' +
                '<button class="om-batch-btn" id="om-batch-tag"><i class="fa-solid fa-tag"></i> 标签</button>' +
                '<button class="om-batch-btn" id="om-batch-aidesc"><i class="fa-solid fa-wand-magic-sparkles"></i> AI描述</button>' +
                '<button class="om-batch-btn danger" id="om-batch-del"><i class="fa-solid fa-trash"></i> 删除</button>' +
                '</div></div>';
        } else {
            batchArea.style.display = 'none';
            batchArea.innerHTML = '';
        }
    }

    var html = '';
    html += '<div class="om-grid">';

    if (!state.batchMode) {
        html += '<div class="om-add-card" id="om-addcard"><i class="fa-solid fa-plus"></i><span>添加穿搭</span></div>';
    }

    if (list.length === 0) {
        var hasFilter = state.filterNoCat || state.filterNoTag || state.filterNoDesc;
        var emptyMsg = state.searchQuery ? '没有匹配「' + esc(state.searchQuery) + '」的穿搭'
            : hasFilter ? '没有符合筛选条件的穿搭'
            : (state.curCat !== '__all__' ? '该分类暂无穿搭' : '还没有穿搭，点击左上角添加');
        html += '</div><div class="om-empty"><i class="fa-solid fa-shirt"></i><span>' + emptyMsg + '</span></div>';
    } else {
        list.forEach(function (o) {
            var on = partIsActive(part, o.id);
            var bsel = state.batchSelected.indexOf(o.id) !== -1;
            var checkBox = state.batchMode ? '<div class="om-card-check' + (bsel ? ' checked' : '') + '" data-id="' + o.id + '"><i class="fa-solid fa-check"></i></div>' : '';
            var badge = (on && !state.batchMode) ? '<div class="om-badge-on"><i class="fa-solid fa-check"></i></div>' : '';

            var imgContent = '';
            if (o.imageData) {
                imgContent = '<img class="om-lazy-img" src="' + OM_TRANSPARENT_PIXEL + '" data-outfit-id="' + esc(o.id) + '" alt="' + esc(o.name) + '" loading="lazy" decoding="async" />';
            } else {
                var descPreview = (o.description && o.description.trim()) ? o.description.trim() : '';
                imgContent = '<div class="om-card-noimg">' +
                    '<div class="om-noimg-name">' + esc(o.name) + '</div>' +
                    (descPreview ? '<div class="om-noimg-desc">' + esc(descPreview) + '</div>' : '') +
                    '<i class="fa-regular fa-file-lines om-noimg-icon"></i>' +
                    '</div>';
            }

            var menuBtn = state.batchMode ? '' : '<button class="om-card-menu" data-id="' + o.id + '" title="操作"><i class="fa-solid fa-ellipsis-vertical"></i></button>';
            var tagText = (o.sceneTag && o.sceneTag.trim()) ? o.sceneTag.trim() : '';
            html += '<div class="om-card' + (on ? ' on' : '') + (bsel ? ' batch-sel' : '') + (o.imageData ? '' : ' no-img') + '" data-id="' + o.id + '">' +
                '<div class="om-card-img">' +
                checkBox + imgContent + badge + menuBtn +
                '</div>' +
                '<div class="om-card-info">' +
                '<div class="om-card-name">' + esc(o.name) + '</div>' +
                (tagText ? '<div class="om-card-tag">' + esc(tagText) + '</div>' : '') +
                '</div>' +
                '</div>';
        });
        html += '</div>';
    }

    area.innerHTML = html;
    setupGridLazyImages(area);

    // 添加卡点击
    var ac = area.querySelector('#om-addcard');
    if (ac) ac.addEventListener('click', function () {
        var defCat = state.catDrillParent || (state.curCat !== '__all__' ? state.curCat : '');
        var defSub = state.catDrillParent && state.curSubCat ? state.curSubCat : '';
        fn.openEditSheet(null, defCat, defSub);
    });

    // 批量操作
    if (state.batchMode) {
        var selall = batchArea.querySelector('#om-batch-selall');
        var selnone = batchArea.querySelector('#om-batch-none');
        var btagBtn = batchArea.querySelector('#om-batch-tag');
        var bdelBtn = batchArea.querySelector('#om-batch-del');

        if (selall) selall.addEventListener('click', function () { state.batchSelected = list.map(function (o) { return o.id; }); renderGrid(); });
        if (selnone) selnone.addEventListener('click', function () { state.batchSelected = []; renderGrid(); });
        var bcatBtn = batchArea.querySelector('#om-batch-cat');
        if (bcatBtn) bcatBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            var curPart = loadCurrent();
            var cats = curPart.categories || [];
            var catNames = getCatNames(cats);
            if (catNames.length === 0) { toast('还没有分类，请先在设置中添加', true); return; }
            var itemsHtml = '';
            cats.forEach(function (catObj) {
                var catName = typeof catObj === 'object' ? catObj.name : catObj;
                var children = typeof catObj === 'object' ? (catObj.children || []) : [];
                var n = curPart.outfits.filter(function (o) { return o.category === catName; }).length;
                itemsHtml += '<div class="om-cat-item om-bcat-pick" data-cat="' + esc(catName) + '" data-sub="" style="cursor:pointer;font-weight:600"><span class="om-cat-name">' + esc(catName) + '</span><span class="om-cat-count">' + n + '套</span></div>';
                children.forEach(function (sc) {
                    var sn = curPart.outfits.filter(function (o) { return o.category === catName && o.subCategory === sc; }).length;
                    itemsHtml += '<div class="om-cat-item om-bcat-pick" data-cat="' + esc(catName) + '" data-sub="' + esc(sc) + '" style="cursor:pointer;padding-left:28px;opacity:.85"><span class="om-cat-name"><i class="fa-solid fa-turn-up fa-rotate-90" style="font-size:.6em;opacity:.3;margin-right:6px"></i>' + esc(sc) + '</span><span class="om-cat-count">' + sn + '套</span></div>';
                });
            });
            var catSheet = fn.createSheet([
                '<div class="om-sheet-title"><i class="fa-solid fa-folder"></i>选择分类</div>',
                '<div class="om-hint" style="margin-bottom:10px">为已选 ' + state.batchSelected.length + ' 套穿搭设置分类</div>',
                itemsHtml,
                '<div class="om-divider"></div>',
                '<div class="om-cat-item om-bcat-pick" data-cat="" data-sub="" style="cursor:pointer;opacity:.6"><span class="om-cat-name">清除分类</span></div>',
            ].join(''));
            catSheet.querySelectorAll('.om-bcat-pick').forEach(function (item) {
                item.addEventListener('click', function () {
                    var targetCat = item.dataset.cat;
                    var targetSub = item.dataset.sub;
                    var p2 = loadCurrent();
                    p2.outfits.forEach(function (o) {
                        if (state.batchSelected.indexOf(o.id) !== -1) {
                            o.category = targetCat;
                            o.subCategory = targetSub || '';
                        }
                    });
                    saveCurrent(p2); fn.closeSheet(catSheet);
                    var label = targetCat ? (targetSub ? '「' + targetCat + ' > ' + targetSub + '」' : '「' + targetCat + '」') : '清除分类';
                    toast('✅ 已将 ' + state.batchSelected.length + ' 套' + (targetCat ? '移到' + label : label));
                    state.batchSelected = []; renderGrid();
                });
            });
        });
        if (btagBtn) btagBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            fn.openBatchTagPanel(state.batchSelected.slice(), function () {
                state.batchSelected = []; renderGrid();
            });
        });
        var bmoveBtn = batchArea.querySelector('#om-batch-move');
        if (bmoveBtn) bmoveBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            fn.openMoveToPanel(state.batchSelected.slice(), function () {
                state.batchSelected = []; state.batchMode = false;
                fn.renderViewbar(); fn.renderCatbar(); renderGrid(); fn.renderBottomStatus(); fn.updateBtn();
            });
        });
        if (bdelBtn) bdelBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            if (!confirm('确定删除已选 ' + state.batchSelected.length + ' 套穿搭？')) return;
            if (state.kitFocusPartKey === currentPartKey() && state.batchSelected.indexOf(state.kitFocusOutfitId) !== -1) clearKitDraft();
            var curP = loadCurrent();
            curP.outfits = curP.outfits.filter(function (o) { return state.batchSelected.indexOf(o.id) === -1; });
            curP.activeIds = (curP.activeIds || []).filter(function (id) { return state.batchSelected.indexOf(id) === -1; });
            saveCurrent(curP);
            syncActivePartitions(currentPartKey(), curP.activeIds);
            fn.updateBtn(); renderBottomStatus(); toast('已删除 ' + state.batchSelected.length + ' 套穿搭'); state.batchSelected = []; renderGrid();
        });

        var baidescBtn = batchArea.querySelector('#om-batch-aidesc');
        if (baidescBtn) baidescBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            var m = loadMeta();
            if (!m.apiVision.endpoint || !m.apiVision.key || !m.apiVision.model) {
                toast('请先在设置中配置"描述生成 API"', true); return;
            }
            var curP = loadCurrent();
            var hasImg = state.batchSelected.some(function (id) { var o = partGetById(curP, id); return o && o.imageData; });
            if (!hasImg) { toast('所选穿搭中没有带图片的', true); return; }
            fn.openBatchDescModal(state.batchSelected.slice());
        });

        area.querySelectorAll('.om-card').forEach(function (card) {
            card.addEventListener('click', function (e) {
                if (e.target.closest('.om-card-check')) return;
                var id = card.dataset.id;
                var chk = card.querySelector('.om-card-check');
                var idx = state.batchSelected.indexOf(id);
                if (idx !== -1) state.batchSelected.splice(idx, 1); else state.batchSelected.push(id);
                if (chk) chk.classList.toggle('checked', state.batchSelected.indexOf(id) !== -1);
                card.classList.toggle('batch-sel', state.batchSelected.indexOf(id) !== -1);
                var cnt = document.getElementById('om-batch-count');
                if (cnt) cnt.textContent = state.batchSelected.length;
            });
        });
        area.querySelectorAll('.om-card-check').forEach(function (chk) {
            chk.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = chk.dataset.id;
                var idx = state.batchSelected.indexOf(id);
                if (idx !== -1) state.batchSelected.splice(idx, 1); else state.batchSelected.push(id);
                chk.classList.toggle('checked', state.batchSelected.indexOf(id) !== -1);
                var card = chk.closest('.om-card');
                if (card) card.classList.toggle('batch-sel', state.batchSelected.indexOf(id) !== -1);
                var cnt = document.getElementById('om-batch-count');
                if (cnt) cnt.textContent = state.batchSelected.length;
            });
        });
    } else {
        // 非批量：单击 = 选择/取消
        area.querySelectorAll('.om-card').forEach(function (card) {
            var id = card.dataset.id;

            card.addEventListener('click', function (e) {
                if (e.target.closest('.om-card-menu') || e.target.closest('.om-badge-on')) return;
                var curP = loadCurrent();
                var aids = curP.activeIds || [];
                var idx = aids.indexOf(id);
                if (idx !== -1) aids.splice(idx, 1); else aids.push(id);
                curP.activeIds = aids;
                if (idx !== -1 && isCurrentKitFocus(currentPartKey(), id)) clearKitDraft();

                // 通用衣柜 ↔ 单人衣柜互斥
                var m = loadMeta();
                if (m.currentView === 'char' && idx === -1) {
                    if (m.currentChar === SHARED_CHAR_KEY) {
                        // 在通用衣柜激活 → 清空所有单人衣柜
                        (m.charIndex || []).forEach(function (ci) {
                            if (ci.id !== SHARED_CHAR_KEY) {
                                var cp = loadPartition(ci.partKey);
                                if (cp.activeIds && cp.activeIds.length > 0) {
                                    cp.activeIds = [];
                                    savePartition(ci.partKey, cp);
                                    syncActivePartitions(ci.partKey, []);
                                }
                            }
                        });
                    } else {
                        // 在单人衣柜激活 → 清空通用衣柜
                        var sharedPK = 'char:' + SHARED_CHAR_KEY;
                        var sp = loadPartition(sharedPK);
                        if (sp.activeIds && sp.activeIds.length > 0) {
                            sp.activeIds = [];
                            savePartition(sharedPK, sp);
                            syncActivePartitions(sharedPK, []);
                        }
                    }
                }

                saveCurrent(curP);
                syncActivePartitions(currentPartKey(), aids);
                if (idx === -1 && state.accMode) ensureKitFocusForAccMode(false);
                fn.updateBtn(); renderBottomStatus();
                preResolveActiveImages();

                // 更新卡片样式
                var nowActive = partIsActive(curP, id);
                card.classList.toggle('on', nowActive);
                var badge = card.querySelector('.om-badge-on');
                if (nowActive) {
                    if (!badge) { var b = document.createElement('div'); b.className = 'om-badge-on'; b.innerHTML = '<i class="fa-solid fa-check"></i>'; card.querySelector('.om-card-img').appendChild(b); }
                } else {
                    if (badge) badge.parentNode.removeChild(badge);
                }
                closeDetailPanel();
                var n = aids.length;
                var o = partGetById(curP, id);
                if (idx !== -1) toast('已取消：' + (o ? o.name : ''));
                else if (n === 1) toast('✅ 已选：' + (o ? o.name : ''));
                else toast('✅ 衣柜模式，共' + n + '套');
            });
        });

        // 菜单按钮
        area.querySelectorAll('.om-card-menu').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = btn.dataset.id;
                var o = partGetById(loadCurrent(), id);
                fn.openContextMenu(o, imgOutfits);
            });
        });
    }
}

// ── 配饰网格渲染 ────────────────────────────────────────
function renderAccGrid(area, part) {
    ensureKitFocusForAccMode(false);
    var allAcc = part.accessories || [];

    // 按配饰分类过滤
    var list;
    if (state.accDrillParent) {
        var parentCat = state.accDrillParent;
        var inParent = allAcc.filter(function (a) { return a.category === parentCat; });
        list = (state.accSubCat === null) ? inParent : inParent.filter(function (a) { return a.subCategory === state.accSubCat; });
    } else if (state.accCat === '__all__') {
        list = allAcc;
    } else {
        list = allAcc.filter(function (a) { return a.category === state.accCat; });
    }

    // 搜索过滤
    if (state.searchQuery) {
        var q = state.searchQuery.toLowerCase();
        list = list.filter(function (a) {
            return (a.name && a.name.toLowerCase().indexOf(q) !== -1) ||
                (a.category && a.category.toLowerCase().indexOf(q) !== -1) ||
                (a.description && a.description.toLowerCase().indexOf(q) !== -1);
        });
    }
    if (state.filterNoCat) {
        list = list.filter(function (a) { return !a.category || !a.category.trim(); });
    }
    if (state.filterNoDesc) {
        list = list.filter(function (a) { return !a.description || !a.description.trim(); });
    }

    var batchArea = document.getElementById('om-batch-area');
    if (batchArea) {
        if (state.batchMode) {
            batchArea.style.display = '';
            batchArea.innerHTML = '<div class="om-batch-bar">' +
                '<span class="om-batch-info">已选&nbsp;<b id="om-batch-count">' + state.batchSelected.length + '</b>&nbsp;个</span>' +
                '<div class="om-batch-divider" style="width:1px;height:16px;background:rgba(127,127,127,.25);flex-shrink:0;margin:0 2px;"></div>' +
                '<div class="om-batch-acts">' +
                '<button class="om-batch-btn" id="om-acc-batch-selall">全选</button>' +
                '<button class="om-batch-btn" id="om-acc-batch-invert">反选</button>' +
                '<button class="om-batch-btn" id="om-acc-batch-desc"><i class="fa-solid fa-wand-magic-sparkles"></i> AI描述</button>' +
                '<button class="om-batch-btn danger" id="om-acc-batch-del"><i class="fa-solid fa-trash"></i> 删除</button>' +
                '</div></div>';
        } else {
            batchArea.style.display = 'none';
            batchArea.innerHTML = '';
        }
    }

    var html = '<div class="om-grid">';
    if (!state.batchMode) {
        html += '<div class="om-add-card" id="om-acc-addcard"><i class="fa-solid fa-plus"></i><span>添加配饰</span></div>';
    }

    if (list.length === 0) {
        var hasFilter = state.filterNoCat || state.filterNoDesc;
        var emptyMsg = state.searchQuery ? '没有匹配的配饰'
            : hasFilter ? '没有符合筛选条件的配饰'
            : (state.accCat !== '__all__' ? '该分类暂无配饰' : '还没有配饰，点击添加');
        html += '</div><div class="om-empty"><i class="fa-solid fa-gem"></i><span>' + emptyMsg + '</span></div>';
    } else {
        list.forEach(function (a) {
            var imgContent = '';
            var selected = !state.batchMode && draftHasAcc(a.id);
            var bsel = state.batchSelected.indexOf(a.id) !== -1;
            var checkBox = state.batchMode ? '<div class="om-card-check' + (bsel ? ' checked' : '') + '" data-acc-id="' + esc(a.id) + '"><i class="fa-solid fa-check"></i></div>' : '';
            if (a.imageData) {
                imgContent = '<img class="om-lazy-img" src="' + OM_TRANSPARENT_PIXEL + '" data-acc-id="' + esc(a.id) + '" alt="' + esc(a.name) + '" loading="lazy" decoding="async" />';
            } else {
                var descPreview = (a.description && a.description.trim()) ? a.description.trim() : '';
                imgContent = '<div class="om-card-noimg">' +
                    '<div class="om-noimg-name">' + esc(a.name) + '</div>' +
                    (descPreview ? '<div class="om-noimg-desc">' + esc(descPreview) + '</div>' : '') +
                    '<i class="fa-solid fa-gem om-noimg-icon"></i>' +
                    '</div>';
            }
            var menuBtn = state.batchMode ? '' : '<button class="om-card-menu" data-acc-id="' + esc(a.id) + '" title="操作"><i class="fa-solid fa-ellipsis-vertical"></i></button>';
            html += '<div class="om-card' + (a.imageData ? '' : ' no-img') + (selected ? ' kit-selected' : '') + (bsel ? ' batch-sel' : '') + ' om-acc-card" data-acc-id="' + esc(a.id) + '">' +
                '<div class="om-card-img">' +
                checkBox + imgContent +
                (selected ? '<div class="om-badge-on om-kit-badge"><i class="fa-solid fa-check"></i></div>' : '') +
                menuBtn +
                '</div>' +
                '<div class="om-card-info">' +
                '<div class="om-card-name">' + esc(a.name) + '</div>' +
                '</div>' +
                '</div>';
        });
        html += '</div>';
    }

    area.innerHTML = html;

    // 配饰懒加载
    setupAccLazyImages(area);

    if (state.batchMode && batchArea) {
        var selall = batchArea.querySelector('#om-acc-batch-selall');
        var invert = batchArea.querySelector('#om-acc-batch-invert');
        var delBtn = batchArea.querySelector('#om-acc-batch-del');
        var descBtn = batchArea.querySelector('#om-acc-batch-desc');
        if (selall) selall.addEventListener('click', function () {
            state.batchSelected = list.map(function (a) { return a.id; });
            renderGrid();
        });
        if (invert) invert.addEventListener('click', function () {
            var visibleIds = list.map(function (a) { return a.id; });
            state.batchSelected = visibleIds.filter(function (id) { return state.batchSelected.indexOf(id) === -1; });
            renderGrid();
        });
        if (delBtn) delBtn.addEventListener('click', function () {
            batchDeleteAccessories(state.batchSelected.slice());
        });
        if (descBtn) descBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择配饰', true); return; }
            var m = loadMeta();
            if (!m.apiVision.endpoint || !m.apiVision.key || !m.apiVision.model) {
                toast('请先在设置中配置"描述生成 API"', true); return;
            }
            var curP = loadCurrent();
            var hasImg = state.batchSelected.some(function (id) { var acc = partGetAccById(curP, id); return acc && acc.imageData; });
            if (!hasImg) { toast('所选配饰中没有带图片的', true); return; }
            if (fn.openAccBatchDescModal) fn.openAccBatchDescModal(state.batchSelected.slice());
        });
    }

    // 添加配饰
    var ac = area.querySelector('#om-acc-addcard');
    if (ac) ac.addEventListener('click', function () {
        var defCat = state.accDrillParent || (state.accCat !== '__all__' ? state.accCat : '');
        fn.openAccEditSheet(null, defCat);
    });

    // 配饰卡片点击 → 临时选择到当前主体草稿
    area.querySelectorAll('.om-acc-card').forEach(function (card) {
        card.addEventListener('click', function (e) {
            if (e.target.closest('.om-card-menu')) return;
            var accId = card.dataset.accId;
            if (state.batchMode) {
                var idx = state.batchSelected.indexOf(accId);
                if (idx !== -1) state.batchSelected.splice(idx, 1); else state.batchSelected.push(accId);
                var chk = card.querySelector('.om-card-check');
                if (chk) chk.classList.toggle('checked', state.batchSelected.indexOf(accId) !== -1);
                card.classList.toggle('batch-sel', state.batchSelected.indexOf(accId) !== -1);
                var cnt = document.getElementById('om-batch-count');
                if (cnt) cnt.textContent = state.batchSelected.length;
                return;
            }
            toggleDraftAcc(accId);
        });
    });
    area.querySelectorAll('.om-card-check[data-acc-id]').forEach(function (chk) {
        chk.addEventListener('click', function (e) {
            e.stopPropagation();
            var accId = chk.dataset.accId;
            var idx = state.batchSelected.indexOf(accId);
            if (idx !== -1) state.batchSelected.splice(idx, 1); else state.batchSelected.push(accId);
            chk.classList.toggle('checked', state.batchSelected.indexOf(accId) !== -1);
            var card = chk.closest('.om-card');
            if (card) card.classList.toggle('batch-sel', state.batchSelected.indexOf(accId) !== -1);
            var cnt = document.getElementById('om-batch-count');
            if (cnt) cnt.textContent = state.batchSelected.length;
        });
    });

    // 菜单按钮
    area.querySelectorAll('.om-card-menu[data-acc-id]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var accId = btn.dataset.accId;
            var acc = partGetAccById(loadCurrent(), accId);
            if (acc) fn.openAccContextMenu(acc);
        });
    });
}

// 配饰图片懒加载
function setupAccLazyImages(area) {
    var imgs = area.querySelectorAll('img.om-lazy-img[data-acc-id]');
    if (!imgs.length) return;

    function loadImg(img) {
        if (!img || img.dataset.loaded === '1') return;
        var id = img.getAttribute('data-acc-id');
        var part = loadCurrent();
        var a = partGetAccById(part, id);
        if (!a || !a.imageData) return;
        img.dataset.loaded = '1';
        img.onload = function () { img.classList.add('om-loaded'); };
        img.onerror = function () { img.classList.add('om-loaded'); };
        img.src = a.imageData;
        img.removeAttribute('data-acc-id');
        if (img.complete && img.naturalWidth) img.classList.add('om-loaded');
    }

    if (!('IntersectionObserver' in window)) { imgs.forEach(loadImg); return; }
    var obs = new IntersectionObserver(function (entries, observer) {
        entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            loadImg(entry.target);
            observer.unobserve(entry.target);
        });
    }, { root: area, rootMargin: '400px 0px', threshold: 0.01 });
    imgs.forEach(function (img) { obs.observe(img); });
}

// ── 底栏状态（使用 loadActivePartitions 跨分包显示）────────
function renderBottomStatus() {
    var el = document.getElementById('om-bottom-status'); if (!el) return;
    var meta = loadMeta();
    var activeParts = loadActivePartitions();

    var allActive = [];
    var curUserPK = currentUserPartKey();

    for (var pk in activeParts) {
        var ap = activeParts[pk];
        var ownerName;
        if (pk.indexOf('user:') === 0) {
            ownerName = 'User';
        } else if (pk === 'char:' + SHARED_CHAR_KEY) {
            ownerName = SHARED_CHAR_KEY;
        } else {
            var cid = pk.substring(5);
            ownerName = charNameById(cid) || cid;
        }
        (ap.activeIds || []).forEach(function (id) {
            var o = partGetById(ap, id);
            if (o) allActive.push({ owner: ownerName, name: o.name, id: id, partKey: pk });
        });
    }

    var dotClass, text;
    if (allActive.length === 0) { dotClass = 'gray'; text = '未选择穿搭'; }
    else {
        dotClass = 'green';
        var parts = [];
        var userCount = allActive.filter(function (a) { return a.owner === 'User'; }).length;
        if (userCount > 0) parts.push('User ' + userCount + '套');
        var charCounts = {};
        allActive.forEach(function (a) {
            if (a.owner !== 'User') {
                var label = a.owner === SHARED_CHAR_KEY ? '通用' : a.owner;
                charCounts[label] = (charCounts[label] || 0) + 1;
            }
        });
        for (var cl in charCounts) { parts.push(cl + ' ' + charCounts[cl] + '套'); }
        text = parts.join(' · ');
        if (allActive.length > 1) dotClass = 'orange';
    }

    var clearBtn = allActive.length > 0 ? '<button class="om-status-clear" id="om-status-clearall">全部取消</button>' : '';
    el.innerHTML = '<div class="om-status-dot ' + dotClass + '"></div><span class="om-status-text">' + esc(text) + '</span>' + clearBtn;

    var clr = el.querySelector('#om-status-clearall');
    if (clr) clr.addEventListener('click', function (e) {
        e.stopPropagation();
        // 清空所有 partition 的 activeIds
        var ap2 = loadActivePartitions();
        for (var pk2 in ap2) {
            ap2[pk2].activeIds = [];
            savePartition(pk2, ap2[pk2]);
            syncActivePartitions(pk2, []);
        }
        clearKitDraft();
        fn.updateBtn(); renderBottomStatus(); renderGrid(); closeDetailPanel();
        toast('已取消全部选择');
    });
}

// ── 选择详情面板 ─────────────────────────────────────────
function buildDetailGroups() {
    var activeParts = loadActivePartitions();
    var groups = [];
    for (var pk in activeParts) {
        var ap = activeParts[pk];
        var ownerName;
        if (pk.indexOf('user:') === 0) ownerName = 'User';
        else if (pk === 'char:' + SHARED_CHAR_KEY) ownerName = '通用';
        else { var cid = pk.substring(5); ownerName = charNameById(cid) || cid; }

        var items = [];
        (ap.activeIds || []).forEach(function (id) {
            var o = partGetById(ap, id);
            if (o) items.push({ id: id, name: o.name, partKey: pk, outfit: o });
        });
        if (items.length > 0) groups.push({ owner: ownerName, partKey: pk, part: ap, items: items });
    }
    return groups;
}

function toggleDetailPanel() {
    if (detailPanelOpen) { closeDetailPanel(); return; }
    var groups = buildDetailGroups();
    if (groups.length === 0) return;
    openDetailPanel(groups);
}

function openDetailPanel(groups) {
    closeDetailPanel();
    var bottombar = document.getElementById('om-bottombar'); if (!bottombar) return;
    detailPanelOpen = true;
    var panel = document.createElement('div');
    panel.id = 'om-detail-panel';
    panel.className = 'om-detail-panel';
    panel.style.cssText = 'position:absolute;bottom:100%;left:0;right:0;z-index:10;';

    var html = '<div class="om-detail-handle"></div>';
    var curPK = currentPartKey();
    groups.forEach(function (g) {
        html += '<div class="om-detail-title" style="margin-top:4px">' + esc(g.owner) + '</div>';
        var looseHtml = '';
        var rowHtml = '';
        g.items.forEach(function (w) {
            ensureOutfitKits(w.outfit);
            var focused = isCurrentKitFocus(w.partKey, w.id);
            var useDraft = state.accMode && focused && w.partKey === curPK;
            var kit = getActiveKit(w.outfit);
            var accs = [];
            if (useDraft) {
                (state.kitDraftAccIds || []).forEach(function (aid) {
                    var draftAcc = partGetAccById(g.part, aid);
                    if (draftAcc) accs.push(draftAcc);
                });
            } else if (kit) {
                accs = getKitAccessories(g.part, kit);
            }

            var subjectTag = '<span class="om-detail-tag om-subject-tag' + (focused ? ' focus' : '') + '" data-focus-id="' + esc(w.id) + '" data-pk="' + esc(w.partKey) + '">' +
                esc(w.name) + '<button class="om-detail-tag-x" data-id="' + esc(w.id) + '" data-pk="' + esc(w.partKey) + '">&#x2715;</button></span>';

            if (useDraft || (kit && accs.length > 0)) {
                rowHtml += '<div class="om-kit-row' + (focused ? ' focus' : '') + '">' + subjectTag + '<div class="om-kit-accs-scroll">';
                accs.forEach(function (acc) {
                    var disabled = !useDraft && kit && Array.isArray(kit.disabledAccIds) && kit.disabledAccIds.indexOf(acc.id) !== -1;
                    rowHtml += '<button class="om-kit-acc-tag' + (disabled ? ' disabled' : '') + '" data-pk="' + esc(w.partKey) + '" data-outfit-id="' + esc(w.id) + '" data-acc-id="' + esc(acc.id) + '" data-draft="' + (useDraft ? '1' : '0') + '">' + esc(acc.name) + '</button>';
                });
                rowHtml += '</div>';
                if (useDraft) rowHtml += '<button class="om-kit-save" data-save-kit="1">保存套装</button>';
                rowHtml += '</div>';
            } else {
                looseHtml += subjectTag;
            }
        });
        if (looseHtml) html += '<div class="om-detail-loose-row">' + looseHtml + '</div>';
        if (looseHtml && rowHtml) html += '<div class="om-detail-divider"></div>';
        if (rowHtml) html += '<div class="om-kit-rows">' + rowHtml + '</div>';
    });
    panel.innerHTML = html;
    bottombar.appendChild(panel);
    panel.querySelectorAll('.om-detail-tag-x').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.dataset.id;
            var pk = btn.dataset.pk;
            var targetPart = loadPartition(pk);
            var ai = (targetPart.activeIds || []).indexOf(id);
            if (ai !== -1) targetPart.activeIds.splice(ai, 1);
            if (isCurrentKitFocus(pk, id)) clearKitDraft();
            savePartition(pk, targetPart);
            syncActivePartitions(pk, targetPart.activeIds);
            fn.updateBtn(); renderBottomStatus(); renderGrid();
            preResolveActiveImages();
            closeDetailPanel();
        });
    });
    panel.querySelectorAll('.om-subject-tag').forEach(function (tag) {
        tag.addEventListener('click', function (e) {
            if (e.target.closest('.om-detail-tag-x')) return;
            if (!state.accMode) return;
            var pk = tag.dataset.pk;
            var id = tag.dataset.focusId;
            if (pk !== currentPartKey()) { toast('只能为当前衣柜搭配配饰', true); return; }
            if (setKitFocus(pk, id)) {
                renderGrid();
                refreshDetailPanel();
            }
        });
    });
    panel.querySelectorAll('.om-kit-acc-tag').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var accId = btn.dataset.accId;
            if (btn.dataset.draft === '1') toggleDraftAcc(accId);
            else toggleDisabledAcc(btn.dataset.pk, btn.dataset.outfitId, accId);
        });
    });
    panel.querySelectorAll('[data-save-kit]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            saveFocusedKitDraft();
        });
    });
    setTimeout(function () {
        document.addEventListener('click', outsideDetailClick, true);
    }, 10);
}

function outsideDetailClick(e) {
    var panel = document.getElementById('om-detail-panel');
    var statusEl = document.getElementById('om-bottom-status');
    if (panel && !panel.contains(e.target) && statusEl && !statusEl.contains(e.target)) {
        closeDetailPanel();
    }
}

function closeDetailPanel() {
    detailPanelOpen = false;
    var p = document.getElementById('om-detail-panel'); if (p && p.parentNode) p.parentNode.removeChild(p);
    document.removeEventListener('click', outsideDetailClick, true);
}


// ── 注册到共享桥 ─────────────────────────────────────────
export { openPopup, closePopup, renderGrid, renderCatbar, renderAccCatbar, renderViewbar, renderBottomStatus, preResolveActiveImages };

export function registerMainFn() {
    fn.openPopup = openPopup;
    fn.closePopup = closePopup;
    fn.renderGrid = renderGrid;
    fn.renderCatbar = renderCatbar;
    fn.renderAccCatbar = renderAccCatbar;
    fn.renderViewbar = renderViewbar;
    fn.renderBottomStatus = renderBottomStatus;
    fn.closeDetailPanel = closeDetailPanel;
    fn.preResolveActiveImages = preResolveActiveImages;
}
