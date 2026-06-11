// ── 穿搭管理器 · 主界面 ──────────────────────────────────
// 全屏弹窗、视角切换、分类栏、穿搭网格、底栏状态、详情面板

import { load, save } from './db.js';
import { getCharData, getViewOutfits, getViewCategories, getViewActiveIds, setViewActiveIds, getById, getViewById, isActive } from './data.js';
import { genId, esc, toast, getPopupLayer } from './utils.js';
import { injectStyles } from './styles.js';
import { state, fn } from './bridge.js';

var SCRIPT_NAME = '穿搭管理';

// ── 弹窗状态 ──────────────────────────────────────────────





var detailPanelOpen = false;

// ── 打开全屏主界面 ────────────────────────────────────────
function openPopup() {
    if (document.querySelector('.om-overlay')) return;
    // 防止悬浮球点击事件穿透到面板下方的元素
    var shield = document.createElement('div');
    shield.setAttribute('style', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;');
    shield.addEventListener('touchstart', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    shield.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    document.body.appendChild(shield);
    setTimeout(function () { if (shield.parentNode) shield.parentNode.removeChild(shield); }, 400);

    injectStyles();
    state.batchMode = false; state.batchSelected = []; state.searchQuery = ''; state.searchOpen = false; detailPanelOpen = false;

    var ov = document.createElement('div');
    ov.className = 'om-overlay ' + (state.darkMode ? 'om-dark' : 'om-light');
    ov.setAttribute('style', 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;z-index:2147483647 !important;');

    ov.innerHTML =
        '<div class="om-box">' +
        // 顶栏
        '<div class="om-head">' +
        '<div class="om-head-title"><i class="fa-solid fa-shirt"></i>' + SCRIPT_NAME + '</div>' +
        '<div class="om-head-actions">' +
        '<button class="om-icon-btn" id="om-search-toggle" title="搜索"><i class="fa-solid fa-magnifying-glass"></i></button>' +
        '<button class="om-theme-btn" id="om-theme-toggle"><i class="fa-solid fa-circle-half-stroke"></i></button>' +
        '<button class="om-icon-btn" id="om-x" title="关闭"><i class="fa-solid fa-xmark"></i></button>' +
        '</div></div>' +
        // 搜索栏（默认隐藏）
        '<div class="om-search-bar" id="om-search-bar">' +
        '<div class="om-search-wrap"><i class="fa-solid fa-magnifying-glass"></i>' +
        '<input class="om-search-inp" id="om-search-inp" type="text" placeholder="搜索名称或标签…" autocomplete="off" /></div>' +
        '<button class="om-search-clear" id="om-search-clear" title="关闭搜索"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        // 视角切换栏（User / Char）
        '<div class="om-viewbar" id="om-viewbar"></div>' +
        // 分类栏
        '<div class="om-catbar" id="om-catbar"></div>' +
        // 网格区
        '<div class="om-grid-area" id="om-grid-area"></div>' +
        // 底栏
        '<div class="om-bottombar" id="om-bottombar" style="position:relative;">' +
        '<div class="om-bottom-status" id="om-bottom-status"></div>' +
        '<button class="om-batch-toggle-btn" id="om-batch-toggle">多选</button>' +
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
    sinp.addEventListener('input', function () { state.searchQuery = sinp.value; renderGrid(); });
    sinp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { state.searchOpen = false; state.searchQuery = ''; ov.querySelector('#om-search-bar').classList.remove('open'); renderGrid(); } });

    // 绑定底栏
    ov.querySelector('#om-bottom-status').addEventListener('click', function () { toggleDetailPanel(); });
    ov.querySelector('#om-batch-toggle').addEventListener('click', function () {
        state.batchMode = !state.batchMode; state.batchSelected = [];
        ov.querySelector('#om-batch-toggle').classList.toggle('on', state.batchMode);
        renderGrid();
    });
    ov.querySelector('#om-bottom-presets').addEventListener('click', function () { fn.openPresetsSheet(); });
    ov.querySelector('#om-bottom-settings').addEventListener('click', function () { fn.openSettingsSheet(); });

    renderViewbar();
    renderCatbar();
    renderGrid();
    renderBottomStatus();
    // closeFab is no-op (fab is single button now)
}

function closePopup() {
    var ov = document.querySelector('.om-overlay'); if (ov) ov.parentNode.removeChild(ov);
}

// ── 视角切换栏渲染 ──────────────────────────────────────────
var charPanelExpanded = false;
var collapsedGroups = {};

function renderViewbar() {
    var vbar = document.getElementById('om-viewbar'); if (!vbar) return;
    var d = load();
    var isUser = d.currentView !== 'char';
    vbar.style.position = 'relative';

    var html = '<button class="om-viewtab' + (isUser ? ' on' : '') + '" data-v="user"><i class="fa-solid fa-user" style="margin-right:4px"></i>User</button>' +
        '<button class="om-viewtab' + (!isUser ? ' on' : '') + '" data-v="char"><i class="fa-solid fa-masks-theater" style="margin-right:4px"></i>角色</button>';

    if (!isUser) {
        html += '<input type="text" class="om-char-input" id="om-char-input" placeholder="' + (d.currentChar ? esc(d.currentChar) : '搜索角色…') + '" autocomplete="off" />' +
            '<button class="om-char-add-btn" id="om-char-add" title="添加角色">+</button>';
    }

    vbar.innerHTML = html;

    vbar.querySelectorAll('.om-viewtab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            var dd = load();
            dd.currentView = tab.dataset.v;
            save(dd);
            charPanelExpanded = false;
            renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
        });
    });

    if (!isUser) {
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
        if (charPanelExpanded) renderCharDropdown(vbar, d, '');
    }
}

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
    var dd = load();
    if (!dd.charNames) dd.charNames = [];
    if (dd.charNames.indexOf(name) !== -1) { toast('角色「' + name + '」已存在', true); return; }
    dd.charNames.push(name); dd.currentChar = name; save(dd);
    charPanelExpanded = false;
    renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
    toast('✅ 已添加角色「' + name + '」');
}

