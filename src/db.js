// ── 穿搭管理器 · 存储层 ──────────────────────────────────
// IndexedDB 主存储 + localStorage 回退

import { ensureDefaults } from './data.js';

var DB_NAME = 'outfit_mgr_db';
var DB_VERSION = 1;
var STORE_NAME = 'data';
var DATA_KEY = 'main';
var LS_KEY = 'outfit_mgr_v4';

var dbInstance = null;
var dataCache = null;

// ── IndexedDB ─────────────────────────────────────────────
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

// ── 异步加载 ─────────────────────────────────────────────
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

export function save(d) { dataCache = d; saveToDB(d); }

export function getCache() { return dataCache; }
export function setCache(d) { dataCache = d; }

// ── LS 迁移辅助 ─────────────────────────────────────────
export { loadFromLS };
export function removeLSData() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }
