// ── 穿搭管理器 · 批量操作与导入导出 ──────────────────────
// 批量标签、批量导入、批量AI生成、数据导出导入

import { load, save, isServerMode, batchResolveImages, uploadImage, getImageUrlPrefix } from './db.js';
import { getCharData, getViewOutfits, getViewCategories, getById, getCatNames, getSubCats, SHARED_CHAR_KEY, SHARED_CHAR_LABEL } from './data.js';
import { genId, esc, toast, getPopupLayer, compressImage } from './utils.js';
import { batchGenerateDescriptions } from './api.js';
import { state, fn } from './bridge.js';

// 需要从 ui-sheets.js 引入的通用函数
var createSheet, closeSheet, getAllTagSuggestions;

export function initBatchDeps(cs, cls, gats) {
    createSheet = cs;
    closeSheet = cls;
    getAllTagSuggestions = gats;
}

// ── 批量标签选择面板 ──────────────────────────────────────
function openBatchTagPanel(selectedIds, onDone) {
    var d = load();
    var tags = getAllTagSuggestions(d);
    var allOutfits = getViewOutfits(d);
    var count = selectedIds.length;

    function countTag(tag) {
        var n = 0;
        allOutfits.forEach(function (o) { if (o.sceneTag && o.sceneTag.trim() === tag) n++; });
        return n;
    }

    var sheet = createSheet([
        '<div class="om-sheet-title"><i class="fa-solid fa-tags"></i>设置场景标签</div>',
        '<div class="om-hint" style="margin-bottom:10px">为已选 ' + count + ' 套穿搭设置标签</div>',
        '<div class="om-tagpanel">',
        '<input type="text" class="om-tagpanel-search" id="om-btag-search" placeholder="搜索标签…" autocomplete="off" />',
        '<div class="om-tagpanel-list" id="om-btag-list"></div>',
        '<div class="om-tagpanel-add"><input type="text" id="om-btag-new" placeholder="输入新标签并应用…" /><button class="om-btn om-btn-safe" id="om-btag-apply">应用</button></div>',
        '<div class="om-divider" style="margin:6px 0"></div>',
        '<button class="om-btn om-btn-outline" id="om-btag-clear" style="width:100%;opacity:.6"><i class="fa-solid fa-eraser"></i> 清除所选穿搭的标签</button>',
        '</div>',
    ].join(''));

    var listEl = sheet.querySelector('#om-btag-list');
    var searchInp = sheet.querySelector('#om-btag-search');

    function renderList(filter) {
        var q = (filter || '').trim().toLowerCase();
        var filtered = q ? tags.filter(function (t) { return t.toLowerCase().indexOf(q) !== -1; }) : tags;

        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="om-tagpanel-empty">' + (q ? '没有匹配的标签' : '还没有标签') + '</div>';
            return;
        }

        listEl.innerHTML = filtered.map(function (tag) {
            return '<div class="om-cat-item om-btag-pick" data-tag="' + esc(tag) + '" style="cursor:pointer"><span class="om-cat-name">' + esc(tag) + '</span><span class="om-cat-count">' + countTag(tag) + '套</span></div>';
        }).join('');

        listEl.querySelectorAll('.om-btag-pick').forEach(function (item) {
            item.addEventListener('click', function () {
                applyTag(item.dataset.tag);
            });
        });
    }

    function applyTag(tag) {
        var dd = load();
        var vo = getViewOutfits(dd);
        vo.forEach(function (o) { if (selectedIds.indexOf(o.id) !== -1) o.sceneTag = tag; });
        save(dd); closeSheet(sheet);
        toast('✅ 已设置标签：' + tag);
        if (onDone) onDone();
    }

    renderList('');
    searchInp.addEventListener('input', function () { renderList(this.value); });
    setTimeout(function () { searchInp.focus(); }, 100);

    // 输入新标签并直接应用
    var newInp = sheet.querySelector('#om-btag-new');
    sheet.querySelector('#om-btag-apply').addEventListener('click', function () {
        var tag = newInp.value.trim();
        if (!tag) { toast('请输入标签', true); return; }
        applyTag(tag);
    });
    newInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') sheet.querySelector('#om-btag-apply').click(); });

    // 清除标签
    sheet.querySelector('#om-btag-clear').addEventListener('click', function () {
        var dd = load();
        var vo = getViewOutfits(dd);
        vo.forEach(function (o) { if (selectedIds.indexOf(o.id) !== -1) o.sceneTag = ''; });
        save(dd); closeSheet(sheet);
        toast('✅ 已清除 ' + count + ' 套穿搭的标签');
        if (onDone) onDone();
    });
}

// ── 导出 ──────────────────────────────────────────────────
function doExportFile(data, filename) {
    try {
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
    } catch (e) { toast('导出失败：' + e.message, true); }
}

// 收集数据中所有后端图片 URL
function collectImageUrls(data) {
    var urls = [];
    var prefix = getImageUrlPrefix();
    function scanOutfits(outfits) {
        if (!Array.isArray(outfits)) return;
        outfits.forEach(function (o) {
            if (o && typeof o.imageData === 'string' && o.imageData.indexOf(prefix) === 0) {
                urls.push(o.imageData);
            }
        });
    }
    scanOutfits(data.outfits);
    if (data.chars) {
        for (var cn in data.chars) { scanOutfits((data.chars[cn] || {}).outfits); }
    }
    if (Array.isArray(data.presets)) {
        data.presets.forEach(function (p) { if (p) scanOutfits(p.outfits); });
    }
    if (typeof data.fabImage === 'string' && data.fabImage.indexOf(prefix) === 0) {
        urls.push(data.fabImage);
    }
    return urls;
}

