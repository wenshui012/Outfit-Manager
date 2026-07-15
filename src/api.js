// ── 穿搭管理器 · API 调用 ──────────────────────────────────
// Vision API、模型选择、批量描述生成

import { load, save, loadMeta, loadCurrent, saveCurrent, loadPartition, savePartition, currentPartKey, resolveImageForExternal } from './db.js';
import { getById, partGetById, partGetAccById } from './data.js';
import { toast, getPopupLayer, esc } from './utils.js';

// ── 端点规范化 ─────────────────────────────────────────
export function normalizeEndpoint(raw, path) {
    try {
        var u = raw.replace(/\/+$/, '');
        if (u.match(/\/v\d+$/)) u = u.replace(/\/v\d+$/, '');
        if (u.match(/\/v\d+\/.*$/)) u = u.replace(/\/v\d+\/.*$/, '');
        return u + path;
    } catch (e) { return raw + path; }
}

// ── 获取模型列表 ─────────────────────────────────────────
export function fetchModelList(apiCfg, cb) {
    var url = normalizeEndpoint(apiCfg.endpoint, '/v1/models');
    fetch(url, {
        headers: { 'Authorization': 'Bearer ' + apiCfg.key, 'X-OM-Internal': '1' }
    }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status); });
        return r.json();
    }).then(function (data) {
        var models = [];
        if (data && data.data) {
            var list = Array.isArray(data.data) ? data.data : [];
            list.forEach(function (m) {
                var id = m.id || m.name || '';
                if (id) models.push(id);
            });
        }
        models.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
        cb(null, models);
    }).catch(function (e) { cb(e.message || String(e)); });
}

// ── 模型选择弹窗 ─────────────────────────────────────────
export function openModelPicker(apiCfg, onSelect) {
    toast('正在获取模型列表…');
    fetchModelList(apiCfg, function (err, models) {
        if (err) { toast('获取失败：' + err, true); return; }
        if (!models || models.length === 0) { toast('未找到可用模型', true); return; }

        var _mp = getPopupLayer();
        var listHtml = models.map(function (m) {
            return '<div class="om-model-item" data-m="' + esc(m) + '" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(127,127,127,.08);font-size:.88em;transition:.12s;">' + esc(m) + '</div>';
        }).join('');

        var modal = document.createElement('div');
        modal.className = 'om-modal';
        modal.innerHTML = '<div class="om-modal-box" style="max-height:70vh;"><div class="om-modal-title">选择模型</div>' +
            '<input id="om-model-search" type="text" placeholder="搜索模型…" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.2);background:rgba(127,127,127,.08);color:inherit;font-size:.88em;font-family:inherit;" />' +
            '<div style="max-height:50vh;overflow-y:auto;border:1px solid rgba(127,127,127,.12);border-radius:8px;">' + listHtml + '</div>' +
            '<button id="om-model-cancel" class="om-modal-cancel">取消</button></div>';
        _mp.appendChild(modal);

        modal.addEventListener('click', function (e) { if (e.target === modal) _mp.removeChild(modal); });
        modal.querySelector('#om-model-cancel').addEventListener('click', function () { _mp.removeChild(modal); });

        modal.querySelector('#om-model-search').addEventListener('input', function () {
            var q = this.value.toLowerCase();
            modal.querySelectorAll('.om-model-item').forEach(function (item) {
                item.style.display = item.dataset.m.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
            });
        });
        setTimeout(function () { modal.querySelector('#om-model-search').focus(); }, 50);

        modal.querySelectorAll('.om-model-item').forEach(function (item) {
            item.addEventListener('mouseenter', function () { item.style.background = 'rgba(127,127,127,.12)'; });
            item.addEventListener('mouseleave', function () { item.style.background = ''; });
            item.addEventListener('click', function () {
                onSelect(item.dataset.m);
                if (modal.parentNode) _mp.removeChild(modal);
            });
        });
    });
}

// ── 解析 AI 返回的 JSON（容错：处理 markdown 代码块、提取 JSON）
function parseAIResponse(raw) {
    if (!raw || !raw.trim()) return null;
    var s = raw.trim();
    // 去掉 markdown 代码块
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    // 尝试直接解析
    try { var obj = JSON.parse(s); if (obj && typeof obj === 'object') return cleanParsed(obj); } catch (e) {}
    // 尝试提取第一个 { ... }
    var m = s.match(/\{[\s\S]*\}/);
    if (m) { try { var obj2 = JSON.parse(m[0]); if (obj2 && typeof obj2 === 'object') return cleanParsed(obj2); } catch (e2) {} }
    // JSON 解析全部失败：尝试把首行当 name，其余当 description
    var lines = s.split(/\n+/).filter(function (l) { return l.trim(); });
    if (lines.length >= 2 && lines[0].length <= 20) {
        return { name: lines[0].trim(), description: lines.slice(1).join('\n').trim() };
    }
    return null;
}

// 清理 AI 返回的 JSON：如果 description 开头就是 name，去掉重复
function cleanParsed(obj) {
    if (obj.name && obj.description) {
        var n = obj.name.trim();
        var d = obj.description.trim();
        // description 开头是 name（可能后面跟换行、逗号、句号、冒号等）
        if (d.indexOf(n) === 0) {
            d = d.slice(n.length).replace(/^[\s,，.。:：\-—\n]+/, '').trim();
            if (d) obj.description = d;
        }
    }
    return obj;
}

function getCategoryName(catObj) {
    return catObj && typeof catObj === 'object' ? (catObj.name || '') : (catObj || '');
}

function getCategoryChildren(catObj) {
    return catObj && typeof catObj === 'object' && Array.isArray(catObj.children) ? catObj.children : [];
}

function buildClassificationPrompt(categories) {
    var lines = [];
    (categories || []).forEach(function (catObj) {
        var name = getCategoryName(catObj);
        if (!name) return;
        var children = getCategoryChildren(catObj).filter(function (sc) { return !!sc; });
        lines.push('- ' + name + (children.length ? '：' + children.join(' / ') : ''));
    });
    return [
        '你是穿搭图片分类助手。请只根据图片判断它最适合放进哪个现有分类。',
        '只能从下面列出的现有分类和子分类中选择，不能新增、改写、翻译或猜造分类。',
        'category 必须是非空的现有父分类，禁止返回空字符串、null、无分类、未分类或 unknown。',
        '即使不确定，也必须选择最接近的父分类；只有 subCategory 可以为空字符串。',
        '只回复 JSON，不要代码块：{"category":"现有父分类","subCategory":"现有子分类或空字符串","confidence":0.0}',
        '',
        '现有分类：',
        lines.join('\n')
    ].join('\n');
}

function buildCombinedDescriptionPrompt(descriptionPrompt, categories) {
    var lines = [];
    (categories || []).forEach(function (catObj) {
        var name = getCategoryName(catObj);
        if (!name) return;
        var children = getCategoryChildren(catObj).filter(function (sc) { return !!sc; });
        lines.push('- ' + name + (children.length ? '：' + children.join(' / ') : ''));
    });
    return [
        '请根据图片同时完成【穿搭描述】和【现有分类判断】。',
        '',
        '穿搭描述要求：',
        descriptionPrompt || '生成穿搭名称和服装描述。',
        '',
        '分类要求：只能从下面列出的现有分类和子分类中选择，不能新增、改写、翻译或猜造分类。category 必须是非空的现有父分类，禁止返回空字符串、null、无分类、未分类或 unknown。即使不确定，也必须选择最接近的父分类；只有 subCategory 可以为空字符串。',
        '',
        '只回复 JSON，不要代码块：{"name":"穿搭名称6字以内","description":"服装描述","category":"现有父分类","subCategory":"现有子分类或空字符串","confidence":0.0}',
        '',
        '现有分类：',
        lines.join('\n')
    ].join('\n');
}

