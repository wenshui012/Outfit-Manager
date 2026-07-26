'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

class FakeElement {
    constructor(tagName) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.listeners = {};
        this._id = '';
        this._html = '';
        this._selectorMap = new Map();
    }
    set id(value) { this._id = String(value || ''); }
    get id() { return this._id; }
    set innerHTML(value) {
        this._html = String(value || '');
        this._selectorMap = new Map();
        const ids = this._html.matchAll(/id="([^"]+)"/g);
        for (const match of ids) {
            const child = new FakeElement('button');
            child.id = match[1];
            child.parentNode = this;
            this._selectorMap.set('#' + child.id, child);
        }
    }
    get innerHTML() { return this._html; }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
    }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    click() {
        if (this.listeners.click) this.listeners.click({ target: this, preventDefault() {}, stopPropagation() {} });
    }
    querySelector(selector) { return this._selectorMap.get(selector) || null; }
}

function findById(root, id) {
    if (!root) return null;
    if (root.id === id) return root;
    for (const child of root.children || []) {
        const found = findById(child, id);
        if (found) return found;
    }
    return null;
}

async function run() {
    const body = new FakeElement('body');
    const menu = new FakeElement('div');
    body.appendChild(menu);
    const document = {
        body,
        createElement: (tag) => new FakeElement(tag),
        getElementById: (id) => findById(body, id)
    };

    let diagnoseCalls = 0;
    let initCalls = 0;
    let restoreCalls = 0;
    let recoveredCalls = 0;
    const diagnosis = {
        ok: true,
        healthy: false,
        issues: [{ code: 'JSON_INVALID', message: 'meta.json 的 JSON 已损坏或无法解析' }],
        latestSnapshot: { id: 'snapshot-1', createdAt: '2026-07-27T00:00:00.000Z' },
        canRestore: true
    };
    let currentDiagnosis = diagnosis;
    const dbExports = {
        diagnoseServerRecovery(cb) { diagnoseCalls++; cb(null, currentDiagnosis); },
        initStorage(cb) { initCalls++; cb(null); },
        restoreServerSnapshot(_id, cb) { restoreCalls++; cb(null, { ok: true }); }
    };

    const context = vm.createContext({
        console,
        document,
        window: {},
        confirm: () => true,
        Blob: class Blob {},
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        Date,
        JSON,
        String,
        Error,
        Array,
        Object,
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout
    });

    const source = fs.readFileSync(path.join(ROOT, 'src', 'ui-recovery.js'), 'utf8');
    const mod = new vm.SourceTextModule(source, { context, identifier: path.join(ROOT, 'src', 'ui-recovery.js') });
    await mod.link(async (specifier) => {
        if (specifier === './db.js') {
            return new vm.SyntheticModule(
                ['diagnoseServerRecovery', 'initStorage', 'restoreServerSnapshot'],
                function () {
                    this.setExport('diagnoseServerRecovery', dbExports.diagnoseServerRecovery);
                    this.setExport('initStorage', dbExports.initStorage);
                    this.setExport('restoreServerSnapshot', dbExports.restoreServerSnapshot);
                },
                { context }
            );
        }
        if (specifier === './ui-fab.js') {
            return new vm.SyntheticModule(['BTN_ID', 'findMenu'], function () {
                this.setExport('BTN_ID', 'outfit-mgr-ext-btn-v4');
                this.setExport('findMenu', () => menu);
            }, { context });
        }
        if (specifier === './utils.js') {
            return new vm.SyntheticModule(['esc'], function () {
                this.setExport('esc', (value) => String(value === undefined || value === null ? '' : value));
            }, { context });
        }
        throw new Error('Unexpected import: ' + specifier);
    });
    await mod.evaluate();
    const api = mod.namespace;

    api.activateRecovery(
        Object.assign(new Error('后端 meta 读取失败'), { code: 'META_READ_FAILED', details: { status: 500 } }),
        () => { recoveredCalls++; }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const overlay = document.getElementById('om-recovery-overlay');
    assert.ok(overlay, 'failure should automatically open recovery dialog');
    assert.equal(diagnoseCalls, 1, 'automatic diagnosis should run once');
    assert.match(overlay.innerHTML, /一键恢复/, 'verified snapshot should expose explicit restore action');
    assert.equal(restoreCalls, 0, 'diagnosis must never restore automatically');

    overlay.querySelector('#om-recovery-close').click();
    assert.equal(document.getElementById('om-recovery-overlay'), null);

    api.injectRecoveryBtn();
    const entry = document.getElementById('outfit-mgr-ext-btn-v4');
    assert.ok(entry, 'ordinary plugin entry should remain available after closing the dialog');
    assert.match(entry.innerHTML, /穿搭管理/);
    entry.click();
    assert.ok(document.getElementById('om-recovery-overlay'), 'ordinary entry should reopen the recovery dialog');

    document.getElementById('om-recovery-overlay').querySelector('#om-recovery-retry').click();
    assert.equal(initCalls, 1);
    assert.equal(recoveredCalls, 1);
    assert.equal(document.getElementById('om-recovery-overlay'), null, 'successful recheck should leave recovery mode');

    currentDiagnosis = Object.assign({}, diagnosis, { healthy: true });
    api.activateRecovery(
        Object.assign(new Error('后端临时连接失败'), { code: 'SERVER_STATUS_FAILED', details: { status: 500 } }),
        () => { recoveredCalls++; }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
        document.getElementById('om-recovery-overlay').querySelector('#om-recovery-restore'),
        null,
        'healthy diagnosis should offer recheck instead of rollback'
    );
    api.deactivateRecovery();

    currentDiagnosis = diagnosis;
    api.activateRecovery(
        Object.assign(new Error('后端 meta 读取失败'), { code: 'META_READ_FAILED', details: { status: 500 } }),
        () => { recoveredCalls++; }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    document.getElementById('om-recovery-overlay').querySelector('#om-recovery-restore').click();
    assert.equal(restoreCalls, 1, 'restore must run only after the explicit button click');
    assert.equal(initCalls, 2, 'successful restore must be followed by a full initialization recheck');
    assert.equal(recoveredCalls, 2);
    assert.equal(document.getElementById('om-recovery-overlay'), null);

    console.log('recovery UI: pass (auto popup / read-only diagnosis / explicit restore / entry reopen / full retry)');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