function doExport(data, filename) {
    if (!isServerMode()) {
        doExportFile(data, filename);
        return;
    }
    // Server 模式：收集图片 URL → 批量取 base64 → 附加 _assets
    var urls = collectImageUrls(data);
    if (urls.length === 0) {
        doExportFile(data, filename);
        return;
    }
    toast('📦 正在打包图片…');
    batchResolveImages(urls, function (imageMap) {
        var assets = {};
        var prefix = getImageUrlPrefix();
        for (var url in imageMap) {
            var dataUrl = imageMap[url];
            if (dataUrl && dataUrl.indexOf('data:image/') === 0) {
                var name = url.replace(prefix, '');
                if (name && !assets[name]) assets[name] = dataUrl;
            }
        }
        var exportData = JSON.parse(JSON.stringify(data));
        if (Object.keys(assets).length > 0) exportData._assets = assets;
        doExportFile(exportData, filename);
        toast('✅ 导出完成（含 ' + Object.keys(assets).length + ' 张图片）');
    });
}

function exportData() {
    var d = load();
    var isCharView = d.currentView === 'char' && d.currentChar;
    var modal = document.createElement('div');
    modal.className = 'om-modal ' + (state.darkMode ? 'om-dark' : 'om-light');
    modal.style.setProperty('z-index', '2147483647', 'important');

    var charBtns = '';
    if (isCharView) {
        charBtns =
            '<button class="om-modal-btn" id="om-exp-char-one"><i class="fa-solid fa-user" style="margin-right:8px"></i>导出「' + esc(d.currentChar) + '」<br><small style="opacity:.6;font-weight:400">当前角色的穿搭+分类</small></button>';
    }
    if (d.charNames && d.charNames.length > 0) {
        charBtns +=
            '<button class="om-modal-btn" id="om-exp-char-all"><i class="fa-solid fa-users" style="margin-right:8px"></i>导出全部角色<br><small style="opacity:.6;font-weight:400">所有角色的穿搭+分类</small></button>';
    }

    modal.innerHTML = '<div class="om-modal-box">' +
        '<div class="om-modal-title"><i class="fa-solid fa-download" style="margin-right:6px"></i>导出数据</div>' +
        '<button class="om-modal-btn" id="om-exp-all"><i class="fa-solid fa-database" style="margin-right:8px"></i>导出完整备份<br><small style="opacity:.6;font-weight:400">User+角色+预设+设置</small></button>' +
        '<button class="om-modal-btn" id="om-exp-user"><i class="fa-solid fa-shirt" style="margin-right:8px"></i>仅导出 User 穿搭<br><small style="opacity:.6;font-weight:400">User的穿搭+分类</small></button>' +
        charBtns +
        '<button class="om-modal-cancel" id="om-exp-cancel">取消</button></div>';
    var _mp = getPopupLayer();
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    _mp.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal) _mp.removeChild(modal); });
    modal.querySelector('#om-exp-cancel').addEventListener('click', function () { _mp.removeChild(modal); });

    document.getElementById('om-exp-all').addEventListener('click', function () {
        _mp.removeChild(modal);
        doExport(d, 'outfit-mgr-backup-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('✅ 已导出完整数据');
    });

    document.getElementById('om-exp-user').addEventListener('click', function () {
        _mp.removeChild(modal);
        doExport({ type: 'user', outfits: d.outfits, categories: d.categories }, 'outfit-mgr-user-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('✅ 已导出 User 穿搭');
    });

    var expCharOne = document.getElementById('om-exp-char-one');
    if (expCharOne) expCharOne.addEventListener('click', function () {
        _mp.removeChild(modal);
        var cd = getCharData(d, d.currentChar);
        doExport({ type: 'char', charName: d.currentChar, outfits: cd.outfits, categories: cd.categories }, 'outfit-mgr-char-' + d.currentChar + '-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('✅ 已导出「' + d.currentChar + '」');
    });

    var expCharAll = document.getElementById('om-exp-char-all');
    if (expCharAll) expCharAll.addEventListener('click', function () {
        _mp.removeChild(modal);
        var charExport = { type: 'chars_all', charNames: d.charNames, chars: {} };
        (d.charNames || []).forEach(function (cn) { charExport.chars[cn] = getCharData(d, cn); });
        doExport(charExport, 'outfit-mgr-all-chars-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('✅ 已导出全部角色（' + d.charNames.length + '个）');
    });
}

function importData() {
    var modal = document.createElement('div');
    modal.className = 'om-modal';
    modal.style.setProperty('z-index', '2147483647', 'important');
    modal.innerHTML = '<div class="om-modal-box">' +
        '<div class="om-modal-title"><i class="fa-solid fa-upload" style="margin-right:6px"></i>导入数据</div>' +
        '<div class="om-hint" style="margin-bottom:10px">选择之前导出的 .json 文件。</div>' +
        '<button class="om-modal-btn" id="om-imp-merge"><i class="fa-solid fa-code-merge" style="margin-right:8px"></i>合并导入<br><small style="opacity:.6;font-weight:400">追加到现有数据，不覆盖</small></button>' +
        '<button class="om-modal-btn" id="om-imp-replace"><i class="fa-solid fa-arrows-rotate" style="margin-right:8px"></i>覆盖导入<br><small style="opacity:.6;font-weight:400">替换现有穿搭（预设保留）</small></button>' +
        '<input type="file" id="om-imp-file" accept=".json" style="display:none" />' +
        '<button class="om-modal-cancel" id="om-imp-cancel">取消</button></div>';
    var _mp2 = getPopupLayer();
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    _mp2.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal) _mp2.removeChild(modal); });
    modal.querySelector('#om-imp-cancel').addEventListener('click', function () { _mp2.removeChild(modal); });
    var fileInp = document.getElementById('om-imp-file');
    var importMode = 'merge';
    function triggerImport(mode) { importMode = mode; fileInp.click(); }
    document.getElementById('om-imp-merge').addEventListener('click', function () { triggerImport('merge'); });
    document.getElementById('om-imp-replace').addEventListener('click', function () { triggerImport('replace'); });
    fileInp.addEventListener('change', function () {
        var file = fileInp.files[0]; if (!file) return;
        var reader = new FileReader();
        reader.onload = function (e) {
            try {
                var imported = JSON.parse(e.target.result);
                _mp2.removeChild(modal);
                if (imported._assets) {
                    resolveImportAssets(imported, function () {
                        processImport(imported, importMode);
                    });
                } else {
                    processImport(imported, importMode);
                }
            }
            catch (err) { toast('文件解析失败，请确认是有效的 JSON 文件', true); }
        };
        reader.onerror = function () { toast('文件读取失败', true); };
        reader.readAsText(file, 'utf-8');
    });
}

