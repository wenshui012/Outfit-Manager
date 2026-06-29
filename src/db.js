// ── 穿搭管理器 · 存储层 v3 ────────────────────────────────
// 分包存储架构：meta + partition 独立 key
// IndexedDB 本地分包 + Server 后端全量兼容（Phase 1）
// meta: 全局设置/索引/激活追踪
// partition: { outfits, categories, activeIds } 按 user/char 独立存储

import { defMeta, defPartition, ensureMetaDefaults, ensurePartDefaults, migrateCategories, SHARED_CHAR_KEY } from './data.js';

// 8位随机ID生成（用于 charId / presetId）
var ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function genId8() {
    var s = '';
    for (var i = 0; i < 8; i++) s += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
    return s;
}
export { genId8 };

// ── 常量 ─────────────────────────────────────────────────
var DB_NAME = 'outfit_mgr_db';
var DB_VERSION = 1;
var STORE_NAME = 'data';
var LS_KEY = 'outfit_mgr_v4';

// v1 旧 key（迁移用）
var LEGACY_DATA_KEY = 'main';

var SERVER_BASE = '/api/plugins/outfit-manager';
var IMAGE_URL_PREFIX = SERVER_BASE + '/images/';

// ── 内存缓存 ─────────────────────────────────────────────
var dbInstance = null;
var metaCache = null;           // meta 对象
var partCache = {};             // { partKey: partition }
var serverMode = false;
var serverVersion = 1;
var serverSupportsPartitions = false;
var csrfToken = null;

// server PUT 防抖（v1 全量模式）
var serverDirty = false;
var serverDebounceTimer = null;
var serverPutInFlight = false;
var SERVER_DEBOUNCE_MS = 1000;

// server PUT 防抖（v2 分包模式）
var dirtyPartKeys = {};         // { partKey: true }
var partFlushTimer = null;
var partFlushInFlight = false;
var deletedPartKeys = {};       // tombstone：已删除的 key，防止 in-flight PUT 复活

// ══════════════════════════════════════════════════════════
//  IndexedDB 底层
// ══════════════════════════════════════════════════════════

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

// 通用：读单个 key
function idbGet(key, cb) {
    openDB(function (db) {
        if (!db) { cb(null); return; }
        var tx = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function () { cb(req.result !== undefined ? req.result : null); };
        req.onerror = function () { cb(null); };
    });
}

// 通用：写单个 key
function idbPut(key, value, cb) {
    openDB(function (db) {
        if (!db) { if (cb) cb(); return; }
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = function () { if (cb) cb(); };
        tx.onerror = function () { if (cb) cb(); };
    });
}

// 通用：删除单个 key
function idbDelete(key, cb) {
    openDB(function (db) {
        if (!db) { if (cb) cb(); return; }
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = function () { if (cb) cb(); };
        tx.onerror = function () { if (cb) cb(); };
    });
}

// 通用：批量写多个 key（同一事务）
function idbPutBatch(entries, cb) {
    openDB(function (db) {
        if (!db) { if (cb) cb(); return; }
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        entries.forEach(function (e) { store.put(e.value, e.key); });
        tx.oncomplete = function () { if (cb) cb(); };
        tx.onerror = function () { if (cb) cb(); };
    });
}

// 通用：读取所有 key（迁移检测用）
function idbGetAllKeys(cb) {
    openDB(function (db) {
        if (!db) { cb([]); return; }
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        if (store.getAllKeys) {
            var req = store.getAllKeys();
            req.onsuccess = function () { cb(req.result || []); };
            req.onerror = function () { cb([]); };
        } else {
            // fallback for older browsers
            var keys = [];
            var cursor = store.openKeyCursor();
            cursor.onsuccess = function (e) {
                var c = e.target.result;
                if (c) { keys.push(c.key); c.continue(); }
                else cb(keys);
            };
            cursor.onerror = function () { cb(keys); };
        }
    });
}

// ══════════════════════════════════════════════════════════
//  Server 通信
// ══════════════════════════════════════════════════════════

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

function detectServer(cb) {
    fetch(SERVER_BASE + '/status', { method: 'GET', credentials: 'same-origin' })
        .then(function (r) { return (r && r.ok) ? r.json() : null; })
        .then(function (j) {
            if (!j || !j.ok) { cb(false); return; }
            serverVersion = j.version || 1;
            serverSupportsPartitions = serverVersion >= 2 && j.partitions === true;
            cb(true);
        })
        .catch(function () { cb(false); });
}

function serverGetData(cb) {
    fetch(SERVER_BASE + '/data', { method: 'GET', credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { cb((j && j.ok) ? (j.data || null) : null); })
        .catch(function () { cb(null); });
}

// Phase 1: server 仍然是完整 JSON 读写
// 确保所有 partition 都加载完再重组，防止未加载 partition 被空数组覆盖
function serverPutFull() {
    if (serverPutInFlight) { serverDirty = true; return; }
    // 先收集所有需要的 partition key
    var meta = metaCache || defMeta();
    var allKeys = ['user:__default__'];
    (meta.presets || []).forEach(function (pi) { if (allKeys.indexOf(pi.partKey) === -1) allKeys.push(pi.partKey); });
    (meta.charIndex || []).forEach(function (ci) { if (allKeys.indexOf(ci.partKey) === -1) allKeys.push(ci.partKey); });
    // 活跃预设
    var activePK = currentUserPartKey();
    if (allKeys.indexOf(activePK) === -1) allKeys.push(activePK);

    // 找出未加载的 partition
    var missing = allKeys.filter(function (k) { return !partCache[k]; });
    if (missing.length === 0) {
        doServerPut();
        return;
    }
    // 加载缺失的 partition 再 PUT
    var pending = missing.length;
    missing.forEach(function (pk) {
        idbGet(pk, function (raw) {
            if (raw) partCache[pk] = ensurePartDefaults(raw);
            pending--;
            if (pending === 0) doServerPut();
        });
    });
}

function doServerPut() {
    var full = reassembleFullData();
    serverPutInFlight = true;
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/data', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify(full)
        });
    }).then(function (r) {
        if (r && r.status === 403) { csrfToken = null; }
    }).catch(function () {}).then(function () {
        serverPutInFlight = false;
        if (serverDirty) {
            serverDirty = false;
            serverPutFull();
        }
    });
}

function scheduleServerPut() {
    if (!serverMode) return;
    serverDirty = true;
    if (serverDebounceTimer) clearTimeout(serverDebounceTimer);
    serverDebounceTimer = setTimeout(function () {
        serverDebounceTimer = null;
        if (serverDirty) {
            serverDirty = false;
            serverPutFull();
        }
    }, SERVER_DEBOUNCE_MS);
}

// ── v2 分包模式 server 通信 ─────────────────────────────

// 统一调度：根据后端版本选择全量或分包
function scheduleServerPutKey(key) {
    if (!serverMode) return;
    if (!serverSupportsPartitions) {
        scheduleServerPut(); // v1 后端走全量
        return;
    }
    dirtyPartKeys[key] = true;
    if (partFlushTimer) clearTimeout(partFlushTimer);
    partFlushTimer = setTimeout(function () {
        partFlushTimer = null;
        flushDirtyPartitions();
    }, SERVER_DEBOUNCE_MS);
}