function getDefaultClassification(categories) {
    var cats = categories || [];
    for (var i = 0; i < cats.length; i++) {
        var name = getCategoryName(cats[i]);
        if (name) return { category: name, subCategory: '', confidence: 0 };
    }
    return { category: '', subCategory: '', confidence: 0 };
}

function normalizeClassificationFallback(categories, fallback) {
    fallback = fallback || {};
    var wantedCat = (fallback.category || '').trim();
    var wantedSub = (fallback.subCategory || '').trim();
    var cats = categories || [];
    for (var i = 0; i < cats.length; i++) {
        var name = getCategoryName(cats[i]);
        if (name !== wantedCat) continue;
        var result = { category: name, subCategory: '', confidence: 0 };
        if (wantedSub && getCategoryChildren(cats[i]).indexOf(wantedSub) !== -1) result.subCategory = wantedSub;
        return result;
    }
    return getDefaultClassification(categories);
}

function validateClassificationResult(parsed, categories, fallback) {
    var result = normalizeClassificationFallback(categories, fallback);
    if (!parsed || typeof parsed !== 'object') return result;

    var confidence = Number(parsed.confidence);
    if (!isFinite(confidence)) confidence = 0.5;
    if (confidence > 1) confidence = confidence / 100;
    if (confidence < 0) confidence = 0;
    if (confidence > 1) confidence = 1;

    var wantedCat = (parsed.category || parsed.cat || '').trim();
    var wantedSub = (parsed.subCategory || parsed.subcategory || parsed.sub || '').trim();
    if (!wantedCat && !wantedSub) return result;

    var cats = categories || [];
    var foundCat = null;
    for (var i = 0; i < cats.length; i++) {
        if (getCategoryName(cats[i]) === wantedCat) { foundCat = cats[i]; break; }
    }

    if (!foundCat && wantedSub) {
        for (var j = 0; j < cats.length; j++) {
            if (getCategoryChildren(cats[j]).indexOf(wantedSub) !== -1) {
                foundCat = cats[j];
                wantedCat = getCategoryName(cats[j]);
                break;
            }
        }
    }

    if (!foundCat) return result;
    result.category = wantedCat;
    result.confidence = confidence;

    var subs = getCategoryChildren(foundCat);
    if (wantedSub && subs.indexOf(wantedSub) !== -1) result.subCategory = wantedSub;
    else result.subCategory = '';
    return result;
}

// ── 单次 Vision API 调用 ─────────────────────────────────
export function callVisionAPI(apiCfg, image, systemPrompt, cb) {
    var url = normalizeEndpoint(apiCfg.endpoint, '/v1/chat/completions');
    var imgContent = image.dataUrl.indexOf('data:') === 0 ? image.dataUrl : 'data:image/jpeg;base64,' + image.dataUrl;
    var body = {
        model: apiCfg.model,
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: imgContent } },
                { type: 'text', text: systemPrompt || '请描述图中服装' }
            ]
        }],
        max_tokens: 4096
    };
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiCfg.key, 'X-OM-Internal': '1' },
        body: JSON.stringify(body)
    }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 200)); });
        return r.json();
    }).then(function (data) {
        var text = '';
        if (data.choices && data.choices[0]) {
            var msg = data.choices[0].message;
            if (msg) {
                if (typeof msg.content === 'string') text = msg.content;
                else if (Array.isArray(msg.content)) {
                    var parts = msg.content.filter(function (p) { return p.type === 'text'; });
                    if (parts) text = parts.map(function (p) { return p.text || ''; }).join('');
                }
            }
        }
        cb(null, text.trim());
    }).catch(function (e) { cb(e.message || String(e)); });
}

// ── 图片自动分类：只允许命中现有穿搭分类 ──────────────────
export function classifyOutfitImage(apiCfg, image, categories, fallback, cb) {
    if (!apiCfg || !apiCfg.endpoint || !apiCfg.key || !apiCfg.model) {
        cb(null, fallback || { category: '', subCategory: '' });
        return;
    }
    if (!Array.isArray(categories) || categories.length === 0) {
        cb(null, fallback || { category: '', subCategory: '' });
        return;
    }
    callVisionAPI(apiCfg, image, buildClassificationPrompt(categories), function (err, text) {
        if (err) { cb(err, fallback || { category: '', subCategory: '' }); return; }
        var parsed = parseAIResponse(text);
        cb(null, validateClassificationResult(parsed, categories, fallback));
    });
}

function getClassificationFallback(categories, outfit) {
    return normalizeClassificationFallback(categories, outfit || {});
}

// ── 批量自动分类（后台队列）──────────────────────────────
export function batchClassifyOutfits(outfitIds, options, progressCb, doneCb) {
    if (typeof options === 'function') {
        doneCb = progressCb;
        progressCb = options;
        options = {};
    }
    options = options || {};
    var meta = loadMeta();
    var apiCfg = meta.apiVision;
    if (!apiCfg || !apiCfg.endpoint || !apiCfg.key || !apiCfg.model) {
        doneCb('请先在设置中配置描述API', 0, []);
        return;
    }
    var sourcePartKey = options.sourcePartKey || currentPartKey();
    var srcPart = loadPartition(sourcePartKey);
    var categories = srcPart.categories || [];
    if (!Array.isArray(categories) || categories.length === 0) {
        doneCb('还没有分类，无法自动分类', 0, []);
        return;
    }
    var seen = {};
    var queue = [];
    (outfitIds || []).forEach(function (id) {
        if (!id || seen[id]) return;
        seen[id] = true;
        var o = partGetById(srcPart, id);
        if (!o || !o.imageData) return;
        queue.push({
            id: id,
            name: o.name || '穿搭',
            dataUrl: o.imageData,
            fallback: getClassificationFallback(categories, o)
        });
    });
    if (queue.length === 0) { doneCb(null, 0, []); return; }

    var resolveCount = 0;
    queue.forEach(function (item) {
        resolveImageForExternal(item.dataUrl, function (resolved) {
            item.dataUrl = resolved;
            resolveCount++;
            if (resolveCount >= queue.length) runBatch();
        });
    });

    function runBatch() {
        var done = 0, errors = [], running = 0, idx = 0;
        var total = queue.length;
        var concurrency = 2;

        function processNext() {
            while (running < concurrency && idx < queue.length) {
                (function (item) {
                    running++;
                    classifyOutfitImage(apiCfg, item, categories, item.fallback, function (err, cls) {
                        running--;
                        done++;
                        if (err) {
                            errors.push({ name: item.name, error: err });
                        } else {
                            var cp = loadPartition(sourcePartKey);
                            var o = partGetById(cp, item.id);
                            if (!o) {
                                errors.push({ name: item.name, error: '未找到穿搭数据' });
                            } else {
                                o.category = cls && cls.category ? cls.category : '';
                                o.subCategory = cls && cls.subCategory ? cls.subCategory : '';
                                savePartition(sourcePartKey, cp);
                            }
                        }
                        var label = '✅ ' + item.name;
                        if (errors.length > 0 && errors[errors.length - 1].name === item.name) {
                            label = '❌ ' + item.name;
                        }
                        if (progressCb) progressCb(done, total, label);
                        if (done >= total) doneCb(null, done, errors);
                        else processNext();
                    });
                })(queue[idx]);
                idx++;
            }
        }
        processNext();
    }
}