// ── _assets 处理（导入时）─────────────────────────────────
function resolveImportAssets(imported, cb) {
    var assets = imported._assets;
    if (!assets || typeof assets !== 'object') { cb(); return; }
    var prefix = getImageUrlPrefix();

    function replaceInOutfits(outfits, urlMap) {
        if (!Array.isArray(outfits)) return;
        outfits.forEach(function (o) {
            if (!o || typeof o.imageData !== 'string') return;
            if (o.imageData.indexOf(prefix) === 0) {
                var name = o.imageData.replace(prefix, '');
                if (urlMap[name]) o.imageData = urlMap[name];
            }
        });
    }

    function replaceAll(data, urlMap) {
        replaceInOutfits(data.outfits, urlMap);
        if (data.chars) {
            for (var cn in data.chars) { replaceInOutfits((data.chars[cn] || {}).outfits, urlMap); }
        }
        if (Array.isArray(data.presets)) {
            data.presets.forEach(function (p) { if (p) replaceInOutfits(p.outfits, urlMap); });
        }
        if (typeof data.fabImage === 'string' && data.fabImage.indexOf(prefix) === 0) {
            var fabName = data.fabImage.replace(prefix, '');
            if (urlMap[fabName]) data.fabImage = urlMap[fabName];
        }
    }

    if (isServerMode()) {
        // 后端可用：上传 _assets 中的图片，用新 URL 替换引用
        var names = Object.keys(assets);
        var urlMap = {};
        var done = 0;
        if (names.length === 0) { delete imported._assets; cb(); return; }
        toast('📦 正在上传图片（0/' + names.length + '）…');
        names.forEach(function (name) {
            uploadImage(assets[name], function (_err, newUrl) {
                urlMap[name] = newUrl;
                done++;
                if (done % 5 === 0 || done === names.length) {
                    toast('📦 正在上传图片（' + done + '/' + names.length + '）…');
                }
                if (done >= names.length) {
                    replaceAll(imported, urlMap);
                    delete imported._assets;
                    cb();
                }
            });
        });
    } else {
        // 后端不可用：用 _assets 中的 base64 还原 URL 引用
        var urlMap2 = {};
        for (var name in assets) { urlMap2[name] = assets[name]; }
        replaceAll(imported, urlMap2);
        delete imported._assets;
        cb();
    }
}

function processImport(imported, mode) {
    var dd = load();
    try {
        if (imported.type === 'preset' && imported.preset) {
            var p = imported.preset; p.id = genId();
            if (!Array.isArray(dd.presets)) dd.presets = [];
            dd.presets.push(p); save(dd); fn.renderGrid(); toast('✅ 已导入预设：' + p.name); return;
        }

        if (imported.type === 'char' && imported.charName) {
            var cn = imported.charName;
            if (!dd.chars) dd.chars = {};
            if (!dd.charNames) dd.charNames = [];
            var srcO = (imported.outfits || []).map(function (o) { return Object.assign({}, o, { id: genId() }); });
            var srcC = imported.categories || [];
            if (mode === 'replace') {
                dd.chars[cn] = { outfits: srcO, categories: srcC, activeIds: [] };
            } else {
                var cd = getCharData(dd, cn);
                srcO.forEach(function (o) { cd.outfits.push(o); });
                srcC.forEach(function (c) { if (cd.categories.indexOf(c) === -1) cd.categories.push(c); });
            }
            if (dd.charNames.indexOf(cn) === -1) dd.charNames.push(cn);
            save(dd); fn.renderViewbar(); fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus();
            toast('✅ 已导入角色「' + cn + '」（' + srcO.length + '套穿搭）');
            return;
        }

        if (imported.type === 'chars_all' && imported.chars) {
            if (!dd.chars) dd.chars = {};
            if (!dd.charNames) dd.charNames = [];
            var importedNames = imported.charNames || Object.keys(imported.chars);
            var totalOutfits = 0;
            importedNames.forEach(function (cn) {
                var src = imported.chars[cn]; if (!src) return;
                var srcO2 = (src.outfits || []).map(function (o) { return Object.assign({}, o, { id: genId() }); });
                var srcC2 = src.categories || [];
                if (mode === 'replace') {
                    dd.chars[cn] = { outfits: srcO2, categories: srcC2, activeIds: [] };
                } else {
                    var cd2 = getCharData(dd, cn);
                    srcO2.forEach(function (o) { cd2.outfits.push(o); });
                    srcC2.forEach(function (c) { if (cd2.categories.indexOf(c) === -1) cd2.categories.push(c); });
                }
                if (dd.charNames.indexOf(cn) === -1) dd.charNames.push(cn);
                totalOutfits += srcO2.length;
            });
            save(dd); fn.renderViewbar(); fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus();
            toast('✅ 已导入 ' + importedNames.length + ' 个角色（共 ' + totalOutfits + ' 套穿搭）');
            return;
        }

        var srcOutfits = imported.outfits || [], srcCats = imported.categories || [], srcPresets = imported.presets || [];
        if (mode === 'replace') {
            dd.outfits = srcOutfits.map(function (o) { return Object.assign({}, o, { id: genId() }); });
            dd.categories = srcCats.slice(); dd.activeIds = [];
        } else {
            srcOutfits.forEach(function (o) { dd.outfits.push(Object.assign({}, o, { id: genId() })); });
            srcCats.forEach(function (c) { if (dd.categories.indexOf(c) === -1) dd.categories.push(c); });
            if (srcPresets.length > 0) {
                if (!Array.isArray(dd.presets)) dd.presets = [];
                srcPresets.forEach(function (p2) { if (p2) dd.presets.push(Object.assign({}, p2, { id: genId() })); });
            }
        }

        if (imported.chars) {
            if (!dd.chars) dd.chars = {};
            if (!dd.charNames) dd.charNames = [];
            var impNames = imported.charNames || Object.keys(imported.chars);
            impNames.forEach(function (cn) {
                var src2 = imported.chars[cn]; if (!src2) return;
                dd.chars[cn] = {
                    outfits: (src2.outfits || []).map(function (o) { return Object.assign({}, o, { id: genId() }); }),
                    categories: src2.categories || [],
                    activeIds: []
                };
                if (dd.charNames.indexOf(cn) === -1) dd.charNames.push(cn);
            });
        }

        save(dd); fn.renderViewbar(); fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus(); fn.updateBtn();
        toast('✅ 导入成功：' + dd.outfits.length + ' 套穿搭');
    } catch (err) { toast('导入处理失败：' + err.message, true); }
}