// 批量 flush 所有 dirty key
function flushDirtyPartitions() {
    if (partFlushInFlight) return;
    var keys = Object.keys(dirtyPartKeys);
    if (keys.length === 0) return;
    dirtyPartKeys = {};
    partFlushInFlight = true;

    var pending = keys.length;
    function done() {
        pending--;
        if (pending <= 0) {
            partFlushInFlight = false;
            // 如果 flush 期间又有新 dirty key，再调度一轮
            if (Object.keys(dirtyPartKeys).length > 0) {
                flushDirtyPartitions();
            }
        }
    }
    keys.forEach(function (key) {
        // 跳过已被删除的 key（tombstone 防复活）
        if (deletedPartKeys[key]) { done(); return; }
        var data = (key === 'meta') ? metaCache : partCache[key];
        if (!data) { done(); return; }
        serverPutPartition(key, data, done);
    });
}

// PUT 单个 partition 到 v2 后端
function serverPutPartition(key, data, cb) {
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/partitions/' + encodeURIComponent(key), {
            method: 'PUT',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify(data)
        });
    }).then(function (r) {
        if (r && r.status === 403) { csrfToken = null; }
    }).catch(function () {}).then(function () {
        // PUT 完成后检查：如果此 key 在 PUT 期间被删除了，补发 DELETE
        if (deletedPartKeys[key]) {
            sendDeletePartition(key);
        }
        if (cb) cb();
    });
}

// DELETE 单个 partition（立即发送，不防抖）
function serverDeletePartition(key) {
    if (!serverMode || !serverSupportsPartitions) return;
    // 标记 tombstone，防止 in-flight PUT 复活此 key
    deletedPartKeys[key] = true;
    // 从 dirty 队列移除（已删的不需要再 PUT）
    delete dirtyPartKeys[key];
    sendDeletePartition(key);
}

// 底层 DELETE 发送（serverDeletePartition 和 PUT 后补删都调用这里）
function sendDeletePartition(key) {
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/partitions/' + encodeURIComponent(key), {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: headers
        });
    }).then(function (r) {
        if (r && r.status === 403) { csrfToken = null; }
    }).catch(function () {});
}

// GET 单个 partition（v2 启动加载用）
function serverGetPartition(key, cb) {
    fetch(SERVER_BASE + '/partitions/' + encodeURIComponent(key), {
        method: 'GET',
        credentials: 'same-origin'
    })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { cb((j && j.ok) ? (j.data || null) : null); })
    .catch(function () { cb(null); });
}

// GET /partitions/keys（v2 启动用）
function serverGetPartitionKeys(cb) {
    fetch(SERVER_BASE + '/partitions/keys', {
        method: 'GET',
        credentials: 'same-origin'
    })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { cb((j && j.ok) ? (j.keys || []) : []); })
    .catch(function () { cb([]); });
}

// 从内存重组 v1 格式的完整数据（server 兼容用）
function reassembleFullData() {
    var meta = metaCache || defMeta();
    var d = {};

    // 设置字段
    var settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'tagOrder',
        'currentView', 'currentChar'
    ];
    settingsKeys.forEach(function (k) { if (meta[k] !== undefined) d[k] = meta[k]; });

    // currentChar: 还原为角色名
    if (meta.currentChar && meta.charIndex) {
        var found = null;
        for (var i = 0; i < meta.charIndex.length; i++) {
            if (meta.charIndex[i].id === meta.currentChar) { found = meta.charIndex[i].name; break; }
        }
        d.currentChar = found || '';
    }

    // User 默认预设
    var activePartKey = currentUserPartKey();
    var userPart = partCache[activePartKey] || defPartition();
    d.outfits = userPart.outfits || [];
    d.categories = userPart.categories || [];
    d.activeIds = userPart.activeIds || [];
    d.accessories = userPart.accessories || [];
    d.accCategories = userPart.accCategories || [];

    // 预设：重组为旧格式（presets 数组内嵌 outfits）
    d.presets = [];
    d.activePresetId = meta.activePresetId || null;
    (meta.presets || []).forEach(function (pi) {
        var pp = partCache[pi.partKey] || null;
        if (pp) {
            d.presets.push({
                id: pi.id,
                name: pi.name,
                outfits: pp.outfits || [],
                categories: pp.categories || [],
                activeIds: pp.activeIds || [],
                accessories: pp.accessories || [],
                accCategories: pp.accCategories || []
            });
        } else {
            // partition 未加载时写索引占位
            d.presets.push({ id: pi.id, name: pi.name, outfits: [], categories: [], activeIds: [], accessories: [], accCategories: [] });
        }
    });

    // Char 数据
    d.chars = {};
    d.charNames = [];
    d.charFavorites = [];
    d.charGroups = {};

    if (meta.charIndex) {
        meta.charIndex.forEach(function (ci) {
            var name = ci.name;
            var partKey = ci.partKey;
            if (ci.id === SHARED_CHAR_KEY) {
                // 通用衣柜
                var sp = partCache[partKey] || defPartition();
                d.chars[SHARED_CHAR_KEY] = { outfits: sp.outfits || [], categories: sp.categories || [], activeIds: sp.activeIds || [], accessories: sp.accessories || [], accCategories: sp.accCategories || [] };
            } else {
                d.charNames.push(name);
                var cp = partCache[partKey] || defPartition();
                d.chars[name] = { outfits: cp.outfits || [], categories: cp.categories || [], activeIds: cp.activeIds || [], accessories: cp.accessories || [], accCategories: cp.accCategories || [] };
            }
        });
    }

    // charFavorites: id → name
    if (meta.charFavorites && meta.charIndex) {
        meta.charFavorites.forEach(function (cid) {
            for (var j = 0; j < meta.charIndex.length; j++) {
                if (meta.charIndex[j].id === cid) { d.charFavorites.push(meta.charIndex[j].name); break; }
            }
        });
    }

    // charGroups: id → name
    if (meta.charGroups && meta.charIndex) {
        for (var gn in meta.charGroups) {
            d.charGroups[gn] = [];
            (meta.charGroups[gn] || []).forEach(function (cid) {
                for (var j = 0; j < meta.charIndex.length; j++) {
                    if (meta.charIndex[j].id === cid) { d.charGroups[gn].push(meta.charIndex[j].name); break; }
                }
            });
        }
    }

    return d;
}

// ══════════════════════════════════════════════════════════
//  Meta 读写
// ══════════════════════════════════════════════════════════

export function loadMeta() {
    if (!metaCache) metaCache = defMeta();
    return metaCache;
}

export function saveMeta(meta) {
    metaCache = meta;
    idbPut('meta', meta);
    scheduleServerPutKey('meta');
}

// ══════════════════════════════════════════════════════════
//  Partition 读写
// ══════════════════════════════════════════════════════════

// 同步读（从缓存，必须已 ensure 过）
export function loadPartition(partKey) {
    if (!partCache[partKey]) partCache[partKey] = defPartition();
    return partCache[partKey];
}

// 写 partition（本地 IDB + server 防抖）
export function savePartition(partKey, data) {
    partCache[partKey] = data;
    idbPut(partKey, data);
    scheduleServerPutKey(partKey);
}

