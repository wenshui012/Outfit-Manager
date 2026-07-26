'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

class FakeStyle {
    constructor() { this.values = {}; }
    setProperty(name, value) { this.values[name] = String(value); }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.id = '';
        this.children = [];
        this.parentNode = null;
        this.listeners = {};
        this.attributes = {};
        this.style = new FakeStyle();
        this.innerHTML = '';
        this.src = '';
    }
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
    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'style') {
            const top = /top:([-\d.]+)px/.exec(value);
            const left = /left:([-\d.]+)px/.exec(value);
            if (top) this.style.setProperty('top', top[1] + 'px');
            if (left) this.style.setProperty('left', left[1] + 'px');
        }
    }
    addEventListener(type, handler) {
        if (!this.listeners[type]) this.listeners[type] = new Set();
        this.listeners[type].add(handler);
    }
    removeEventListener(type, handler) {
        if (this.listeners[type]) this.listeners[type].delete(handler);
    }
    dispatch(type, event) {
        for (const handler of Array.from(this.listeners[type] || [])) handler(event || {});
    }
    querySelector(selector) {
        if (selector.charAt(0) !== '#') return null;
        return findById(this, selector.slice(1));
    }
    getBoundingClientRect() {
        const left = parseFloat(this.style.values.left || '0');
        const top = parseFloat(this.style.values.top || '0');
        let size = 38;
        if (this.children[0] && this.children[0].attributes.style) {
            const width = /width:([-\d.]+)px/.exec(this.children[0].attributes.style);
            if (width) size = parseFloat(width[1]);
        }
        return { left, top, width: size, height: size, right: left + size, bottom: top + size };
    }
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
    const styleSource = fs.readFileSync(path.join(ROOT, 'src', 'styles.js'), 'utf8');
    assert.match(styleSource, /padding-top:max\(12px, env\(safe-area-inset-top, 12px\)\)/);
    assert.match(styleSource, /padding-bottom:max\(10px, env\(safe-area-inset-bottom, 10px\)\)/);

    const body = new FakeElement('body');
    const documentListeners = {};
    const document = {
        body,
        documentElement: { clientWidth: 500, clientHeight: 400 },
        createElement: (tag) => new FakeElement(tag),
        getElementById: (id) => findById(body, id),
        querySelectorAll: () => [],
        addEventListener(type, handler) {
            if (!documentListeners[type]) documentListeners[type] = new Set();
            documentListeners[type].add(handler);
        },
        removeEventListener(type, handler) {
            if (documentListeners[type]) documentListeners[type].delete(handler);
        },
        dispatch(type, event) {
            for (const handler of Array.from(documentListeners[type] || [])) handler(event || {});
        }
    };
    const window = {
        innerWidth: 500,
        innerHeight: 400,
        getComputedStyle: () => ({ display: 'flex', visibility: 'visible', opacity: '1' }),
        addEventListener() {},
        removeEventListener() {}
    };

    const state = { showBall: true, fabSize: 38, fabPos: null };
    let saveCount = 0;
    let openCount = 0;
    const fn = { openPopup() { openCount++; } };
    const context = vm.createContext({
        console,
        document,
        window,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Math,
        Object,
        Array,
        String,
        Number,
        Boolean,
        Error
    });

    const source = fs.readFileSync(path.join(ROOT, 'src', 'ui-fab.js'), 'utf8');
    const mod = new vm.SourceTextModule(source, { context, identifier: path.join(ROOT, 'src', 'ui-fab.js') });
    await mod.link(async (specifier) => {
        if (specifier === './db.js') {
            return new vm.SyntheticModule(['load', 'loadMeta', 'saveMeta'], function () {
                this.setExport('load', () => ({ activeIds: [] }));
                this.setExport('loadMeta', () => state);
                this.setExport('saveMeta', (value) => {
                    saveCount++;
                    Object.assign(state, value);
                    return true;
                });
            }, { context });
        }
        if (specifier === './data.js') {
            return new vm.SyntheticModule(['getById'], function () {
                this.setExport('getById', () => null);
            }, { context });
        }
        if (specifier === './utils.js') {
            return new vm.SyntheticModule(['esc', 'compressImage'], function () {
                this.setExport('esc', (value) => String(value || ''));
                this.setExport('compressImage', (_value, cb) => cb(_value));
            }, { context });
        }
        if (specifier === './bridge.js') {
            return new vm.SyntheticModule(['fn'], function () {
                this.setExport('fn', fn);
            }, { context });
        }
        throw new Error('Unexpected import: ' + specifier);
    });
    await mod.evaluate();

    mod.namespace.injectFab();
    const container = document.getElementById('om-fab-main');
    const button = document.getElementById('om-fab-main-btn');
    assert.ok(container);
    assert.ok(button);
    assert.match(button.attributes.style, /touch-action:none/);

    const mouseEvent = (extra) => Object.assign({
        button: 0,
        clientX: 460,
        clientY: 300,
        preventDefault() {},
        stopPropagation() {}
    }, extra || {});
    button.dispatch('mousedown', mouseEvent());
    document.dispatch('mousemove', mouseEvent({ clientX: 250, clientY: 150 }));
    document.dispatch('mouseup', mouseEvent({ clientX: 250, clientY: 150 }));
    button.dispatch('click', mouseEvent({ clientX: 250, clientY: 150 }));

    assert.equal(saveCount, 1, 'desktop drag should persist the final position once');
    assert.equal(state.fabPos.top, 132);
    assert.equal(state.fabPos.left, 236);
    assert.equal(openCount, 0, 'drag completion must suppress the following click');
    assert.equal((documentListeners.mousemove || new Set()).size, 0);
    assert.equal((documentListeners.mouseup || new Set()).size, 0);

    button.dispatch('mousedown', mouseEvent({ clientX: 250, clientY: 150 }));
    document.dispatch('mouseup', mouseEvent({ clientX: 250, clientY: 150 }));
    button.dispatch('click', mouseEvent({ clientX: 250, clientY: 150 }));
    assert.equal(openCount, 1, 'a stationary desktop click should still open the manager');

    console.log('viewport/FAB: pass (safe-area insets / desktop drag / persisted position / click suppression)');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