function renderCharPanel() { /* 兼容 */ }

// ── 分类栏渲染 ────────────────────────────────────────────
function renderCatbar() {
    var catbar = document.getElementById('om-catbar'); if (!catbar) return;
    var d = load();
    var cats = getViewCategories(d);
    if (cats.length === 0) { catbar.style.display = 'none'; return; }
    catbar.style.display = '';
    var html = '<button class="om-catbtn' + (state.curCat === '__all__' ? ' on' : '') + '" data-c="__all__">全部</button>';
    cats.forEach(function (c) {
        html += '<button class="om-catbtn' + (state.curCat === c ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</button>';
    });
    catbar.innerHTML = html;
    catbar.querySelectorAll('.om-catbtn').forEach(function (btn) {
        btn.addEventListener('click', function () { state.curCat = btn.dataset.c; renderCatbar(); renderGrid(); });
    });
    // ★ 电脑端支持：鼠标滚轮横向滚动 + 鼠标拖拽滚动
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

// ── 网格区渲染 ────────────────────────────────────────────
function renderGrid() {
    var area = document.getElementById('om-grid-area'); if (!area) return;
    var d = load();

    // 如果是角色视角但没选角色，显示提示
    if (d.currentView === 'char' && !d.currentChar) {
        area.innerHTML = '<div class="om-empty"><i class="fa-solid fa-masks-theater"></i><span>请先选择或添加一个角色</span></div>';
        return;
    }

    // 当前视角的穿搭
    var allOutfits = getViewOutfits(d);

    // 按分类过滤
    var list = state.curCat === '__all__' ? allOutfits : allOutfits.filter(function (o) { return o.category === state.curCat; });
    if (state.searchQuery) {
        var q = state.searchQuery.toLowerCase();
        list = list.filter(function (o) {
            return (o.name && o.name.toLowerCase().indexOf(q) !== -1) ||
                (o.category && o.category.toLowerCase().indexOf(q) !== -1) ||
                (o.sceneTag && o.sceneTag.toLowerCase().indexOf(q) !== -1) ||
                (o.description && o.description.toLowerCase().indexOf(q) !== -1);
        });
    }
    var imgOutfits = list.filter(function (o) { return !!o.imageData; });

    var html = '';

    // 批量操作栏
    if (state.batchMode) {
        html += '<div class="om-batch-bar">' +
            '<span class="om-batch-info">已选&nbsp;<b id="om-batch-count">' + state.batchSelected.length + '</b>&nbsp;套</span>' +
            '<div class="om-batch-divider" style="width:1px;height:16px;background:rgba(127,127,127,.25);flex-shrink:0;margin:0 2px;"></div>' +
            '<div class="om-batch-acts">' +
            '<button class="om-batch-btn" id="om-batch-selall">全选</button>' +
            '<button class="om-batch-btn" id="om-batch-none">取消</button>' +
            '<button class="om-batch-btn" id="om-batch-cat"><i class="fa-solid fa-folder"></i> 分类</button>' +
            '<button class="om-batch-btn" id="om-batch-tag"><i class="fa-solid fa-tag"></i> 标签</button>' +
            '<button class="om-batch-btn" id="om-batch-aidesc"><i class="fa-solid fa-wand-magic-sparkles"></i> AI描述</button>' +
            '<button class="om-batch-btn danger" id="om-batch-del"><i class="fa-solid fa-trash"></i> 删除</button>' +
            '</div></div>';
    }

    html += '<div class="om-grid">';

    // 添加卡（仅非批量模式）
    if (!state.batchMode) {
        html += '<div class="om-add-card" id="om-addcard"><i class="fa-solid fa-plus"></i><span>添加穿搭</span></div>';
    }

    if (list.length === 0) {
        html += '</div><div class="om-empty"><i class="fa-solid fa-shirt"></i><span>' +
            (state.searchQuery ? '没有匹配「' + esc(state.searchQuery) + '」的穿搭' : (state.curCat !== '__all__' ? '该分类暂无穿搭' : '还没有穿搭，点击左上角添加')) +
            '</span></div>';
    } else {
        list.forEach(function (o) {
            var on = isActive(d, o.id);
            var bsel = state.batchSelected.indexOf(o.id) !== -1;
            var checkBox = state.batchMode ? '<div class="om-card-check' + (bsel ? ' checked' : '') + '" data-id="' + o.id + '"><i class="fa-solid fa-check"></i></div>' : '';
            var badge = (on && !state.batchMode) ? '<div class="om-badge-on"><i class="fa-solid fa-check"></i></div>' : '';

            var imgContent = '';
            if (o.imageData) {
                imgContent = '<img src="' + o.imageData + '" alt="' + esc(o.name) + '" />';
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

    // 添加卡点击
    var ac = area.querySelector('#om-addcard');
    if (ac) ac.addEventListener('click', function () { fn.openEditSheet(null, state.curCat !== '__all__' ? state.curCat : ''); });

    // 批量操作
    if (state.batchMode) {
        var selall = area.querySelector('#om-batch-selall');
        var selnone = area.querySelector('#om-batch-none');
        var btagBtn = area.querySelector('#om-batch-tag');
        var bdelBtn = area.querySelector('#om-batch-del');

        if (selall) selall.addEventListener('click', function () { state.batchSelected = list.map(function (o) { return o.id; }); renderGrid(); });
        if (selnone) selnone.addEventListener('click', function () { state.batchSelected = []; renderGrid(); });
        var bcatBtn = area.querySelector('#om-batch-cat');
        if (bcatBtn) bcatBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            var dd = load();
            var cats = getViewCategories(dd);
            if (cats.length === 0) { toast('还没有分类，请先在设置中添加', true); return; }
            // 自定义分类选择面板
            var catSheet = fn.createSheet([
                '<div class="om-sheet-title"><i class="fa-solid fa-folder"></i>选择分类</div>',
                '<div class="om-hint" style="margin-bottom:10px">为已选 ' + state.batchSelected.length + ' 套穿搭设置分类</div>',
                cats.map(function (cat) {
                    var n = getViewOutfits(dd).filter(function (o) { return o.category === cat; }).length;
                    return '<div class="om-cat-item om-bcat-pick" data-cat="' + esc(cat) + '" style="cursor:pointer"><span class="om-cat-name">' + esc(cat) + '</span><span class="om-cat-count">' + n + '套</span></div>';
                }).join(''),
                '<div class="om-divider"></div>',
                '<div class="om-cat-item om-bcat-pick" data-cat="" style="cursor:pointer;opacity:.6"><span class="om-cat-name">清除分类</span></div>',
            ].join(''));
            catSheet.querySelectorAll('.om-bcat-pick').forEach(function (item) {
                item.addEventListener('click', function () {
                    var targetCat = item.dataset.cat;
                    var dd2 = load();
                    var viewOutfits = getViewOutfits(dd2);
                    viewOutfits.forEach(function (o) { if (state.batchSelected.indexOf(o.id) !== -1) o.category = targetCat; });
                    save(dd2); fn.closeSheet(catSheet);
                    toast('✅ 已将 ' + state.batchSelected.length + ' 套' + (targetCat ? '移到「' + targetCat + '」' : '清除分类'));
                    state.batchSelected = []; renderGrid();
                });
            });
        });
        if (btagBtn) btagBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            // 复用标签管理面板，选择后批量设置
            fn.openBatchTagPanel(state.batchSelected.slice(), function () {
                state.batchSelected = []; renderGrid();
            });
        });
        if (bdelBtn) bdelBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            if (!confirm('确定删除已选 ' + state.batchSelected.length + ' 套穿搭？')) return;
            var dd = load();
            dd.outfits = dd.outfits.filter(function (o) { return state.batchSelected.indexOf(o.id) === -1; });
            if (dd.chars) { for (var cn in dd.chars) { dd.chars[cn].outfits = (dd.chars[cn].outfits || []).filter(function (o) { return state.batchSelected.indexOf(o.id) === -1; }); } }
            state.batchSelected.forEach(function (id) {
                var ai = (dd.activeIds || []).indexOf(id); if (ai !== -1) dd.activeIds.splice(ai, 1);
                if (dd.chars) { for (var cn2 in dd.chars) { var cai = (dd.chars[cn2].activeIds || []).indexOf(id); if (cai !== -1) dd.chars[cn2].activeIds.splice(cai, 1); } }
            });
            save(dd); fn.updateBtn(); renderBottomStatus(); toast('已删除 ' + state.batchSelected.length + ' 套穿搭'); state.batchSelected = []; renderGrid();
        });

        var baidescBtn = area.querySelector('#om-batch-aidesc');
        if (baidescBtn) baidescBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            var dd = load();
            if (!dd.apiVision.endpoint || !dd.apiVision.key || !dd.apiVision.model) {
                toast('请先在设置中配置"描述生成 API"', true); return;
            }
            var hasImg = state.batchSelected.some(function (id) { var o = getById(dd, id); return o && o.imageData; });
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
                var cnt = area.querySelector('#om-batch-count');
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
                var cnt = area.querySelector('#om-batch-count');
                if (cnt) cnt.textContent = state.batchSelected.length;
            });
        });
    } else {
        // 非批量：单击 = 选择/取消，点击⋯按钮 = 操作菜单
        area.querySelectorAll('.om-card').forEach(function (card) {
            var id = card.dataset.id;

            card.addEventListener('click', function (e) {
                if (e.target.closest('.om-card-menu') || e.target.closest('.om-badge-on')) return;
                var dd = load();
                var aids = getViewActiveIds(dd);
                var idx = aids.indexOf(id);
                if (idx !== -1) aids.splice(idx, 1); else aids.push(id);
                setViewActiveIds(dd, aids);
                save(dd); fn.updateBtn(); renderBottomStatus();


                save(dd); fn.updateBtn(); renderBottomStatus();
                // 更新卡片样式
                card.classList.toggle('on', isActive(dd, id));
                var badge = card.querySelector('.om-badge-on');
                if (isActive(dd, id)) {
                    if (!badge) { var b = document.createElement('div'); b.className = 'om-badge-on'; b.innerHTML = '<i class="fa-solid fa-check"></i>'; card.querySelector('.om-card-img').appendChild(b); }
                } else {
                    if (badge) badge.parentNode.removeChild(badge);
                }
                closeDetailPanel();
                var n = aids.length;
                var o = getById(dd, id);
                if (idx !== -1) toast('已取消：' + (o ? o.name : ''));
                else if (n === 1) toast('✅ 已选：' + (o ? o.name : ''));
                else toast('✅ 衣柜模式，共' + n + '套');
            });
        });

        // 菜单按钮点击事件（独立绑定，stopPropagation防止触发卡片选择）
        area.querySelectorAll('.om-card-menu').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = btn.dataset.id;
                var o = getById(load(), id);
                fn.openContextMenu(o, imgOutfits);
            });
        });
    }
}