// 异步确保 partition 在缓存里（切视角时用）
export function ensurePartition(partKey, cb) {
    if (partCache[partKey]) { if (cb) cb(partCache[partKey]); return; }
    idbGet(partKey, function (raw) {
        partCache[partKey] = ensurePartDefaults(raw);
        if (cb) cb(partCache[partKey]);
    });
}

// 删除 partition（角色删除时用）
export function deletePartition(partKey) {
    delete partCache[partKey];
    idbDelete(partKey);
    serverDeletePartition(partKey);
}

// ══════════════════════════════════════════════════════════
//  便捷：当前视角
// ══════════════════════════════════════════════════════════

// 当前 User partition key
export function currentUserPartKey() {
    var meta = loadMeta();
    if (meta.activePresetId) {
        // 找到预设索引
        for (var i = 0; i < (meta.presets || []).length; i++) {
            if (meta.presets[i].id === meta.activePresetId) return meta.presets[i].partKey;
        }
    }
    return 'user:__default__';
}

// 当前视角的 partition key
export function currentPartKey() {
    var meta = loadMeta();
    if (meta.currentView === 'char' && meta.currentChar) {
        // currentChar 存的是 charId
        var charId = meta.currentChar;
        if (charId === SHARED_CHAR_KEY) return 'char:__shared__';
        return 'char:' + charId;
    }
    return currentUserPartKey();
}

// 当前视角的 partition（同步读）
export function loadCurrent() {
    return loadPartition(currentPartKey());
}

// 保存当前视角的 partition
export function saveCurrent(data) {
    savePartition(currentPartKey(), data);
}

// ══════════════════════════════════════════════════════════
//  activePartitions 管理
// ══════════════════════════════════════════════════════════

// 更新 meta.activePartitions（选择/取消穿搭时调用）
export function syncActivePartitions(partKey, activeIds) {
    var meta = loadMeta();
    if (!meta.activePartitions) meta.activePartitions = {};
    if (activeIds && activeIds.length > 0) {
        meta.activePartitions[partKey] = activeIds.slice();
    } else {
        delete meta.activePartitions[partKey];
    }
    // 如果是 user:* 的 key，清掉其他 user:* 的记录（同一时刻只有一个 User 预设有效）
    if (partKey.indexOf('user:') === 0) {
        cleanUserActivePartitions(meta, partKey);
    }
    saveMeta(meta);
}

// 清掉除 keepKey 之外的所有 user:* activePartitions
// User 同一时刻只能有一个活跃预设/默认衣柜
function cleanUserActivePartitions(meta, keepKey) {
    if (!meta.activePartitions) return;
    var toDelete = [];
    for (var pk in meta.activePartitions) {
        if (pk.indexOf('user:') === 0 && pk !== keepKey) toDelete.push(pk);
    }
    toDelete.forEach(function (pk) { delete meta.activePartitions[pk]; });
}

// 切预设后调用：确保 activePartitions 只保留当前 User partKey
export function syncCurrentUserActivePartition() {
    var meta = loadMeta();
    var curPK = currentUserPartKey();
    var curPart = loadPartition(curPK);
    if (!meta.activePartitions) meta.activePartitions = {};
    // 设置当前
    if (curPart.activeIds && curPart.activeIds.length > 0) {
        meta.activePartitions[curPK] = curPart.activeIds.slice();
    } else {
        delete meta.activePartitions[curPK];
    }
    // 清掉其他 user:*
    cleanUserActivePartitions(meta, curPK);
    saveMeta(meta);
}

// 注入用：返回所有有激活穿搭的 partition（同步，已预加载）
// 对 user:* 只返回当前活跃预设，忽略其他 user:* 残留
export function loadActivePartitions() {
    var meta = loadMeta();
    var result = {};
    var ap = meta.activePartitions || {};
    var curUserPK = currentUserPartKey();
    for (var pk in ap) {
        if (ap[pk].length > 0 && partCache[pk]) {
            // user:* 只保留当前活跃的那个
            if (pk.indexOf('user:') === 0 && pk !== curUserPK) continue;
            result[pk] = partCache[pk];
        }
    }
    return result;
}

// ══════════════════════════════════════════════════════════
//  charIndex 辅助
// ══════════════════════════════════════════════════════════

export function charNameById(charId) {
    var meta = loadMeta();
    if (charId === SHARED_CHAR_KEY) return SHARED_CHAR_KEY;
    for (var i = 0; i < (meta.charIndex || []).length; i++) {
        if (meta.charIndex[i].id === charId) return meta.charIndex[i].name;
    }
    return '';
}

export function charIdByName(name) {
    var meta = loadMeta();
    for (var i = 0; i < (meta.charIndex || []).length; i++) {
        if (meta.charIndex[i].name === name) return meta.charIndex[i].id;
    }
    return '';
}

export function charPartKey(charId) {
    if (charId === SHARED_CHAR_KEY) return 'char:__shared__';
    return 'char:' + charId;
}

// ══════════════════════════════════════════════════════════
//  图片相关（保留原接口不变）
// ══════════════════════════════════════════════════════════

export function isServerMode() { return serverMode; }
export function getImageUrlPrefix() { return IMAGE_URL_PREFIX; }

export function resolveImageForExternal(imageData, cb) {
    if (!imageData || typeof imageData !== 'string') { cb(imageData); return; }
    if (imageData.indexOf('data:image/') === 0) { cb(imageData); return; }
    if (imageData.indexOf(IMAGE_URL_PREFIX) !== 0) { cb(imageData); return; }
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/images/batch-fetch', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ urls: [imageData] })
        });
    }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
        if (j && j.ok && j.images && j.images[imageData]) cb(j.images[imageData]);
        else cb(imageData);
    }).catch(function () { cb(imageData); });
}

export function batchResolveImages(urls, cb) {
    if (!urls || urls.length === 0) { cb({}); return; }
    var needFetch = [];
    var results = {};
    urls.forEach(function (url) {
        if (!url || typeof url !== 'string') return;
        if (url.indexOf('data:image/') === 0) { results[url] = url; }
        else if (url.indexOf(IMAGE_URL_PREFIX) === 0) { needFetch.push(url); }
        else { results[url] = url; }
    });
    if (needFetch.length === 0) { cb(results); return; }
    var unique = []; var seen = {};
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
        if (j && j.ok && j.images) { for (var url in j.images) { results[url] = j.images[url]; } }
        needFetch.forEach(function (u) { if (!results[u]) results[u] = u; });
        cb(results);
    }).catch(function () {
        needFetch.forEach(function (u) { if (!results[u]) results[u] = u; });
        cb(results);
    });
}

export function uploadImage(dataUrl, cb) {
    if (!serverMode) { cb(null, dataUrl); return; }
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/images', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ dataUrl: dataUrl })
        });
    }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
        if (j && j.ok && j.url) cb(null, j.url);
        else cb(null, dataUrl);
    }).catch(function () { cb(null, dataUrl); });
}

// ══════════════════════════════════════════════════════════
//  v1 → v2 数据迁移
// ══════════════════════════════════════════════════════════

