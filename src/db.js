// ── 穿搭管理器 · 存储层 v2 ────────────────────────────────
// IndexedDB 本地存储 + Server 后端存储 自动切换
// 启动时探测 /api/plugins/outfit-manager/status，可用则 server 模式
// 不可用则回退本地 IndexedDB / localStorage（与旧版完全兼容）

import { ensureDefaults } from './data.js';

// ── 常量 ─────────────────────────────────────────────────
var DB_NAME = 'outfit_mgr_db';
var DB_VERSION = 1;
var STORE_NAME = 'data';
var DATA_KEY = 'main';
var LS_KEY = 'outfit_mgr_v4';

var SERVER_BASE = '/api/plugins/outfit-manager';
var IMAGE_URL_PREFIX = SERVER_BASE + '/images/';

// ── 状态 ─────────────────────────────────────────────────
var dbInstance = null;
var dataCache = null;
var serverMode = false;
var serverReady = false;

// server PUT 队列（避免并发写）
var pendingPut = null;
var queuedPut = null;
var csrfToken = null;

// ── Server 通信 ──────────────────────────────────────────

// 获取 ST 写请求头（含 CSRF token）
function getWriteHeaders() {
    try {
        if (typeof window !== 'undefined' && typeof window.getRequestHeaders === 'function') {
            var h = window.getRequestHeaders();
            if (h) { h['Content-Type'] = 'application/json'; return Promise.resolve(h); }
        }
    } catch (e) {}
    var base = { 'Content-Type': 'application/json' };
    if (csrfToken) { base['X-CSRF-Token'] = csrfToken; return Promise.resolve(base); }
    return fetch('/csrf-token', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
            if (j && j.token) { csrfToken = j.token; base['X-CSRF-Token'] = j.token; }
            return base;
        })
        .catch(function () { return base; });
}

// 本地镜像：server 模式下把数据同步写一份到 IndexedDB
// 后端挂了回退时，至少拿到最近一次成功同步的数据
function mirrorToLocal(d) {
    try {
        openDB(function (db) {
            if (!db) return;
            var tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(d, DATA_KEY);
        });
    } catch (e) { /* 镜像失败不影响主流程 */ }
}

function serverGetData(cb) {
    fetch(SERVER_BASE + '/data', { method: 'GET', credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
            var data = (j && j.ok) ? (j.data || null) : null;
            // 成功拉取后写一份本地镜像，后端挂了时可回退到最近数据
            if (data) { mirrorToLocal(data); }
            cb(data);
        })
        .catch(function () { cb(null); });
}

function serverPutData(d) {
    // 合并队列：PUT 进行中只保留最新数据，完成后补发
    if (pendingPut) { queuedPut = d; return; }
    // PUT 同时写一份本地镜像
    mirrorToLocal(d);
    pendingPut = getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/data', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify(d)
        });
    }).then(function (r) {
        if (r && r.status === 403) { csrfToken = null; }
    }).catch(function () {}).then(function () {
        pendingPut = null;
        if (queuedPut) { var q = queuedPut; queuedPut = null; serverPutData(q); }
    });
}

function detectServer(cb) {
    fetch(SERVER_BASE + '/status', { method: 'GET', credentials: 'same-origin' })
        .then(function (r) { cb(!!(r && r.ok)); })
        .catch(function () { cb(false); });
}

// ── IndexedDB 本地存储 ──────────────────────────────────
function openDB(cb) {
    if (dbInstance) { cb(dbInstance); return; }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = function (e) { dbInstance = e.target.result; cb(dbInstance); };
    req.onerror = function () { cb(null); };
}

function loadFromLS() {
    try { var r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; }
}

// ── 异步加载（初始化用）─────────────────────────────────
export function loadFromDB(cb) {
    if (dataCache) { cb(dataCache); return; }
    openDB(function (db) {
        if (!db) { dataCache = ensureDefaults(loadFromLS()); cb(dataCache); return; }
        var tx = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).get(DATA_KEY);
        req.onsuccess = function () { dataCache = ensureDefaults(req.result || loadFromLS()); cb(dataCache); };
        req.onerror = function () { dataCache = ensureDefaults(loadFromLS()); cb(dataCache); };
    });
}

// ── 异步保存 ─────────────────────────────────────────────
export function saveToDB(d, cb) {
    dataCache = d;
    openDB(function (db) {
        if (!db) { try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) {} if (cb) cb(); return; }
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(d, DATA_KEY);
        tx.oncomplete = function () { if (cb) cb(); };
        tx.onerror = function () { if (cb) cb(); };
    });
}

// ── 同步读写（操作缓存）─────────────────────────────────
export function load() {
    if (dataCache) return dataCache;
    dataCache = ensureDefaults(loadFromLS());
    return dataCache;
}