// ── 底栏状态 ─────────────────────────────────────────────
function renderBottomStatus() {
    var el = document.getElementById('om-bottom-status'); if (!el) return;
    var d = load();

    // 收集所有owner的激活穿搭
    var allActive = [];
    // User
    (d.activeIds || []).forEach(function (id) { var o = getById(d, id); if (o) allActive.push({ owner: 'User', name: o.name, id: id }); });
    // Chars
    if (d.chars) {
        for (var cn in d.chars) {
            var cd = d.chars[cn];
            (cd.activeIds || []).forEach(function (id) {
                var o = null; for (var k = 0; k < (cd.outfits || []).length; k++) { if (cd.outfits[k].id === id) { o = cd.outfits[k]; break; } }
                if (o) allActive.push({ owner: cn, name: o.name, id: id });
            });
        }
    }

    var dotClass, text;
    if (allActive.length === 0) { dotClass = 'gray'; text = '未选择穿搭'; }
    else {
        dotClass = 'green';
        var parts = [];
        var userCount = allActive.filter(function (a) { return a.owner === 'User'; }).length;
        if (userCount > 0) parts.push('User ' + userCount + '套');
        if (d.chars) {
            for (var cn2 in d.chars) {
                var cnt = allActive.filter(function (a) { return a.owner === cn2; }).length;
                if (cnt > 0) parts.push(cn2 + ' ' + cnt + '套');
            }
        }
        text = parts.join(' · ');
        if (allActive.length > 1) dotClass = 'orange';
    }

    var clearBtn = allActive.length > 0 ? '<button class="om-status-clear" id="om-status-clearall">全部取消</button>' : '';
    el.innerHTML = '<div class="om-status-dot ' + dotClass + '"></div><span class="om-status-text">' + esc(text) + '</span>' + clearBtn;

    var clr = el.querySelector('#om-status-clearall');
    if (clr) clr.addEventListener('click', function (e) {
        e.stopPropagation();
        var dd = load(); dd.activeIds = [];
        if (dd.chars) { for (var cn3 in dd.chars) { dd.chars[cn3].activeIds = []; } }
        save(dd);
        fn.updateBtn(); renderBottomStatus(); renderGrid(); closeDetailPanel();
        toast('已取消全部选择');
    });
}

