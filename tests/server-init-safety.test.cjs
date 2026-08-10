'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createIndexedDB(seed) {
    const values = new Map(Object.entries(clone(seed || {})));
    const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => {
            const tx = { oncomplete: null, onerror: null };
            const store = {
                get(key) {
                    const req = {};
                    setTimeout(() => {
                        req.result = clone(values.get(key));
                        if (req.onsuccess) req.onsuccess();
                    }, 0);
                    return req;
                },
                put(value, key) { values.set(key, clone(value)); },
                delete(key) { values.delete(key); },
                getAllKeys() {
                    const req = {};
                    setTimeout(() => {
                        req.result = Array.from(values.keys());
                        if (req.onsuccess) req.onsuccess();
                    }, 0);
                    return req;
                }
            };
            tx.objectStore = () => store;
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
            return tx;
        }
    };
    return {
        open() {
            const req = {};
            setTimeout(() => {
                req.result = db;
                if (req.onsuccess) req.onsuccess({ target: { result: db } });
            }, 0);
            return req;
        },
        dump: () => Object.fromEntries(Array.from(values.entries()).map(([key, value]) => [key, clone(value)]))
    };
}

function httpResponse(spec) {
    const status = spec.status === undefined ? 200 : spec.status;
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => spec.parseError
            ? Promise.reject(new Error(spec.parseError))
            : Promise.resolve(clone(spec.body))
    };
}

function createFetch(config, requests) {
    const counts = {};
    function take(name, fallback) {
        const list = config[name] || [fallback];
        const index = counts[name] || 0;
        counts[name] = index + 1;
        return list[Math.min(index, list.length - 1)];
    }
    return function fetch(url, options) {
        const method = (options && options.method) || 'GET';
        requests.push({ method, url, headers: options && options.headers ? clone(options.headers) : null, body: options && options.body });
        if (method !== 'GET') {
            let name = 'write';
            if (url.includes('/partitions/')) name = 'write:' + decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
            else if (url.endsWith('/recovery/checkpoints')) name = 'checkpoint';
            const spec = take(name, { status: 200, body: { ok: true } });
            const respond = () => spec.networkError ? Promise.reject(new Error(spec.networkError)) : Promise.resolve(httpResponse(spec));
            if (spec.delay) return new Promise((resolve) => setTimeout(resolve, spec.delay)).then(respond);
            return respond();
        }

        let spec;
        if (url.endsWith('/status')) spec = take('status', { status: 200, body: { ok: true, version: 2, pluginVersion: '2.0.3', partitions: true, partitionTransactions: true, recovery: 1, recoveryRevision: 'revision-test' } });
        else if (url.endsWith('/partitions/keys')) spec = take('keys', { status: 200, body: { ok: true, keys: [] } });
        else if (url.includes('/partitions/')) {
            const key = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
            spec = take('part:' + key, { status: 404, body: { ok: false } });
        } else spec = { status: 404, body: { ok: false } };

        if (spec.syncError) throw new Error(spec.syncError);
        if (spec.networkError) return Promise.reject(new Error(spec.networkError));
        return Promise.resolve(httpResponse(spec));
    };
}

async function loadDb(config, seed) {
    const requests = [];
    const indexedDB = createIndexedDB(seed);
    const localValues = new Map();
    if (config.serverSeen) localValues.set('outfit_mgr_server_seen', '1');
    const fastSetTimeout = (fn, ms) => setTimeout(fn, Math.min(ms || 0, 3));
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        fetch: createFetch(config, requests),
        indexedDB,
        localStorage: {
            getItem: (key) => localValues.has(key) ? localValues.get(key) : null,
            setItem: (key, value) => localValues.set(key, String(value)),
            removeItem: (key) => localValues.delete(key)
        },
        window: { getRequestHeaders: () => ({ 'X-Test': '1' }) },
        Promise,
        setTimeout: fastSetTimeout,
        clearTimeout,
        URL,
        Math,
        Date,
        JSON,
        Object,
        Array,
        String,
        Number,
        Boolean,
        RegExp,
        Error,
        encodeURIComponent,
        decodeURIComponent
    });
    const modules = new Map();
    async function load(file) {
        const resolved = path.resolve(file);
        if (modules.has(resolved)) return modules.get(resolved);
        const source = fs.readFileSync(resolved, 'utf8');
        const mod = new vm.SourceTextModule(source, { context, identifier: resolved });
        modules.set(resolved, mod);
        await mod.link((specifier, referencing) => load(path.resolve(path.dirname(referencing.identifier), specifier)));
        return mod;
    }
    const mod = await load(path.join(ROOT, 'src', 'db.js'));
    await mod.evaluate();
    return { api: mod.namespace, requests, indexedDB };
}