// v17 兼容（从旧版 data.js 移过来，迁移时一次性执行）
function migrateV17(d) {
    if (!d || !d.outfits) return;
    var userOutfits = [];
    var moved = {};
    d.outfits.forEach(function (o) {
        if (o.owner && o.owner !== 'user') {
            var cn = o.owner;
            if (!moved[cn]) moved[cn] = [];
            delete o.owner;
            moved[cn].push(o);
        } else {
            delete o.owner;
            userOutfits.push(o);
        }
    });
    d.outfits = userOutfits;
    if (!d.chars) d.chars = {};
    if (!d.charNames) d.charNames = [];
    for (var cn in moved) {
        if (!d.chars[cn]) d.chars[cn] = { outfits: [], categories: [], activeIds: [] };
        d.chars[cn].outfits = d.chars[cn].outfits.concat(moved[cn]);
        if (d.charNames.indexOf(cn) === -1) d.charNames.push(cn);
    }
    if (d.charActiveIds) {
        for (var cn2 in d.charActiveIds) {
            if (!d.chars[cn2]) d.chars[cn2] = { outfits: [], categories: [], activeIds: [] };
            d.chars[cn2].activeIds = d.charActiveIds[cn2];
        }
        delete d.charActiveIds;
    }
}

function migrateFromV1(oldData, cb) {
    // 先跑 v17 迁移确保 chars 结构正确
    migrateV17(oldData);

    var meta = defMeta();
    var entries = []; // { key, value } 批量写入

    // ── 提取设置到 meta ──
    var settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'tagOrder',
        'currentView'
    ];
    settingsKeys.forEach(function (k) {
        if (oldData[k] !== undefined) meta[k] = oldData[k];
    });

    // ── apiVision 规范化 ──
    if (meta.apiVision) {
        var dv = defMeta().apiVision;
        for (var vk in dv) { if (meta.apiVision[vk] === undefined) meta.apiVision[vk] = dv[vk]; }
        if (meta.apiVision.batchSize && !meta.apiVision.concurrency) {
            meta.apiVision.concurrency = Math.min(meta.apiVision.batchSize, 5);
        }
        delete meta.apiVision.batchSize;
    }

    // ── User 默认预设 ──
    var userDefault = {
        outfits: oldData.outfits || [],
        categories: migrateCategories(oldData.categories || []),
        activeIds: Array.isArray(oldData.activeIds) ? oldData.activeIds : (oldData.activeId ? [oldData.activeId] : []),
        accessories: oldData.accessories || [],
        accCategories: migrateCategories(oldData.accCategories || [])
    };
    entries.push({ key: 'user:__default__', value: userDefault });
    partCache['user:__default__'] = userDefault;

    // ── User 预设 ──
    meta.presets = [];
    meta.activePresetId = oldData.activePresetId || null;
    if (Array.isArray(oldData.presets)) {
        oldData.presets.forEach(function (p) {
            if (!p) return;
            var pid = p.id || ('p_' + genId8());
            var partKey = 'user:' + pid;
            meta.presets.push({ id: pid, name: p.name || '未命名', partKey: partKey });
            var pPart = {
                outfits: p.outfits || [],
                categories: migrateCategories(p.categories || []),
                activeIds: p.activeIds || [],
                accessories: p.accessories || [],
                accCategories: migrateCategories(p.accCategories || [])
            };
            entries.push({ key: partKey, value: pPart });
            partCache[partKey] = pPart;
        });
    }

    // User 激活：旧版的顶层 outfits/categories/activeIds 是当前实际使用的数据
    // 如果有 activePresetId，说明这些顶层数据其实是该预设的当前工作状态
    // 所以要把顶层数据写入该预设的 partition（覆盖预设快照），而不是 __default__
    var activeUserPK = 'user:__default__';
    if (meta.activePresetId) {
        for (var pi2 = 0; pi2 < meta.presets.length; pi2++) {
            if (meta.presets[pi2].id === meta.activePresetId) {
                activeUserPK = meta.presets[pi2].partKey;
                // 用当前顶层数据覆盖预设 partition（顶层才是最新状态）
                var activePPart = {
                    outfits: userDefault.outfits,
                    categories: userDefault.categories,
                    activeIds: userDefault.activeIds,
                    accessories: userDefault.accessories,
                    accCategories: userDefault.accCategories
                };
                // 更新 entries 和 partCache 里对应的 partition
                for (var ei = 0; ei < entries.length; ei++) {
                    if (entries[ei].key === activeUserPK) {
                        entries[ei].value = activePPart;
                        break;
                    }
                }
                partCache[activeUserPK] = activePPart;
                break;
            }
        }
    }
    if (userDefault.activeIds.length > 0) {
        meta.activePartitions[activeUserPK] = userDefault.activeIds.slice();
    }

    // ── 角色 ──
    meta.charIndex = [];
    var charFavNames = oldData.charFavorites || [];
    var charGroupsOld = oldData.charGroups || {};
    meta.charFavorites = [];
    meta.charGroups = {};

    // 通用衣柜
    if (oldData.chars && oldData.chars[SHARED_CHAR_KEY]) {
        var scd = oldData.chars[SHARED_CHAR_KEY];
        var sharedPart = {
            outfits: scd.outfits || [],
            categories: migrateCategories(scd.categories || []),
            activeIds: scd.activeIds || [],
            accessories: scd.accessories || [],
            accCategories: migrateCategories(scd.accCategories || [])
        };
        meta.charIndex.push({ id: SHARED_CHAR_KEY, name: SHARED_CHAR_KEY, partKey: 'char:__shared__' });
        entries.push({ key: 'char:__shared__', value: sharedPart });
        partCache['char:__shared__'] = sharedPart;
        if (sharedPart.activeIds.length > 0) {
            meta.activePartitions['char:__shared__'] = sharedPart.activeIds.slice();
        }
    }

    // 普通角色
    var charNames = oldData.charNames || [];
    // 也收集 chars 里有但 charNames 没列出的
    if (oldData.chars) {
        for (var cn in oldData.chars) {
            if (cn !== SHARED_CHAR_KEY && charNames.indexOf(cn) === -1) {
                charNames.push(cn);
            }
        }
    }

    // name → id 映射（迁移用）
    var nameToId = {};
    charNames.forEach(function (name) {
        var cid = 'c_' + genId8();
        // 防碰撞
        while (nameToId[cid]) { cid = 'c_' + genId8(); }
        nameToId[name] = cid;
        var partKey = 'char:' + cid;
        var cd = (oldData.chars && oldData.chars[name]) ? oldData.chars[name] : { outfits: [], categories: [], activeIds: [] };
        var charPart = {
            outfits: cd.outfits || [],
            categories: migrateCategories(cd.categories || []),
            activeIds: cd.activeIds || [],
            accessories: cd.accessories || [],
            accCategories: migrateCategories(cd.accCategories || [])
        };
        meta.charIndex.push({ id: cid, name: name, partKey: partKey });
        entries.push({ key: partKey, value: charPart });
        partCache[partKey] = charPart;
        if (charPart.activeIds.length > 0) {
            meta.activePartitions[partKey] = charPart.activeIds.slice();
        }
    });

    // 迁移 charFavorites: name → id
    charFavNames.forEach(function (name) {
        if (nameToId[name]) meta.charFavorites.push(nameToId[name]);
    });

    // 迁移 charGroups: name → id
    for (var gn in charGroupsOld) {
        meta.charGroups[gn] = [];
        (charGroupsOld[gn] || []).forEach(function (name) {
            if (nameToId[name]) meta.charGroups[gn].push(nameToId[name]);
        });
    }

    // currentChar: name → id
    if (oldData.currentChar) {
        if (oldData.currentChar === SHARED_CHAR_KEY) {
            meta.currentChar = SHARED_CHAR_KEY;
        } else {
            meta.currentChar = nameToId[oldData.currentChar] || '';
        }
    }

    // ── 写入所有 partitions + meta + 备份旧 key ──
    entries.push({ key: 'meta', value: meta });
    // 备份旧数据
    entries.push({ key: 'backup:main:v1:' + Date.now(), value: oldData });

    metaCache = meta;

    idbPutBatch(entries, function () {
        // 删除旧 key
        idbDelete(LEGACY_DATA_KEY, function () {
            try { console.log('[outfit-manager] v1→v2 迁移完成，已创建 ' + entries.length + ' 个分包 key'); } catch (e) {}
            cb();
        });
    });
}