// ── 批量导入弹窗 ─────────────────────────────────────────
function openBatchImportModal(files) {
    var d = load();
    var curCat = (state.curCat && state.curCat !== '__all__') ? state.curCat : '';
    var viewCats = getViewCategories(d);
    var catNames = getCatNames(viewCats);
    var catOpts = '<option value="">未分类</option>' +
        catNames.map(function (c) { return '<option value="' + esc(c) + '"' + (c === curCat ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    var hasApi = !!(d.apiVision.endpoint && d.apiVision.key && d.apiVision.model);

    var modal = document.createElement('div');
    modal.className = 'om-modal';
    modal.style.setProperty('z-index', '2147483647', 'important');
    modal.innerHTML = '<div class="om-modal-box" style="background:' + (state.darkMode ? '#1e1e24' : '#ececef') + ';color:' + (state.darkMode ? '#eee' : '#111') + ';max-height:80vh">' +
        '<div class="om-modal-title"><i class="fa-solid fa-images" style="margin-right:6px;color:var(--SmartThemeQuoteColor,#7c6daf)"></i>批量导入穿搭</div>' +
        '<div style="font-size:.82em;opacity:.7;margin-bottom:8px">已选择 ' + files.length + ' 张图片，将自动压缩</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;max-height:120px;overflow-y:auto;margin-bottom:10px" id="om-bimport-preview"></div>' +
        '<div class="om-field" style="margin-bottom:8px"><label style="font-size:.82em;font-weight:600">导入到分类</label><select id="om-bimport-cat" style="background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;padding:7px 10px;font-size:.85em;width:100%;box-sizing:border-box;font-family:inherit">' + catOpts + '</select></div>' +
        (hasApi ? '<label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer;margin-bottom:10px"><input type="checkbox" id="om-bimport-ai" checked /> 导入后自动 AI 生成描述和名称</label>' : '<div style="font-size:.78em;opacity:.4;margin-bottom:10px">💡 配置"描述生成 API"后可自动生成描述和名称</div>') +
        '<div id="om-bimport-status" style="display:none;margin:8px 0;font-size:.82em"></div>' +
        '<div class="om-btn-row" style="margin-top:6px" id="om-bimport-actions">' +
        '<button class="om-btn om-btn-safe" id="om-bimport-start"><i class="fa-solid fa-file-import"></i> 开始导入</button>' +
        '<button class="om-btn om-btn-outline" id="om-bimport-close">取消</button></div></div>';

    var _mp = getPopupLayer();
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    _mp.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal && !modal.dataset.running) _mp.removeChild(modal); });
    modal.querySelector('#om-bimport-close').addEventListener('click', function () { if (!modal.dataset.running) _mp.removeChild(modal); });

    var previewEl = modal.querySelector('#om-bimport-preview');
    files.forEach(function (f) {
        var thumb = document.createElement('div');
        thumb.style.cssText = 'width:52px;height:52px;border-radius:6px;overflow:hidden;background:rgba(127,127,127,.1);flex-shrink:0;';
        var reader = new FileReader();
        reader.onload = function (e) {
            thumb.innerHTML = '<img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover" />';
        };
        reader.readAsDataURL(f);
        previewEl.appendChild(thumb);
    });

    modal.querySelector('#om-bimport-start').addEventListener('click', function () {
        modal.dataset.running = '1';
        modal.querySelector('#om-bimport-start').disabled = true;
        modal.querySelector('#om-bimport-start').textContent = '导入中...';
        modal.querySelector('#om-bimport-close').textContent = '请等待...';
        var statusEl = modal.querySelector('#om-bimport-status');
        statusEl.style.display = 'block';

        var cat = modal.querySelector('#om-bimport-cat').value;
        var useAI = hasApi && modal.querySelector('#om-bimport-ai') && modal.querySelector('#om-bimport-ai').checked;
        var imported = 0;
        var newIds = [];

        function compressNext(i) {
            if (i >= files.length) {
                delete modal.dataset.running;
                statusEl.innerHTML = '<div style="color:#4caf50;font-weight:600">✅ 已导入 ' + imported + ' 套穿搭</div>';
                var actionsEl = modal.querySelector('#om-bimport-actions');
                if (useAI && newIds.length > 0) {
                    actionsEl.innerHTML = '<button class="om-btn om-btn-safe" id="om-bimport-ai-go"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成描述</button><button class="om-btn om-btn-outline" id="om-bimport-done">跳过</button>';
                    modal.querySelector('#om-bimport-ai-go').addEventListener('click', function () {
                        _mp.removeChild(modal);
                        fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus();
                        openBatchDescModal(newIds);
                    });
                    modal.querySelector('#om-bimport-done').addEventListener('click', function () {
                        _mp.removeChild(modal);
                        fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus(); fn.updateBtn();
                    });
                } else {
                    actionsEl.innerHTML = '<button class="om-btn om-btn-safe" id="om-bimport-done">完成</button>';
                    modal.querySelector('#om-bimport-done').addEventListener('click', function () {
                        _mp.removeChild(modal);
                        fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus(); fn.updateBtn();
                    });
                }
                return;
            }
            statusEl.textContent = '压缩中... ' + (i + 1) + '/' + files.length;
            var reader = new FileReader();
            reader.onload = function (e) {
                compressImage(e.target.result, function (compressed) {
                    var dd = load();
                    var id = genId();
                    var newOutfit = {
                        id: id,
                        name: '穿搭' + (i + 1),
                        category: cat,
                        description: '',
                        sceneTag: '',
                        imageData: compressed,
                        createdAt: Date.now()
                    };
                    if (dd.currentView === 'char' && dd.currentChar) {
                        getCharData(dd, dd.currentChar).outfits.push(newOutfit);
                    } else {
                        dd.outfits.push(newOutfit);
                    }
                    save(dd);
                    newIds.push(id);
                    imported++;
                    compressNext(i + 1);
                });
            };
            reader.onerror = function () { compressNext(i + 1); };
            reader.readAsDataURL(files[i]);
        }
        compressNext(0);
    });
}