export function save(d) {
    dataCache = d;
    if (serverMode) { serverPutData(d); return; }
    saveToDB(d);
}

export function getCache() { return dataCache; }
export function setCache(d) { dataCache = d; }

// ── LS 迁移辅助 ─────────────────────────────────────────
export { loadFromLS };
export function removeLSData() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }

// ── Server 模式查询 ─────────────────────────────────────
export function isServerMode() { return serverMode; }
export function getImageUrlPrefix() { return IMAGE_URL_PREFIX; }

// ── 图片 URL → base64 解析（给外部调用用）──────────────
// resolveImageForExternal：
//   如果是 data:image/... → 原样返回
//   如果是后端 URL → fetch 回来转 dataURL
//   其他 → 原样返回
export function resolveImageForExternal(imageData, cb) {
    if (!imageData || typeof imageData !== 'string') { cb(imageData); return; }
    // 已经是 base64
    if (imageData.indexOf('data:image/') === 0) { cb(imageData); return; }
    // 不是本插件 URL
    if (imageData.indexOf(IMAGE_URL_PREFIX) !== 0) { cb(imageData); return; }
    // 后端 URL → 通过 batch-fetch 取回 base64
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/images/batch-fetch', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ urls: [imageData] })
        });
    }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
        if (j && j.ok && j.images && j.images[imageData]) {
            cb(j.images[imageData]);
        } else {
            cb(imageData); // 回退：原样返回
        }
    }).catch(function () { cb(imageData); });
}

// 批量版本：urls → { url: dataUrl }
export function batchResolveImages(urls, cb) {
    if (!urls || urls.length === 0) { cb({}); return; }

    // 分离：已经是 base64 的不用请求
    var needFetch = [];
    var results = {};
    urls.forEach(function (url) {
        if (!url || typeof url !== 'string') return;
        if (url.indexOf('data:image/') === 0) {
            results[url] = url;
        } else if (url.indexOf(IMAGE_URL_PREFIX) === 0) {
            needFetch.push(url);
        } else {
            results[url] = url;
        }
    });

    if (needFetch.length === 0) { cb(results); return; }

    // 去重
    var unique = [];
    var seen = {};
    needFetch.forEach(function (u) { if (!seen[u]) { seen[u] = true; unique.push(u); } });

    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/images/batch-fetch', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ urls: unique })
        });
    }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
        if (j && j.ok && j.images) {
            for (var url in j.images) { results[url] = j.images[url]; }
        }
        // 没取到的保持原值
        needFetch.forEach(function (u) { if (!results[u]) results[u] = u; });
        cb(results);
    }).catch(function () {
        needFetch.forEach(function (u) { if (!results[u]) results[u] = u; });
        cb(results);
    });
}

// ── 单张图片上传到后端 ──────────────────────────────────
export function uploadImage(dataUrl, cb) {
    if (!serverMode) { cb(null, dataUrl); return; } // 本地模式不上传，原样返回
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/images', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ dataUrl: dataUrl })
        });
    }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
        if (j && j.ok && j.url) {
            cb(null, j.url);
        } else {
            cb(null, dataUrl); // 回退
        }
    }).catch(function () { cb(null, dataUrl); });
}

// ── 启动初始化 ──────────────────────────────────────────
// 探测后端 → 可用则拉取数据 → 不可用则本地加载
// 首次迁移：本地有数据 + 后端为空 → 自动上传
export function initStorage(cb) {
    detectServer(function (ok) {
        serverMode = !!ok;

        if (serverMode) {
            serverGetData(function (serverData) {
                if (serverData && (serverData.outfits || serverData.chars)) {
                    // 后端有数据，直接用
                    dataCache = ensureDefaults(serverData);
                    serverReady = true;
                    cb(dataCache);
                    return;
                }
                // 后端为空：尝试从本地迁移
                loadFromDB(function (localData) {
                    dataCache = ensureDefaults(localData);
                    serverReady = true;
                    var hasLocal = (dataCache.outfits && dataCache.outfits.length > 0) ||
                                   (dataCache.chars && Object.keys(dataCache.chars).length > 0);
                    if (hasLocal) {
                        serverPutData(dataCache);
                        try { console.log('[outfit-manager] 已将本地数据迁移到后端。'); } catch (e) {}
                    }
                    cb(dataCache);
                });
            });
            return;
        }

        // 本地模式
        loadFromDB(function (d) {
            dataCache = d;
            // LS → IndexedDB 迁移
            var lsData = loadFromLS();
            if (lsData && lsData.outfits && lsData.outfits.length > 0 && (!d.outfits || d.outfits.length === 0)) {
                dataCache = ensureDefaults(lsData);
                saveToDB(dataCache, function () { removeLSData(); });
            }
            cb(dataCache);
        });
    });
}