// ══════════════════════════════════════════════════════════
//  Server 数据 → 分包拆解（server 模式启动用）
// ══════════════════════════════════════════════════════════

function splitServerDataToPartitions(serverData, cb) {
    // 和 migrateFromV1 基本一样，但不备份
    migrateV17(serverData);

    var meta = defMeta();
    var entries = [];

    var settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'tagOrder',
        'currentView'
    ];
    settingsKeys.forEach(function (k) {
        if (serverData[k] !== undefined) meta[k] = serverData[k];
    });

    if (meta.apiVision) {
        var dv = defMeta().apiVision;
        for (var vk in dv) { if (meta.apiVision[vk] === undefined) meta.apiVision[vk] = dv[vk]; }
        if (meta.apiVision.batchSize) { delete meta.apiVision.batchSize; }
    }

    // User
    var userDefault = {
        outfits: serverData.outfits || [],
        categories: migrateCategories(serverData.categories || []),
        activeIds: Array.isArray(serverData.activeIds) ? serverData.activeIds : [],
        accessories: serverData.accessories || [],
        accCategories: migrateCategories(serverData.accCategories || [])
    };
    entries.push({ key: 'user:__default__', value: userDefault });
    partCache['user:__default__'] = userDefault;

    // 预设
    meta.presets = [];
    meta.activePresetId = serverData.activePresetId || null;
    if (Array.isArray(serverData.presets)) {
        serverData.presets.forEach(function (p) {
            if (!p) return;
            var pid = p.id || ('p_' + genId8());
            var partKey = 'user:' + pid;
            meta.presets.push({ id: pid, name: p.name || '未命名', partKey: partKey });
            var pPart = {
                outfits: p.outfits || [],
                categories: migrateCategories(p.categories || []),
                activeIds: p.activeIds || [],
                accessories: p.accessories || [],
                accCategories: migrateCategories(p.accCategories || [])
            };
            entries.push({ key: partKey, value: pPart });
            partCache[partKey] = pPart;
        });
    }

    // User 激活：同 migrateFromV1 逻辑
    var activeUserPK = 'user:__default__';
    if (meta.activePresetId) {
        for (var pi2 = 0; pi2 < meta.presets.length; pi2++) {
            if (meta.presets[pi2].id === meta.activePresetId) {
                activeUserPK = meta.presets[pi2].partKey;
                var activePPart = {
                    outfits: userDefault.outfits,
                    categories: userDefault.categories,
                    activeIds: userDefault.activeIds,
                    accessories: userDefault.accessories,
                    accCategories: userDefault.accCategories
                };
                for (var ei = 0; ei < entries.length; ei++) {
                    if (entries[ei].key === activeUserPK) {
                        entries[ei].value = activePPart;
                        break;
                    }
                }
                partCache[activeUserPK] = activePPart;
                break;
            }
        }
    }
    if (userDefault.activeIds.length > 0) {
        meta.activePartitions[activeUserPK] = userDefault.activeIds.slice();
    }

    // 角色
    meta.charIndex = [];
    meta.charFavorites = [];
    meta.charGroups = {};
    var nameToId = {};
    var charNames = serverData.charNames || [];
    if (serverData.chars) {
        for (var cn in serverData.chars) {
            if (cn !== SHARED_CHAR_KEY && charNames.indexOf(cn) === -1) charNames.push(cn);
        }
    }

    // 通用衣柜
    if (serverData.chars && serverData.chars[SHARED_CHAR_KEY]) {
        var scd = serverData.chars[SHARED_CHAR_KEY];
        var sharedPart = {
            outfits: scd.outfits || [],
            categories: migrateCategories(scd.categories || []),
            activeIds: scd.activeIds || [],
            accessories: scd.accessories || [],
            accCategories: migrateCategories(scd.accCategories || [])
        };
        meta.charIndex.push({ id: SHARED_CHAR_KEY, name: SHARED_CHAR_KEY, partKey: 'char:__shared__' });
        entries.push({ key: 'char:__shared__', value: sharedPart });
        partCache['char:__shared__'] = sharedPart;
        if (sharedPart.activeIds.length > 0) meta.activePartitions['char:__shared__'] = sharedPart.activeIds.slice();
    }

    charNames.forEach(function (name) {
        var cid = 'c_' + genId8();
        nameToId[name] = cid;
        var partKey = 'char:' + cid;
        var cd = (serverData.chars && serverData.chars[name]) || { outfits: [], categories: [], activeIds: [] };
        var charPart = {
            outfits: cd.outfits || [],
            categories: migrateCategories(cd.categories || []),
            activeIds: cd.activeIds || [],
            accessories: cd.accessories || [],
            accCategories: migrateCategories(cd.accCategories || [])
        };
        meta.charIndex.push({ id: cid, name: name, partKey: partKey });
        entries.push({ key: partKey, value: charPart });
        partCache[partKey] = charPart;
        if (charPart.activeIds.length > 0) meta.activePartitions[partKey] = charPart.activeIds.slice();
    });

    // favorites / groups
    (serverData.charFavorites || []).forEach(function (name) {
        if (nameToId[name]) meta.charFavorites.push(nameToId[name]);
    });
    for (var gn in (serverData.charGroups || {})) {
        meta.charGroups[gn] = [];
        (serverData.charGroups[gn] || []).forEach(function (name) {
            if (nameToId[name]) meta.charGroups[gn].push(nameToId[name]);
        });
    }

    if (serverData.currentChar) {
        if (serverData.currentChar === SHARED_CHAR_KEY) meta.currentChar = SHARED_CHAR_KEY;
        else meta.currentChar = nameToId[serverData.currentChar] || '';
    }

    entries.push({ key: 'meta', value: meta });
    metaCache = meta;

    idbPutBatch(entries, function () {
        if (cb) cb();
    });
}