// ── 批量 AI 生成描述弹窗 ──────────────────────────────────
function openBatchDescModal(ids) {
    var d = load();
    var withImg = ids.filter(function (id) { var o = getById(d, id); return o && o.imageData; });
    var skipCount = ids.length - withImg.length;
    var willSkipDesc = withImg.filter(function (id) { var o = getById(d, id); return o && o.description && o.description.trim() && !d.apiVision.overwrite; }).length;
    var modal = document.createElement('div');
    modal.className = 'om-modal';
    modal.style.setProperty('z-index', '2147483647', 'important');
    modal.innerHTML = '<div class="om-modal-box" style="background:' + (state.darkMode ? '#1e1e24' : '#ececef') + ';color:' + (state.darkMode ? '#eee' : '#111') + '">' +
        '<div class="om-modal-title"><i class="fa-solid fa-wand-magic-sparkles" style="margin-right:6px;color:var(--SmartThemeQuoteColor,#7c6daf)"></i>AI 批量生成</div>' +
        '<div style="font-size:.82em;opacity:.7;margin-bottom:8px">' +
        '共选中 ' + ids.length + ' 套，其中 ' + withImg.length + ' 套有图片' +
        (skipCount > 0 ? '，' + skipCount + ' 套无图片将跳过' : '') +
        (willSkipDesc > 0 ? '<br>' + willSkipDesc + ' 套已有描述将跳过（可在设置中开启覆盖）' : '') +
        '</div>' +
        '<div style="font-size:.78em;opacity:.5;margin-bottom:8px">共需 ' + (withImg.length - willSkipDesc) + ' 次 API 调用</div>' +
        '<div style="border:1px solid rgba(127,127,127,.12);border-radius:8px;padding:10px;margin-bottom:8px">' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer"><input type="checkbox" id="om-batch-autoname" checked /> 同时生成穿搭名称（覆盖现有名称）</label>' +
        '</div>' +
        '<div id="om-batch-progress" style="display:none;margin:10px 0">' +
        '<div style="font-size:.82em;margin-bottom:6px" id="om-batch-prog-text">准备中...</div>' +
        '<div style="height:6px;background:rgba(127,127,127,.15);border-radius:3px;overflow:hidden">' +
        '<div id="om-batch-prog-bar" style="height:100%;width:0%;background:var(--SmartThemeQuoteColor,#7c6daf);border-radius:3px;transition:width .3s"></div></div></div>' +
        '<div id="om-batch-result" style="display:none;margin:8px 0;font-size:.82em;max-height:120px;overflow-y:auto"></div>' +
        '<div class="om-btn-row" style="margin-top:10px" id="om-batch-actions">' +
        '<button class="om-btn om-btn-safe" id="om-batch-start"><i class="fa-solid fa-play"></i> 开始生成</button>' +
        '<button class="om-btn om-btn-outline" id="om-batch-close">取消</button></div></div>';

    var _mp = getPopupLayer();
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    _mp.appendChild(modal);

    var modalAlive = true;
    function removeModal() { if (modalAlive && modal.parentNode) { modal.parentNode.removeChild(modal); modalAlive = false; } }

    modal.addEventListener('click', function (e) { if (e.target === modal) removeModal(); });
    modal.querySelector('#om-batch-close').addEventListener('click', function () { removeModal(); });

    modal.querySelector('#om-batch-start').addEventListener('click', function () {
        modal.querySelector('#om-batch-progress').style.display = 'block';
        modal.querySelector('#om-batch-start').disabled = true;
        modal.querySelector('#om-batch-start').textContent = '生成中...';
        var closeBtn = modal.querySelector('#om-batch-close');
        closeBtn.textContent = '后台运行';
        closeBtn.onclick = function () {
            removeModal();
            toast('👗 AI 生成中，可继续使用酒馆，完成后会通知');
        };

        var options = {
            autoName: modal.querySelector('#om-batch-autoname').checked
        };

        batchGenerateDescriptions(ids, options,
            function (done, total, msg) {
                var pct = total > 0 ? Math.round(done / total * 100) : 0;
                if (modalAlive) {
                    var bar = modal.querySelector('#om-batch-prog-bar');
                    var txt = modal.querySelector('#om-batch-prog-text');
                    if (bar) bar.style.width = pct + '%';
                    if (txt) txt.textContent = done + '/' + total + ' ' + msg;
                }
            },
            function (err, doneCount, errors) {
                var successCount = (doneCount || 0) - (errors ? errors.length : 0);
                var failCount = errors ? errors.length : 0;

                if (modalAlive) {
                    var bar = modal.querySelector('#om-batch-prog-bar');
                    if (bar) bar.style.width = '100%';
                    var resultEl = modal.querySelector('#om-batch-result');
                    resultEl.style.display = 'block';
                    if (err && !doneCount) {
                        resultEl.innerHTML = '<div style="color:#e57373"><i class="fa-solid fa-circle-exclamation"></i> ' + esc(err) + '</div>';
                    } else {
                        var html2 = '<div style="color:#4caf50;font-weight:600">✅ 成功生成 ' + successCount + ' 条</div>';
                        if (failCount > 0) {
                            html2 += '<div style="color:#ff8c42;margin-top:4px">⚠️ ' + failCount + ' 个失败：</div>';
                            errors.forEach(function (e) {
                                html2 += '<div style="opacity:.6;font-size:.9em;margin-left:8px">· ' + esc(e.name) + '：' + esc(e.error) + '</div>';
                            });
                        }
                        resultEl.innerHTML = html2;
                    }
                    var actionsEl = modal.querySelector('#om-batch-actions');
                    actionsEl.innerHTML = '<button class="om-btn om-btn-safe" id="om-batch-done">完成</button>';
                    modal.querySelector('#om-batch-done').addEventListener('click', function () {
                        removeModal();
                        fn.renderGrid();
                    });
                } else {
                    if (failCount > 0) {
                        toast('👗 AI 生成完成：' + successCount + ' 成功，' + failCount + ' 失败');
                    } else {
                        toast('👗 AI 生成完成：' + successCount + ' 条描述已就绪');
                    }
                    fn.renderGrid();
                }
            }
        );
    });
}