function part(name) {
    return { outfits: [{ id: name, name }], categories: [], activeIds: [], accessories: [], accCategories: [] };
}

const DEFAULT_KEY = 'user:__default__';
const PRESET_KEY = 'user:p_ABC12345';
const SHARED_KEY = 'char:__shared__';
const CHAR_KEY = 'char:c_ABC12345';
const ALL_KEYS = ['meta', DEFAULT_KEY, PRESET_KEY, SHARED_KEY, CHAR_KEY];
const META = {
    _version: 2,
    presets: [{ id: 'p_ABC12345', name: 'Preset', partKey: PRESET_KEY }],
    activePresetId: 'p_ABC12345',
    charIndex: [
        { id: '__shared__', name: '__shared__', partKey: SHARED_KEY },
        { id: 'c_ABC12345', name: 'Alice', partKey: CHAR_KEY }
    ],
    charFavorites: [],
    charGroups: {},
    activePartitions: {},
    currentView: 'user',
    currentChar: ''
};

function successfulConfig(overrides) {
    return Object.assign({
        keys: [{ status: 200, body: { ok: true, keys: ALL_KEYS } }],
        'part:meta': [{ status: 200, body: { ok: true, data: META } }],
        ['part:' + DEFAULT_KEY]: [{ status: 200, body: { ok: true, data: part('default') } }],
        ['part:' + PRESET_KEY]: [{ status: 200, body: { ok: true, data: part('preset') } }],
        ['part:' + SHARED_KEY]: [{ status: 200, body: { ok: true, data: part('shared') } }],
        ['part:' + CHAR_KEY]: [{ status: 200, body: { ok: true, data: part('char') } }]
    }, overrides || {});
}

function writes(requests) {
    return requests.filter((request) => request.method === 'PUT' || request.method === 'DELETE');
}

function countGets(requests, key) {
    const suffix = '/partitions/' + encodeURIComponent(key);
    return requests.filter((request) => request.method === 'GET' && request.url.endsWith(suffix)).length;
}

async function initialize(env) {
    return new Promise((resolve) => env.api.initStorage((err) => resolve(err || null)));
}

async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 25));
}

async function assertFailureHasNoWrites(env, expectedMessage) {
    const err = await initialize(env);
    assert.ok(err, 'initialization should fail');
    if (expectedMessage) assert.match(err.message, expectedMessage);
    assert.equal(env.api.saveMeta({ _version: 2 }), false);
    assert.equal(env.api.savePartition(DEFAULT_KEY, part('blocked')), false);
    assert.equal(env.api.deletePartition(DEFAULT_KEY), false);
    await settle();
    assert.equal(writes(env.requests).length, 0, 'failed initialization must not issue PUT/DELETE');
    assert.equal(
        env.requests.filter((request) => request.method !== 'GET').length,
        0,
        'failed initialization must not issue any mutating request before explicit recovery'
    );
    return err;
}