// ══════════════════════════════════════════════════════════
//  预加载所有 partition（兼容期必须全部加载）
// ══════════════════════════════════════════════════════════
// 兼容期间旧 UI 通过 load() 拿到所有 chars 的浅引用，
// save(d) 会遍历 d.chars 写回各 partition。
// 如果某个 partition 没加载，load() 会给空数组，
// save(d) 就会把空数组写回去 → 数据丢失。
// 所以兼容期启动时必须加载所有 partition，不能只加载 active/current。
// 等所有 UI 模块改用新 API 后，可以改回 preloadActivePartitions。

function preloadAllPartitions(cb) {
    var meta = loadMeta();
    var keys = [];

    // user:__default__
    if (keys.indexOf('user:__default__') === -1) keys.push('user:__default__');

    // 当前活跃 User 预设
    var curUPK = currentUserPartKey();
    if (keys.indexOf(curUPK) === -1) keys.push(curUPK);

    // 所有 User 预设
    (meta.presets || []).forEach(function (pi) {
        if (keys.indexOf(pi.partKey) === -1) keys.push(pi.partKey);
    });

    // 所有角色
    (meta.charIndex || []).forEach(function (ci) {
        if (keys.indexOf(ci.partKey) === -1) keys.push(ci.partKey);
    });

    // activePartitions 里可能有的
    var ap = meta.activePartitions || {};
    for (var pk in ap) {
        if (keys.indexOf(pk) === -1) keys.push(pk);
    }

    var pending = keys.length;
    if (pending === 0) { cb(); return; }

    keys.forEach(function (pk) {
        if (partCache[pk]) { pending--; if (pending === 0) cb(); return; }
        idbGet(pk, function (raw) {
            partCache[pk] = ensurePartDefaults(raw);
            pending--;
            if (pending === 0) cb();
        });
    });
}

// ══════════════════════════════════════════════════════════
//  启动初始化
// ══════════════════════════════════════════════════════════

function loadFromLS() {
    try { var r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; }
}
function removeLSData() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }

function hasRealOutfitData(d) {
    if (!d || typeof d !== 'object') return false;
    if (Array.isArray(d.outfits) && d.outfits.length > 0) return true;
    if (d.chars && typeof d.chars === 'object') {
        for (var cn in d.chars) {
            var cd = d.chars[cn];
            if (cd && Array.isArray(cd.outfits) && cd.outfits.length > 0) return true;
        }
    }
    if (Array.isArray(d.presets)) {
        for (var i = 0; i < d.presets.length; i++) {
            var p = d.presets[i];
            if (p && Array.isArray(p.outfits) && p.outfits.length > 0) return true;
        }
    }
    return false;
}

export function initStorage(cb) {
    detectServer(function (ok) {
        serverMode = !!ok;

        if (serverMode && serverSupportsPartitions) {
            // v2 后端：逐个 partition 加载
            initFromServerV2(function () { cb(); });
            return;
        }

        if (serverMode) {
            // v1 后端：从后端拉取完整数据 → 拆成 meta + partitions 缓存到本地
            serverGetData(function (serverData) {
                if (hasRealOutfitData(serverData)) {
                    splitServerDataToPartitions(serverData, function () {
                        preloadAllPartitions(function () { cb(); });
                    });
                    return;
                }
                // 后端无数据：检查本地
                initLocal(function () {
                    // 如果本地有数据，上传到后端
                    if (Object.keys(partCache).length > 0) {
                        scheduleServerPut();
                        try { console.log('[outfit-manager] 已将本地数据迁移到后端。'); } catch (e) {}
                    }
                    cb();
                });
            });
            return;
        }

        // 本地模式
        initLocal(function () { cb(); });
    });
}

// v2 后端启动：GET /partitions/keys → 逐个 GET /partitions/:key
function initFromServerV2(cb) {
    serverGetPartitionKeys(function (keys) {
        if (!keys || keys.length === 0) {
            // v2 后端无数据：检查本地，有则上传
            initLocal(function () {
                if (Object.keys(partCache).length > 0) {
                    // 本地有数据，逐个推到 v2 后端
                    uploadLocalToServerV2(function () {
                        try { console.log('[outfit-manager] 已将本地数据迁移到 v2 后端。'); } catch (e) {}
                        cb();
                    });
                } else {
                    cb();
                }
            });
            return;
        }

        // 有 key，逐个拉取
        var pending = keys.length;
        var entries = []; // { key, value } 批量写 IDB
        keys.forEach(function (key) {
            serverGetPartition(key, function (data) {
                if (key === 'meta') {
                    metaCache = ensureMetaDefaults(data);
                    entries.push({ key: 'meta', value: metaCache });
                } else {
                    partCache[key] = ensurePartDefaults(data);
                    entries.push({ key: key, value: partCache[key] });
                }
                pending--;
                if (pending === 0) {
                    // 批量写入 IDB 作本地缓存
                    idbPutBatch(entries, function () {
                        // 兼容期：确保所有 partition 都已加载
                        preloadAllPartitions(function () { cb(); });
                    });
                }
            });
        });
    });
}

// 本地数据上传到 v2 后端（本地→server 迁移）
function uploadLocalToServerV2(cb) {
    var keys = ['meta'];
    var meta = metaCache || defMeta();

    // 收集所有 partition key
    if (keys.indexOf('user:__default__') === -1) keys.push('user:__default__');
    var curUPK = currentUserPartKey();
    if (keys.indexOf(curUPK) === -1) keys.push(curUPK);
    (meta.presets || []).forEach(function (pi) {
        if (keys.indexOf(pi.partKey) === -1) keys.push(pi.partKey);
    });
    (meta.charIndex || []).forEach(function (ci) {
        if (keys.indexOf(ci.partKey) === -1) keys.push(ci.partKey);
    });

    var pending = keys.length;
    if (pending === 0) { cb(); return; }
    keys.forEach(function (key) {
        var data = (key === 'meta') ? metaCache : partCache[key];
        if (!data) { pending--; if (pending === 0) cb(); return; }
        serverPutPartition(key, data, function () {
            pending--;
            if (pending === 0) cb();
        });
    });
}

function initLocal(cb) {
    // 检查是否已有 v2 meta
    idbGet('meta', function (existingMeta) {
        if (existingMeta && existingMeta._version >= 2) {
            // 已是 v2 分包格式
            metaCache = ensureMetaDefaults(existingMeta);
            preloadAllPartitions(function () { cb(); });
            return;
        }

        // 检查旧 v1 key
        idbGet(LEGACY_DATA_KEY, function (oldData) {
            if (oldData && hasRealOutfitData(oldData)) {
                // v1 → v2 迁移
                migrateFromV1(oldData, function () {
                    preloadAllPartitions(function () { cb(); });
                });
                return;
            }

            // 检查 localStorage（极旧版本）
            var lsData = loadFromLS();
            if (lsData && hasRealOutfitData(lsData)) {
                migrateFromV1(lsData, function () {
                    removeLSData();
                    preloadAllPartitions(function () { cb(); });
                });
                return;
            }

            // 全新安装：创建空 meta + 空默认 partition
            metaCache = defMeta();
            partCache['user:__default__'] = defPartition();
            idbPutBatch([
                { key: 'meta', value: metaCache },
                { key: 'user:__default__', value: partCache['user:__default__'] }
            ], function () { cb(); });
        });
    });
}

