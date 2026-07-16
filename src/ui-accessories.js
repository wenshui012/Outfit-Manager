// ── 穿搭管理器 · 单品界面 ──────────────────────────────────
// 单品分类、网格、卡片操作与套装草稿

import {
    loadMeta,
    loadCurrent, saveCurrent,
    loadPartition, savePartition,
    currentPartKey
} from './db.js';
import {
    getCatNames, getSubCats, hasSubCats,
    partGetById, partGetAccById,
    getActiveKit, ensureOutfitKits, cleanAccIdFromKits
} from './data.js';
import { genId, esc, toast, uniqueIds } from './utils.js';
import { state, fn } from './bridge.js';

var OM_TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export function clearKitDraft() {
    state.kitFocusPartKey = null;
    state.kitFocusOutfitId = null;
    state.kitDraftAccIds = [];
    state.kitDraftSourceKitId = null;
    state.kitDraftDirty = false;
}

export function isCurrentKitFocus(partKey, outfitId) {
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

export function setKitFocus(partKey, outfitId) {
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

export function ensureKitFocusForAccMode(showToast) {
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

export function draftHasAcc(accId) {
    if (state.kitFocusPartKey !== currentPartKey()) return false;
    return (state.kitDraftAccIds || []).indexOf(accId) !== -1;
}

export function toggleDraftAcc(accId) {
    if (!ensureKitFocusForAccMode(true)) {
        fn.outfitsInternalRefreshDetailPanel();
        return;
    }
    var ids = uniqueIds(state.kitDraftAccIds || []);
    var idx = ids.indexOf(accId);
    if (idx !== -1) ids.splice(idx, 1);
    else ids.push(accId);
    state.kitDraftAccIds = ids;
    state.kitDraftDirty = true;
    fn.renderGrid();
    fn.outfitsInternalRefreshDetailPanel();
}

function nextKitName(kits) {
    var n = (kits || []).length + 1;
    var used = {};
    (kits || []).forEach(function (kit) { if (kit && kit.name) used[kit.name] = true; });
    while (used['套装' + n]) n++;
    return '套装' + n;
}

export function saveFocusedKitDraft() {
    if (!ensureKitFocusForAccMode(true)) return;
    var ctx = getCurrentFocusContext();
    if (!ctx || ctx.partKey !== currentPartKey()) { toast('请先在当前衣柜选择主体', true); return; }
    ensureOutfitKits(ctx.outfit);
    var draft = uniqueIds(state.kitDraftAccIds || []).filter(function (id) { return !!partGetAccById(ctx.part, id); });
    var kit = getActiveKit(ctx.outfit);

    if (!kit) {
        if (draft.length === 0) { toast('请先选择单品', true); return; }
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
    fn.renderGrid();
    fn.renderBottomStatus();
    fn.outfitsInternalRefreshDetailPanel();
    toast('已保存套装');
}

export function toggleDisabledAcc(partKey, outfitId, accId) {
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
    fn.renderBottomStatus();
    fn.outfitsInternalRefreshDetailPanel();
}

function batchDeleteAccessories(accIds) {
    accIds = uniqueIds(accIds || []);
    if (accIds.length === 0) { toast('请先选择单品', true); return; }
    if (!confirm('确定删除 ' + accIds.length + ' 个单品？引用它们的套装方案将自动更新。')) return;
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
    fn.accessoriesInternalUpdateBatchButtonState();
    fn.renderAccCatbar();
    fn.renderGrid();
    fn.renderBottomStatus();
    toast('已删除 ' + accIds.length + ' 个单品');
}

function openAccBatchCategorySheet(accIds) {
    accIds = uniqueIds(accIds || []);
    if (accIds.length === 0) { toast('请先选择单品', true); return; }
    var part = loadCurrent();
    var cats = part.accCategories || [];
    var catNames = getCatNames(cats);
    if (catNames.length === 0) { toast('还没有单品分类，请先在设置中添加', true); return; }
    var itemsHtml = '';
    cats.forEach(function (catObj) {
        var catName = typeof catObj === 'object' ? catObj.name : catObj;
        var children = typeof catObj === 'object' ? (catObj.children || []) : [];
        var n = (part.accessories || []).filter(function (a) { return a.category === catName; }).length;
        itemsHtml += '<div class="om-cat-item om-acc-bcat-pick" data-cat="' + esc(catName) + '" data-sub="" style="cursor:pointer;font-weight:600"><span class="om-cat-name">' + esc(catName) + '</span><span class="om-cat-count">' + n + '件</span></div>';
        children.forEach(function (sc) {
            var sn = (part.accessories || []).filter(function (a) { return a.category === catName && a.subCategory === sc; }).length;
            itemsHtml += '<div class="om-cat-item om-acc-bcat-pick" data-cat="' + esc(catName) + '" data-sub="' + esc(sc) + '" style="cursor:pointer;padding-left:28px;opacity:.85"><span class="om-cat-name"><i class="fa-solid fa-turn-up fa-rotate-90" style="font-size:.6em;opacity:.3;margin-right:6px"></i>' + esc(sc) + '</span><span class="om-cat-count">' + sn + '件</span></div>';
        });
    });
    var sheet = fn.createSheet([
        '<div class="om-sheet-title"><i class="fa-solid fa-folder"></i>选择单品分类</div>',
        '<div class="om-hint" style="margin-bottom:10px">为已选 ' + accIds.length + ' 件单品设置分类</div>',
        itemsHtml,
        '<div class="om-divider"></div>',
        '<div class="om-cat-item om-acc-bcat-pick" data-cat="" data-sub="" style="cursor:pointer;opacity:.6"><span class="om-cat-name">清除分类</span></div>',
    ].join(''));
    sheet.querySelectorAll('.om-acc-bcat-pick').forEach(function (item) {
        item.addEventListener('click', function () {
            var targetCat = item.dataset.cat;
            var targetSub = item.dataset.sub;
            var p = loadCurrent();
            (p.accessories || []).forEach(function (acc) {
                if (accIds.indexOf(acc.id) !== -1) {
                    acc.category = targetCat;
                    acc.subCategory = targetSub || '';
                }
            });
            saveCurrent(p);
            fn.closeSheet(sheet);
            state.batchSelected = [];
            fn.renderAccCatbar();
            fn.renderGrid();
            toast('已更新 ' + accIds.length + ' 件单品分类');
        });
    });
}

// ── 单品分类栏渲染 ─────────────────────────────────────────
export function renderAccCatbar() {
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
    accbar.innerHTML = html;

    // 事件绑定
    if (state.accDrillParent) {
        accbar.querySelector('#om-acc-cat-back').addEventListener('click', function () {
            state.accDrillParent = null; state.accSubCat = null; state.accCat = '__all__';
            renderAccCatbar(); fn.renderGrid();
        });
        accbar.querySelectorAll('.om-catbtn[data-asub]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var sub = btn.dataset.asub;
                state.accSubCat = (sub === '__all__') ? null : sub;
                renderAccCatbar(); fn.renderGrid();
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
                renderAccCatbar(); fn.renderGrid();
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

// ── 单品网格渲染 ────────────────────────────────────────
export function renderAccGrid(area, part) {
    var allAcc = part.accessories || [];

    // 按单品分类过滤
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
                '<span class="om-batch-info">已选&nbsp;<b id="om-batch-count">' + state.batchSelected.length + '</b>&nbsp;件</span>' +
                '<div class="om-batch-divider" style="width:1px;height:16px;background:rgba(127,127,127,.25);flex-shrink:0;margin:0 2px;"></div>' +
                '<div class="om-batch-acts">' +
                '<button class="om-batch-btn" id="om-acc-batch-selall">全选</button>' +
                '<button class="om-batch-btn" id="om-acc-batch-none">取消</button>' +
                '<button class="om-batch-btn" id="om-acc-batch-cat"><i class="fa-solid fa-folder"></i> 分类</button>' +
                '<button class="om-batch-btn" id="om-acc-batch-move"><i class="fa-solid fa-arrow-right-arrow-left"></i> 移动</button>' +
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
        html += '<div class="om-add-card" id="om-acc-addcard"><i class="fa-solid fa-plus"></i><span>添加单品</span></div>';
    }

    if (list.length === 0) {
        var hasFilter = state.filterNoCat || state.filterNoDesc;
        var emptyMsg = state.searchQuery ? '没有匹配的单品'
            : hasFilter ? '没有符合筛选条件的单品'
            : (state.accCat !== '__all__' ? '该分类暂无单品' : '还没有单品，点击添加');
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
            var menuBtn = state.batchMode ? '' : '<button class="om-card-menu" data-acc-id="' + esc(a.id) + '" title="操作"><i class="fa-solid fa-ellipsis"></i></button>';
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

    // 单品懒加载
    setupAccLazyImages(area);

    if (state.batchMode && batchArea) {
        var selall = batchArea.querySelector('#om-acc-batch-selall');
        var selnone = batchArea.querySelector('#om-acc-batch-none');
        var catBtn = batchArea.querySelector('#om-acc-batch-cat');
        var moveBtn = batchArea.querySelector('#om-acc-batch-move');
        var delBtn = batchArea.querySelector('#om-acc-batch-del');
        var descBtn = batchArea.querySelector('#om-acc-batch-desc');
        if (selall) selall.addEventListener('click', function () {
            state.batchSelected = list.map(function (a) { return a.id; });
            fn.renderGrid();
        });
        if (selnone) selnone.addEventListener('click', function () {
            state.batchSelected = [];
            fn.renderGrid();
        });
        if (catBtn) catBtn.addEventListener('click', function () {
            openAccBatchCategorySheet(state.batchSelected.slice());
        });
        if (moveBtn) moveBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择单品', true); return; }
            if (fn.openAccMoveToPanel) {
                fn.openAccMoveToPanel(state.batchSelected.slice(), function () {
                    state.batchSelected = [];
                    state.batchMode = false;
                    fn.accessoriesInternalUpdateBatchButtonState();
                    fn.renderAccCatbar();
                    fn.renderGrid();
                    fn.renderBottomStatus();
                });
            }
        });
        if (delBtn) delBtn.addEventListener('click', function () {
            batchDeleteAccessories(state.batchSelected.slice());
        });
        if (descBtn) descBtn.addEventListener('click', function () {
            var m = loadMeta();
            if (!m.apiVision.endpoint || !m.apiVision.key || !m.apiVision.model) {
                toast('请先在设置中配置"描述生成 API"', true); return;
            }
            var curP = loadCurrent();
            var ids = state.batchSelected.slice();
            if (ids.length === 0) {
                ids = list.filter(function (acc) {
                    return acc && acc.imageData && (!acc.description || !acc.description.trim());
                }).map(function (acc) { return acc.id; });
                if (ids.length === 0) {
                    toast('请先勾选单品，或当前筛选范围内没有可生成的未描述单品', true); return;
                }
                if (!confirm('未勾选单品，是否为当前筛选范围内 ' + ids.length + ' 个未描述单品生成描述？')) return;
            }
            var hasImg = ids.some(function (id) { var acc = partGetAccById(curP, id); return acc && acc.imageData; });
            if (!hasImg) { toast('所选单品中没有带图片的', true); return; }
            if (fn.openAccBatchDescModal) fn.openAccBatchDescModal(ids);
        });
    }

    // 添加单品
    var ac = area.querySelector('#om-acc-addcard');
    if (ac) ac.addEventListener('click', function () {
        var defCat = state.accDrillParent || (state.accCat !== '__all__' ? state.accCat : '');
        fn.openAccEditSheet(null, defCat);
    });

    // 单品卡片点击 → 临时选择到当前主体草稿
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

// 单品图片懒加载
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
    Array.prototype.slice.call(imgs, 0, 12).forEach(loadImg);
    setTimeout(function () {
        imgs.forEach(function (img) {
            if (img && img.dataset.loaded !== '1') loadImg(img);
        });
    }, 350);
}