async function run() {
    const results = [];

    // A. 正常后端：完整加载后允许正常保存。
    {
        const env = await loadDb(successfulConfig());
        assert.equal(await initialize(env), null);
        assert.equal(env.api.getStorageHealth().serverPluginVersion, '2.0.3');
        assert.equal(env.api.getStorageHealth().minimumServerPluginVersion, '2.0.3');
        assert.equal(env.api.getStorageHealth().serverPluginUpdateRecommended, false);
        assert.ok(env.requests.findIndex((r) => r.url.endsWith('/partitions/meta')) < env.requests.findIndex((r) => r.url.endsWith('/partitions/' + encodeURIComponent(PRESET_KEY))));
        assert.equal(writes(env.requests).length, 0, 'hydrate itself should not write normalized data when no change is needed');
        env.api.saveMeta(env.api.loadMeta());
        await settle();
        const metaWrite = writes(env.requests).find((r) => r.method === 'PUT' && r.url.endsWith('/partitions/batch'));
        assert.ok(metaWrite);
        assert.equal(metaWrite.headers['X-OM-Recovery-Revision'], 'revision-test');
        assert.ok(
            env.requests.some((request) => request.method === 'POST' && request.url.endsWith('/recovery/checkpoints')),
            'healthy hydrated data should create a verified checkpoint'
        );
        results.push({ scenario: 'A', status: 'pass', failureWrites: 0 });
    }

    // B. meta 首次 500、第二次成功：重试完成前无写请求。
    {
        const env = await loadDb(successfulConfig({
            'part:meta': [
                { status: 500, body: { ok: false } },
                { status: 200, body: { ok: true, data: META } }
            ]
        }));
        assert.equal(await initialize(env), null);
        assert.equal(countGets(env.requests, 'meta'), 2);
        assert.equal(writes(env.requests).length, 0);
        results.push({ scenario: 'B', status: 'pass', failureWrites: 0 });
    }

    // 旧 v2 后端未声明 batch transaction 时仍保留逐分包兼容路径。
    {
        const env = await loadDb(successfulConfig({
            status: [{ status: 200, body: { ok: true, version: 2, partitions: true, recovery: 1, recoveryRevision: 'revision-test' } }]
        }));
        assert.equal(await initialize(env), null);
        assert.equal(env.api.getStorageHealth().serverPluginVersion, null);
        assert.equal(env.api.getStorageHealth().serverPluginUpdateRecommended, true, 'legacy backend without a release version should recommend an update');
        env.api.saveMeta(env.api.loadMeta());
        await settle();
        assert.ok(writes(env.requests).some((request) => request.method === 'PUT' && request.url.endsWith('/partitions/meta')));
        assert.equal(writes(env.requests).some((request) => request.url.endsWith('/partitions/batch')), false);
        results.push({ scenario: 'old-v2-write-fallback', status: 'pass', failureWrites: 0 });
    }

    // C. meta 连续失败：中止，保留本地缓存，不写服务器。
    {
        const seed = { meta: { _version: 2, sentinel: 'unchanged' } };
        const env = await loadDb(successfulConfig({ 'part:meta': [{ status: 500, body: { ok: false } }] }), seed);
        await assertFailureHasNoWrites(env, /meta 读取失败/);
        assert.equal(countGets(env.requests, 'meta'), 3);
        assert.equal(env.indexedDB.dump().meta.sentinel, 'unchanged');
        results.push({ scenario: 'C', status: 'pass', failureWrites: 0 });
    }

    // D. User 预设分包失败：不创建空分包、不覆盖。
    {
        const seed = { [PRESET_KEY]: { sentinel: 'unchanged' } };
        const env = await loadDb(successfulConfig({ ['part:' + PRESET_KEY]: [{ status: 500, body: { ok: false } }] }), seed);
        await assertFailureHasNoWrites(env, /衣柜分包读取失败/);
        assert.equal(countGets(env.requests, PRESET_KEY), 3);
        assert.equal(env.indexedDB.dump()[PRESET_KEY].sentinel, 'unchanged');
        results.push({ scenario: 'D', status: 'pass', failureWrites: 0 });
    }

    // E. 角色分包失败：不把角色衣柜当空数据保存。
    {
        const env = await loadDb(successfulConfig({ ['part:' + CHAR_KEY]: [{ status: 500, body: { ok: false } }] }));
        await assertFailureHasNoWrites(env, /衣柜分包读取失败/);
        assert.equal(countGets(env.requests, CHAR_KEY), 3);
        results.push({ scenario: 'E', status: 'pass', failureWrites: 0 });
    }

    // F. 有孤儿分包但无 meta：明确诊断且零写入。
    {
        const env = await loadDb({ keys: [{ status: 200, body: { ok: true, keys: [DEFAULT_KEY, CHAR_KEY] } }] });
        await assertFailureHasNoWrites(env, /meta 索引缺失，需要恢复索引/);
        assert.equal(countGets(env.requests, 'meta'), 0);
        results.push({ scenario: 'F', status: 'pass', failureWrites: 0 });
    }

    // G. 明确空 keys 才执行首次安装，并通过 /data 数据集事务一次提交。
    {
        const env = await loadDb({ keys: [{ status: 200, body: { ok: true, keys: [] } }] });
        assert.equal(await initialize(env), null);
        await settle();
        const dataPuts = writes(env.requests).filter((r) => r.method === 'PUT' && r.url.endsWith('/partitions/batch'));
        assert.equal(dataPuts.length, 1);
        const uploaded = JSON.parse(dataPuts[0].body);
        assert.ok(uploaded.meta && uploaded.partitions[DEFAULT_KEY] && uploaded.partitions[SHARED_KEY]);
        assert.equal(writes(env.requests).filter((r) => r.method === 'DELETE').length, 0);
        results.push({ scenario: 'G', status: 'pass', failureWrites: 0 });
    }

    // H. 从未确认过后端：404、网络/代理、解析异常均允许纯前端本地运行，且不产生后端写请求。
    {
        const seed = { meta: META, [DEFAULT_KEY]: part('cached'), [PRESET_KEY]: part('cached-preset'), [SHARED_KEY]: part('cached-shared'), [CHAR_KEY]: part('cached-char') };
        const configs = [
            { status: [{ status: 404, body: { ok: false } }] },
            { status: [{ syncError: 'Tauri relative API unavailable' }] },
            { status: [{ networkError: 'route unavailable' }] },
            { status: [{ status: 200, parseError: 'HTML response' }] },
            { status: [{ status: 403, body: { ok: false } }] }
        ];
        for (const config of configs) {
            const env = await loadDb(config, seed);
            assert.equal(await initialize(env), null);
            await settle();
            assert.equal(env.api.getStorageHealth().serverMode, false);
            assert.equal(env.api.getStorageHealth().serverInitFailed, false);
            assert.equal(writes(env.requests).length, 0);
        }
        const removedEnv = await loadDb({
            status: [
                { status: 404, body: { ok: false } },
                { networkError: 'route remains unavailable' }
            ],
            serverSeen: true
        }, seed);
        assert.equal(await initialize(removedEnv), null, 'explicit 404 should allow an installed backend to be removed');
        assert.equal(await initialize(removedEnv), null, '404 should clear the confirmed marker for later non-standard failures');
        assert.equal(removedEnv.api.getStorageHealth().serverMode, false);
        assert.equal(removedEnv.api.getStorageHealth().serverInitFailed, false);
        assert.equal(writes(removedEnv.requests).length, 0);
        results.push({ scenario: 'H', status: 'pass', failureWrites: 0 });
    }

    // I. 曾成功确认过后端：状态接口网络/500/协议错误仍必须进入恢复锁定。
    {
        const seed = { meta: META, [DEFAULT_KEY]: part('cached') };
        const networkEnv = await loadDb({ status: [{ networkError: 'offline' }], serverSeen: true }, seed);
        await assertFailureHasNoWrites(networkEnv, /状态检测失败/);
        assert.equal(networkEnv.api.getStorageHealth().error.code, 'SERVER_STATUS_FAILED');
        assert.equal(networkEnv.requests.filter((request) => request.url.endsWith('/status')).length, 3);

        const httpEnv = await loadDb({ status: [{ status: 500, body: { ok: false } }], serverSeen: true }, seed);
        await assertFailureHasNoWrites(httpEnv, /状态检测失败/);
        assert.equal(httpEnv.requests.filter((request) => request.url.endsWith('/status')).length, 3);

        const protocolEnv = await loadDb({ status: [{ status: 200, body: { ok: false } }], serverSeen: true }, seed);
        await assertFailureHasNoWrites(protocolEnv, /状态检测失败/);
        results.push({ scenario: 'I', status: 'pass', failureWrites: 0 });
    }

    // 额外重点：keys 连续失败绝不能进入首次安装。
    {
        const env = await loadDb({ keys: [{ status: 500, body: { ok: false } }] });
        await assertFailureHasNoWrites(env, /分包索引读取失败/);
        assert.equal(env.requests.filter((r) => r.url.endsWith('/partitions/keys')).length, 3);
        results.push({ scenario: 'keys-failure', status: 'pass', failureWrites: 0 });
    }

    // 结构化协议：网络/解析错误可重试，旧后端 null、404、异常响应均不可伪装成空数据。
    {
        const retryEnv = await loadDb(successfulConfig({
            keys: [
                { networkError: 'temporary offline' },
                { status: 200, parseError: 'temporary invalid JSON' },
                { status: 200, body: { ok: true, keys: ALL_KEYS } }
            ]
        }));
        assert.equal(await initialize(retryEnv), null);
        assert.equal(retryEnv.requests.filter((r) => r.url.endsWith('/partitions/keys')).length, 3);
        assert.equal(writes(retryEnv.requests).length, 0);

        const legacyNullEnv = await loadDb(successfulConfig({
            'part:meta': [{ status: 200, body: { ok: true, data: null } }]
        }));
        await assertFailureHasNoWrites(legacyNullEnv, /meta 读取失败/);
        assert.equal(countGets(legacyNullEnv.requests, 'meta'), 1);

        const missingEnv = await loadDb(successfulConfig({
            ['part:' + DEFAULT_KEY]: [{ status: 404, body: { ok: false } }]
        }));
        await assertFailureHasNoWrites(missingEnv, /衣柜分包读取失败/);
        assert.equal(countGets(missingEnv.requests, DEFAULT_KEY), 1);

        const unexpectedEnv = await loadDb({ keys: [{ status: 200, body: { ok: true, keys: null } }] });
        await assertFailureHasNoWrites(unexpectedEnv, /分包索引读取失败/);
        assert.equal(unexpectedEnv.requests.filter((r) => r.url.endsWith('/partitions/keys')).length, 1);
        results.push({ scenario: 'read-protocol', status: 'pass', failureWrites: 0 });
    }

    // 新后端明确分类 META_MISSING / META_CORRUPT 时，前端不再读 keys，更不会用本地空数据反向覆盖。
    for (const state of ['META_MISSING', 'META_CORRUPT']) {
        const env = await loadDb({
            status: [{ status: 200, body: {
                ok: true, version: 2, partitions: true, recovery: 1,
                storageState: state, recoveryResult: { attempted: true, recovered: false }
            } }]
        });
        const err = await assertFailureHasNoWrites(env, state === 'META_MISSING' ? /索引缺失/ : /索引损坏/);
        assert.equal(err.code, state);
        assert.equal(env.requests.filter((request) => request.url.endsWith('/partitions/keys')).length, 0);
    }
    results.push({ scenario: 'explicit-storage-state', status: 'pass', failureWrites: 0 });

    // JSON.parse 成功的 {} 也必须被判为 META schema 错误，不能 ensure defaults 后继续。
    {
        const env = await loadDb(successfulConfig({
            'part:meta': [{ status: 200, body: { ok: true, data: {} } }]
        }));
        const err = await assertFailureHasNoWrites(env, /meta\._version/);
        assert.equal(err.code, 'META_SCHEMA_INVALID');
        results.push({ scenario: 'empty-meta-rejected', status: 'pass', failureWrites: 0 });
    }

    // PUT 失败时保留当前最新 revision：旧请求结束后只能重试最新快照。
    {
        const env = await loadDb(successfulConfig({
            ['write:' + DEFAULT_KEY]: [
                { status: 500, body: { ok: false }, delay: 12 },
                { status: 200, body: { ok: true } }
            ]
        }));
        assert.equal(await initialize(env), null);
        env.api.savePartition(DEFAULT_KEY, part('revision-1'));
        await new Promise((resolve) => setTimeout(resolve, 6));
        env.api.savePartition(DEFAULT_KEY, part('revision-2'));
        await new Promise((resolve) => setTimeout(resolve, 70));
        const puts = env.requests.filter((request) => request.method === 'PUT' && request.url.endsWith('/partitions/' + encodeURIComponent(DEFAULT_KEY)));
        assert.equal(puts.length, 2);
        assert.equal(JSON.parse(puts[0].body).outfits[0].id, 'revision-1');
        assert.equal(JSON.parse(puts[1].body).outfits[0].id, 'revision-2');
        results.push({ scenario: 'failed-put-latest-revision', status: 'pass', failureWrites: 0 });
    }

    // 删除随最新 meta revision 进入 /data journal；失败只重试最新完整数据集，不先发 DELETE。
    {
        const env = await loadDb(successfulConfig({
            'write:batch': [
                { status: 500, body: { ok: false } },
                { status: 200, body: { ok: true } }
            ]
        }));
        assert.equal(await initialize(env), null);
        env.api.deletePartition(CHAR_KEY);
        var changedMeta = env.api.loadMeta();
        changedMeta.charIndex = changedMeta.charIndex.filter((item) => item.partKey !== CHAR_KEY);
        env.api.saveMeta(changedMeta);
        await new Promise((resolve) => setTimeout(resolve, 70));
        const mutations = env.requests.filter((request) =>
            (request.method === 'PUT' && request.url.endsWith('/partitions/batch')) ||
            (request.method === 'DELETE' && request.url.endsWith('/partitions/' + encodeURIComponent(CHAR_KEY)))
        );
        assert.deepEqual(mutations.map((request) => request.method), ['PUT', 'PUT']);
        assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(mutations[1].body).partitions, CHAR_KEY), false);
        results.push({ scenario: 'meta-before-delete', status: 'pass', failureWrites: 0 });
    }

    for (const result of results) console.log(`${result.scenario}: ${result.status}; failed-init PUT/DELETE=${result.failureWrites}`);
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