// ══════════════════════════════════════════════════════════
//  兼容旧接口（过渡期，逐步废弃）
//  旧 UI 模块大量使用 d.chars / d.charNames / d.charFavorites /
//  d.charGroups / d.presets / d.currentChar（角色名），
//  必须在 load() 里完整组装这些字段，在 save() 里把修改反写回
//  meta + partitions，包括角色名 ↔ charId 的双向翻译。
// ══════════════════════════════════════════════════════════

// charId ↔ name 翻译辅助（仅兼容层内部使用）
function _nameToIdMap() {
    var meta = loadMeta();
    var map = {};
    (meta.charIndex || []).forEach(function (ci) { if (ci.id !== SHARED_CHAR_KEY) map[ci.name] = ci.id; });
    return map;
}
function _idToNameMap() {
    var meta = loadMeta();
    var map = {};
    (meta.charIndex || []).forEach(function (ci) { if (ci.id !== SHARED_CHAR_KEY) map[ci.id] = ci.name; });
    return map;
}

// load() — 旧代码的读取入口（deprecated，适配完成后删除）
// 返回完整旧格式对象，chars 按角色名索引，currentChar 是角色名
export function load() {
    var meta = loadMeta();
    var part = loadCurrent();

    var d = {};
    // meta 设置字段
    var metaKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'tagOrder',
        'currentView', 'activePresetId'
    ];
    metaKeys.forEach(function (k) { d[k] = meta[k]; });

    // currentChar: charId → 角色名（旧 UI 使用角色名）
    if (meta.currentChar === SHARED_CHAR_KEY) {
        d.currentChar = SHARED_CHAR_KEY;
    } else if (meta.currentChar) {
        d.currentChar = charNameById(meta.currentChar) || '';
    } else {
        d.currentChar = '';
    }

    // 当前视角 partition
    d.outfits = part.outfits;
    d.categories = part.categories;
    d.activeIds = part.activeIds;
    d.accessories = part.accessories;
    d.accCategories = part.accCategories;

    // 组装 chars：{ 角色名: { outfits, categories, activeIds, accessories, accCategories } }
    d.chars = {};
    d.charNames = [];
    (meta.charIndex || []).forEach(function (ci) {
        var cp = partCache[ci.partKey] || defPartition();
        if (ci.id === SHARED_CHAR_KEY) {
            d.chars[SHARED_CHAR_KEY] = { outfits: cp.outfits, categories: cp.categories, activeIds: cp.activeIds, accessories: cp.accessories, accCategories: cp.accCategories };
        } else {
            d.charNames.push(ci.name);
            d.chars[ci.name] = { outfits: cp.outfits, categories: cp.categories, activeIds: cp.activeIds, accessories: cp.accessories, accCategories: cp.accCategories };
        }
    });

    // charFavorites: charId[] → name[]
    d.charFavorites = [];
    var idToName = _idToNameMap();
    (meta.charFavorites || []).forEach(function (cid) {
        if (idToName[cid]) d.charFavorites.push(idToName[cid]);
    });

    // charGroups: { groupName: charId[] } → { groupName: name[] }
    d.charGroups = {};
    for (var gn in (meta.charGroups || {})) {
        d.charGroups[gn] = [];
        (meta.charGroups[gn] || []).forEach(function (cid) {
            if (idToName[cid]) d.charGroups[gn].push(idToName[cid]);
        });
    }

    // presets（旧格式包含内嵌 outfits，但兼容层只做索引展示）
    d.presets = [];
    (meta.presets || []).forEach(function (pi) {
        var pp = partCache[pi.partKey] || null;
        d.presets.push({
            id: pi.id,
            name: pi.name,
            outfits: pp ? pp.outfits : [],
            categories: pp ? pp.categories : [],
            activeIds: pp ? pp.activeIds : [],
            accessories: pp ? pp.accessories : [],
            accCategories: pp ? pp.accCategories : []
        });
    });

    return d;
}