// ── 移动到… 面板 ─────────────────────────────────────────
// selectedIds: 要移动的 outfit id 数组
// onDone: 完成后回调
function openMoveToPanel(selectedIds, onDone) {
    var d = load();
    var count = selectedIds.length;
    var isCharView = d.currentView === 'char' && d.currentChar;
    var currentLabel = isCharView ? (d.currentChar === SHARED_CHAR_KEY ? SHARED_CHAR_LABEL : d.currentChar) : 'User';
    var isCopy = false;

    // ── 第一步：选类型 ──
    var html = '<div class="om-sheet-title"><i class="fa-solid fa-arrow-right-arrow-left"></i>移动 / 复制</div>';
    html += '<div class="om-hint" style="margin-bottom:10px">' + count + ' 套穿搭 · 来自：' + esc(currentLabel) + '</div>';
    html += '<div class="om-move-toggle">' +
        '<button class="om-move-toggle-btn on" data-mode="move"><i class="fa-solid fa-arrow-right-arrow-left"></i> 移动</button>' +
        '<button class="om-move-toggle-btn" data-mode="copy"><i class="fa-regular fa-copy"></i> 复制</button></div>';
    html += '<div class="om-divider" style="margin:10px 0"></div>';
    html += '<div class="om-cat-item om-move-type" data-type="user" style="cursor:pointer;padding:14px"><i class="fa-solid fa-user" style="opacity:.45;width:22px;text-align:center;margin-right:8px"></i><span class="om-cat-name" style="font-weight:600;font-size:1em">User 衣柜</span></div>';
    html += '<div class="om-cat-item om-move-type" data-type="char" style="cursor:pointer;padding:14px"><i class="fa-solid fa-masks-theater" style="opacity:.45;width:22px;text-align:center;margin-right:8px"></i><span class="om-cat-name" style="font-weight:600;font-size:1em">角色衣柜</span></div>';
    if (Array.isArray(d.presets) && d.presets.length > 0) {
        html += '<div class="om-divider" style="margin:10px 0"></div>';
        html += '<div class="om-cat-item om-move-type" data-type="preset" style="cursor:pointer;padding:14px"><i class="fa-solid fa-bookmark" style="opacity:.45;width:22px;text-align:center;margin-right:8px"></i><span class="om-cat-name" style="font-weight:600;font-size:1em">复制到预设</span></div>';
    }

    var sheet1 = createSheet(html);

    sheet1.querySelectorAll('.om-move-toggle-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            isCopy = btn.dataset.mode === 'copy';
            sheet1.querySelectorAll('.om-move-toggle-btn').forEach(function (b) { b.classList.toggle('on', b === btn); });
        });
    });
    sheet1.querySelectorAll('.om-move-type').forEach(function (item) {
        item.addEventListener('click', function () {
            var type = item.dataset.type;
            closeSheet(sheet1);
            openMoveDetailSheet(selectedIds, type, isCopy, onDone);
        });
    });
}

