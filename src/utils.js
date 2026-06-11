// ── 穿搭管理器 · 工具函数 ──────────────────────────────────
// 通用辅助：ID生成、HTML转义、Toast、图片压缩等

export var MAX_IMG_WIDTH = 800;
export var IMG_QUALITY = 0.75;

export function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

export function esc(s) { return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; }

// 获取弹层容器
export function getPopupLayer() {
    var slot = document.getElementById('om-popup-slot');
    if (slot) return slot;
    var ov = document.querySelector('.om-overlay');
    if (ov) return ov;
    return document.body;
}

// ── Toast ─────────────────────────────────────────────────
export function toast(msg, isErr) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:absolute !important;bottom:96px !important;left:50% !important;' +
        'transform:translateX(-50%) translateY(8px) !important;' +
        'background:' + (isErr ? '#e57373' : 'var(--SmartThemeQuoteColor,#7c6daf)') + ' !important;' +
        'color:#fff !important;padding:8px 20px !important;border-radius:20px !important;' +
        'font-size:13px !important;font-weight:600 !important;z-index:2147483649 !important;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.4) !important;white-space:nowrap !important;' +
        'pointer-events:none !important;opacity:0 !important;transition:all .22s !important;';
    getPopupLayer().appendChild(el);
    setTimeout(function () {
        el.style.setProperty('opacity', '1', 'important');
        el.style.setProperty('transform', 'translateX(-50%) translateY(0)', 'important');
    }, 10);
    setTimeout(function () { el.style.setProperty('opacity', '0', 'important'); }, 2400);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2700);
}

// ── 图片压缩 ─────────────────────────────────────────────
export function compressImage(dataUrl, cb) {
    var img = new Image();
    img.onload = function () {
        var w = img.width, h = img.height, canvas = document.createElement('canvas');
        if (w > MAX_IMG_WIDTH) { canvas.width = MAX_IMG_WIDTH; canvas.height = Math.round(h * MAX_IMG_WIDTH / w); }
        else { canvas.width = w; canvas.height = h; }
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        cb(canvas.toDataURL('image/jpeg', IMG_QUALITY));
    };
    img.onerror = function () { cb(dataUrl); };
    img.src = dataUrl;
}