// ── 批量生成描述（并发队列）─────────────────────────────
export function batchGenerateDescriptions(outfitIds, options, progressCb, doneCb) {
    options = options || {};
    var meta = loadMeta();
    var apiCfg = meta.apiVision;
    // 固定源分包 key：后台运行时用户可能切换视角/预设，
    // 回调必须写回启动时的分包，不能跟随 currentPartKey() 漂移
    var sourcePartKey = currentPartKey();
    var srcPart = loadPartition(sourcePartKey);
    var categories = srcPart.categories || [];
    var queue = [];
    var overwriteDescription = options.overwriteDescription !== undefined ? !!options.overwriteDescription : !!apiCfg.overwrite;
    outfitIds.forEach(function (id) {
        var o = partGetById(srcPart, id);
        if (!o || !o.imageData) return;
        var skipDescription = !!(o.description && o.description.trim() && !overwriteDescription);
        if (skipDescription && !options.autoClassify) return;
        queue.push({
            id: id,
            name: o.name,
            dataUrl: o.imageData,
            skipDescription: skipDescription,
            fallbackClass: getClassificationFallback(categories, o)
        });
    });
    if (queue.length === 0) { doneCb(null, 0, []); return; }

    // server 模式下先批量 resolve 图片 URL → base64
    var resolveCount = 0;
    function resolveQueue(cb) {
        queue.forEach(function (item) {
            resolveImageForExternal(item.dataUrl, function (resolved) {
                item.dataUrl = resolved;
                resolveCount++;
                if (resolveCount >= queue.length) cb();
            });
        });
    }

    resolveQueue(function () {
        var done = 0, errors = [], running = 0, idx = 0;
        var total = queue.length;
        var concurrency = 3;
        var prompt = options.autoClassify ? buildCombinedDescriptionPrompt(apiCfg.prompt, categories) : apiCfg.prompt;
        var stats = {
            descTarget: queue.filter(function (item) { return !item.skipDescription; }).length,
            descSuccess: 0,
            classTarget: options.autoClassify ? queue.length : 0,
            classSuccess: 0
        };

        function processNext() {
            while (running < concurrency && idx < queue.length) {
                (function (item) {
                    running++;
                    callVisionAPI(apiCfg, item, prompt, function (err, text) {
                        running--;
                        done++;
                        if (err) {
                            errors.push({ name: item.name, error: err });
                        } else if (!text || !text.trim()) {
                            errors.push({ name: item.name, error: 'API 返回了空内容' });
                        } else {
                            var parsed = parseAIResponse(text);
                            // 用固定的 sourcePartKey 读写，不受用户切换视角影响
                            var cp = loadPartition(sourcePartKey);
                            var o = partGetById(cp, item.id);
                            if (!o) { errors.push({ name: item.name, error: '未找到穿搭数据' }); }
                            else {
                                if (!item.skipDescription && parsed && parsed.description) {
                                    o.description = parsed.description;
                                    if (options.autoName && parsed.name && parsed.name.trim()) o.name = parsed.name.trim();
                                    stats.descSuccess++;
                                } else if (!item.skipDescription) {
                                    o.description = text;
                                    stats.descSuccess++;
                                }
                                if (options.autoClassify) {
                                    var cls = validateClassificationResult(parsed, categories, item.fallbackClass);
                                    o.category = cls.category || '';
                                    o.subCategory = cls.subCategory || '';
                                    stats.classSuccess++;
                                }
                                savePartition(sourcePartKey, cp);
                            }
                        }
                        if (progressCb) progressCb(done, total, errors.length > 0 && errors[errors.length - 1].name === item.name ? '❌ ' + item.name : '✅ ' + item.name);
                        if (done >= total) { doneCb(null, done, errors, stats); }
                        else { processNext(); }
                    });
                })(queue[idx]);
                idx++;
            }
        }
        processNext();
    });
}