// save(d) — 旧代码的保存入口（deprecated，适配完成后删除）
// 把旧格式对象拆回 meta + partitions
// 处理：角色增删改名、currentChar 名→id、收藏/分组名→id、
//       chars 数据回写到各 partition、activePartitions 同步
export function save(d) {
    var meta = loadMeta();

    // ── 1. meta 设置字段 ──
    var settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'tagOrder',
        'currentView', 'activePresetId'
    ];
    settingsKeys.forEach(function (k) { if (d[k] !== undefined) meta[k] = d[k]; });

    // ── 2. 当前视角 partition ──
    var part = loadCurrent();
    part.outfits = d.outfits || part.outfits;
    part.categories = d.categories || part.categories;
    part.activeIds = d.activeIds || part.activeIds;
    if (d.accessories) part.accessories = d.accessories;
    if (d.accCategories) part.accCategories = d.accCategories;
    saveCurrent(part);
    syncActivePartitions(currentPartKey(), part.activeIds);

    // ── 3. currentChar: 延迟到 charIndex 重建之后处理 ──
    // （旧 UI 的 d.currentChar 是角色名，可能是刚改过的新名）
    // （必须等第4步 charIndex 更新完才能正确翻译 name → id）
    var pendingCurrentChar = d.currentChar; // 暂存，后面处理

    // ── 4. 角色增删改名同步 ──
    // 对比 d.charNames 和 meta.charIndex 来检测变化
    var dNames = d.charNames || [];
    var oldIndex = meta.charIndex || [];
    var oldNameSet = {};
    oldIndex.forEach(function (ci) { if (ci.id !== SHARED_CHAR_KEY) oldNameSet[ci.name] = ci; });

    var newIndex = [];
    // 保留通用衣柜
    oldIndex.forEach(function (ci) { if (ci.id === SHARED_CHAR_KEY) newIndex.push(ci); });
    if (newIndex.length === 0) {
        var sharedPartKey = 'char:__shared__';
        if (!partCache[sharedPartKey]) savePartition(sharedPartKey, defPartition());
        newIndex.push({ id: SHARED_CHAR_KEY, name: SHARED_CHAR_KEY, partKey: sharedPartKey });
    }

    dNames.forEach(function (name) {
        if (oldNameSet[name]) {
            // 已存在，保留
            newIndex.push(oldNameSet[name]);
            delete oldNameSet[name];
        } else {
            // 新角色：检查是否是改名（旧名消失+新名出现+chars有数据）
            // 改名在旧 UI 里是直接 dd.chars[newName] = dd.chars[oldName]; delete dd.chars[oldName];
            // 然后 dd.charNames[idx] = newName; 所以 oldNameSet 里会剩下旧名
            // 我们检查 d.chars[name] 是否有引用到某个旧 partition 的数据
            var foundRename = null;
            var foundOldName = '';
            for (var oldName in oldNameSet) {
                var oldCi = oldNameSet[oldName];
                var oldPart = partCache[oldCi.partKey];
                if (oldPart && d.chars && d.chars[name] && d.chars[name].outfits === oldPart.outfits) {
                    // 浅引用相同，说明是改名
                    foundRename = oldCi;
                    foundOldName = oldName;
                    break;
                }
            }
            if (foundRename) {
                // 改名：更新 charIndex 里的 name，partition key 不变
                foundRename.name = name;
                newIndex.push(foundRename);
                delete oldNameSet[foundOldName];
            } else {
                // 全新角色
                var newCid = 'c_' + genId8();
                var newPartKey = 'char:' + newCid;
                newIndex.push({ id: newCid, name: name, partKey: newPartKey });
                // 如果 d.chars[name] 有数据，写入新 partition
                if (d.chars && d.chars[name]) {
                    var newPart = {
                        outfits: d.chars[name].outfits || [],
                        categories: d.chars[name].categories || [],
                        activeIds: d.chars[name].activeIds || [],
                        accessories: d.chars[name].accessories || [],
                        accCategories: d.chars[name].accCategories || []
                    };
                    savePartition(newPartKey, newPart);
                    if (newPart.activeIds.length > 0) {
                        syncActivePartitions(newPartKey, newPart.activeIds);
                    }
                } else {
                    savePartition(newPartKey, defPartition());
                }
                // 如果是新增角色且设为当前角色，更新 meta.currentChar
                if (d.currentChar === name) meta.currentChar = newCid;
            }
        }
    });

    // oldNameSet 里剩下的 = 被删除的角色
    for (var deletedName in oldNameSet) {
        var deletedCi = oldNameSet[deletedName];
        deletePartition(deletedCi.partKey);
        // 清理 activePartitions
        if (meta.activePartitions) delete meta.activePartitions[deletedCi.partKey];
        // 清理 favorites
        if (meta.charFavorites) {
            var fi = meta.charFavorites.indexOf(deletedCi.id);
            if (fi !== -1) meta.charFavorites.splice(fi, 1);
        }
        // 清理 groups
        if (meta.charGroups) {
            for (var gg in meta.charGroups) {
                var gi = meta.charGroups[gg].indexOf(deletedCi.id);
                if (gi !== -1) meta.charGroups[gg].splice(gi, 1);
            }
        }
    }

    meta.charIndex = newIndex;

    // ── 4b. currentChar: 现在 charIndex 已重建，可以安全翻译 name → id ──
    if (pendingCurrentChar === SHARED_CHAR_KEY) {
        meta.currentChar = SHARED_CHAR_KEY;
    } else if (pendingCurrentChar) {
        // charIdByName 读的是 meta.charIndex（刚更新过），包含改名后的记录
        var resolvedCid = charIdByName(pendingCurrentChar);
        meta.currentChar = resolvedCid || '';
    } else {
        meta.currentChar = '';
    }

    // ── 5. chars 数据回写到各 partition ──
    // 安全守卫：只回写 load() 组装时有对应缓存的 partition
    // 如果某个 partition 没在 partCache 里（理论上兼容期不会发生，
    // 因为 preloadAllPartitions 会加载全部），跳过而不是写空
    if (d.chars) {
        var nameToId = _nameToIdMap();
        for (var cn in d.chars) {
            var cid2, pk;
            if (cn === SHARED_CHAR_KEY) {
                pk = 'char:__shared__';
            } else {
                cid2 = nameToId[cn];
                if (!cid2) {
                    // 可能是上面刚新增的，重建映射
                    cid2 = charIdByName(cn);
                }
                if (!cid2) continue; // 安全跳过
                pk = 'char:' + cid2;
            }
            // 守卫：如果 partition 从未加载过，不要写入空数据
            if (!partCache[pk] && (!d.chars[cn].outfits || d.chars[cn].outfits.length === 0)) {
                continue; // 跳过，保护磁盘上的数据
            }
            var charPart = loadPartition(pk);
            charPart.outfits = d.chars[cn].outfits || charPart.outfits;
            charPart.categories = d.chars[cn].categories || charPart.categories;
            charPart.activeIds = d.chars[cn].activeIds || charPart.activeIds;
            if (d.chars[cn].accessories) charPart.accessories = d.chars[cn].accessories;
            if (d.chars[cn].accCategories) charPart.accCategories = d.chars[cn].accCategories;
            savePartition(pk, charPart);
            syncActivePartitions(pk, charPart.activeIds);
        }
    }

    // ── 6. charFavorites: name[] → charId[] ──
    if (d.charFavorites) {
        var nameToId2 = _nameToIdMap();
        meta.charFavorites = [];
        d.charFavorites.forEach(function (name) {
            if (nameToId2[name]) meta.charFavorites.push(nameToId2[name]);
        });
    }

    // ── 7. charGroups: { groupName: name[] } → { groupName: charId[] } ──
    if (d.charGroups) {
        var nameToId3 = _nameToIdMap();
        meta.charGroups = {};
        for (var gn2 in d.charGroups) {
            meta.charGroups[gn2] = [];
            (d.charGroups[gn2] || []).forEach(function (name) {
                if (nameToId3[name]) meta.charGroups[gn2].push(nameToId3[name]);
            });
        }
    }

    // ── 8. presets 同步：d.presets → meta.presets + user:{id} partition ──
    // 旧 UI 里 d.presets 是 [{id, name, outfits, categories, activeIds}, ...]
    if (d.presets) {
        var oldPresets = meta.presets || [];
        var oldPresetMap = {};
        oldPresets.forEach(function (p) { oldPresetMap[p.id] = p; });

        var newPresets = [];
        d.presets.forEach(function (dp) {
            if (!dp || !dp.id) return;
            var existing = oldPresetMap[dp.id];
            if (existing) {
                // 已有预设：可能改名或数据更新
                existing.name = dp.name || existing.name;
                newPresets.push(existing);
                // 写 partition 数据
                var pp = {
                    outfits: dp.outfits || [],
                    categories: dp.categories || [],
                    activeIds: dp.activeIds || [],
                    accessories: dp.accessories || [],
                    accCategories: dp.accCategories || []
                };
                savePartition(existing.partKey, pp);
                delete oldPresetMap[dp.id];
            } else {
                // 新预设
                var pid = dp.id;
                var partKey = 'user:' + pid;
                newPresets.push({ id: pid, name: dp.name || '未命名', partKey: partKey });
                var newPP = {
                    outfits: dp.outfits || [],
                    categories: dp.categories || [],
                    activeIds: dp.activeIds || [],
                    accessories: dp.accessories || [],
                    accCategories: dp.accCategories || []
                };
                savePartition(partKey, newPP);
            }
        });

        // oldPresetMap 里剩下的 = 被删除的预设
        for (var dpid in oldPresetMap) {
            var deletedPreset = oldPresetMap[dpid];
            deletePartition(deletedPreset.partKey);
            if (meta.activePartitions) delete meta.activePartitions[deletedPreset.partKey];
            // 如果删的是当前活跃预设，回退到默认
            if (meta.activePresetId === dpid) meta.activePresetId = null;
        }

        meta.presets = newPresets;

        // activePresetId 同步
        if (d.activePresetId !== undefined) meta.activePresetId = d.activePresetId;

        // 清理 User activePartitions：只保留当前活跃的 user:*
        var curUPK = currentUserPartKey();
        cleanUserActivePartitions(meta, curUPK);
        var curUPart = loadPartition(curUPK);
        if (curUPart.activeIds && curUPart.activeIds.length > 0) {
            meta.activePartitions[curUPK] = curUPart.activeIds.slice();
        }
    }

    // ── 9. 保存 meta ──
    saveMeta(meta);
}