// ── 第二步：折叠式详情选择 ──
function openMoveDetailSheet(selectedIds, type, isCopy, onDone) {
    var d = load();
    var count = selectedIds.length;
    var actionWord = isCopy ? '复制' : '移动';
    var exp = {}; // 折叠状态

    function doAction(targetType, targetChar, presetIdx, targetCat, targetSub) {
        closeSheet(sheet);
        var isCurrentView = false;
        if (targetType === 'user' && (d.currentView === 'user' || !d.currentChar)) isCurrentView = true;
        if (targetType === 'char' && targetChar && d.currentView === 'char' && d.currentChar === targetChar) isCurrentView = true;
        executeMove(selectedIds, targetType, targetChar, presetIdx, targetCat, targetSub, isCurrentView, isCopy, onDone);
    }

    function buildCatTree(cats, indent) {
        var h = '';
        h += '<div class="om-acc-leaf" data-cat="" data-sub="" style="padding-left:' + indent + 'px;opacity:.55">不设分类</div>';
        (cats || []).forEach(function (catObj) {
            var catName = typeof catObj === 'object' ? catObj.name : catObj;
            var children = typeof catObj === 'object' ? (catObj.children || []) : [];
            if (children.length > 0) {
                var isOpen = exp['cat_' + catName];
                h += '<div class="om-acc-row om-acc-cat-toggle" data-key="cat_' + esc(catName) + '" style="padding-left:' + (indent - 4) + 'px"><i class="fa-solid fa-chevron-right om-acc-arrow' + (isOpen ? ' open' : '') + '"></i><span style="font-weight:600">' + esc(catName) + '</span></div>';
                if (isOpen) {
                    h += '<div class="om-acc-leaf" data-cat="' + esc(catName) + '" data-sub="" style="padding-left:' + (indent + 16) + 'px">全部' + esc(catName) + '</div>';
                    children.forEach(function (sc) {
                        h += '<div class="om-acc-leaf" data-cat="' + esc(catName) + '" data-sub="' + esc(sc) + '" style="padding-left:' + (indent + 16) + 'px"><i class="fa-solid fa-turn-up fa-rotate-90" style="font-size:.55em;opacity:.25;margin-right:5px"></i>' + esc(sc) + '</div>';
                    });
                }
            } else {
                h += '<div class="om-acc-leaf" data-cat="' + esc(catName) + '" data-sub="" style="padding-left:' + indent + 'px">' + esc(catName) + '</div>';
            }
        });
        return h;
    }

    function render() {
        var dd = load();
        var h = '';
        if (type === 'user') {
            h += buildCatTree(dd.categories, 16);
        } else if (type === 'char') {
            // 通用衣柜
            var shCd = getCharData(dd, SHARED_CHAR_KEY);
            var shOpen = exp[SHARED_CHAR_KEY];
            h += '<div class="om-acc-row om-acc-char" data-cn="' + SHARED_CHAR_KEY + '"><i class="fa-solid fa-chevron-right om-acc-arrow' + (shOpen ? ' open' : '') + '"></i><i class="fa-solid fa-globe" style="opacity:.45;margin-right:5px"></i>' + SHARED_CHAR_LABEL + '</div>';
            if (shOpen) h += buildCatTree(shCd.categories, 36);
            // 其他角色
            (dd.charNames || []).forEach(function (cn) {
                var cd = getCharData(dd, cn);
                var cOpen = exp[cn];
                h += '<div class="om-acc-row om-acc-char" data-cn="' + esc(cn) + '"><i class="fa-solid fa-chevron-right om-acc-arrow' + (cOpen ? ' open' : '') + '"></i><i class="fa-solid fa-masks-theater" style="opacity:.45;margin-right:5px"></i>' + esc(cn) + '</div>';
                if (cOpen) h += buildCatTree(cd.categories, 36);
            });
        } else if (type === 'preset') {
            (dd.presets || []).forEach(function (p, pi) {
                if (!p) return;
                var pOpen = exp['p_' + pi];
                h += '<div class="om-acc-row om-acc-preset" data-pidx="' + pi + '"><i class="fa-solid fa-chevron-right om-acc-arrow' + (pOpen ? ' open' : '') + '"></i><i class="fa-solid fa-bookmark" style="opacity:.45;margin-right:5px"></i>' + esc(p.name || '预设' + (pi + 1)) + ' <span style="opacity:.4;font-size:.85em">' + (p.outfits ? p.outfits.length : 0) + '套</span></div>';
                if (pOpen) h += buildCatTree((p && p.categories) || [], 36);
            });
        }
        return h;
    }

    function bindEvents() {
        var content = sheet.querySelector('.om-sheet-scroll') || sheet;
        // 角色折叠
        content.querySelectorAll('.om-acc-char').forEach(function (row) {
            row.addEventListener('click', function () { exp[row.dataset.cn] = !exp[row.dataset.cn]; refresh(); });
        });
        // 预设折叠
        content.querySelectorAll('.om-acc-preset').forEach(function (row) {
            row.addEventListener('click', function () { var k = 'p_' + row.dataset.pidx; exp[k] = !exp[k]; refresh(); });
        });
        // 分类折叠
        content.querySelectorAll('.om-acc-cat-toggle').forEach(function (row) {
            row.addEventListener('click', function () { exp[row.dataset.key] = !exp[row.dataset.key]; refresh(); });
        });
        // 叶子点击 → 执行
        content.querySelectorAll('.om-acc-leaf').forEach(function (leaf) {
            leaf.addEventListener('click', function () {
                var cat = leaf.dataset.cat || '';
                var sub = leaf.dataset.sub || '';
                if (type === 'user') {
                    doAction('user', '', -1, cat, sub);
                } else if (type === 'char') {
                    // 找到所属角色：向上找最近的展开的om-acc-char
                    var charName = '';
                    var prev = leaf.previousElementSibling;
                    while (prev) {
                        if (prev.classList.contains('om-acc-char') && exp[prev.dataset.cn]) { charName = prev.dataset.cn; break; }
                        prev = prev.previousElementSibling;
                    }
                    if (charName) doAction('char', charName, -1, cat, sub);
                } else if (type === 'preset') {
                    var pidx = -1;
                    var prev2 = leaf.previousElementSibling;
                    while (prev2) {
                        if (prev2.classList.contains('om-acc-preset') && exp['p_' + prev2.dataset.pidx]) { pidx = parseInt(prev2.dataset.pidx); break; }
                        prev2 = prev2.previousElementSibling;
                    }
                    if (pidx >= 0) doAction('preset', '', pidx, cat, sub);
                }
            });
        });
    }

    function refresh() {
        var scrollEl = sheet.querySelector('.om-sheet-scroll');
        var scrollTop = scrollEl ? scrollEl.scrollTop : 0;
        var body = sheet.querySelector('.om-acc-body');
        if (body) body.innerHTML = render();
        bindEvents();
        if (scrollEl) scrollEl.scrollTop = scrollTop;
    }

    var titleIcon = type === 'user' ? 'fa-user' : type === 'char' ? 'fa-masks-theater' : 'fa-bookmark';
    var titleText = type === 'user' ? (actionWord + '到 User 衣柜') : type === 'char' ? (actionWord + '到角色衣柜') : '复制到预设';

    var sheet = createSheet(
        '<div class="om-sheet-title"><i class="fa-solid ' + titleIcon + '"></i>' + titleText + '</div>' +
        '<div class="om-hint" style="margin-bottom:8px">' + count + ' 套穿搭</div>' +
        '<div class="om-acc-body">' + render() + '</div>'
    );
    bindEvents();
}