// ── 批量生成单品描述（并发队列）──────────────────────────
export function batchGenerateAccDescriptions(accIds, options, progressCb, doneCb) {
    options = options || {};
    var meta = loadMeta();
    var apiCfg = meta.apiVision;
    var sourcePartKey = currentPartKey();
    var srcPart = loadPartition(sourcePartKey);
    var queue = [];
    var overwriteDescription = options.overwriteDescription !== undefined ? !!options.overwriteDescription : !!apiCfg.overwrite;
    accIds.forEach(function (id) {
        var a = partGetAccById(srcPart, id);
        if (!a || !a.imageData) return;
        if (a.description && a.description.trim() && !overwriteDescription) return;
        queue.push({ id: id, name: a.name, category: a.category || '单品', dataUrl: a.imageData });
    });
    if (queue.length === 0) { doneCb(null, 0, []); return; }

    var resolveCount = 0;
    queue.forEach(function (item) {
        resolveImageForExternal(item.dataUrl, function (resolved) {
            item.dataUrl = resolved;
            resolveCount++;
            if (resolveCount >= queue.length) runBatch();
        });
    });

    function runBatch() {
        var done = 0, errors = [], running = 0, idx = 0;
        var total = queue.length;
        var concurrency = 3;

        function processNext() {
            while (running < concurrency && idx < queue.length) {
                (function (item) {
                    running++;
                    var prompt = (apiCfg.accPrompt || apiCfg.prompt || '')
                        .replace(/\{\{accCategory\}\}/g, item.category || '单品');
                    callVisionAPI(apiCfg, item, prompt, function (err, text) {
                        running--;
                        done++;
                        if (err) {
                            errors.push({ name: item.name, error: err });
                        } else if (!text || !text.trim()) {
                            errors.push({ name: item.name, error: 'API 返回了空内容' });
                        } else {
                            var parsed = parseAIResponse(text);
                            var cp = loadPartition(sourcePartKey);
                            var acc = partGetAccById(cp, item.id);
                            if (!acc) { errors.push({ name: item.name, error: '未找到单品数据' }); }
                            else {
                                if (parsed && parsed.description) {
                                    acc.description = parsed.description;
                                    if (options.autoName && parsed.name && parsed.name.trim()) acc.name = parsed.name.trim();
                                } else {
                                    acc.description = text;
                                }
                                savePartition(sourcePartKey, cp);
                            }
                        }
                        if (progressCb) progressCb(done, total, errors.length > 0 && errors[errors.length - 1].name === item.name ? '❌ ' + item.name : '✅ ' + item.name);
                        if (done >= total) { doneCb(null, done, errors); }
                        else { processNext(); }
                    });
                })(queue[idx]);
                idx++;
            }
        }
        processNext();
    }
}

// ── 单套描述生成（返回结构化数据）───────────────────────
export function generateSingleDescription(outfit, cb) {
    var meta = loadMeta();
    var apiCfg = meta.apiVision;
    if (!apiCfg.endpoint || !apiCfg.key || !apiCfg.model) { cb('请先在设置中配置描述API'); return; }
    if (!outfit.imageData) { cb('该穿搭没有图片'); return; }
    // server 模式下图片可能是后端 URL，外部 AI 无法访问，需要先 resolve 为 base64
    resolveImageForExternal(outfit.imageData, function (resolvedUrl) {
        callVisionAPI(apiCfg, { name: outfit.name, dataUrl: resolvedUrl }, apiCfg.prompt, function (err, text) {
            if (err) { cb(err); return; }
            var parsed = parseAIResponse(text);
            if (parsed && parsed.description) {
                cb(null, { name: parsed.name || '', description: parsed.description });
            } else {
                cb(null, { name: '', description: text });
            }
        });
    });
}

// ── 单个单品描述生成（返回结构化数据）────────────────────
export function generateSingleAccDescription(acc, cb) {
    var meta = loadMeta();
    var apiCfg = meta.apiVision;
    if (!apiCfg.endpoint || !apiCfg.key || !apiCfg.model) { cb('请先在设置中配置描述API'); return; }
    if (!acc.imageData) { cb('该单品没有图片'); return; }
    var prompt = (apiCfg.accPrompt || apiCfg.prompt || '')
        .replace(/\{\{accCategory\}\}/g, acc.category || '单品');
    resolveImageForExternal(acc.imageData, function (resolvedUrl) {
        callVisionAPI(apiCfg, { name: acc.name || '', dataUrl: resolvedUrl }, prompt, function (err, text) {
            if (err) { cb(err); return; }
            var parsed = parseAIResponse(text);
            if (parsed && parsed.description) {
                cb(null, { name: parsed.name || '', description: parsed.description });
            } else {
                cb(null, { name: '', description: text });
            }
        });
    });
}