// ── 选择详情面板 ─────────────────────────────────────────
function toggleDetailPanel() {
    if (detailPanelOpen) { closeDetailPanel(); return; }
    var d = load();

    // 收集所有owner的激活穿搭，按owner分组
    var groups = [];
    var userNames = [];
    (d.activeIds || []).forEach(function (id) { var o = getById(d, id); if (o) userNames.push({ id: id, name: o.name }); });
    if (userNames.length > 0) groups.push({ owner: 'User', items: userNames });
    if (d.chars) {
        for (var cn in d.chars) {
            var cd = d.chars[cn];
            var charNames = [];
            (cd.activeIds || []).forEach(function (id) {
                for (var k = 0; k < (cd.outfits || []).length; k++) { if (cd.outfits[k].id === id) { charNames.push({ id: id, name: cd.outfits[k].name }); break; } }
            });
            if (charNames.length > 0) groups.push({ owner: cn, items: charNames });
        }
    }
    if (groups.length === 0) return;
    openDetailPanel(groups, d);
}

function openDetailPanel(groups, d) {
    closeDetailPanel();
    var bottombar = document.getElementById('om-bottombar'); if (!bottombar) return;
    detailPanelOpen = true;
    var panel = document.createElement('div');
    panel.id = 'om-detail-panel';
    panel.className = 'om-detail-panel';
    panel.style.cssText = 'position:absolute;bottom:100%;left:0;right:0;z-index:10;';

    var html = '<div class="om-detail-handle"></div>';
    groups.forEach(function (g) {
        html += '<div class="om-detail-title" style="margin-top:4px">' + esc(g.owner) + '</div>';
        html += '<div class="om-detail-tags">';
        g.items.forEach(function (w) {
            html += '<span class="om-detail-tag">' + esc(w.name) +
                '<button class="om-detail-tag-x" data-id="' + w.id + '">&#x2715;</button></span>';
        });
        html += '</div>';
    });
    panel.innerHTML = html;
    bottombar.appendChild(panel);
    panel.querySelectorAll('.om-detail-tag-x').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var dd = load(); var id = btn.dataset.id;
            // 从所有owner中查找并移除
            var ai1 = (dd.activeIds || []).indexOf(id); if (ai1 !== -1) dd.activeIds.splice(ai1, 1);
            if (dd.chars) { for (var cn in dd.chars) { var cai = (dd.chars[cn].activeIds || []).indexOf(id); if (cai !== -1) dd.chars[cn].activeIds.splice(cai, 1); } }
            save(dd); fn.updateBtn(); renderBottomStatus(); renderGrid();
            closeDetailPanel();
        });
    });
    // 点击底栏外关闭
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
export { openPopup, closePopup, renderGrid, renderCatbar, renderViewbar, renderBottomStatus };

export function registerMainFn() {
    fn.openPopup = openPopup;
    fn.closePopup = closePopup;
    fn.renderGrid = renderGrid;
    fn.renderCatbar = renderCatbar;
    fn.renderViewbar = renderViewbar;
    fn.renderBottomStatus = renderBottomStatus;
    fn.closeDetailPanel = closeDetailPanel;
}