// ── 执行移动/复制 ──
function executeMove(selectedIds, targetType, targetChar, presetIdx, targetCat, targetSub, isCurrentView, isCopy, onDone) {
    var dd = load();
    var count = selectedIds.length;

    // 收集要操作的 outfit 对象
    var sourceOutfits = [];
    selectedIds.forEach(function (id) {
        var o = getById(dd, id);
        if (o) sourceOutfits.push(o);
    });

    if (sourceOutfits.length === 0) { toast('未找到穿搭', true); return; }

    if (isCurrentView && !isCopy) {
        // ── 同视角改分类 ──
        sourceOutfits.forEach(function (o) {
            o.category = targetCat;
            o.subCategory = targetSub || '';
        });
        save(dd);
        var catLabel = targetCat ? (targetSub ? '「' + targetCat + ' > ' + targetSub + '」' : '「' + targetCat + '」') : '无分类';
        toast('✅ 已将 ' + count + ' 套更改为' + catLabel);
    } else if (targetType === 'preset') {
        // ── 复制到预设（预设始终是复制）──
        var p = dd.presets[presetIdx];
        if (!p) { toast('预设不存在', true); return; }
        if (!p.outfits) p.outfits = [];
        sourceOutfits.forEach(function (o) {
            var copy = JSON.parse(JSON.stringify(o));
            copy.id = genId();
            copy.category = targetCat;
            copy.subCategory = targetSub || '';
            p.outfits.push(copy);
        });
        save(dd);
        toast('✅ 已复制 ' + count + ' 套到预设「' + (p.name || '预设') + '」');
    } else if (isCopy) {
        // ── 复制到目标 ──
        var targetOutfits2;
        if (targetType === 'char' && targetChar) {
            var tcd2 = getCharData(dd, targetChar);
            targetOutfits2 = tcd2.outfits;
            if (targetChar !== SHARED_CHAR_KEY && dd.charNames.indexOf(targetChar) === -1) dd.charNames.push(targetChar);
        } else {
            targetOutfits2 = dd.outfits;
        }
        sourceOutfits.forEach(function (o) {
            var copy = JSON.parse(JSON.stringify(o));
            copy.id = genId();
            copy.category = targetCat;
            copy.subCategory = targetSub || '';
            targetOutfits2.push(copy);
        });
        save(dd);
        var destLabel2 = (targetType === 'char' && targetChar) ? (targetChar === SHARED_CHAR_KEY ? SHARED_CHAR_LABEL : targetChar) : 'User';
        toast('✅ 已复制 ' + count + ' 套到「' + destLabel2 + '」');
    } else {
        // ── 跨视角移动（User↔Char / Char↔Char）──
        // 1) 从源位置删除
        // 从 user outfits 删
        dd.outfits = dd.outfits.filter(function (o) { return selectedIds.indexOf(o.id) === -1; });
        dd.activeIds = (dd.activeIds || []).filter(function (id) { return selectedIds.indexOf(id) === -1; });
        // 从所有 chars 删
        if (dd.chars) {
            for (var cn in dd.chars) {
                dd.chars[cn].outfits = (dd.chars[cn].outfits || []).filter(function (o) { return selectedIds.indexOf(o.id) === -1; });
                dd.chars[cn].activeIds = (dd.chars[cn].activeIds || []).filter(function (id) { return selectedIds.indexOf(id) === -1; });
            }
        }

        // 2) 插入目标位置
        var targetOutfits;
        if (targetType === 'char' && targetChar) {
            var tcd = getCharData(dd, targetChar);
            targetOutfits = tcd.outfits;
            if (targetChar !== SHARED_CHAR_KEY && dd.charNames.indexOf(targetChar) === -1) dd.charNames.push(targetChar);
        } else {
            targetOutfits = dd.outfits;
        }

        sourceOutfits.forEach(function (o) {
            o.category = targetCat;
            o.subCategory = targetSub || '';
            targetOutfits.push(o);
        });

        save(dd);
        var destLabel = (targetType === 'char' && targetChar) ? (targetChar === SHARED_CHAR_KEY ? SHARED_CHAR_LABEL : targetChar) : 'User';
        toast('✅ 已移动 ' + count + ' 套到「' + destLabel + '」');
    }

    if (onDone) onDone();
}

// ── 导出 ──────────────────────────────────────────────────
export { openBatchDescModal, openBatchTagPanel, openBatchImportModal, openMoveToPanel };
export { exportData, importData, processImport };

export function registerBatchFn() {
    fn.openBatchDescModal = openBatchDescModal;
    fn.openBatchTagPanel = openBatchTagPanel;
    fn.openBatchImportModal = openBatchImportModal;
    fn.openMoveToPanel = openMoveToPanel;
    fn.exportData = exportData;
    fn.importData = importData;
}
