// ── 穿搭管理器 · 悬浮球 & 侧栏按钮 ─────────────────────
// FAB 拖拽悬浮球 + 扩展菜单侧栏按钮

import { load } from './db.js';
import { getById } from './data.js';
import { esc, compressImage } from './utils.js';
import { fn } from './bridge.js';

var SCRIPT_NAME = '穿搭管理';
var BTN_ID = 'outfit-mgr-ext-btn-v4';
var FAB_ID = 'om-fab-main';

// ── FAB（悬浮球）────────────────────────────────────────
var fabResizeHandler = null;

function injectFab() {
    if (document.getElementById(FAB_ID)) return;
    var d = load(); if (d.showBall === false) return;
    var container = document.createElement('div'); container.id = FAB_ID;
    var MAIN_SIZE = d.fabSize || 38;
    var accent = 'var(--SmartThemeQuoteColor,#7c6daf)';

    function posFab() {
        var vh = window.innerHeight || document.documentElement.clientHeight;
        var vw = window.innerWidth || document.documentElement.clientWidth;
        var mainTop = vh - 80 - MAIN_SIZE; var mainLeft = vw - 16 - MAIN_SIZE;
        if (mainTop < 10) mainTop = 10; if (mainLeft < 10) mainLeft = 10;
        container.setAttribute('style',
            'position:fixed !important;top:' + mainTop + 'px !important;left:' + mainLeft + 'px !important;' +
            'z-index:2147483647 !important;display:flex !important;align-items:center !important;' +
            'pointer-events:none !important;margin:0 !important;padding:0 !important;');
    }

    var mainBtn;
    if (d.fabImage) {
        mainBtn = document.createElement('img');
        mainBtn.src = d.fabImage;
        mainBtn.setAttribute('style',
            'width:' + MAIN_SIZE + 'px !important;height:' + MAIN_SIZE + 'px !important;' +
            'cursor:pointer !important;display:block !important;' +
            'pointer-events:auto !important;object-fit:contain !important;' +
            'filter:drop-shadow(0 2px 6px rgba(0,0,0,.25)) !important;');
    } else {
        mainBtn = document.createElement('div');
        mainBtn.innerHTML = '<i class="fa-solid fa-shirt" style="pointer-events:none;font-size:' + Math.max(0.7, MAIN_SIZE / 35) + 'em;"></i>';
        mainBtn.setAttribute('style',
            'width:' + MAIN_SIZE + 'px !important;height:' + MAIN_SIZE + 'px !important;border-radius:50% !important;' +
            'background:' + accent + ' !important;color:#fff !important;border:none !important;cursor:pointer !important;' +
            'display:flex !important;align-items:center !important;justify-content:center !important;' +
            'box-shadow:0 4px 16px rgba(0,0,0,.35) !important;opacity:.9 !important;pointer-events:auto !important;');
    }

    mainBtn.id = 'om-fab-main-btn';
    container.appendChild(mainBtn);

    // 拖拽 + 点击判断
    var _dragState = { sx: 0, sy: 0, ox: 0, oy: 0, moved: false };
    mainBtn.addEventListener('touchstart', function (e) {
        var t = e.touches[0];
        _dragState.sx = t.clientX; _dragState.sy = t.clientY;
        var rect = container.getBoundingClientRect();
        _dragState.ox = rect.left; _dragState.oy = rect.top;
        _dragState.moved = false;
    }, { passive: true });
    mainBtn.addEventListener('touchmove', function (e) {
        var t = e.touches[0];
        var dx = t.clientX - _dragState.sx, dy = t.clientY - _dragState.sy;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) _dragState.moved = true;
        if (_dragState.moved) {
            var nx = _dragState.ox + dx, ny = _dragState.oy + dy;
            var vw = window.innerWidth, vh = window.innerHeight;
            nx = Math.max(0, Math.min(nx, vw - MAIN_SIZE));
            ny = Math.max(0, Math.min(ny, vh - MAIN_SIZE));
            container.style.setProperty('left', nx + 'px', 'important');
            container.style.setProperty('top', ny + 'px', 'important');
        }
    }, { passive: true });
    mainBtn.addEventListener('touchend', function (e) {
        if (!_dragState.moved) {
            _dragState.handled = true;
            e.preventDefault(); // 阻止后续 click 事件
            // 延迟打开，等触摸事件完全结束
            setTimeout(function () { fn.openPopup(); }, 50);
        }
    });
    // PC端点击
    mainBtn.addEventListener('click', function (e) {
        if (_dragState.handled) { _dragState.handled = false; return; }
        if (_dragState.moved) { _dragState.moved = false; return; }
        fn.openPopup();
    });

    posFab();
    if (fabResizeHandler) window.removeEventListener('resize', fabResizeHandler);
    fabResizeHandler = posFab;
    window.addEventListener('resize', fabResizeHandler);
    document.body.appendChild(container);
}

function closeFab() { /* no-op, fab is now single button */ }

// ── 侧栏按钮 ──────────────────────────────────────────────
function updateBtn() {
    var btn = document.getElementById(BTN_ID); if (!btn) return;
    var d = load();
    var names = []; d.activeIds.forEach(function (id) { var o = getById(d, id); if (o) names.push(o.name); });
    var span = btn.querySelector('span');
    if (span) {
        if (names.length === 0) span.textContent = SCRIPT_NAME;
        else if (names.length === 1) span.textContent = names[0];
        else span.textContent = '衣柜(' + names.length + '套)';
    }
    btn.style.color = names.length > 0 ? 'var(--SmartThemeQuoteColor)' : '';
}

function findMenu() {
    var m = document.getElementById('extensionsMenu'); if (m) return m;
    m = document.getElementById('extensions_menu'); if (m) return m;
    var items = document.querySelectorAll('.list-group-item.interactable');
    for (var i = 0; i < items.length; i++) { var t = items[i].textContent || ''; if (t.indexOf('CSS') !== -1 || t.indexOf('头像框') !== -1 || t.indexOf('变量管理') !== -1) return items[i].parentElement; }
    return null;
}

function injectBtn() {
    if (document.getElementById(BTN_ID)) return;
    var menu = findMenu(); if (!menu) return;
    var d = load(); var names = []; d.activeIds.forEach(function (id) { var o = getById(d, id); if (o) names.push(o.name); });
    var btn = document.createElement('div');
    btn.id = BTN_ID; btn.className = 'list-group-item flex-container flexGap5 interactable'; btn.title = SCRIPT_NAME;
    if (names.length > 0) btn.style.color = 'var(--SmartThemeQuoteColor)';
    btn.innerHTML = '<i class="fa-solid fa-shirt"></i><span>' + esc(names.length === 1 ? names[0] : names.length > 1 ? '衣柜(' + names.length + '套)' : SCRIPT_NAME) + '</span>';
    btn.addEventListener('click', function() { fn.openPopup(); });
    menu.appendChild(btn);
}

// ── 导出 ─────────────────────────────────────────────────
export { FAB_ID, BTN_ID, injectFab, closeFab, updateBtn, injectBtn, findMenu };

export function registerFabFn() {
    fn.updateBtn = updateBtn;
    fn.injectBtn = injectBtn;
    fn.injectFab = injectFab;
}
