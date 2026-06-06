// 穿搭管理扩展 v19 - SillyTavern Extension
// ★ v19 改进：
//   1. 合并注入：User+Char穿搭拼成一条文本后统一注入，避免多条system被忽略
//   2. 强化模板：默认模板加入角色扮演指令格式，Gemini/DeepSeek/Claude均能识别
//   3. 默认注入位置改为user（用户消息末尾），Gemini兼容性最佳
//   4. 保留v18全部功能

(function () {

    var SCRIPT_NAME = '穿搭管理';
    var BTN_ID = 'outfit-mgr-ext-btn-v4';
    var DB_NAME = 'outfit_mgr_db';
    var DB_VERSION = 1;
    var STORE_NAME = 'data';
    var DATA_KEY = 'main';
    var MAX_IMG_WIDTH = 800;
    var IMG_QUALITY = 0.75;
    var FAB_ID = 'om-fab-main';

    var dbInstance = null;
    var dataCache = null;
    var darkMode = false; // 默认浅色
    // 获取弹层容器（overlay内部的absolute层，不受overflow:hidden影响因为overlay本身没有overflow）
    function getPopupLayer() {
        // 首选overlay内的slot
        var slot = document.getElementById('om-popup-slot');
        if (slot) return slot;
        // 回退：overlay本身
        var ov = document.querySelector('.om-overlay');
        if (ov) return ov;
        // 最后回退：body
        return document.body;
    }

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

    function loadFromDB(cb) {
        if (dataCache) { cb(dataCache); return; }
        openDB(function (db) {
            if (!db) { dataCache = ensureDefaults(loadFromLS()); cb(dataCache); return; }
            var tx = db.transaction(STORE_NAME, 'readonly');
            var req = tx.objectStore(STORE_NAME).get(DATA_KEY);
            req.onsuccess = function () { dataCache = ensureDefaults(req.result || loadFromLS()); cb(dataCache); };
            req.onerror = function () { dataCache = ensureDefaults(loadFromLS()); cb(dataCache); };
        });
    }

    function saveToDB(d, cb) {
        dataCache = d;
        openDB(function (db) {
            if (!db) { try { localStorage.setItem('outfit_mgr_v4', JSON.stringify(d)); } catch (e) {} if (cb) cb(); return; }
            var tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(d, DATA_KEY);
            tx.oncomplete = function () { if (cb) cb(); };
            tx.onerror = function () { if (cb) cb(); };
        });
    }

    function load() {
        if (dataCache) return dataCache;
        dataCache = ensureDefaults(loadFromLS());
        return dataCache;
    }

    function save(d) { dataCache = d; saveToDB(d); }

    function loadFromLS() {
        try { var r = localStorage.getItem('outfit_mgr_v4'); return r ? JSON.parse(r) : null; } catch (e) { return null; }
    }

    function ensureDefaults(d) {
        var dd = def();
        if (!d) return dd;
        for (var k in dd) { if (d[k] === undefined) d[k] = dd[k]; }
        if (d.activeId && !d.activeIds) d.activeIds = [d.activeId];
        if (!Array.isArray(d.activeIds)) d.activeIds = [];
        if (!Array.isArray(d.presets)) d.presets = [];
        if (!d.chars) d.chars = {};
        if (!d.charNames) d.charNames = [];
        if (!d.apiVision) d.apiVision = def().apiVision;
        else { var dv = def().apiVision; for (var vk in dv) { if (d.apiVision[vk] === undefined) d.apiVision[vk] = dv[vk]; } if (d.apiVision.batchSize && !d.apiVision.concurrency) { d.apiVision.concurrency = Math.min(d.apiVision.batchSize, 5); } delete d.apiVision.batchSize; }
        // v17→v18迁移：把带owner的穿搭移入chars
        migrateV17(d);
        return d;
    }

    function def() {
        return {
            // User 数据（预设只管这块）
            outfits: [],
            categories: [],
            activeIds: [],
            presets: [],
            activePresetId: null,
            // Char 数据（独立存储，不受预设影响）
            chars: {},           // { '角色名': { outfits:[], categories:[], activeIds:[] } }
            charNames: [],       // 角色名列表
            charFavorites: [],   // 收藏的角色名（预留）
            charGroups: {},      // 分组（预留）：{ '组名': ['角色名1','角色名2'] }
            // 界面状态
            currentView: 'user',
            currentChar: '',
            showBall: true,
            // 注入配置
            mode: 'text',
            injectPosition: 'user',
            singleTemplate: '[User当前穿着]\n{{description}}\n（禁止编造其他服装。严禁集中罗列服装信息，服装细节必须分散融入不同的动作、触感、环境互动中，每次只带出一两个细节。）',
            multiTemplate: '[User的可选穿搭]\n{{wardrobe}}\n（禁止编造以上之外的服装。根据场景标签匹配穿搭，若回复中出现场景转换则对应切换穿搭。严禁集中罗列服装信息，服装细节必须分散融入动作、触感、环境互动中，每次只带出一两个细节。）',
            charSingleTemplate: '[{{charName}}当前穿着]\n{{description}}\n（禁止编造其他服装。严禁集中罗列服装信息，服装细节必须分散融入不同的动作、触感、环境互动中，每次只带出一两个细节。）',
            charMultiTemplate: '[{{charName}}的可选穿搭]\n{{wardrobe}}\n（禁止编造以上之外的服装。根据场景标签匹配穿搭，若回复中出现场景转换则对应切换穿搭。严禁集中罗列服装信息，服装细节必须分散融入动作、触感、环境互动中，每次只带出一两个细节。）',
            imagePrompt: '图中为角色当前穿着，禁止编造其他服装。严禁集中罗列，服装细节必须分散融入动作、触感、环境互动中，每次只带出一两个细节。',
            multiImagePrompt: '以上图片为可选穿搭，根据场景标签匹配，场景转换则切换穿搭，禁止编造其他服装。严禁集中罗列，细节分散融入动作和互动中。',
            debug: false,
            // API
            apiVision: { endpoint: '', key: '', model: '', concurrency: 3, prompt: '请用中文详细描述这张穿搭图片中的服装。包括：服装类型、颜色、材质、款式细节、搭配方式等。只描述服装本身，不描述人物外貌。每套穿搭的描述控制在100-200字。', overwrite: false }
        };
    }

    function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }

    // ── Char数据访问辅助 ────────────────────────────────────────
    function getCharData(d, charName) {
        if (!d.chars) d.chars = {};
        if (!d.chars[charName]) d.chars[charName] = { outfits: [], categories: [], activeIds: [] };
        return d.chars[charName];
    }

    // 当前视角是user还是某个角色
    function currentOwner(d) {
        if (d.currentView === 'char' && d.currentChar) return d.currentChar;
        return 'user';
    }

    // 获取当前视角的穿搭列表
    function getViewOutfits(d) {
        if (d.currentView === 'char' && d.currentChar) return getCharData(d, d.currentChar).outfits;
        return d.outfits;
    }

    // 获取当前视角的分类列表
    function getViewCategories(d) {
        if (d.currentView === 'char' && d.currentChar) return getCharData(d, d.currentChar).categories;
        return d.categories;
    }

    // 获取当前视角的activeIds
    function getViewActiveIds(d) {
        if (d.currentView === 'char' && d.currentChar) return getCharData(d, d.currentChar).activeIds;
        return d.activeIds;
    }

    // 设置当前视角的activeIds
    function setViewActiveIds(d, ids) {
        if (d.currentView === 'char' && d.currentChar) { getCharData(d, d.currentChar).activeIds = ids; }
        else { d.activeIds = ids; }
    }

    // 按id查找穿搭（在所有数据中查找）
    function getById(d, id) {
        for (var i = 0; i < d.outfits.length; i++) { if (d.outfits[i].id === id) return d.outfits[i]; }
        if (d.chars) { for (var cn in d.chars) { var co = d.chars[cn].outfits || []; for (var j = 0; j < co.length; j++) { if (co[j].id === id) return co[j]; } } }
        return null;
    }

    // 按id查找穿搭（仅当前视角）
    function getViewById(d, id) {
        var list = getViewOutfits(d);
        for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
        return null;
    }

    // 判断是否激活（当前视角）
    function isActive(d, id) {
        return getViewActiveIds(d).indexOf(id) !== -1;
    }

    // v17兼容：迁移旧数据中带owner字段的穿搭到chars结构
    function migrateV17(d) {
        if (!d.outfits) return;
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
        // 迁移 charActiveIds
        if (d.charActiveIds) {
            for (var cn2 in d.charActiveIds) {
                if (!d.chars[cn2]) d.chars[cn2] = { outfits: [], categories: [], activeIds: [] };
                d.chars[cn2].activeIds = d.charActiveIds[cn2];
            }
            delete d.charActiveIds;
        }
    }

    // ── 图片压缩 ─────────────────────────────────────────────
    function compressImage(dataUrl, cb) {
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

    // ── Toast ─────────────────────────────────────────────────
    function toast(msg, isErr) {
        var el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'position:absolute !important;bottom:96px !important;left:50% !important;' +
            'transform:translateX(-50%) translateY(8px) !important;' +
            'background:' + (isErr ? '#e57373' : 'var(--SmartThemeQuoteColor,#7c6daf)') + ' !important;' +
            'color:#fff !important;padding:8px 20px !important;border-radius:20px !important;' +
            'font-size:13px !important;font-weight:600 !important;z-index:2147483649 !important;' +
            'box-shadow:0 4px 16px rgba(0,0,0,.4) !important;white-space:nowrap !important;' +
            'pointer-events:none !important;opacity:0 !important;transition:all .22s !important;';
        // 优先挂在 overlay 内
        getPopupLayer().appendChild(el);
        setTimeout(function () {
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('transform', 'translateX(-50%) translateY(0)', 'important');
        }, 10);
        setTimeout(function () { el.style.setProperty('opacity', '0', 'important'); }, 2400);
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2700);
    }

    // ── CSS ───────────────────────────────────────────────────
    function injectStyles() {
        var old = document.getElementById('om-style-v4');
        if (old) old.parentNode.removeChild(old);
        var s = document.createElement('style');
        s.id = 'om-style-v4';
        s.textContent = [
            /* ══ 全屏主界面 ══ */
            '@keyframes om-fadein{from{opacity:0}to{opacity:1}}',
            '@keyframes om-sheet-up{from{transform:translateY(100%)}to{transform:translateY(0)}}',
            '@keyframes om-popin{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}',

            /* 全屏遮罩/容器 */
            '.om-light{--om-bg:#f5f5f7;--om-bg2:#ececef;--om-text:#111;--om-border:rgba(0,0,0,.1);--om-card-bg:rgba(0,0,0,.04);--om-head-bg:rgba(255,255,255,.8);}',
            '.om-dark{--om-bg:#16161a;--om-bg2:#1e1e24;--om-text:#eee;--om-border:rgba(255,255,255,.08);--om-card-bg:rgba(255,255,255,.05);--om-head-bg:rgba(0,0,0,.3);}',
            '.om-overlay{position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100dvh;z-index:2147483647;',
            'background:var(--om-bg,var(--SmartThemeBackgroundColor,#16161a));',
            'color:var(--om-text,var(--SmartThemeBodyColor,#eee));',
            'display:flex;flex-direction:column;color:var(--SmartThemeBodyColor,#eee);',
            'animation:om-fadein .18s ease;font-size:14px;}',

            /* 主框 全屏填满 */
            '.om-box{width:100%;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;}',

            /* ══ 顶栏 ══ */
            '.om-head{display:flex;align-items:center;gap:8px;padding:12px 15px;flex-shrink:0;',
            'border-bottom:1px solid rgba(127,127,127,.1);background:rgba(0,0,0,.12);}',
            '.om-head-title{font-weight:700;font-size:1.05em;display:flex;align-items:center;gap:7px;flex:1;min-width:0;}',
            '.om-head-title i{color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-head-actions{display:flex;align-items:center;gap:4px;}',
            '.om-icon-btn{cursor:pointer;background:none;border:none;opacity:.55;font-size:1.15em;',
            'width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
            'transition:.18s;color:inherit;flex-shrink:0;}',
            '.om-icon-btn:hover{opacity:1;background:rgba(127,127,127,.12);color:var(--SmartThemeQuoteColor,#7c6daf);}',
            /* 日夜切换 */
            '.om-theme-btn{cursor:pointer;background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.2);',
            'border-radius:14px;padding:4px 10px;font-size:.75em;display:flex;align-items:center;gap:5px;',
            'transition:.2s;color:inherit;flex-shrink:0;height:28px;white-space:nowrap;}',
            '.om-theme-btn:hover{background:rgba(127,127,127,.2);}',,

            /* 搜索框（顶栏下方展开）*/
            '.om-search-bar{display:none;padding:8px 15px;border-bottom:1px solid rgba(127,127,127,.08);',
            'background:rgba(0,0,0,.06);flex-shrink:0;}',
            '.om-search-bar.open{display:flex;align-items:center;gap:8px;}',
            '.om-search-wrap{flex:1;position:relative;display:flex;align-items:center;}',
            '.om-search-wrap i{position:absolute;left:10px;opacity:.4;font-size:.85em;pointer-events:none;}',
            '.om-search-inp{width:100%;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);',
            'border-radius:8px;color:inherit;padding:7px 32px 7px 30px;font-size:.85em;font-family:inherit;box-sizing:border-box;}',
            '.om-search-inp:focus{outline:none;border-color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-search-clear{background:none;border:none;color:inherit;opacity:.4;cursor:pointer;font-size:.9em;padding:4px;line-height:1;}',
            '.om-search-clear:hover{opacity:.9;}',

            /* ══ 视角切换栏 ══ */
            '.om-viewbar{display:flex;align-items:center;gap:6px;padding:8px 15px;flex-shrink:0;',
            'border-bottom:1px solid rgba(127,127,127,.08);}',
            '.om-viewtab{padding:5px 16px;border-radius:18px;font-size:.78em;cursor:pointer;white-space:nowrap;',
            'border:1px solid rgba(127,127,127,.15);background:rgba(127,127,127,.06);transition:all .15s;color:inherit;font-family:inherit;}',
            '.om-viewtab:hover{border-color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-viewtab.on{background:var(--SmartThemeQuoteColor,#7c6daf);color:#fff;border-color:var(--SmartThemeQuoteColor,#7c6daf);font-weight:600;}',
            '.om-char-sel{flex:1;min-width:0;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);',
            'border-radius:8px;color:inherit;padding:5px 10px;font-size:.78em;font-family:inherit;}',
            '.om-char-sel:focus{outline:none;border-color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-char-add-btn{background:none;border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;',
            'cursor:pointer;padding:5px 10px;font-size:.78em;white-space:nowrap;font-family:inherit;}',
            '.om-char-add-btn:hover{border-color:var(--SmartThemeQuoteColor,#7c6daf);}',

            /* ══ 角色选择面板 ══ */
            /* viewbar内的角色搜索框 */
            '.om-char-input{flex:1;min-width:0;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);',
            'border-radius:8px;color:inherit;padding:5px 10px;font-size:.78em;font-family:inherit;box-sizing:border-box;}',
            '.om-char-input:focus{outline:none;border-color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-char-input::placeholder{opacity:.4;}',
            /* 下拉列表容器 */
            '.om-char-dropdown{position:absolute;left:0;right:0;top:100%;z-index:50;',
            'background:var(--om-bg,#1a1a20);border-bottom:1px solid rgba(127,127,127,.15);',
            'max-height:50vh;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,.2);}',
            '.om-light .om-char-dropdown{background:var(--om-bg,#f4f4f6);}',
            /* 分组标题 */
            '.om-char-group-hdr{display:flex;align-items:center;gap:6px;padding:7px 12px 4px;cursor:pointer;font-size:.78em;font-weight:600;opacity:.5;}',
            '.om-char-group-hdr:hover{opacity:.7;}',
            '.om-char-group-hdr i.om-g-arrow{font-size:.7em;transition:transform .15s;width:10px;text-align:center;}',
            '.om-char-group-hdr i.om-g-arrow.collapsed{transform:rotate(-90deg);}',
            '.om-char-group-hdr i.om-g-icon{font-size:.75em;opacity:.6;}',
            /* 角色行 */
            '.om-char-row{display:flex;align-items:center;gap:8px;padding:9px 12px 9px 20px;cursor:pointer;',
            'transition:background .1s;font-size:.9em;}',
            '.om-char-row:hover{background:rgba(127,127,127,.08);}',
            '.om-char-row.active{background:rgba(124,109,175,.1);}',
            '.om-char-star{cursor:pointer;opacity:.25;flex-shrink:0;width:20px;text-align:center;font-size:.85em;}',
            '.om-char-star.on{opacity:.8;color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-char-rname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.om-char-count{font-size:.78em;opacity:.4;flex-shrink:0;min-width:28px;text-align:right;}',
            '.om-char-actions{display:flex;gap:2px;flex-shrink:0;}',
            '.om-char-act{background:none;border:none;color:inherit;cursor:pointer;opacity:.25;font-size:.82em;padding:3px 5px;border-radius:4px;transition:.15s;}',
            '.om-char-act:hover{opacity:.85;background:rgba(127,127,127,.15);}',
            '.om-char-act.om-char-delete:hover{opacity:1;color:#e57373;background:rgba(229,115,115,.12);}',
            '.om-char-empty{text-align:center;opacity:.3;font-size:.85em;padding:18px 15px;}',

            /* ══ 分类栏 ══ */
            '.om-catbar{display:flex;gap:6px;padding:8px 15px;overflow-x:auto;flex-wrap:nowrap;flex-shrink:0;',
            '-webkit-overflow-scrolling:touch;scrollbar-width:none;',
            'border-bottom:1px solid rgba(127,127,127,.08);}',
            '.om-catbar::-webkit-scrollbar{display:none;}',
            '.om-catbtn{padding:5px 14px;border-radius:18px;font-size:.78em;cursor:pointer;white-space:nowrap;flex-shrink:0;',
            'border:1px solid rgba(127,127,127,.15);background:rgba(127,127,127,.06);transition:all .15s;color:inherit;font-family:inherit;}',
            '.om-catbtn:hover{border-color:var(--SmartThemeQuoteColor,#7c6daf);color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-catbtn.on{background:var(--SmartThemeQuoteColor,#7c6daf);color:#fff;border-color:var(--SmartThemeQuoteColor,#7c6daf);font-weight:600;}',

            /* ══ 网格区（独立滚动）══ */
            '.om-grid-area{flex:1;overflow-y:auto;padding:12px 12px 8px;}',
            '.om-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:9px;}',

            /* ══ 添加卡片 ══ */
            '.om-add-card{border:2px dashed rgba(127,127,127,.22);border-radius:10px;',
            'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;',
            'cursor:pointer;opacity:.55;transition:all .2s;font-size:.8em;color:inherit;}',
            '.om-add-card:hover{opacity:1;border-color:var(--SmartThemeQuoteColor,#7c6daf);',
            'color:var(--SmartThemeQuoteColor,#7c6daf);background:rgba(127,127,127,.04);}',
            '.om-add-card i{font-size:1.4em;}',

            /* ══ 穿搭卡片 ══ */
            '.om-card{border-radius:10px;overflow:hidden;position:relative;cursor:pointer;',
            'transition:all .18s;border:2px solid transparent;display:flex;flex-direction:column;}',
            '.om-card:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.25);}',
            '.om-card.on{border-color:var(--SmartThemeQuoteColor,#7c6daf);',
            'box-shadow:0 0 0 1px var(--SmartThemeQuoteColor,#7c6daf),0 4px 16px rgba(0,0,0,.2);}',
            /* 图片区 */
            '.om-card-img{width:100%;aspect-ratio:3/4;position:relative;background:rgba(127,127,127,.1);',
            'display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;}',
            '.om-card-img img{width:100%;height:100%;object-fit:cover;display:block;}',
            /* 底部渐变文字遮罩 */
            /* 触屏：点击过的卡片菜单常显 */
            '@media (hover:none){.om-card-menu{opacity:.75 !important;}}',
            '.om-card-info{padding:5px 7px 6px;background:var(--om-card-bg,rgba(127,127,127,.06));min-height:36px;box-sizing:border-box;}',
            '.om-card-name{font-size:.8em;font-weight:600;line-height:1.3;',
            'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
            'color:var(--om-text,#eee);}',
            '.om-card-tag{font-size:.68em;line-height:1.2;margin-top:2px;',
            'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
            'color:var(--om-text,#aaa);opacity:.5;}',
            /* 无图片占位 - 显示描述摘要 */
            '.om-card-noimg{display:flex;flex-direction:column;align-items:flex-start;gap:5px;',
            'width:100%;height:100%;justify-content:flex-start;padding:12px 12px 32px 12px;box-sizing:border-box;',
            'background:linear-gradient(135deg,rgba(127,127,127,.08) 0%,rgba(127,127,127,.03) 100%);}',
            '.om-card-noimg .om-noimg-name{font-size:.88em;font-weight:700;line-height:1.3;',
            'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;',
            'word-break:break-all;color:var(--om-text,#eee);}',
            '.om-card-noimg .om-noimg-desc{font-size:.78em;line-height:1.45;opacity:.55;',
            'display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden;',
            'word-break:break-all;color:var(--om-text,#ccc);}',
            '.om-card-noimg .om-noimg-icon{font-size:1.2em;opacity:.2;position:absolute;bottom:8px;right:8px;}',
            /* 有文字描述但无图片时显示背景 */
            '.om-card.no-img{background:var(--om-card-bg,rgba(127,127,127,.06));}',
            '.om-card.no-img .om-card-info{display:none;}',
            '.om-card.no-img .om-card-img{aspect-ratio:unset;flex:1;min-height:0;}',
            /* 选中角标 */
            '.om-badge-on{position:absolute;top:5px;right:5px;',
            'width:20px;height:20px;border-radius:50%;',
            'background:var(--SmartThemeQuoteColor,#7c6daf);color:#fff;',
            'display:flex;align-items:center;justify-content:center;font-size:.6em;',
            'box-shadow:0 2px 6px rgba(0,0,0,.3);}',
            /* 批量选择框 */
            '.om-card-check{position:absolute;top:5px;left:5px;',
            'width:20px;height:20px;border-radius:6px;border:2px solid rgba(255,255,255,.7);',
            'background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;',
            'cursor:pointer;transition:.15s;z-index:2;}',
            '.om-card-check.checked{background:var(--SmartThemeQuoteColor,#7c6daf);border-color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-card-check i{font-size:.65em;color:#fff;opacity:0;transition:.12s;}',
            '.om-card-check.checked i{opacity:1;}',
            '.om-card.batch-sel{border:2px solid var(--SmartThemeQuoteColor,#7c6daf);}',

            /* 卡片菜单按钮 - 右下角，不与对号冲突 */
            '.om-card-menu{position:absolute;bottom:5px;right:5px;',
            'width:20px;height:20px;border-radius:50%;',
            'background:rgba(0,0,0,.5);color:#fff;border:none;cursor:pointer;',
            'display:flex;align-items:center;justify-content:center;font-size:.55em;line-height:1;overflow:hidden;',
            'opacity:0;transition:opacity .18s;z-index:3;pointer-events:auto;',
            'backdrop-filter:blur(4px);box-shadow:0 2px 6px rgba(0,0,0,.3);}',
            '.om-card:hover .om-card-menu,.om-card:active .om-card-menu{opacity:1;}',
            '.om-card-menu:hover{background:rgba(0,0,0,.75);}',

            /* ══ 批量操作栏（网格区顶部，随滚动）══ */
            '.om-batch-bar{display:flex;align-items:center;gap:6px;padding:8px 10px;',
            'background:rgba(124,109,175,.08);border:1px solid rgba(124,109,175,.2);',
            'border-radius:10px;margin-bottom:10px;flex-wrap:nowrap;overflow-x:auto;',
            '-webkit-overflow-scrolling:touch;scrollbar-width:none;}',
            '.om-batch-bar::-webkit-scrollbar{display:none;}',
            '.om-batch-info{font-size:.82em;font-weight:600;color:var(--SmartThemeQuoteColor,#7c6daf);white-space:nowrap;flex-shrink:0;}',
            '.om-batch-acts{display:flex;gap:5px;flex-shrink:0;flex-wrap:nowrap;}',
            '.om-batch-btn{padding:5px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.2);',
            'background:rgba(127,127,127,.07);color:inherit;cursor:pointer;font-size:.78em;',
            'font-family:inherit;transition:.15s;white-space:nowrap;flex-shrink:0;}',
            '.om-batch-btn:hover{background:rgba(127,127,127,.15);border-color:var(--SmartThemeQuoteColor,#7c6daf);color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-batch-btn.danger{color:#e57373;border-color:rgba(229,115,115,.35);}',
            '.om-batch-btn.danger:hover{background:#e57373;color:#fff;border-color:#e57373;}',

            /* 空状态 */
            '.om-empty{text-align:center;padding:40px 0;opacity:.45;display:flex;flex-direction:column;gap:10px;align-items:center;font-size:.88em;}',
            '.om-empty i{font-size:2.6em;}',

            /* ══ 底栏 ══ */
            '.om-bottombar{display:flex !important;align-items:center;gap:6px;padding:10px 14px;flex-shrink:0;',
            'border-top:1px solid rgba(127,127,127,.1);background:rgba(0,0,0,.12);}',
            '.om-bottom-status{flex:1;min-width:0;display:flex;align-items:center;gap:7px;',
            'cursor:pointer;border-radius:8px;padding:5px 7px;transition:.15s;',
            'border:1px solid transparent;}',
            '.om-bottom-status:hover{background:rgba(127,127,127,.08);border-color:rgba(127,127,127,.12);}',
            '.om-status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}',
            '.om-status-dot.gray{background:rgba(127,127,127,.5);}',
            '.om-status-dot.green{background:#4caf50;}',
            '.om-status-dot.orange{background:#ff8c42;}',
            '.om-status-text{font-size:.82em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.9;}',
            '.om-status-clear{margin-left:4px;background:none;border:none;font-size:.75em;color:inherit;',
            'opacity:.5;cursor:pointer;white-space:nowrap;padding:2px 5px;border-radius:4px;font-family:inherit;flex-shrink:0;}',
            '.om-status-clear:hover{opacity:1;background:rgba(127,127,127,.1);}',
            '.om-bottom-btn{width:36px;height:36px;border-radius:50%;border:1px solid rgba(127,127,127,.15);',
            'background:rgba(127,127,127,.06);color:inherit;cursor:pointer;',
            'display:flex;align-items:center;justify-content:center;font-size:.9em;',
            'transition:.18s;flex-shrink:0;}',
            '.om-bottom-btn:hover{background:rgba(127,127,127,.15);border-color:var(--SmartThemeQuoteColor,#7c6daf);',
            'color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-batch-toggle-btn{padding:6px 11px;border-radius:18px;border:1px solid rgba(127,127,127,.2);',
            'background:rgba(127,127,127,.07);color:inherit;cursor:pointer;font-size:.75em;',
            'white-space:nowrap;font-family:inherit;transition:.15s;flex-shrink:0;}',
            '.om-batch-toggle-btn:hover{border-color:var(--SmartThemeQuoteColor,#7c6daf);color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-batch-toggle-btn.on{background:var(--SmartThemeQuoteColor,#7c6daf);color:#fff;border-color:var(--SmartThemeQuoteColor,#7c6daf);}',

            /* ══ 选择详情面板（从底栏上方弹出）══ */
            '.om-detail-panel{position:absolute;bottom:0;left:0;right:0;',
            'background:var(--om-bg2,var(--SmartThemeBackgroundColor,rgba(28,28,32,1)));',
            'border-radius:16px 16px 0 0;padding:14px 16px 16px;',
            'box-shadow:0 -4px 24px rgba(0,0,0,.3);',
            'animation:om-sheet-up .22s ease;border-top:1px solid rgba(127,127,127,.15);}',
            '.om-detail-handle{width:32px;height:4px;border-radius:2px;',
            'background:rgba(127,127,127,.25);margin:0 auto 12px;}',
            '.om-detail-title{font-size:.78em;font-weight:700;opacity:.55;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;}',
            '.om-detail-tags{display:flex;flex-wrap:wrap;gap:6px;}',
            '.om-detail-tag{display:inline-flex;align-items:center;gap:5px;',
            'padding:4px 6px 4px 10px;border-radius:14px;',
            'background:var(--SmartThemeQuoteColor,#7c6daf);color:#fff;font-size:.78em;font-weight:600;}',
            '.om-detail-tag-x{background:none;border:none;color:#fff;cursor:pointer;',
            'font-size:.9em;line-height:1;padding:0 2px;opacity:.75;font-family:inherit;}',
            '.om-detail-tag-x:hover{opacity:1;}',

            /* ══ Bottom Sheet 通用 ══ */
            '.om-sheet-overlay{position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;pointer-events:auto !important;}',
            '.om-sheet{position:absolute;bottom:0;left:0;right:0;max-height:88vh;max-height:88dvh;',
            'background:var(--om-bg2,var(--SmartThemeBackgroundColor,#1a1a1e));',
            'color:var(--om-text,var(--SmartThemeBodyColor,#eee));',
            'border-radius:18px 18px 0 0;overflow-y:auto;',
            'animation:om-sheet-up .25s ease;border:1px solid rgba(127,127,127,.15);border-bottom:none;}',
            '.om-sheet-handle{width:36px;height:4px;border-radius:2px;',
            'background:rgba(127,127,127,.25);margin:10px auto 4px;}',
            '.om-sheet-content{padding:4px 20px 32px;}',
            '.om-sheet-title{font-weight:700;font-size:1.05em;padding:10px 0 14px;',
            'display:flex;align-items:center;gap:8px;}',
            '.om-sheet-title i{color:var(--SmartThemeQuoteColor,#7c6daf);}',

            /* ══ 长按操作菜单 Bottom Sheet ══ */
            '.om-ctx-item{display:flex;align-items:center;gap:12px;padding:14px 4px;',
            'cursor:pointer;border-bottom:1px solid rgba(127,127,127,.08);transition:.15s;border-radius:0;}',
            '.om-ctx-item:last-child{border-bottom:none;}',
            '.om-ctx-item:hover{color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-ctx-item i{width:20px;text-align:center;opacity:.75;font-size:1em;}',
            '.om-ctx-item.danger{color:#e57373;}',
            '.om-ctx-item.danger:hover{color:#ef5350;}',
            '.om-ctx-outfit-name{font-size:.85em;opacity:.5;padding:2px 0 10px;',
            'border-bottom:1px solid rgba(127,127,127,.1);margin-bottom:4px;}',

            /* ══ 通用组件 ══ */
            '.om-sec-title{font-size:.75em;font-weight:700;opacity:.55;text-transform:uppercase;',
            'letter-spacing:.07em;padding:10px 0 7px;}',
            '.om-divider{height:1px;background:rgba(127,127,127,.12);margin:6px 0 12px;}',
            '.om-hint{font-size:.76em;opacity:.5;line-height:1.4;}',
            '.om-btn-row{display:flex;gap:8px;flex-wrap:wrap;}',
            '.om-btn{padding:8px 16px;border-radius:8px;border:none;cursor:pointer;',
            'font-size:.87em;font-weight:600;transition:.18s;font-family:inherit;}',
            '.om-btn-safe{background:var(--SmartThemeQuoteColor,#7c6daf);color:#fff;}',
            '.om-btn-safe:hover{filter:brightness(1.1);box-shadow:0 3px 10px rgba(0,0,0,.15);}',
            '.om-btn-outline{background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.22);color:inherit;}',
            '.om-btn-outline:hover{background:rgba(127,127,127,.15);border-color:var(--SmartThemeQuoteColor,#7c6daf);color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-btn-danger{background:rgba(229,115,115,.1);border:1px solid #e57373;color:#e57373;}',
            '.om-btn-danger:hover{background:#e57373;color:#fff;}',
            /* 输入 */
            '.om-setting-row{display:flex;flex-direction:column;gap:5px;margin-bottom:4px;}',
            '.om-setting-row label{font-size:.8em;opacity:.7;}',
            '.om-setting-row select,.om-setting-row textarea{background:rgba(127,127,127,.08);',
            'border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;',
            'padding:7px 10px;font-size:.85em;width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;}',
            '.om-setting-row select:focus,.om-setting-row textarea:focus{outline:none;border-color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-row-inline{flex-direction:row!important;align-items:center;justify-content:space-between;}',
            '.om-row-inline label{opacity:.8;font-size:.88em;}',
            '.om-chk{width:17px;height:17px;accent-color:var(--SmartThemeQuoteColor,#7c6daf);cursor:pointer;}',
            '.om-storage-info{font-size:.72em;opacity:.45;padding:4px 0;}',
            /* 编辑表单 */
            '.om-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;}',
            '.om-field label{font-size:.8em;opacity:.7;font-weight:500;}',
            '.om-field input[type=text],.om-field select,.om-field textarea{',
            'background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);',
            'border-radius:8px;color:inherit;padding:9px 11px;font-size:.9em;width:100%;box-sizing:border-box;font-family:inherit;}',
            '.om-field textarea{resize:none;}',
            '.om-field input:focus,.om-field select:focus,.om-field textarea:focus{outline:none;border-color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-frow{display:flex;gap:7px;align-items:stretch;}',
            '.om-frow select{flex:1;}',
            '.om-imgarea{width:100%;height:160px;background:rgba(127,127,127,.06);',
            'border:2px dashed rgba(127,127,127,.25);border-radius:10px;',
            'display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;transition:border-color .18s;}',
            '.om-imgarea:hover,.om-imgarea.drag{border-color:var(--SmartThemeQuoteColor,#7c6daf);background:rgba(127,127,127,.1);}',
            '.om-imgph{display:flex;flex-direction:column;align-items:center;gap:6px;opacity:.4;font-size:.82em;pointer-events:none;}',
            '.om-imgph i{font-size:1.8em;}',
            '.om-imgarea img{width:100%;height:100%;object-fit:contain;}',
            '.om-img-actions{display:flex;gap:7px;margin-top:7px;}',
            '.om-edit-foot{display:flex;gap:9px;justify-content:flex-end;padding-top:14px;',
            'border-top:1px solid rgba(127,127,127,.1);margin-top:10px;}',
            /* 场景标签建议 */
            '.om-suggest-wrap{position:relative;width:100%;}',
            '.om-suggest-wrap input{width:100%;box-sizing:border-box;}',
            '.om-suggest-list{position:absolute;top:100%;left:0;right:0;',
            'background:var(--om-bg2,var(--SmartThemeBackgroundColor,rgba(40,40,40,.98)));',
            'border:1px solid rgba(127,127,127,.22);border-radius:8px;margin-top:3px;',
            'z-index:200;max-height:160px;overflow-y:auto;box-shadow:0 6px 20px rgba(0,0,0,.25);}',
            '.om-suggest-item{padding:8px 12px;font-size:.85em;cursor:pointer;transition:.12s;color:var(--SmartThemeBodyColor,inherit);}',
            '.om-suggest-item:hover{background:rgba(127,127,127,.15);color:var(--SmartThemeQuoteColor,#7c6daf);}',
            /* 分类管理 */
            '.om-cat-item{display:flex;align-items:center;gap:8px;padding:9px 12px;',
            'background:rgba(127,127,127,.06);border-radius:9px;',
            'border:1px solid rgba(127,127,127,.1);transition:all .15s;margin-bottom:7px;}',
            '.om-cat-item:hover{background:rgba(127,127,127,.11);}',
            '.om-cat-name{flex:1;font-size:.88em;}',
            '.om-cat-count{font-size:.74em;opacity:.45;}',
            '.om-cat-add-row{display:flex;gap:8px;}',
            '.om-cat-add-row input{flex:1;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);',
            'border-radius:8px;color:inherit;padding:8px 11px;font-size:.88em;font-family:inherit;box-sizing:border-box;}',
            '.om-cat-add-row input:focus{outline:none;border-color:var(--SmartThemeQuoteColor,#7c6daf);}',
            /* 预设 */
            '.om-preset-item{display:flex;align-items:center;gap:8px;padding:10px 14px;',
            'background:rgba(127,127,127,.06);border-radius:9px;border:1px solid rgba(127,127,127,.1);',
            'transition:all .15s;cursor:pointer;margin-bottom:7px;}',
            '.om-preset-item:hover{background:rgba(127,127,127,.12);border-color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-preset-name{flex:1;font-size:.9em;font-weight:600;}',
            '.om-preset-count{font-size:.74em;opacity:.5;white-space:nowrap;}',
            '.om-preset-item.current{border-color:var(--SmartThemeQuoteColor,#7c6daf);background:rgba(124,109,175,.08);}',
            /* 通用小按钮 */
            '.om-btn-sm{padding:5px 7px;border-radius:6px;cursor:pointer;font-size:.78em;',
            'background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.14);',
            'transition:all .15s;color:inherit;font-family:inherit;}',
            '.om-btn-sm:hover{background:rgba(127,127,127,.15);}',
            /* 导出/导入 modal */
            '.om-modal{position:absolute;inset:0;z-index:2;background:rgba(0,0,0,.45);pointer-events:auto;',
            'display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;}',
            '.om-modal-box{background:var(--om-bg2,var(--SmartThemeBackgroundColor,rgba(30,30,30,1)));',
            'color:var(--om-text,var(--SmartThemeBodyColor,#eee));border-radius:16px;padding:22px 20px 26px;',
            'width:100%;max-width:400px;max-height:85vh;overflow-y:auto;',
            'display:flex;flex-direction:column;gap:10px;',
            'box-shadow:0 8px 32px rgba(0,0,0,.4);margin:auto;border:1px solid rgba(127,127,127,.15);}',
            '.om-modal-title{font-weight:700;font-size:1em;margin-bottom:4px;}',
            '.om-modal-btn{padding:10px 14px;border-radius:9px;border:1px solid rgba(127,127,127,.2);',
            'background:rgba(127,127,127,.07);color:inherit;cursor:pointer;font-size:.88em;text-align:left;',
            'font-family:inherit;transition:.15s;}',
            '.om-modal-btn:hover{background:rgba(127,127,127,.16);border-color:var(--SmartThemeQuoteColor,#7c6daf);color:var(--SmartThemeQuoteColor,#7c6daf);}',
            '.om-modal-cancel{padding:9px;border-radius:9px;border:none;background:none;',
            'color:inherit;cursor:pointer;font-size:.85em;opacity:.5;font-family:inherit;margin-top:4px;}',
            '.om-modal-cancel:hover{opacity:1;}',
            /* 全屏 lightbox */
            '.om-lightbox{position:absolute;inset:0;z-index:3;background:rgba(0,0,0,.92);pointer-events:auto;',
            'display:flex;align-items:center;justify-content:center;animation:om-popin .18s ease;}',
            '.om-lb-img{max-width:92vw;max-height:88vh;object-fit:contain;border-radius:10px;',
            'box-shadow:0 8px 40px rgba(0,0,0,.6);user-select:none;}',
            '.om-lb-close{position:absolute;top:18px;right:20px;background:rgba(255,255,255,.12);',
            'border:none;color:#fff;font-size:1.3em;width:40px;height:40px;border-radius:50%;',
            'cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s;z-index:2147483647;}',
            '.om-lb-close:hover{background:rgba(255,255,255,.25);}',
            '.om-lb-nav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.12);',
            'border:none;color:#fff;font-size:1.2em;width:42px;height:42px;border-radius:50%;',
            'cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s;z-index:2147483647;}',
            '.om-lb-nav:hover{background:rgba(255,255,255,.25);}',
            '.om-lb-prev{left:14px;} .om-lb-next{right:14px;}',
            '.om-lb-counter{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);',
            'color:rgba(255,255,255,.6);font-size:.82em;background:rgba(0,0,0,.4);',
            'padding:4px 14px;border-radius:20px;z-index:2147483647;}',
            '.om-lb-name{position:absolute;top:20px;left:50%;transform:translateX(-50%);',
            'color:#fff;font-size:.9em;font-weight:600;background:rgba(0,0,0,.4);',
            'padding:5px 16px;border-radius:20px;max-width:60vw;white-space:nowrap;',
            'overflow:hidden;text-overflow:ellipsis;z-index:2147483647;}',
        ].join('');
        document.head.appendChild(s);
    }

    // ── 弹窗状态 ──────────────────────────────────────────────
    var curCat = '__all__';
    var batchMode = false;
    var batchSelected = [];
    var searchQuery = '';
    var searchOpen = false;
    var detailPanelOpen = false;

    // ── 打开全屏主界面 ────────────────────────────────────────
    function openPopup() {
        if (document.querySelector('.om-overlay')) return;
        // 防止悬浮球点击事件穿透到面板下方的元素
        var shield = document.createElement('div');
        shield.setAttribute('style', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;');
        shield.addEventListener('touchstart', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
        shield.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
        document.body.appendChild(shield);
        setTimeout(function () { if (shield.parentNode) shield.parentNode.removeChild(shield); }, 400);

        injectStyles();
        batchMode = false; batchSelected = []; searchQuery = ''; searchOpen = false; detailPanelOpen = false;

        var ov = document.createElement('div');
        ov.className = 'om-overlay ' + (darkMode ? 'om-dark' : 'om-light');
        ov.setAttribute('style', 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;z-index:2147483647 !important;');

        ov.innerHTML =
            '<div class="om-box">' +
            // 顶栏
            '<div class="om-head">' +
            '<div class="om-head-title"><i class="fa-solid fa-shirt"></i>' + SCRIPT_NAME + '</div>' +
            '<div class="om-head-actions">' +
            '<button class="om-icon-btn" id="om-search-toggle" title="搜索"><i class="fa-solid fa-magnifying-glass"></i></button>' +
            '<button class="om-theme-btn" id="om-theme-toggle"><i class="fa-solid fa-circle-half-stroke"></i></button>' +
            '<button class="om-icon-btn" id="om-x" title="关闭"><i class="fa-solid fa-xmark"></i></button>' +
            '</div></div>' +
            // 搜索栏（默认隐藏）
            '<div class="om-search-bar" id="om-search-bar">' +
            '<div class="om-search-wrap"><i class="fa-solid fa-magnifying-glass"></i>' +
            '<input class="om-search-inp" id="om-search-inp" type="text" placeholder="搜索名称或标签…" autocomplete="off" /></div>' +
            '<button class="om-search-clear" id="om-search-clear" title="关闭搜索"><i class="fa-solid fa-xmark"></i></button>' +
            '</div>' +
            // 视角切换栏（User / Char）
            '<div class="om-viewbar" id="om-viewbar"></div>' +
            // 分类栏
            '<div class="om-catbar" id="om-catbar"></div>' +
            // 网格区
            '<div class="om-grid-area" id="om-grid-area"></div>' +
            // 底栏
            '<div class="om-bottombar" id="om-bottombar" style="position:relative;">' +
            '<div class="om-bottom-status" id="om-bottom-status"></div>' +
            '<button class="om-batch-toggle-btn" id="om-batch-toggle">多选</button>' +
            '<button class="om-bottom-btn" id="om-bottom-presets" title="预设"><i class="fa-solid fa-bookmark"></i></button>' +
            '<button class="om-bottom-btn" id="om-bottom-settings" title="设置"><i class="fa-solid fa-sliders"></i></button>' +
            '</div>' +
            '</div>' +
            '<div id="om-popup-slot" style="position:absolute;inset:0;z-index:999;pointer-events:none;"></div>';

        document.body.appendChild(ov);

        // 绑定顶栏
        ov.querySelector('#om-x').addEventListener('click', closePopup);
        ov.querySelector('#om-theme-toggle').addEventListener('click', function () {
            darkMode = !darkMode;
            var overlay = document.querySelector('.om-overlay');
            if (overlay) {
                overlay.classList.toggle('om-dark', darkMode);
                overlay.classList.toggle('om-light', !darkMode);
            }
            var btn = ov.querySelector('#om-theme-toggle');
            if (btn) btn.innerHTML = darkMode
                ? '<i class="fa-solid fa-circle-half-stroke"></i>'
                : '<i class="fa-regular fa-sun"></i>';
        });
        ov.querySelector('#om-search-toggle').addEventListener('click', function () {
            searchOpen = !searchOpen;
            var bar = document.getElementById('om-search-bar');
            bar.classList.toggle('open', searchOpen);
            if (searchOpen) { setTimeout(function () { var i = document.getElementById('om-search-inp'); if (i) i.focus(); }, 50); }
            else { searchQuery = ''; renderGrid(); }
        });
        ov.querySelector('#om-search-clear').addEventListener('click', function () {
            searchOpen = false;
            searchQuery = '';
            var bar = document.getElementById('om-search-bar');
            bar.classList.remove('open');
            renderGrid();
        });
        var sinp = ov.querySelector('#om-search-inp');
        sinp.addEventListener('input', function () { searchQuery = sinp.value; renderGrid(); });
        sinp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { searchOpen = false; searchQuery = ''; ov.querySelector('#om-search-bar').classList.remove('open'); renderGrid(); } });

        // 绑定底栏
        ov.querySelector('#om-bottom-status').addEventListener('click', function () { toggleDetailPanel(); });
        ov.querySelector('#om-batch-toggle').addEventListener('click', function () {
            batchMode = !batchMode; batchSelected = [];
            ov.querySelector('#om-batch-toggle').classList.toggle('on', batchMode);
            renderGrid();
        });
        ov.querySelector('#om-bottom-presets').addEventListener('click', function () { openPresetsSheet(); });
        ov.querySelector('#om-bottom-settings').addEventListener('click', function () { openSettingsSheet(); });

        renderViewbar();
        renderCatbar();
        renderGrid();
        renderBottomStatus();
        closeFab();
    }

    function closePopup() {
        var ov = document.querySelector('.om-overlay'); if (ov) ov.parentNode.removeChild(ov);
    }

    // ── 视角切换栏渲染 ──────────────────────────────────────────
    function renderViewbar() {
        var vbar = document.getElementById('om-viewbar'); if (!vbar) return;
        var d = load();
        var isUser = d.currentView !== 'char';

        // 顶部tab
        var html = '<button class="om-viewtab' + (isUser ? ' on' : '') + '" data-v="user"><i class="fa-solid fa-user" style="margin-right:4px"></i>User</button>' +
            '<button class="om-viewtab' + (!isUser ? ' on' : '') + '" data-v="char"><i class="fa-solid fa-masks-theater" style="margin-right:4px"></i>角色</button>';

        if (!isUser && d.currentChar) {
            html += '<span style="font-size:.78em;opacity:.5;margin-left:4px">' + esc(d.currentChar) + '</span>';
        }

        vbar.innerHTML = html;

        vbar.querySelectorAll('.om-viewtab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                var dd = load();
                dd.currentView = tab.dataset.v;
                save(dd);
                renderViewbar(); renderCharPanel(); renderCatbar(); renderGrid(); renderBottomStatus();
            });
        });

        renderCharPanel();
    }

    var charPanelExpanded = false;
    var collapsedGroups = {};

    function renderViewbar() {
        var vbar = document.getElementById('om-viewbar'); if (!vbar) return;
        var d = load();
        var isUser = d.currentView !== 'char';
        vbar.style.position = 'relative';

        var html = '<button class="om-viewtab' + (isUser ? ' on' : '') + '" data-v="user"><i class="fa-solid fa-user" style="margin-right:4px"></i>User</button>' +
            '<button class="om-viewtab' + (!isUser ? ' on' : '') + '" data-v="char"><i class="fa-solid fa-masks-theater" style="margin-right:4px"></i>角色</button>';

        if (!isUser) {
            html += '<input type="text" class="om-char-input" id="om-char-input" placeholder="' + (d.currentChar ? esc(d.currentChar) : '搜索角色…') + '" autocomplete="off" />' +
                '<button class="om-char-add-btn" id="om-char-add" title="添加角色">+</button>';
        }

        vbar.innerHTML = html;

        vbar.querySelectorAll('.om-viewtab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                var dd = load();
                dd.currentView = tab.dataset.v;
                save(dd);
                charPanelExpanded = false;
                renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
            });
        });

        if (!isUser) {
            var inp = vbar.querySelector('#om-char-input');
            inp.addEventListener('focus', function () {
                charPanelExpanded = true;
                renderCharDropdown(vbar, load(), '');
            });
            inp.addEventListener('input', function () {
                charPanelExpanded = true;
                renderCharDropdown(vbar, load(), this.value.trim().toLowerCase());
            });
            vbar.querySelector('#om-char-add').addEventListener('click', function () { addCharPrompt(); });
            if (charPanelExpanded) renderCharDropdown(vbar, d, '');
        }
    }

    function renderCharDropdown(vbar, d, query) {
        var old = vbar.querySelector('.om-char-dropdown');
        if (old) old.parentNode.removeChild(old);

        var favs = d.charFavorites || [];
        var groups = d.charGroups || {};
        var allNames = d.charNames || [];
        var matchedGroupKeys = {};
        if (query) { for (var gg in groups) { if (gg.toLowerCase().indexOf(query) !== -1) matchedGroupKeys[gg] = true; } }

        function visible(cn) {
            if (!query) return true;
            if (cn.toLowerCase().indexOf(query) !== -1) return true;
            for (var gg2 in matchedGroupKeys) { if ((groups[gg2] || []).indexOf(cn) !== -1) return true; }
            return false;
        }

        var inGroup = {};
        for (var gn in groups) { (groups[gn] || []).forEach(function (n) { inGroup[n] = true; }); }

        function makeRow(cn) {
            if (!visible(cn)) return '';
            var isFav = favs.indexOf(cn) !== -1;
            var isActive = d.currentChar === cn;
            var cd = d.chars && d.chars[cn] ? d.chars[cn] : { outfits: [] };
            var count = (cd.outfits || []).length;
            return '<div class="om-char-row' + (isActive ? ' active' : '') + '" data-cn="' + esc(cn) + '">' +
                '<i class="fa-' + (isFav ? 'solid' : 'regular') + ' fa-star om-char-star' + (isFav ? ' on' : '') + '" data-cn="' + esc(cn) + '"></i>' +
                '<span class="om-char-rname">' + esc(cn) + '</span>' +
                '<span class="om-char-count">' + count + '套</span>' +
                '<div class="om-char-actions">' +
                '<button class="om-char-act om-char-rename" data-cn="' + esc(cn) + '" title="重命名"><i class="fa-solid fa-pen"></i></button>' +
                '<button class="om-char-act om-char-move-group" data-cn="' + esc(cn) + '" title="分组"><i class="fa-solid fa-folder"></i></button>' +
                '<button class="om-char-act om-char-delete" data-cn="' + esc(cn) + '" title="删除" style="color:#e57373"><i class="fa-solid fa-trash"></i></button>' +
                '</div></div>';
        }

        function makeSection(title, iconClass, names, gkey) {
            var visNames = names.filter(visible);
            if (visNames.length === 0) return '';
            var isCollapsed = collapsedGroups[gkey];
            var html = '<div class="om-char-group-hdr" data-gkey="' + esc(gkey) + '">' +
                '<i class="fa-solid fa-chevron-down om-g-arrow' + (isCollapsed ? ' collapsed' : '') + '"></i>' +
                '<i class="' + iconClass + ' om-g-icon"></i> ' + esc(title) +
                ' <span style="opacity:.4">(' + visNames.length + ')</span></div>';
            if (!isCollapsed) { visNames.forEach(function (cn) { html += makeRow(cn); }); }
            return html;
        }

        var listHtml = '';
        var favNames = allNames.filter(function (n) { return favs.indexOf(n) !== -1; });
        listHtml += makeSection('收藏', 'fa-solid fa-star', favNames, '__fav__');
        for (var gn2 in groups) {
            var gNames = (groups[gn2] || []).filter(function (n) { return allNames.indexOf(n) !== -1; });
            listHtml += makeSection(gn2, 'fa-solid fa-folder', gNames, 'g_' + gn2);
        }
        var ungrouped = allNames.filter(function (n) { return !inGroup[n] && favs.indexOf(n) === -1; });
        if (ungrouped.length > 0) {
            var ugLabel = (favNames.length > 0 || Object.keys(groups).length > 0) ? '未分组' : '全部角色';
            listHtml += makeSection(ugLabel, 'fa-regular fa-folder-open', ungrouped, '__ungrouped__');
        }
        if (allNames.length === 0) listHtml = '<div class="om-char-empty">还没有角色，点 + 添加</div>';

        var dropdown = document.createElement('div');
        dropdown.className = 'om-char-dropdown';
        dropdown.innerHTML = listHtml;
        vbar.appendChild(dropdown);

        // 分组折叠
        dropdown.querySelectorAll('.om-char-group-hdr').forEach(function (hdr) {
            hdr.addEventListener('click', function () {
                collapsedGroups[hdr.dataset.gkey] = !collapsedGroups[hdr.dataset.gkey];
                renderCharDropdown(vbar, load(), query);
            });
        });
        // 选中角色
        dropdown.querySelectorAll('.om-char-row').forEach(function (row) {
            row.addEventListener('click', function (e) {
                if (e.target.closest('.om-char-star') || e.target.closest('.om-char-actions')) return;
                var dd = load(); dd.currentChar = row.dataset.cn; save(dd);
                charPanelExpanded = false;
                renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
            });
        });
        // 收藏
        dropdown.querySelectorAll('.om-char-star').forEach(function (star) {
            star.addEventListener('click', function (e) {
                e.stopPropagation();
                var dd = load(); if (!dd.charFavorites) dd.charFavorites = [];
                var cn = star.dataset.cn; var idx = dd.charFavorites.indexOf(cn);
                if (idx !== -1) dd.charFavorites.splice(idx, 1); else dd.charFavorites.push(cn);
                save(dd); renderCharDropdown(vbar, load(), query);
            });
        });
        // 重命名
        dropdown.querySelectorAll('.om-char-rename').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation(); var cn = btn.dataset.cn;
                var nw = prompt('重命名角色「' + cn + '」：', cn);
                if (!nw || !nw.trim() || nw.trim() === cn) return; nw = nw.trim();
                var dd = load();
                if (dd.charNames.indexOf(nw) !== -1) { toast('角色「' + nw + '」已存在', true); return; }
                var idx = dd.charNames.indexOf(cn); if (idx !== -1) dd.charNames[idx] = nw;
                if (dd.chars && dd.chars[cn]) { dd.chars[nw] = dd.chars[cn]; delete dd.chars[cn]; }
                if (dd.charFavorites) { var fi = dd.charFavorites.indexOf(cn); if (fi !== -1) dd.charFavorites[fi] = nw; }
                if (dd.charGroups) { for (var g in dd.charGroups) { var gi = dd.charGroups[g].indexOf(cn); if (gi !== -1) dd.charGroups[g][gi] = nw; } }
                if (dd.currentChar === cn) dd.currentChar = nw;
                save(dd); renderViewbar(); renderCatbar(); renderGrid(); toast('已重命名为「' + nw + '」');
            });
        });
        // 分组移动
        dropdown.querySelectorAll('.om-char-move-group').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation(); var cn = btn.dataset.cn; var dd = load();
                if (!dd.charGroups) dd.charGroups = {};
                var gNamesList = Object.keys(dd.charGroups);
                if (gNamesList.length === 0) {
                    var gname = prompt('还没有分组，输入新分组名称：');
                    if (!gname || !gname.trim()) return;
                    dd.charGroups[gname.trim()] = [cn]; save(dd); renderCharDropdown(vbar, load(), query);
                    toast('已创建分组并移入'); return;
                }
                var currentGroup = '';
                for (var g in dd.charGroups) { if ((dd.charGroups[g] || []).indexOf(cn) !== -1) { currentGroup = g; break; } }
                var msg = '将「' + cn + '」移到：\n0. 不分组' + (currentGroup ? '（当前：' + currentGroup + '）' : '') + '\n';
                gNamesList.forEach(function (g, i) { msg += (i + 1) + '. ' + g + '\n'; });
                msg += (gNamesList.length + 1) + '. 新建分组';
                var choice = prompt(msg); if (choice === null) return;
                var ci = parseInt(choice);
                for (var g2 in dd.charGroups) { var ri = dd.charGroups[g2].indexOf(cn); if (ri !== -1) dd.charGroups[g2].splice(ri, 1); }
                if (ci > 0 && ci <= gNamesList.length) { dd.charGroups[gNamesList[ci - 1]].push(cn); toast('已移入「' + gNamesList[ci - 1] + '」'); }
                else if (ci === gNamesList.length + 1) { var ng = prompt('新分组名称：'); if (ng && ng.trim()) { dd.charGroups[ng.trim()] = [cn]; toast('已创建分组并移入'); } }
                else { toast('已移出分组'); }
                save(dd); renderCharDropdown(vbar, load(), query);
            });
        });
        // 删除
        dropdown.querySelectorAll('.om-char-delete').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation(); var cn = btn.dataset.cn;
                if (!confirm('删除角色「' + cn + '」及其所有穿搭？')) return;
                var dd = load();
                if (dd.chars) delete dd.chars[cn];
                var idx = dd.charNames.indexOf(cn); if (idx !== -1) dd.charNames.splice(idx, 1);
                if (dd.charFavorites) { var fi = dd.charFavorites.indexOf(cn); if (fi !== -1) dd.charFavorites.splice(fi, 1); }
                if (dd.charGroups) { for (var g in dd.charGroups) { var gi = dd.charGroups[g].indexOf(cn); if (gi !== -1) dd.charGroups[g].splice(gi, 1); } }
                if (dd.currentChar === cn) dd.currentChar = '';
                save(dd); renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus(); toast('已删除角色「' + cn + '」');
            });
        });
        // 点击外部关闭
        function closeOnOutside(e) {
            if (!vbar.contains(e.target)) {
                charPanelExpanded = false;
                var dd2 = vbar.querySelector('.om-char-dropdown');
                if (dd2) dd2.parentNode.removeChild(dd2);
                document.removeEventListener('click', closeOnOutside, true);
            }
        }
        setTimeout(function () { document.addEventListener('click', closeOnOutside, true); }, 50);
    }

    function addCharPrompt() {
        var name = prompt('输入角色名：');
        if (!name || !name.trim()) return; name = name.trim();
        var dd = load();
        if (!dd.charNames) dd.charNames = [];
        if (dd.charNames.indexOf(name) !== -1) { toast('角色「' + name + '」已存在', true); return; }
        dd.charNames.push(name); dd.currentChar = name; save(dd);
        charPanelExpanded = false;
        renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
        toast('✅ 已添加角色「' + name + '」');
    }

    function renderCharPanel() { /* 兼容 */ }

    // ── 分类栏渲染 ────────────────────────────────────────────
    function renderCatbar() {
        var catbar = document.getElementById('om-catbar'); if (!catbar) return;
        var d = load();
        var cats = getViewCategories(d);
        if (cats.length === 0) { catbar.style.display = 'none'; return; }
        catbar.style.display = '';
        var html = '<button class="om-catbtn' + (curCat === '__all__' ? ' on' : '') + '" data-c="__all__">全部</button>';
        cats.forEach(function (c) {
            html += '<button class="om-catbtn' + (curCat === c ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</button>';
        });
        catbar.innerHTML = html;
        catbar.querySelectorAll('.om-catbtn').forEach(function (btn) {
            btn.addEventListener('click', function () { curCat = btn.dataset.c; renderCatbar(); renderGrid(); });
        });
        // ★ 电脑端支持：鼠标滚轮横向滚动 + 鼠标拖拽滚动
        if (!catbar._wheelBound) {
            catbar.addEventListener('wheel', function (e) {
                if (Math.abs(e.deltaY) > 0) {
                    e.preventDefault();
                    catbar.scrollLeft += e.deltaY;
                }
            }, { passive: false });
            var _drag = { down: false, startX: 0, scrollL: 0 };
            catbar.addEventListener('mousedown', function (e) {
                _drag.down = true; _drag.startX = e.pageX; _drag.scrollL = catbar.scrollLeft;
                catbar.style.cursor = 'grabbing'; catbar.style.userSelect = 'none';
            });
            document.addEventListener('mousemove', function (e) {
                if (!_drag.down) return;
                catbar.scrollLeft = _drag.scrollL - (e.pageX - _drag.startX);
            });
            document.addEventListener('mouseup', function () {
                if (_drag.down) { _drag.down = false; catbar.style.cursor = ''; catbar.style.userSelect = ''; }
            });
            catbar._wheelBound = true;
        }
    }

    // ── 网格区渲染 ────────────────────────────────────────────
    function renderGrid() {
        var area = document.getElementById('om-grid-area'); if (!area) return;
        var d = load();

        // 如果是角色视角但没选角色，显示提示
        if (d.currentView === 'char' && !d.currentChar) {
            area.innerHTML = '<div class="om-empty"><i class="fa-solid fa-masks-theater"></i><span>请先选择或添加一个角色</span></div>';
            return;
        }

        // 当前视角的穿搭
        var allOutfits = getViewOutfits(d);

        // 按分类过滤
        var list = curCat === '__all__' ? allOutfits : allOutfits.filter(function (o) { return o.category === curCat; });
        if (searchQuery) {
            var q = searchQuery.toLowerCase();
            list = list.filter(function (o) {
                return (o.name && o.name.toLowerCase().indexOf(q) !== -1) ||
                    (o.category && o.category.toLowerCase().indexOf(q) !== -1) ||
                    (o.sceneTag && o.sceneTag.toLowerCase().indexOf(q) !== -1) ||
                    (o.description && o.description.toLowerCase().indexOf(q) !== -1);
            });
        }
        var imgOutfits = list.filter(function (o) { return !!o.imageData; });

        var html = '';

        // 批量操作栏
        if (batchMode) {
            html += '<div class="om-batch-bar">' +
                '<span class="om-batch-info">已选&nbsp;<b id="om-batch-count">' + batchSelected.length + '</b>&nbsp;套</span>' +
                '<div class="om-batch-divider" style="width:1px;height:16px;background:rgba(127,127,127,.25);flex-shrink:0;margin:0 2px;"></div>' +
                '<div class="om-batch-acts">' +
                '<button class="om-batch-btn" id="om-batch-selall">全选</button>' +
                '<button class="om-batch-btn" id="om-batch-none">取消</button>' +
                '<button class="om-batch-btn" id="om-batch-cat"><i class="fa-solid fa-folder"></i> 分类</button>' +
                '<button class="om-batch-btn" id="om-batch-tag"><i class="fa-solid fa-tag"></i> 标签</button>' +
                '<button class="om-batch-btn" id="om-batch-aidesc"><i class="fa-solid fa-wand-magic-sparkles"></i> AI描述</button>' +
                '<button class="om-batch-btn danger" id="om-batch-del"><i class="fa-solid fa-trash"></i> 删除</button>' +
                '</div></div>';
        }

        html += '<div class="om-grid">';

        // 添加卡（仅非批量模式）
        if (!batchMode) {
            html += '<div class="om-add-card" id="om-addcard"><i class="fa-solid fa-plus"></i><span>添加穿搭</span></div>';
        }

        if (list.length === 0) {
            html += '</div><div class="om-empty"><i class="fa-solid fa-shirt"></i><span>' +
                (searchQuery ? '没有匹配「' + esc(searchQuery) + '」的穿搭' : (curCat !== '__all__' ? '该分类暂无穿搭' : '还没有穿搭，点击左上角添加')) +
                '</span></div>';
        } else {
            list.forEach(function (o) {
                var on = isActive(d, o.id);
                var bsel = batchSelected.indexOf(o.id) !== -1;
                var checkBox = batchMode ? '<div class="om-card-check' + (bsel ? ' checked' : '') + '" data-id="' + o.id + '"><i class="fa-solid fa-check"></i></div>' : '';
                var badge = (on && !batchMode) ? '<div class="om-badge-on"><i class="fa-solid fa-check"></i></div>' : '';

                var imgContent = '';
                if (o.imageData) {
                    imgContent = '<img src="' + o.imageData + '" alt="' + esc(o.name) + '" />';
                } else {
                    var descPreview = (o.description && o.description.trim()) ? o.description.trim() : '';
                    imgContent = '<div class="om-card-noimg">' +
                        '<div class="om-noimg-name">' + esc(o.name) + '</div>' +
                        (descPreview ? '<div class="om-noimg-desc">' + esc(descPreview) + '</div>' : '') +
                        '<i class="fa-regular fa-file-lines om-noimg-icon"></i>' +
                        '</div>';
                }

                var menuBtn = batchMode ? '' : '<button class="om-card-menu" data-id="' + o.id + '" title="操作"><i class="fa-solid fa-ellipsis-vertical"></i></button>';
                var tagText = (o.sceneTag && o.sceneTag.trim()) ? o.sceneTag.trim() : '';
                html += '<div class="om-card' + (on ? ' on' : '') + (bsel ? ' batch-sel' : '') + (o.imageData ? '' : ' no-img') + '" data-id="' + o.id + '">' +
                    '<div class="om-card-img">' +
                    checkBox + imgContent + badge + menuBtn +
                    '</div>' +
                    '<div class="om-card-info">' +
                    '<div class="om-card-name">' + esc(o.name) + '</div>' +
                    (tagText ? '<div class="om-card-tag">' + esc(tagText) + '</div>' : '') +
                    '</div>' +
                    '</div>';
            });
            html += '</div>';
        }

        area.innerHTML = html;

        // 添加卡点击
        var ac = area.querySelector('#om-addcard');
        if (ac) ac.addEventListener('click', function () { openEditSheet(null, curCat !== '__all__' ? curCat : ''); });

        // 批量操作
        if (batchMode) {
            var selall = area.querySelector('#om-batch-selall');
            var selnone = area.querySelector('#om-batch-none');
            var btagBtn = area.querySelector('#om-batch-tag');
            var bdelBtn = area.querySelector('#om-batch-del');

            if (selall) selall.addEventListener('click', function () { batchSelected = list.map(function (o) { return o.id; }); renderGrid(); });
            if (selnone) selnone.addEventListener('click', function () { batchSelected = []; renderGrid(); });
            var bcatBtn = area.querySelector('#om-batch-cat');
            if (bcatBtn) bcatBtn.addEventListener('click', function () {
                if (batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
                var dd = load();
                var cats = getViewCategories(dd);
                if (cats.length === 0) { toast('还没有分类，请先在设置中添加', true); return; }
                var msg = '选择分类（输入序号）：\n' + cats.map(function (n, i) { return (i + 1) + '. ' + n; }).join('\n');
                var choice = prompt(msg);
                if (choice === null) return;
                var ci = parseInt(choice) - 1;
                if (ci < 0 || ci >= cats.length) { toast('无效选择', true); return; }
                var targetCat = cats[ci];
                dd.outfits.forEach(function (o) { if (batchSelected.indexOf(o.id) !== -1) o.category = targetCat; });
                save(dd); toast('✅ 已将 ' + batchSelected.length + ' 套移到「' + targetCat + '」'); batchSelected = []; renderGrid();
            });
            if (btagBtn) btagBtn.addEventListener('click', function () {
                if (batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
                var tag = prompt('为所选 ' + batchSelected.length + ' 套穿搭设置场景标签：'); if (tag === null) return; tag = tag.trim();
                var dd = load(); dd.outfits.forEach(function (o) { if (batchSelected.indexOf(o.id) !== -1) o.sceneTag = tag; });
                save(dd); toast('✅ 已设置标签：' + (tag || '（已清空）')); batchSelected = []; renderGrid();
            });
            if (bdelBtn) bdelBtn.addEventListener('click', function () {
                if (batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
                if (!confirm('确定删除已选 ' + batchSelected.length + ' 套穿搭？')) return;
                var dd = load();
                dd.outfits = dd.outfits.filter(function (o) { return batchSelected.indexOf(o.id) === -1; });
                if (dd.chars) { for (var cn in dd.chars) { dd.chars[cn].outfits = (dd.chars[cn].outfits || []).filter(function (o) { return batchSelected.indexOf(o.id) === -1; }); } }
                batchSelected.forEach(function (id) {
                    var ai = (dd.activeIds || []).indexOf(id); if (ai !== -1) dd.activeIds.splice(ai, 1);
                    if (dd.chars) { for (var cn2 in dd.chars) { var cai = (dd.chars[cn2].activeIds || []).indexOf(id); if (cai !== -1) dd.chars[cn2].activeIds.splice(cai, 1); } }
                });
                save(dd); updateBtn(); renderBottomStatus(); toast('已删除 ' + batchSelected.length + ' 套穿搭'); batchSelected = []; renderGrid();
            });

            var baidescBtn = area.querySelector('#om-batch-aidesc');
            if (baidescBtn) baidescBtn.addEventListener('click', function () {
                if (batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
                var dd = load();
                if (!dd.apiVision.endpoint || !dd.apiVision.key || !dd.apiVision.model) {
                    toast('请先在设置中配置"描述生成 API"', true); return;
                }
                var hasImg = batchSelected.some(function (id) { var o = getById(dd, id); return o && o.imageData; });
                if (!hasImg) { toast('所选穿搭中没有带图片的', true); return; }
                openBatchDescModal(batchSelected.slice());
            });

            area.querySelectorAll('.om-card').forEach(function (card) {
                card.addEventListener('click', function (e) {
                    if (e.target.closest('.om-card-check')) return;
                    var id = card.dataset.id;
                    var chk = card.querySelector('.om-card-check');
                    var idx = batchSelected.indexOf(id);
                    if (idx !== -1) batchSelected.splice(idx, 1); else batchSelected.push(id);
                    if (chk) chk.classList.toggle('checked', batchSelected.indexOf(id) !== -1);
                    card.classList.toggle('batch-sel', batchSelected.indexOf(id) !== -1);
                    var cnt = area.querySelector('#om-batch-count');
                    if (cnt) cnt.textContent = batchSelected.length;
                });
            });
            area.querySelectorAll('.om-card-check').forEach(function (chk) {
                chk.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var id = chk.dataset.id;
                    var idx = batchSelected.indexOf(id);
                    if (idx !== -1) batchSelected.splice(idx, 1); else batchSelected.push(id);
                    chk.classList.toggle('checked', batchSelected.indexOf(id) !== -1);
                    var card = chk.closest('.om-card');
                    if (card) card.classList.toggle('batch-sel', batchSelected.indexOf(id) !== -1);
                    var cnt = area.querySelector('#om-batch-count');
                    if (cnt) cnt.textContent = batchSelected.length;
                });
            });
        } else {
            // 非批量：单击 = 选择/取消，点击⋯按钮 = 操作菜单
            area.querySelectorAll('.om-card').forEach(function (card) {
                var id = card.dataset.id;

                card.addEventListener('click', function (e) {
                    if (e.target.closest('.om-card-menu') || e.target.closest('.om-badge-on')) return;
                    var dd = load();
                    var aids = getViewActiveIds(dd);
                    var idx = aids.indexOf(id);
                    if (idx !== -1) aids.splice(idx, 1); else aids.push(id);
                    setViewActiveIds(dd, aids);
                    save(dd); updateBtn(); renderBottomStatus();


                    save(dd); updateBtn(); renderBottomStatus();
                    // 更新卡片样式
                    card.classList.toggle('on', isActive(dd, id));
                    var badge = card.querySelector('.om-badge-on');
                    if (isActive(dd, id)) {
                        if (!badge) { var b = document.createElement('div'); b.className = 'om-badge-on'; b.innerHTML = '<i class="fa-solid fa-check"></i>'; card.querySelector('.om-card-img').appendChild(b); }
                    } else {
                        if (badge) badge.parentNode.removeChild(badge);
                    }
                    closeDetailPanel();
                    var n = aids.length;
                    var o = getById(dd, id);
                    if (idx !== -1) toast('已取消：' + (o ? o.name : ''));
                    else if (n === 1) toast('✅ 已选：' + (o ? o.name : ''));
                    else toast('✅ 衣柜模式，共' + n + '套');
                });
            });

            // 菜单按钮点击事件（独立绑定，stopPropagation防止触发卡片选择）
            area.querySelectorAll('.om-card-menu').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var id = btn.dataset.id;
                    var o = getById(load(), id);
                    openContextMenu(o, imgOutfits);
                });
            });
        }
    }

    // ── 底栏状态 ─────────────────────────────────────────────
    function renderBottomStatus() {
        var el = document.getElementById('om-bottom-status'); if (!el) return;
        var d = load();

        // 收集所有owner的激活穿搭
        var allActive = [];
        // User
        (d.activeIds || []).forEach(function (id) { var o = getById(d, id); if (o) allActive.push({ owner: 'User', name: o.name, id: id }); });
        // Chars
        if (d.chars) {
            for (var cn in d.chars) {
                var cd = d.chars[cn];
                (cd.activeIds || []).forEach(function (id) {
                    var o = null; for (var k = 0; k < (cd.outfits || []).length; k++) { if (cd.outfits[k].id === id) { o = cd.outfits[k]; break; } }
                    if (o) allActive.push({ owner: cn, name: o.name, id: id });
                });
            }
        }

        var dotClass, text;
        if (allActive.length === 0) { dotClass = 'gray'; text = '未选择穿搭'; }
        else {
            dotClass = 'green';
            var parts = [];
            var userCount = allActive.filter(function (a) { return a.owner === 'User'; }).length;
            if (userCount > 0) parts.push('User ' + userCount + '套');
            if (d.chars) {
                for (var cn2 in d.chars) {
                    var cnt = allActive.filter(function (a) { return a.owner === cn2; }).length;
                    if (cnt > 0) parts.push(cn2 + ' ' + cnt + '套');
                }
            }
            text = parts.join(' · ');
            if (allActive.length > 1) dotClass = 'orange';
        }

        var clearBtn = allActive.length > 0 ? '<button class="om-status-clear" id="om-status-clearall">全部取消</button>' : '';
        el.innerHTML = '<div class="om-status-dot ' + dotClass + '"></div><span class="om-status-text">' + esc(text) + '</span>' + clearBtn;

        var clr = el.querySelector('#om-status-clearall');
        if (clr) clr.addEventListener('click', function (e) {
            e.stopPropagation();
            var dd = load(); dd.activeIds = [];
            if (dd.chars) { for (var cn3 in dd.chars) { dd.chars[cn3].activeIds = []; } }
            save(dd);
            updateBtn(); renderBottomStatus(); renderGrid(); closeDetailPanel();
            toast('已取消全部选择');
        });
    }

    // ── 选择详情面板 ─────────────────────────────────────────
    function toggleDetailPanel() {
        if (detailPanelOpen) { closeDetailPanel(); return; }
        var d = load();

        // 收集所有owner的激活穿搭，按owner分组
        var groups = [];
        var userNames = [];
        (d.activeIds || []).forEach(function (id) { var o = getById(d, id); if (o) userNames.push({ id: id, name: o.name }); });
        if (userNames.length > 0) groups.push({ owner: 'User', items: userNames });
        if (d.chars) {
            for (var cn in d.chars) {
                var cd = d.chars[cn];
                var charNames = [];
                (cd.activeIds || []).forEach(function (id) {
                    for (var k = 0; k < (cd.outfits || []).length; k++) { if (cd.outfits[k].id === id) { charNames.push({ id: id, name: cd.outfits[k].name }); break; } }
                });
                if (charNames.length > 0) groups.push({ owner: cn, items: charNames });
            }
        }
        if (groups.length === 0) return;
        openDetailPanel(groups, d);
    }

    function openDetailPanel(groups, d) {
        closeDetailPanel();
        var bottombar = document.getElementById('om-bottombar'); if (!bottombar) return;
        detailPanelOpen = true;
        var panel = document.createElement('div');
        panel.id = 'om-detail-panel';
        panel.className = 'om-detail-panel';
        panel.style.cssText = 'position:absolute;bottom:100%;left:0;right:0;z-index:10;';

        var html = '<div class="om-detail-handle"></div>';
        groups.forEach(function (g) {
            html += '<div class="om-detail-title" style="margin-top:4px">' + esc(g.owner) + '</div>';
            html += '<div class="om-detail-tags">';
            g.items.forEach(function (w) {
                html += '<span class="om-detail-tag">' + esc(w.name) +
                    '<button class="om-detail-tag-x" data-id="' + w.id + '">&#x2715;</button></span>';
            });
            html += '</div>';
        });
        panel.innerHTML = html;
        bottombar.appendChild(panel);
        panel.querySelectorAll('.om-detail-tag-x').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var dd = load(); var id = btn.dataset.id;
                // 从所有owner中查找并移除
                var ai1 = (dd.activeIds || []).indexOf(id); if (ai1 !== -1) dd.activeIds.splice(ai1, 1);
                if (dd.chars) { for (var cn in dd.chars) { var cai = (dd.chars[cn].activeIds || []).indexOf(id); if (cai !== -1) dd.chars[cn].activeIds.splice(cai, 1); } }
                save(dd); updateBtn(); renderBottomStatus(); renderGrid();
                closeDetailPanel();
            });
        });
        // 点击底栏外关闭
        setTimeout(function () {
            document.addEventListener('click', outsideDetailClick, true);
        }, 10);
    }

    function outsideDetailClick(e) {
        var panel = document.getElementById('om-detail-panel');
        var statusEl = document.getElementById('om-bottom-status');
        if (panel && !panel.contains(e.target) && statusEl && !statusEl.contains(e.target)) {
            closeDetailPanel();
        }
    }

    function closeDetailPanel() {
        detailPanelOpen = false;
        var p = document.getElementById('om-detail-panel'); if (p && p.parentNode) p.parentNode.removeChild(p);
        document.removeEventListener('click', outsideDetailClick, true);
    }

    // ── 长按操作菜单 Bottom Sheet ─────────────────────────────
    function openContextMenu(outfit, imgOutfits) {
        if (!outfit) return;
        var d = load();
        var isOn = isActive(d, outfit.id);

        var sheet = createSheet([
            '<div class="om-ctx-outfit-name"><i class="fa-solid fa-shirt" style="margin-right:6px;opacity:.5;"></i>' + esc(outfit.name) + '</div>',
            isOn
                ? '<div class="om-ctx-item" id="om-ctx-wear"><i class="fa-solid fa-circle-xmark"></i>取消选择</div>'
                : '<div class="om-ctx-item" id="om-ctx-wear"><i class="fa-solid fa-circle-check"></i>选择穿搭</div>',
            outfit.imageData ? '<div class="om-ctx-item" id="om-ctx-view"><i class="fa-solid fa-expand"></i>查看大图</div>' : '',
            '<div class="om-ctx-item" id="om-ctx-edit"><i class="fa-solid fa-pen"></i>编辑</div>',
            outfit.imageData ? '<div class="om-ctx-item" id="om-ctx-aidesc"><i class="fa-solid fa-wand-magic-sparkles"></i>AI 生成描述</div>' : '',
            '<div class="om-ctx-item danger" id="om-ctx-del"><i class="fa-solid fa-trash"></i>删除</div>',
        ].join(''));

        var wearEl = sheet.querySelector('#om-ctx-wear');
        if (wearEl) wearEl.addEventListener('click', function () {
            closeSheet(sheet);
            var dd = load();
            var aids = getViewActiveIds(dd);
            var idx = aids.indexOf(outfit.id);
            if (idx !== -1) aids.splice(idx, 1); else aids.push(outfit.id);
            setViewActiveIds(dd, aids);
            save(dd); updateBtn(); renderBottomStatus(); renderGrid();
            closeDetailPanel();
        });

        var viewEl = sheet.querySelector('#om-ctx-view');
        if (viewEl) viewEl.addEventListener('click', function () {
            closeSheet(sheet);
            openLightbox(imgOutfits, outfit.id);
        });

        var editEl = sheet.querySelector('#om-ctx-edit');
        if (editEl) editEl.addEventListener('click', function () {
            closeSheet(sheet);
            openEditSheet(outfit, outfit.category || '');
        });

        var aidescEl = sheet.querySelector('#om-ctx-aidesc');
        if (aidescEl) aidescEl.addEventListener('click', function () {
            var dd = load();
            if (!dd.apiVision.endpoint || !dd.apiVision.key || !dd.apiVision.model) {
                toast('请先在设置中配置"描述生成 API"', true); closeSheet(sheet); return;
            }
            aidescEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>生成中...';
            aidescEl.style.pointerEvents = 'none';
            generateSingleDescription(outfit, function (err, desc) {
                closeSheet(sheet);
                if (err) { toast('生成失败：' + err, true); return; }
                var dd2 = load(); var o = getById(dd2, outfit.id);
                if (o) { o.description = desc; save(dd2); }
                toast('✅ 描述已生成：' + outfit.name);
                renderGrid();
            });
        });

        var delEl = sheet.querySelector('#om-ctx-del');
        if (delEl) delEl.addEventListener('click', function () {
            closeSheet(sheet);
            if (!confirm('确定删除「' + outfit.name + '」？')) return;
            var dd = load();
            dd.outfits = dd.outfits.filter(function (o) { return o.id !== outfit.id; });
            // 也从chars中查找并删除
            if (dd.chars) { for (var cn in dd.chars) { dd.chars[cn].outfits = (dd.chars[cn].outfits || []).filter(function (o) { return o.id !== outfit.id; }); var cai = (dd.chars[cn].activeIds || []).indexOf(outfit.id); if (cai !== -1) dd.chars[cn].activeIds.splice(cai, 1); } }
            var ai = (dd.activeIds || []).indexOf(outfit.id); if (ai !== -1) dd.activeIds.splice(ai, 1);
            save(dd); updateBtn(); renderBottomStatus(); renderGrid(); toast('已删除');
        });
    }

    // ── 编辑 Bottom Sheet ─────────────────────────────────────
    function getAllTagSuggestions(d) {
        var tags = [];
        d.outfits.forEach(function (o) { if (o.sceneTag && o.sceneTag.trim()) { var t = o.sceneTag.trim(); if (tags.indexOf(t) === -1) tags.push(t); } });
        return tags;
    }

    function openEditSheet(outfit, defaultCat) {
        var d = load();
        var editImgData = outfit ? (outfit.imageData || null) : null;
        var viewCats = getViewCategories(d);
        var catOpts = '<option value="">无分类</option>' +
            viewCats.map(function (c) { return '<option value="' + esc(c) + '"' + (outfit && outfit.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');

        var sheet = createSheet([
            '<div class="om-sheet-title"><i class="fa-solid fa-' + (outfit ? 'pen' : 'plus') + '"></i>' + (outfit ? '编辑穿搭' : '添加穿搭') + '</div>',
            '<div class="om-field"><label>穿搭名称 *</label><input type="text" id="om-dn" placeholder="如：白色蕾丝连衣裙" value="' + esc(outfit ? outfit.name : '') + '" /></div>',
            '<div class="om-field"><label>分类</label><div class="om-frow"><select id="om-dcat">' + catOpts + '</select><button class="om-btn om-btn-outline" id="om-dnewcat" style="white-space:nowrap;font-size:.8em;padding:7px 10px">+ 新建</button></div></div>',
            '<div class="om-field"><label>文字描述 <span class="om-hint">AI 注入用，越详细越好</span></label><textarea id="om-ddesc" rows="4" placeholder="如：白色蕾丝镂空连衣裙，领口略低，裙摆及膝……">' + esc(outfit ? outfit.description || '' : '') + '</textarea>' +
            '<button class="om-btn om-btn-outline" id="om-daidesc" style="font-size:.78em;margin-top:5px;align-self:flex-start"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成描述</button></div>',
            '<div class="om-field"><label>场景标签 <span class="om-hint">多套时 AI 据此选穿搭，如：外出 / 家居 / 睡前</span></label>',
            '<div class="om-suggest-wrap"><input type="text" id="om-dscene" placeholder="外出 / 家居 / 睡前 / 运动" value="' + esc(outfit ? outfit.sceneTag || '' : '') + '" autocomplete="off" />',
            '<div class="om-suggest-list" id="om-scene-suggest" style="display:none"></div></div></div>',
            '<div class="om-field"><label>参考图片 <span class="om-hint">可选，自动压缩</span></label>',
            '<div class="om-imgarea" id="om-dimgarea">' + (editImgData ? '<img src="' + editImgData + '" />' : '<div class="om-imgph"><i class="fa-regular fa-image"></i><span>点击或拖拽上传</span></div>') + '</div>',
            '<input type="file" id="om-dfile" accept="image/*" style="display:none" />',
            '<div class="om-img-actions"><button class="om-btn om-btn-outline" id="om-dpick" style="font-size:.8em"><i class="fa-solid fa-image"></i> 选择图片</button>' + (editImgData ? '<button class="om-btn om-btn-danger" id="om-dclr" style="font-size:.8em">删除图片</button>' : '') + '</div></div>',
            '<div class="om-edit-foot"><button class="om-btn om-btn-outline" id="om-dcancel">取消</button><button class="om-btn om-btn-safe" id="om-dsave">保存</button></div>',
        ].join(''));

        // 设置默认分类
        if (defaultCat) {
            var sel = sheet.querySelector('#om-dcat'); if (sel) sel.value = defaultCat;
        }

        // 场景标签建议
        var sceneInput = sheet.querySelector('#om-dscene');
        var suggestList = sheet.querySelector('#om-scene-suggest');
        var allTags = getAllTagSuggestions(d);
        function showSuggestions(val) {
            var v = val.trim().toLowerCase();
            var filtered = v ? allTags.filter(function (t) { return t.toLowerCase().indexOf(v) !== -1 && t.toLowerCase() !== v; }) : allTags;
            if (filtered.length === 0) { suggestList.style.display = 'none'; return; }
            suggestList.innerHTML = filtered.map(function (t) { return '<div class="om-suggest-item" data-val="' + esc(t) + '">' + esc(t) + '</div>'; }).join('');
            suggestList.style.display = 'block';
        }
        sceneInput.addEventListener('focus', function () { showSuggestions(this.value); });
        sceneInput.addEventListener('input', function () { showSuggestions(this.value); });
        sceneInput.addEventListener('blur', function () { setTimeout(function () { suggestList.style.display = 'none'; }, 150); });
        suggestList.addEventListener('mousedown', function (e) {
            var item = e.target.closest('.om-suggest-item');
            if (item) { sceneInput.value = item.dataset.val; suggestList.style.display = 'none'; }
        });

        // 图片处理
        var fileInp = sheet.querySelector('#om-dfile');
        var imgArea = sheet.querySelector('#om-dimgarea');
        function setImg(data) {
            editImgData = data;
            imgArea.innerHTML = data ? '<img src="' + data + '" />' : '<div class="om-imgph"><i class="fa-regular fa-image"></i><span>点击或拖拽上传</span></div>';
            var clrOld = sheet.querySelector('#om-dclr'); var acts = sheet.querySelector('.om-img-actions');
            if (data && !clrOld && acts) {
                var b2 = document.createElement('button'); b2.className = 'om-btn om-btn-danger'; b2.id = 'om-dclr'; b2.style.fontSize = '.8em'; b2.textContent = '删除图片';
                b2.addEventListener('click', function () { setImg(null); }); acts.appendChild(b2);
            } else if (!data && clrOld) clrOld.parentNode.removeChild(clrOld);
        }
        function handleFile(f) {
            if (!f || f.type.indexOf('image') !== 0) return;
            var r = new FileReader(); r.onload = function (e) { compressImage(e.target.result, function (c) { setImg(c); }); }; r.readAsDataURL(f);
        }
        sheet.querySelector('#om-dpick').addEventListener('click', function () { fileInp.click(); });
        imgArea.addEventListener('click', function () { fileInp.click(); });
        fileInp.addEventListener('change', function () { if (fileInp.files[0]) handleFile(fileInp.files[0]); });
        imgArea.addEventListener('dragover', function (e) { e.preventDefault(); imgArea.classList.add('drag'); });
        imgArea.addEventListener('dragleave', function () { imgArea.classList.remove('drag'); });
        imgArea.addEventListener('drop', function (e) { e.preventDefault(); imgArea.classList.remove('drag'); if (e.dataTransfer && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
        var clr = sheet.querySelector('#om-dclr'); if (clr) clr.addEventListener('click', function () { setImg(null); });

        // AI 生成描述按钮
        sheet.querySelector('#om-daidesc').addEventListener('click', function () {
            var imgData = editImgData;
            if (!imgData) { toast('请先上传图片', true); return; }
            var dd = load();
            if (!dd.apiVision.endpoint || !dd.apiVision.key || !dd.apiVision.model) { toast('请先在设置中配置"描述生成 API"', true); return; }
            var btn = sheet.querySelector('#om-daidesc');
            btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...';
            var tmpOutfit = { name: sheet.querySelector('#om-dn').value || '穿搭', imageData: imgData };
            generateSingleDescription(tmpOutfit, function (err, desc) {
                btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成描述';
                if (err) { toast('生成失败：' + err, true); return; }
                sheet.querySelector('#om-ddesc').value = desc;
                toast('✅ 描述已生成');
            });
        });

        sheet.querySelector('#om-dnewcat').addEventListener('click', function () {
            var name = prompt('新分类名称：'); if (!name || !name.trim()) return; name = name.trim();
            var dd = load(); var vc = getViewCategories(dd); if (vc.indexOf(name) === -1) { vc.push(name); save(dd); renderCatbar(); }
            var sel = sheet.querySelector('#om-dcat'); var ex = false;
            for (var i = 0; i < sel.options.length; i++) { if (sel.options[i].value === name) { ex = true; break; } }
            if (!ex) { var opt = document.createElement('option'); opt.value = name; opt.textContent = name; sel.appendChild(opt); }
            sel.value = name; toast('分类「' + name + '」已添加');
        });

        sheet.querySelector('#om-dcancel').addEventListener('click', function () { closeSheet(sheet); });
        sheet.querySelector('#om-dsave').addEventListener('click', function () {
            var name = sheet.querySelector('#om-dn').value.trim();
            if (!name) { toast('请输入穿搭名称', true); return; }
            var cat = sheet.querySelector('#om-dcat').value;
            var desc = sheet.querySelector('#om-ddesc').value.trim();
            var scene = sheet.querySelector('#om-dscene').value.trim();
            var dd = load();
            if (outfit) {
                // 编辑已有穿搭 - 在所有数据中查找
                var found = false;
                for (var i = 0; i < dd.outfits.length; i++) {
                    if (dd.outfits[i].id === outfit.id) {
                        Object.assign(dd.outfits[i], { name: name, category: cat, description: desc, sceneTag: scene, imageData: editImgData }); found = true; break;
                    }
                }
                if (!found && dd.chars) {
                    for (var cn in dd.chars) {
                        var co = dd.chars[cn].outfits || [];
                        for (var j = 0; j < co.length; j++) {
                            if (co[j].id === outfit.id) { Object.assign(co[j], { name: name, category: cat, description: desc, sceneTag: scene, imageData: editImgData }); found = true; break; }
                        }
                        if (found) break;
                    }
                }
            } else {
                // 新增穿搭 - 放入当前视角
                var newOutfit = { id: genId(), name: name, category: cat, description: desc, sceneTag: scene, imageData: editImgData, createdAt: Date.now() };
                if (dd.currentView === 'char' && dd.currentChar) {
                    getCharData(dd, dd.currentChar).outfits.push(newOutfit);
                } else {
                    dd.outfits.push(newOutfit);
                }
            }
            save(dd); closeSheet(sheet); toast('✨ 已保存：' + name); renderCatbar(); renderGrid(); renderBottomStatus(); updateBtn();
        });
    }

    // ── 预设 Bottom Sheet ─────────────────────────────────────
    function openPresetsSheet() {
        var d = load();
        var activePresetId = d.activePresetId || null;
        var presetListHtml = (!d.presets || d.presets.length === 0)
            ? '<div class="om-empty"><i class="fa-solid fa-bookmark"></i><span>还没有预设</span></div>'
            : d.presets.map(function (p, idx) {
                var isCurrent = (activePresetId && p.id === activePresetId);
                return '<div class="om-preset-item' + (isCurrent ? ' current' : '') + '" data-idx="' + idx + '">' +
                    '<div class="om-preset-name">' + esc(p.name) + (isCurrent ? ' <span style="font-size:.7em;opacity:.5;font-weight:400">（当前）</span>' : '') + '</div>' +
                    '<div class="om-preset-count">包含 ' + (p.outfits || []).length + ' 套穿搭</div>' +
                    '<button class="om-btn-sm om-preset-ren" data-idx="' + idx + '" title="重命名"><i class="fa-solid fa-pen"></i></button>' +
                    '<button class="om-btn-sm om-preset-del" data-idx="' + idx + '" title="删除"><i class="fa-solid fa-trash"></i></button>' +
                    '</div>';
            }).join('');

        // 保存区：如果有当前预设，显示"覆盖保存"按钮
        var currentPreset = null;
        if (activePresetId && d.presets) {
            for (var pi = 0; pi < d.presets.length; pi++) {
                if (d.presets[pi].id === activePresetId) { currentPreset = d.presets[pi]; break; }
            }
        }
        var saveSection = '';
        if (currentPreset) {
            saveSection =
                '<div class="om-sec-title">保存</div>' +
                '<div class="om-btn-row" style="margin-bottom:10px">' +
                '<button class="om-btn om-btn-safe" id="om-preset-overwrite" style="flex:1"><i class="fa-solid fa-floppy-disk"></i> 保存到「' + esc(currentPreset.name) + '」</button>' +
                '</div>' +
                '<div class="om-divider"></div>' +
                '<div class="om-sec-title">另存为新预设</div>' +
                '<div class="om-cat-add-row"><input type="text" id="om-preset-name-inp" placeholder="新预设名称…" /><button class="om-btn om-btn-outline" id="om-preset-save">保存</button></div>';
        } else {
            saveSection =
                '<div class="om-sec-title">保存当前状态为预设</div>' +
                '<div class="om-hint" style="margin-bottom:8px">将当前所有穿搭数据 + 分类一起打包保存</div>' +
                '<div class="om-cat-add-row"><input type="text" id="om-preset-name-inp" placeholder="预设名称…" /><button class="om-btn om-btn-safe" id="om-preset-save">保存</button></div>';
        }

        var sheet = createSheet([
            '<div class="om-sheet-title"><i class="fa-solid fa-bookmark"></i>预设管理</div>',
            '<div class="om-sec-title">已保存的预设 <span class="om-hint">点击名称加载</span></div>',
            presetListHtml,
            '<div class="om-divider"></div>',
            saveSection,
        ].join(''));

        // 覆盖保存到当前预设
        var overwriteBtn = sheet.querySelector('#om-preset-overwrite');
        if (overwriteBtn) overwriteBtn.addEventListener('click', function () {
            var dd = load();
            for (var i = 0; i < dd.presets.length; i++) {
                if (dd.presets[i].id === activePresetId) {
                    dd.presets[i].outfits = JSON.parse(JSON.stringify(dd.outfits));
                    dd.presets[i].categories = JSON.parse(JSON.stringify(dd.categories));
                    dd.presets[i].activeIds = JSON.parse(JSON.stringify(dd.activeIds));
                    dd.presets[i].updatedAt = Date.now();
                    break;
                }
            }
            save(dd); closeSheet(sheet); toast('✅ 已保存到「' + currentPreset.name + '」'); openPresetsSheet();
        });

        // 保存为新预设
        var inp = sheet.querySelector('#om-preset-name-inp');
        sheet.querySelector('#om-preset-save').addEventListener('click', function () {
            var name = inp.value.trim(); if (!name) { toast('请输入预设名称', true); return; }
            var dd = load();
            if (!Array.isArray(dd.presets)) dd.presets = [];
            var newId = genId();
            dd.presets.push({ id: newId, name: name, createdAt: Date.now(), outfits: JSON.parse(JSON.stringify(dd.outfits)), categories: JSON.parse(JSON.stringify(dd.categories)), activeIds: JSON.parse(JSON.stringify(dd.activeIds)) });
            save(dd); dd = load(); dd.activePresetId = newId; save(dd); inp.value = ''; closeSheet(sheet); toast('✨ 预设「' + name + '」已保存'); openPresetsSheet();
        });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') sheet.querySelector('#om-preset-save').click(); });

        // 加载预设
        sheet.querySelectorAll('.om-preset-item').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target.closest('.om-preset-ren') || e.target.closest('.om-preset-del')) return;
                var dd = load(); var p = dd.presets[parseInt(item.dataset.idx)]; if (!p) return;
                if (!confirm('加载预设「' + p.name + '」？这将覆盖当前所有穿搭数据。')) return;
                dd.outfits = JSON.parse(JSON.stringify(p.outfits || []));
                dd.categories = JSON.parse(JSON.stringify(p.categories || []));
                dd.activeIds = JSON.parse(JSON.stringify(p.activeIds || []));
                dd.activePresetId = p.id;
                save(dd); closeSheet(sheet); renderCatbar(); renderGrid(); renderBottomStatus(); updateBtn(); toast('✅ 已加载「' + p.name + '」');
            });
        });
        sheet.querySelectorAll('.om-preset-ren').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var dd = load(); var p = dd.presets[parseInt(btn.dataset.idx)]; if (!p) return;
                var nw = prompt('重命名：', p.name); if (!nw || !nw.trim()) return;
                p.name = nw.trim(); save(dd); closeSheet(sheet); openPresetsSheet(); toast('已重命名');
            });
        });
        sheet.querySelectorAll('.om-preset-del').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var dd = load(); var p = dd.presets[parseInt(btn.dataset.idx)]; if (!p) return;
                if (!confirm('删除预设「' + p.name + '」？')) return;
                if (p.id === activePresetId) { dd.activePresetId = null; }
                dd.presets.splice(parseInt(btn.dataset.idx), 1); save(dd); closeSheet(sheet); openPresetsSheet(); toast('已删除');
            });
        });
    }

    // ── 设置 Bottom Sheet ─────────────────────────────────────
    function openSettingsSheet() {
        var d = load();
        var imgCount = d.outfits.filter(function (o) { return !!o.imageData; }).length;

        var sheet = createSheet([
            '<div class="om-sheet-title"><i class="fa-solid fa-sliders"></i>设置</div>',

            '<div class="om-sec-title">发送内容</div>',
            '<div class="om-setting-row"><label>发送给 AI 的内容类型</label><select id="om-mode">',
            '<option value="text"' + (d.mode === 'text' ? ' selected' : '') + '>仅文字描述</option>',
            '<option value="image"' + (d.mode === 'image' ? ' selected' : '') + '>仅图片</option>',
            '<option value="both"' + (d.mode === 'both' ? ' selected' : '') + '>文字 + 图片</option>',
            '</select></div>',

            '<div class="om-setting-row"><label>注入位置 <span class="om-hint">Gemini/DeepSeek 建议选\"用户消息\"</span></label><select id="om-inject-pos">',
            '<option value="system"' + (d.injectPosition === 'system' ? ' selected' : '') + '>系统提示末尾</option>',
            '<option value="context"' + (d.injectPosition === 'context' ? ' selected' : '') + '>上下文末尾</option>',
            '<option value="user"' + (d.injectPosition === 'user' || !d.injectPosition ? ' selected' : '') + '>用户消息末尾（推荐）</option>',
            '</select></div>',

            '<div class="om-divider"></div>',
            '<div class="om-sec-title">单套模式模板 <span class="om-hint">（User选了1套时生效）</span></div>',
            '<div class="om-hint" style="margin-bottom:6px">{{description}} → 替换为穿搭的文字描述</div>',
            '<div class="om-setting-row"><textarea id="om-tpl-single" rows="3">' + esc(d.singleTemplate) + '</textarea></div>',

            '<div class="om-divider"></div>',
            '<div class="om-sec-title">衣柜模式模板 <span class="om-hint">（User选了多套时生效）</span></div>',
            '<div class="om-hint" style="margin-bottom:6px">{{wardrobe}} → 替换为所有已选穿搭的列表</div>',
            '<div class="om-setting-row"><textarea id="om-tpl-multi" rows="5">' + esc(d.multiTemplate) + '</textarea></div>',

            '<div class="om-divider"></div>',
            '<div class="om-sec-title">角色单套模板 <span class="om-hint">（角色选了1套时生效）</span></div>',
            '<div class="om-hint" style="margin-bottom:6px">{{charName}} → 角色名 / {{description}} → 描述</div>',
            '<div class="om-setting-row"><textarea id="om-tpl-char-single" rows="3">' + esc(d.charSingleTemplate || '【{{charName}}的穿搭】\n{{description}}') + '</textarea></div>',

            '<div class="om-divider"></div>',
            '<div class="om-sec-title">角色衣柜模板 <span class="om-hint">（角色选了多套时生效）</span></div>',
            '<div class="om-hint" style="margin-bottom:6px">{{charName}} → 角色名 / {{wardrobe}} → 穿搭列表</div>',
            '<div class="om-setting-row"><textarea id="om-tpl-char-multi" rows="5">' + esc(d.charMultiTemplate || '【{{charName}}的穿搭】\n{{wardrobe}}') + '</textarea></div>',

            '<div class="om-divider"></div>',
            '<div class="om-sec-title">图片模式补充提示</div>',
            '<div class="om-setting-row"><label>单套+图片</label><textarea id="om-imgprompt" rows="2">' + esc(d.imagePrompt) + '</textarea></div>',
            '<div class="om-setting-row" style="margin-top:6px"><label>衣柜+图片</label><textarea id="om-multi-imgprompt" rows="2">' + esc(d.multiImagePrompt) + '</textarea></div>',

            '<div class="om-divider"></div>',
            '<div class="om-sec-title"><i class="fa-solid fa-wand-magic-sparkles" style="margin-right:4px"></i>描述生成 API <span class="om-hint">（用于批量生成穿搭文字描述，需要 Vision 模型）</span></div>',
            '<div class="om-setting-row"><label>API 地址</label><input type="text" id="om-api-v-endpoint" placeholder="https://api.openai.com 或中转站地址" value="' + esc(d.apiVision.endpoint) + '" style="background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;padding:7px 10px;font-size:.85em;width:100%;box-sizing:border-box;font-family:inherit" /></div>',
            '<div class="om-setting-row"><label>API Key</label><input type="password" id="om-api-v-key" placeholder="sk-..." value="' + esc(d.apiVision.key) + '" style="background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;padding:7px 10px;font-size:.85em;width:100%;box-sizing:border-box;font-family:inherit" /></div>',
            '<div class="om-setting-row"><label>模型名称</label><div style="display:flex;gap:6px;align-items:center"><input type="text" id="om-api-v-model" placeholder="gpt-4o / gemini-2.0-flash / claude-sonnet-4-20250514" value="' + esc(d.apiVision.model) + '" style="flex:1;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;padding:7px 10px;font-size:.85em;box-sizing:border-box;font-family:inherit" /><button class="om-btn om-btn-outline" id="om-api-v-model-fetch" style="font-size:.75em;white-space:nowrap;padding:7px 10px;flex-shrink:0"><i class="fa-solid fa-rotate"></i> 拉取</button></div></div>',
            '<div class="om-setting-row"><label>并发数 <span class="om-hint">同时发送的请求数，越大越快但可能触发限速（1-5）</span></label><input type="number" id="om-api-v-batch" min="1" max="5" value="' + (d.apiVision.concurrency || 3) + '" style="background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;padding:7px 10px;font-size:.85em;width:80px;box-sizing:border-box;font-family:inherit" /></div>',
            '<div class="om-setting-row"><label>描述生成 Prompt</label><textarea id="om-api-v-prompt" rows="3" style="background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;padding:7px 10px;font-size:.85em;width:100%;box-sizing:border-box;resize:vertical;font-family:inherit">' + esc(d.apiVision.prompt) + '</textarea></div>',
            '<div class="om-setting-row om-row-inline"><label>覆盖已有描述</label><input type="checkbox" class="om-chk" id="om-api-v-overwrite"' + (d.apiVision.overwrite ? ' checked' : '') + ' /></div>',
            '<div class="om-btn-row" style="margin-top:6px"><button class="om-btn om-btn-outline" id="om-api-v-test" style="font-size:.8em"><i class="fa-solid fa-flask-vial"></i> 测试连接</button></div>',

            '<div class="om-divider"></div>',
            '<div class="om-sec-title">分类管理</div>',
            '<button class="om-btn om-btn-outline" id="om-open-cats" style="width:100%;text-align:left"><i class="fa-solid fa-tags" style="margin-right:7px"></i>管理分类…</button>',

            '<div class="om-divider"></div>',
            '<div class="om-sec-title">数据</div>',
            '<div class="om-storage-info">' + d.outfits.length + ' 套穿搭 / ' + imgCount + ' 张图片 / ' + (d.presets ? d.presets.length : 0) + ' 个预设 | IndexedDB 存储</div>',
            '<div class="om-btn-row" style="margin-top:8px">',
            '<button class="om-btn om-btn-outline" id="om-exp"><i class="fa-solid fa-download"></i> 导出</button>',
            '<button class="om-btn om-btn-outline" id="om-imp"><i class="fa-solid fa-upload"></i> 导入</button>',
            '<button class="om-btn om-btn-danger" id="om-clear">清空穿搭</button>',
            '</div>',

            '<div class="om-divider"></div>',
            '<div class="om-sec-title">悬浮球</div>',
            '<div class="om-setting-row om-row-inline"><label>显示悬浮球</label><input type="checkbox" class="om-chk" id="om-show-ball"' + (d.showBall !== false ? ' checked' : '') + ' /></div>',
            '<div class="om-divider"></div>',
            '<div class="om-sec-title">调试</div>',
            '<div class="om-setting-row om-row-inline"><label>注入时显示 Toast 提示</label><input type="checkbox" class="om-chk" id="om-debug"' + (d.debug ? ' checked' : '') + ' /></div>',
        ].join(''));

        sheet.querySelector('#om-mode').addEventListener('change', function () { var dd = load(); dd.mode = this.value; save(dd); });
        sheet.querySelector('#om-inject-pos').addEventListener('change', function () { var dd = load(); dd.injectPosition = this.value; save(dd); });
        sheet.querySelector('#om-tpl-single').addEventListener('input', function () { var dd = load(); dd.singleTemplate = this.value; save(dd); });
        sheet.querySelector('#om-tpl-multi').addEventListener('input', function () { var dd = load(); dd.multiTemplate = this.value; save(dd); });
        sheet.querySelector('#om-tpl-char-single').addEventListener('input', function () { var dd = load(); dd.charSingleTemplate = this.value; save(dd); });
        sheet.querySelector('#om-tpl-char-multi').addEventListener('input', function () { var dd = load(); dd.charMultiTemplate = this.value; save(dd); });
        sheet.querySelector('#om-imgprompt').addEventListener('input', function () { var dd = load(); dd.imagePrompt = this.value; save(dd); });
        sheet.querySelector('#om-multi-imgprompt').addEventListener('input', function () { var dd = load(); dd.multiImagePrompt = this.value; save(dd); });

        // API Vision 配置
        sheet.querySelector('#om-api-v-endpoint').addEventListener('input', function () { var dd = load(); dd.apiVision.endpoint = this.value.trim(); save(dd); });
        sheet.querySelector('#om-api-v-key').addEventListener('input', function () { var dd = load(); dd.apiVision.key = this.value.trim(); save(dd); });
        sheet.querySelector('#om-api-v-model').addEventListener('input', function () { var dd = load(); dd.apiVision.model = this.value.trim(); save(dd); });
        sheet.querySelector('#om-api-v-batch').addEventListener('change', function () { var dd = load(); dd.apiVision.concurrency = Math.max(1, Math.min(5, parseInt(this.value) || 3)); save(dd); });
        sheet.querySelector('#om-api-v-prompt').addEventListener('input', function () { var dd = load(); dd.apiVision.prompt = this.value; save(dd); });
        sheet.querySelector('#om-api-v-overwrite').addEventListener('change', function () { var dd = load(); dd.apiVision.overwrite = this.checked; save(dd); });
        sheet.querySelector('#om-api-v-test').addEventListener('click', function () {
            var dd = load();
            if (!dd.apiVision.endpoint || !dd.apiVision.key || !dd.apiVision.model) { toast('请先填写 API 地址、Key 和模型名称', true); return; }
            toast('正在测试...');
            fetch(normalizeEndpoint(dd.apiVision.endpoint, 'chat'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dd.apiVision.key },
                body: JSON.stringify({ model: dd.apiVision.model, messages: [{ role: 'user', content: '回复OK' }], max_tokens: 10 })
            }).then(function (r) {
                if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status); });
                return r.json();
            }).then(function () { toast('✅ 描述 API 连接成功！'); })
            .catch(function (e) { toast('❌ 连接失败：' + e.message, true); });
        });
        // Vision 模型拉取按钮
        var vModelFetch = sheet.querySelector('#om-api-v-model-fetch');
        if (vModelFetch) vModelFetch.addEventListener('click', function () {
            var dd = load();
            if (!dd.apiVision.endpoint || !dd.apiVision.key) { toast('请先填写 API 地址和 Key', true); return; }
            openModelPicker(dd.apiVision, function (model) {
                dd = load(); dd.apiVision.model = model; save(dd);
                var inp = sheet.querySelector('#om-api-v-model'); if (inp) inp.value = model;
            });
        });

        sheet.querySelector('#om-show-ball').addEventListener('change', function () {
            var dd = load(); dd.showBall = this.checked; save(dd);
            var oldFab = document.getElementById(FAB_ID); if (oldFab) oldFab.parentNode.removeChild(oldFab);
            if (dd.showBall) injectFab();
        });
        sheet.querySelector('#om-debug').addEventListener('change', function () { var dd = load(); dd.debug = this.checked; save(dd); });
        sheet.querySelector('#om-exp').addEventListener('click', exportData);
        sheet.querySelector('#om-imp').addEventListener('click', importData);
        sheet.querySelector('#om-clear').addEventListener('click', function () {
            var dd = load();
            var label = dd.currentView === 'char' && dd.currentChar ? '「' + dd.currentChar + '」的穿搭' : 'User 的穿搭';
            if (!confirm('确定清空' + label + '？（其他数据不受影响）')) return;
            if (dd.currentView === 'char' && dd.currentChar) {
                var cd = getCharData(dd, dd.currentChar);
                cd.outfits = []; cd.categories = []; cd.activeIds = [];
            } else {
                dd.outfits = []; dd.categories = []; dd.activeIds = [];
            }
            save(dd); closeSheet(sheet); renderCatbar(); renderGrid(); renderBottomStatus(); updateBtn(); toast('已清空');
        });
        sheet.querySelector('#om-open-cats').addEventListener('click', function () {
            closeSheet(sheet); openCatsSheet();
        });
    }

    // ── 分类管理 Bottom Sheet ─────────────────────────────────
    function openCatsSheet() {
        var d = load();
        var cats = getViewCategories(d);
        var viewOutfits = getViewOutfits(d);
        var viewLabel = d.currentView === 'char' && d.currentChar ? d.currentChar + '的' : 'User的';
        var listHTML = cats.length === 0
            ? '<div class="om-empty"><i class="fa-solid fa-tags"></i><span>还没有分类</span></div>'
            : cats.map(function (cat, idx) {
                var n = viewOutfits.filter(function (o) { return o.category === cat; }).length;
                return '<div class="om-cat-item"><span class="om-cat-name">' + esc(cat) + '</span><span class="om-cat-count">' + n + '套</span>' +
                    '<button class="om-btn-sm om-cat-ren" data-idx="' + idx + '" title="重命名"><i class="fa-solid fa-pen"></i></button>' +
                    '<button class="om-btn-sm om-cat-del" data-idx="' + idx + '" title="删除"><i class="fa-solid fa-trash"></i></button></div>';
            }).join('');

        var sheet = createSheet([
            '<div class="om-sheet-title"><i class="fa-solid fa-tags"></i>' + esc(viewLabel) + '分类管理</div>',
            listHTML,
            '<div class="om-divider"></div>',
            '<div class="om-cat-add-row"><input type="text" id="om-newcat" placeholder="新分类名称…" /><button class="om-btn om-btn-safe" id="om-newadd">添加</button></div>',
        ].join(''));

        var inp = sheet.querySelector('#om-newcat');
        sheet.querySelector('#om-newadd').addEventListener('click', function () {
            var name = inp.value.trim(); if (!name) return;
            var dd = load(); var vc = getViewCategories(dd);
            if (vc.indexOf(name) === -1) { vc.push(name); save(dd); inp.value = ''; closeSheet(sheet); renderCatbar(); openCatsSheet(); toast('分类「' + name + '」已添加'); }
            else toast('分类已存在', true);
        });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') sheet.querySelector('#om-newadd').click(); });

        sheet.querySelectorAll('.om-cat-ren').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var dd = load(); var vc = getViewCategories(dd); var vo = getViewOutfits(dd);
                var idx = parseInt(btn.dataset.idx); var old = vc[idx];
                var nw = prompt('重命名（原：' + old + '）：', old); if (!nw || !nw.trim() || nw.trim() === old) return;
                nw = nw.trim(); vc[idx] = nw;
                vo.forEach(function (o) { if (o.category === old) o.category = nw; });
                save(dd); closeSheet(sheet); renderCatbar(); openCatsSheet(); toast('已重命名');
            });
        });
        sheet.querySelectorAll('.om-cat-del').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var dd = load(); var vc = getViewCategories(dd); var vo = getViewOutfits(dd);
                var idx = parseInt(btn.dataset.idx); var name = vc[idx];
                if (!confirm('删除分类「' + name + '」？（穿搭不会被删除）')) return;
                vc.splice(idx, 1);
                vo.forEach(function (o) { if (o.category === name) o.category = ''; });
                if (curCat === name) curCat = '__all__';
                save(dd); closeSheet(sheet); renderCatbar(); openCatsSheet(); toast('已删除');
            });
        });
    }

    // ── Bottom Sheet 通用创建/关闭 ───────────────────────────
    function createSheet(contentHtml) {
        var ov = document.createElement('div');
        ov.className = 'om-sheet-overlay';
        ov.innerHTML = '<div class="om-sheet"><div class="om-sheet-handle"></div><div class="om-sheet-content">' + contentHtml + '</div></div>';
        getPopupLayer().appendChild(ov);
        ov.addEventListener('click', function (e) { if (e.target === ov) closeSheet(ov); });
        return ov;
    }

    function closeSheet(ov) {
        if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    }

    // ── 全屏 Lightbox ─────────────────────────────────────────
    function openLightbox(outfits, startId) {
        if (!outfits || outfits.length === 0) return;
        var idx = 0;
        for (var i = 0; i < outfits.length; i++) { if (outfits[i].id === startId) { idx = i; break; } }

        var lb = document.createElement('div');
        lb.id = 'om-lightbox';
        lb.className = 'om-lightbox';
        lb.style.cssText = 'position:absolute !important;inset:0 !important;z-index:2 !important;pointer-events:auto !important;background:rgba(0,0,0,.92) !important;display:flex !important;align-items:center !important;justify-content:center !important;';

        function render() {
            var o = outfits[idx];
            lb.innerHTML =
                '<button class="om-lb-close" id="om-lb-close"><i class="fa-solid fa-xmark"></i></button>' +
                '<div class="om-lb-name">' + esc(o.name) + '</div>' +
                (outfits.length > 1 ? '<button class="om-lb-nav om-lb-prev" id="om-lb-prev"><i class="fa-solid fa-chevron-left"></i></button>' : '') +
                '<img class="om-lb-img" src="' + o.imageData + '" draggable="false" />' +
                (outfits.length > 1 ? '<button class="om-lb-nav om-lb-next" id="om-lb-next"><i class="fa-solid fa-chevron-right"></i></button>' : '') +
                (outfits.length > 1 ? '<div class="om-lb-counter">' + (idx + 1) + ' / ' + outfits.length + '</div>' : '');
            lb.querySelector('#om-lb-close').addEventListener('click', closeLb);
            var prev = lb.querySelector('#om-lb-prev'); var next = lb.querySelector('#om-lb-next');
            if (prev) prev.addEventListener('click', function (e) { e.stopPropagation(); idx = (idx - 1 + outfits.length) % outfits.length; render(); });
            if (next) next.addEventListener('click', function (e) { e.stopPropagation(); idx = (idx + 1) % outfits.length; render(); });
        }
        lb.addEventListener('click', function (e) { if (e.target === lb) closeLb(); });
        function closeLb() { if (lb.parentNode) lb.parentNode.removeChild(lb); document.removeEventListener('keydown', keyH); }
        function keyH(e) {
            if (e.key === 'Escape') closeLb();
            else if (e.key === 'ArrowLeft' && outfits.length > 1) { idx = (idx - 1 + outfits.length) % outfits.length; render(); }
            else if (e.key === 'ArrowRight' && outfits.length > 1) { idx = (idx + 1) % outfits.length; render(); }
        }
        document.addEventListener('keydown', keyH);
        render();
        getPopupLayer().appendChild(lb);
        lb.style.setProperty('pointer-events', 'auto', 'important');
    }

    // ── 导出 ──────────────────────────────────────────────────
    function doExport(data, filename) {
        try {
            var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = filename; document.body.appendChild(a); a.click();
            setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
        } catch (e) { toast('导出失败：' + e.message, true); }
    }

    function exportData() {
        var d = load();
        var isCharView = d.currentView === 'char' && d.currentChar;
        var modal = document.createElement('div');
        modal.className = 'om-modal ' + (darkMode ? 'om-dark' : 'om-light');
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

        // 导出完整备份
        document.getElementById('om-exp-all').addEventListener('click', function () {
            _mp.removeChild(modal);
            doExport(d, 'outfit-mgr-backup-' + new Date().toISOString().slice(0, 10) + '.json');
            toast('✅ 已导出完整数据');
        });

        // 导出User穿搭
        document.getElementById('om-exp-user').addEventListener('click', function () {
            _mp.removeChild(modal);
            doExport({ type: 'user', outfits: d.outfits, categories: d.categories }, 'outfit-mgr-user-' + new Date().toISOString().slice(0, 10) + '.json');
            toast('✅ 已导出 User 穿搭');
        });

        // 导出当前角色
        var expCharOne = document.getElementById('om-exp-char-one');
        if (expCharOne) expCharOne.addEventListener('click', function () {
            _mp.removeChild(modal);
            var cd = getCharData(d, d.currentChar);
            doExport({ type: 'char', charName: d.currentChar, outfits: cd.outfits, categories: cd.categories }, 'outfit-mgr-char-' + d.currentChar + '-' + new Date().toISOString().slice(0, 10) + '.json');
            toast('✅ 已导出「' + d.currentChar + '」');
        });

        // 导出全部角色
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
                try { var imported = JSON.parse(e.target.result); _mp2.removeChild(modal); processImport(imported, importMode); }
                catch (err) { toast('文件解析失败，请确认是有效的 JSON 文件', true); }
            };
            reader.onerror = function () { toast('文件读取失败', true); };
            reader.readAsText(file, 'utf-8');
        });
    }

    function processImport(imported, mode) {
        var dd = load();
        try {
            // 1. 预设导入
            if (imported.type === 'preset' && imported.preset) {
                var p = imported.preset; p.id = genId();
                if (!Array.isArray(dd.presets)) dd.presets = [];
                dd.presets.push(p); save(dd); renderGrid(); toast('✅ 已导入预设：' + p.name); return;
            }

            // 2. 单个角色导入
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
                save(dd); renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
                toast('✅ 已导入角色「' + cn + '」（' + srcO.length + '套穿搭）');
                return;
            }

            // 3. 全部角色导入
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
                save(dd); renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
                toast('✅ 已导入 ' + importedNames.length + ' 个角色（共 ' + totalOutfits + ' 套穿搭）');
                return;
            }

            // 4. User穿搭导入（type='user' 或旧格式无type）
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

            // 如果是完整备份（含chars），也导入角色数据
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

            save(dd); renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus(); updateBtn();
            toast('✅ 导入成功：' + dd.outfits.length + ' 套穿搭');
        } catch (err) { toast('导入处理失败：' + err.message, true); }
    }

    // ── FAB（悬浮球）────────────────────────────────────────
    var fabResizeHandler = null;

    function injectFab() {
        if (document.getElementById(FAB_ID)) return;
        var d = load(); if (d.showBall === false) return;
        var container = document.createElement('div'); container.id = FAB_ID;
        var MAIN_SIZE = 38;
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

        var mainBtn = document.createElement('div'); mainBtn.id = 'om-fab-main-btn';
        mainBtn.innerHTML = '<i class="fa-solid fa-shirt" style="pointer-events:none;font-size:1.1em;"></i>';

        function styleMainBtn() {
            mainBtn.setAttribute('style',
                'width:' + MAIN_SIZE + 'px !important;height:' + MAIN_SIZE + 'px !important;border-radius:50% !important;' +
                'background:' + accent + ' !important;color:#fff !important;border:none !important;cursor:pointer !important;' +
                'display:flex !important;align-items:center !important;justify-content:center !important;' +
                'font-size:1.2em !important;box-shadow:0 4px 16px rgba(0,0,0,.35) !important;opacity:.9 !important;' +
                'visibility:visible !important;pointer-events:auto !important;margin:0 !important;padding:0 !important;' +
                'flex-shrink:0 !important;transition:transform .2s !important;position:relative !important;z-index:1 !important;');
        }
        styleMainBtn();

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
                setTimeout(function () { openPopup(); }, 50);
            }
        });
        // PC端点击
        mainBtn.addEventListener('click', function (e) {
            if (_dragState.handled) { _dragState.handled = false; return; }
            if (_dragState.moved) { _dragState.moved = false; return; }
            openPopup();
        });

        posFab();
        if (fabResizeHandler) window.removeEventListener('resize', fabResizeHandler);
        fabResizeHandler = posFab;
        window.addEventListener('resize', fabResizeHandler);
        document.body.appendChild(container);
    }

    function closeFab() { /* no-op, fab is now single button */ }

    // ── 批量 AI 生成描述弹窗 ──────────────────────────────────
    function openBatchDescModal(ids) {
        var d = load();
        var withImg = ids.filter(function (id) { var o = getById(d, id); return o && o.imageData; });
        var skipCount = ids.length - withImg.length;
        var willSkipDesc = withImg.filter(function (id) { var o = getById(d, id); return o && o.description && o.description.trim() && !d.apiVision.overwrite; }).length;

        var modal = document.createElement('div');
        modal.className = 'om-modal';
        modal.style.setProperty('z-index', '2147483647', 'important');
        modal.innerHTML = '<div class="om-modal-box" style="background:' + (darkMode ? '#1e1e24' : '#ececef') + ';color:' + (darkMode ? '#eee' : '#111') + '">' +
            '<div class="om-modal-title"><i class="fa-solid fa-wand-magic-sparkles" style="margin-right:6px;color:var(--SmartThemeQuoteColor,#7c6daf)"></i>AI 批量生成描述</div>' +
            '<div style="font-size:.82em;opacity:.7;margin-bottom:8px">' +
            '共选中 ' + ids.length + ' 套，其中 ' + withImg.length + ' 套有图片' +
            (skipCount > 0 ? '，' + skipCount + ' 套无图片将跳过' : '') +
            (willSkipDesc > 0 ? '<br>' + willSkipDesc + ' 套已有描述将跳过（可在设置中开启覆盖）' : '') +
            '</div>' +
            '<div style="font-size:.78em;opacity:.5;margin-bottom:6px">逐张发送，并发 ' + (d.apiVision.concurrency || 3) + ' 个请求，共需 ' + (withImg.length - willSkipDesc) + ' 次 API 调用</div>' +
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
        modal.addEventListener('click', function (e) { if (e.target === modal && !modal.dataset.running) { _mp.removeChild(modal); } });
        modal.querySelector('#om-batch-close').addEventListener('click', function () { if (!modal.dataset.running) _mp.removeChild(modal); });

        modal.querySelector('#om-batch-start').addEventListener('click', function () {
            modal.dataset.running = '1';
            modal.querySelector('#om-batch-progress').style.display = 'block';
            modal.querySelector('#om-batch-start').disabled = true;
            modal.querySelector('#om-batch-start').textContent = '生成中...';
            modal.querySelector('#om-batch-close').textContent = '请等待...';

            batchGenerateDescriptions(ids,
                function (done, total, msg) {
                    // 进度回调
                    var pct = total > 0 ? Math.round(done / total * 100) : 0;
                    var bar = modal.querySelector('#om-batch-prog-bar');
                    var txt = modal.querySelector('#om-batch-prog-text');
                    if (bar) bar.style.width = pct + '%';
                    if (txt) txt.textContent = msg;
                },
                function (err, doneCount, errors) {
                    // 完成回调
                    delete modal.dataset.running;
                    var bar = modal.querySelector('#om-batch-prog-bar');
                    if (bar) bar.style.width = '100%';
                    var resultEl = modal.querySelector('#om-batch-result');
                    resultEl.style.display = 'block';
                    if (err && !doneCount) {
                        resultEl.innerHTML = '<div style="color:#e57373"><i class="fa-solid fa-circle-exclamation"></i> ' + esc(err) + '</div>';
                    } else {
                        var successCount = (doneCount || 0) - (errors ? errors.length : 0);
                        var html2 = '<div style="color:#4caf50;font-weight:600">✅ 成功生成 ' + successCount + ' 条描述</div>';
                        if (errors && errors.length > 0) {
                            html2 += '<div style="color:#ff8c42;margin-top:4px">⚠️ ' + errors.length + ' 个失败：</div>';
                            errors.forEach(function (e) {
                                html2 += '<div style="opacity:.6;font-size:.9em;margin-left:8px">· ' + esc(e.name) + '：' + esc(e.error) + '</div>';
                            });
                        }
                        resultEl.innerHTML = html2;
                    }
                    var actionsEl = modal.querySelector('#om-batch-actions');
                    actionsEl.innerHTML = '<button class="om-btn om-btn-safe" id="om-batch-done">完成</button>';
                    modal.querySelector('#om-batch-done').addEventListener('click', function () {
                        _mp.removeChild(modal);
                        renderGrid();
                    });
                }
            );
        });
    }

    // ── API 调用核心 ───────────────────────────────────────────
    // 统一处理 API 地址，兼容各种填法
    function normalizeEndpoint(raw, path) {
        // path: 'chat' | 'models'
        var url = raw.replace(/\/+$/, '');
        // 去掉已有的 /v1/chat/completions 或 /v1/models 后缀
        url = url.replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/v1\/models\/?$/, '');
        // 去掉末尾的 /v1（用户可能多写了）
        url = url.replace(/\/v1\/?$/, '');
        if (path === 'models') return url + '/v1/models';
        return url + '/v1/chat/completions';
    }

    // 拉取模型列表
    function fetchModelList(apiCfg, cb) {
        if (!apiCfg.endpoint || !apiCfg.key) { cb('请先填写 API 地址和 Key'); return; }
        var url = normalizeEndpoint(apiCfg.endpoint, 'models');
        fetch(url, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + apiCfg.key }
        }).then(function (r) {
            if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status); });
            return r.json();
        }).then(function (data) {
            var models = [];
            var list = data.data || data.models || data;
            if (Array.isArray(list)) {
                list.forEach(function (m) {
                    var id = m.id || m.name || m;
                    if (typeof id === 'string' && id) models.push(id);
                });
            }
            models.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
            cb(null, models);
        }).catch(function (e) { cb(e.message || String(e)); });
    }

    // 模型选择下拉弹窗
    function openModelPicker(apiCfg, onSelect) {
        toast('正在拉取模型列表...');
        fetchModelList(apiCfg, function (err, models) {
            if (err) { toast('拉取失败：' + err, true); return; }
            if (!models || models.length === 0) { toast('未获取到模型列表', true); return; }
            var modal = document.createElement('div');
            modal.className = 'om-modal';
            modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
            var searchHtml = '<input type="text" id="om-model-search" placeholder="搜索模型..." style="width:100%;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;padding:8px 10px;font-size:.85em;box-sizing:border-box;font-family:inherit;margin-bottom:8px" />';
            var listHtml = models.map(function (m) {
                return '<div class="om-model-item" data-model="' + esc(m) + '" style="padding:10px 12px;cursor:pointer;border-radius:8px;font-size:.85em;transition:.12s;word-break:break-all">' + esc(m) + '</div>';
            }).join('');
            modal.innerHTML = '<div class="om-modal-box" style="background:' + (darkMode ? '#1e1e24' : '#ececef') + ';color:' + (darkMode ? '#eee' : '#111') + ';max-height:75vh">' +
                '<div class="om-modal-title"><i class="fa-solid fa-list" style="margin-right:6px"></i>选择模型 <span style="font-weight:400;font-size:.75em;opacity:.5">（共 ' + models.length + ' 个）</span></div>' +
                searchHtml +
                '<div id="om-model-list" style="overflow-y:auto;max-height:50vh;display:flex;flex-direction:column;gap:2px">' + listHtml + '</div>' +
                '<button class="om-modal-cancel" id="om-model-cancel">取消</button></div>';
            var _mp = getPopupLayer();
            _mp.appendChild(modal);
            modal.addEventListener('click', function (e) { if (e.target === modal) _mp.removeChild(modal); });
            modal.querySelector('#om-model-cancel').addEventListener('click', function () { _mp.removeChild(modal); });
            // 搜索过滤
            modal.querySelector('#om-model-search').addEventListener('input', function () {
                var q = this.value.toLowerCase();
                modal.querySelectorAll('.om-model-item').forEach(function (item) {
                    item.style.display = item.dataset.model.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
                });
            });
            setTimeout(function () { modal.querySelector('#om-model-search').focus(); }, 50);
            // 选择模型
            modal.querySelectorAll('.om-model-item').forEach(function (item) {
                item.addEventListener('mouseenter', function () { item.style.background = 'rgba(127,127,127,.12)'; });
                item.addEventListener('mouseleave', function () { item.style.background = ''; });
                item.addEventListener('click', function () {
                    _mp.removeChild(modal);
                    onSelect(item.dataset.model);
                    toast('✅ 已选择：' + item.dataset.model);
                });
            });
        });
    }

    function callVisionAPI(apiCfg, image, systemPrompt, cb) {
        // image: {name, dataUrl} → 单张图片单个请求
        if (!apiCfg.endpoint || !apiCfg.key || !apiCfg.model) { cb('API 未配置完整'); return; }
        var endpoint = normalizeEndpoint(apiCfg.endpoint, 'chat');
        var content = [
            { type: 'image_url', image_url: { url: image.dataUrl } },
            { type: 'text', text: '请描述这套穿搭：' + image.name }
        ];
        var body = {
            model: apiCfg.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: content }
            ],
            max_tokens: 1024
        };
        fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiCfg.key },
            body: JSON.stringify(body)
        }).then(function (r) {
            if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 200)); });
            return r.json();
        }).then(function (data) {
            var text = '';
            if (data.choices && data.choices[0]) {
                var msg = data.choices[0].message;
                text = msg ? (msg.content || '') : '';
            } else if (data.candidates && data.candidates[0]) {
                var parts = data.candidates[0].content && data.candidates[0].content.parts;
                if (parts) text = parts.map(function (p) { return p.text || ''; }).join('');
            }
            cb(null, text.trim());
        }).catch(function (e) { cb(e.message || String(e)); });
    }

    function batchGenerateDescriptions(outfitIds, progressCb, doneCb) {
        var d = load();
        var apiCfg = d.apiVision;
        if (!apiCfg.endpoint || !apiCfg.key || !apiCfg.model) { doneCb('请先在设置中配置"描述生成 API"'); return; }
        var targets = [];
        outfitIds.forEach(function (id) {
            var o = getById(d, id);
            if (!o || !o.imageData) return;
            if (!apiCfg.overwrite && o.description && o.description.trim()) return;
            targets.push(o);
        });
        if (targets.length === 0) { doneCb('没有需要生成描述的穿搭（可能都已有描述或无图片）'); return; }

        var concurrency = Math.max(1, Math.min(5, apiCfg.concurrency || 3));
        var done = 0; var total = targets.length; var errors = [];
        var queue = targets.slice(); // 待处理队列

        function processNext() {
            if (queue.length === 0) return;
            var o = queue.shift();
            var image = { name: o.name, dataUrl: o.imageData };
            callVisionAPI(apiCfg, image, apiCfg.prompt, function (err, text) {
                done++;
                if (err) {
                    errors.push({ name: o.name, error: err });
                } else if (text) {
                    o.description = text;
                } else {
                    errors.push({ name: o.name, error: '返回内容为空' });
                }
                progressCb(done, total, '已完成 ' + done + '/' + total);
                if (done >= total) {
                    save(d);
                    doneCb(errors.length > 0 ? '完成，但有 ' + errors.length + ' 个错误' : null, done, errors);
                } else {
                    processNext();
                }
            });
        }

        progressCb(0, total, '开始生成，并发数 ' + concurrency + '...');
        // 启动 N 个并发
        for (var i = 0; i < Math.min(concurrency, total); i++) {
            processNext();
        }
    }

    // 单个穿搭生成描述
    function generateSingleDescription(outfit, cb) {
        var d = load();
        var apiCfg = d.apiVision;
        if (!apiCfg.endpoint || !apiCfg.key || !apiCfg.model) { cb('请先在设置中配置"描述生成 API"'); return; }
        if (!outfit.imageData) { cb('该穿搭没有图片'); return; }
        callVisionAPI(apiCfg, { name: outfit.name, dataUrl: outfit.imageData }, apiCfg.prompt, function (err, text) {
            if (err) { cb(err); return; }
            cb(null, text);
        });
    }

    // ── API 注入核心 ──────────────────────────────────────────
    // position: 'system' | 'context' | 'user'
    //   system  = 追加到第一条 system message 末尾（原有行为）
    //   context = 在最后一条 user message 之前插入一条 system message（类似 author's note）
    //   user    = 追加到最后一条 user message 文本末尾
    function injectText(p, text, position) {
        if (!p.messages || !Array.isArray(p.messages)) {
            // 兼容 prompt 模式
            if (typeof p.prompt === 'string') p.prompt = text + '\n\n' + p.prompt;
            return;
        }

        if (position === 'user') {
            // 追加到最后一条 user 消息末尾
            for (var j = p.messages.length - 1; j >= 0; j--) {
                if (p.messages[j].role === 'user') {
                    var c = p.messages[j].content;
                    if (typeof c === 'string') p.messages[j].content = c + '\n\n' + text;
                    else if (Array.isArray(c)) c.push({ type: 'text', text: '\n\n' + text });
                    break;
                }
            }
        } else if (position === 'context') {
            // 在最后一条 user 消息之前插入 system 消息
            var lastUserIdx = -1;
            for (var k = p.messages.length - 1; k >= 0; k--) {
                if (p.messages[k].role === 'user') { lastUserIdx = k; break; }
            }
            var sysMsg = { role: 'system', content: text };
            if (lastUserIdx > 0) p.messages.splice(lastUserIdx, 0, sysMsg);
            else if (lastUserIdx === 0) p.messages.unshift(sysMsg);
            else p.messages.push(sysMsg);
        } else {
            // system: 追加到第一条 system message 末尾
            var si = -1; for (var i = 0; i < p.messages.length; i++) { if (p.messages[i].role === 'system') { si = i; break; } }
            if (si !== -1) {
                var sm = p.messages[si];
                if (typeof sm.content === 'string') sm.content += '\n\n' + text;
                else if (Array.isArray(sm.content)) sm.content.push({ type: 'text', text: '\n\n' + text });
            } else { p.messages.unshift({ role: 'system', content: text }); }
        }
    }

    function injectImages(p, imgs) {
        if (!p.messages || !Array.isArray(p.messages)) return;
        for (var j = p.messages.length - 1; j >= 0; j--) {
            if (p.messages[j].role === 'user') {
                var c = p.messages[j].content;
                var blocks = imgs.map(function (img) { return { type: 'image_url', image_url: { url: img } }; });
                if (typeof c === 'string') p.messages[j].content = [{ type: 'text', text: c }].concat(blocks);
                else if (Array.isArray(c)) blocks.forEach(function (b) { c.push(b); });
                break;
            }
        }
    }

    // ★ v19新增：按owner交错注入 文字标签+图片，让AI知道每张图属于谁
    // ★ v21改进：在末尾注入图片提示词模板（风格引导）
    function injectImageBlocks(p, ownerImageGroups, imgPrompt, multiImgPrompt) {
        if (!p.messages || !Array.isArray(p.messages)) return;
        for (var j = p.messages.length - 1; j >= 0; j--) {
            if (p.messages[j].role === 'user') {
                var c = p.messages[j].content;
                // 确保content是数组格式
                if (typeof c === 'string') {
                    c = [{ type: 'text', text: c }];
                    p.messages[j].content = c;
                }

                // 添加总标题
                if (ownerImageGroups.length > 1) {
                    c.push({ type: 'text', text: '\n\n=== 穿搭图片参考 ===' });
                }

                var hasMulti = false;
                ownerImageGroups.forEach(function (grp) {
                    if (grp.isMulti) {
                        hasMulti = true;
                        // 同一owner多套衣柜
                        c.push({ type: 'text', text: '\n[' + grp.name + '的可选穿搭 - 共' + grp.outfits.length + '套]' });
                        grp.outfits.forEach(function (o, i) {
                            c.push({ type: 'text', text: '\n(' + (i + 1) + ') ' + o.name + (o.sceneTag ? ' [场景：' + o.sceneTag + ']' : '') + '：' });
                            c.push({ type: 'image_url', image_url: { url: o.imageData } });
                        });
                    } else {
                        // 单套
                        var o = grp.outfits[0];
                        c.push({ type: 'text', text: '\n[' + grp.name + '当前穿着]' });
                        c.push({ type: 'image_url', image_url: { url: o.imageData } });
                    }
                });

                // 注入图片提示词模板（风格引导）
                var prompt = hasMulti ? multiImgPrompt : imgPrompt;
                if (prompt) {
                    c.push({ type: 'text', text: '\n' + prompt });
                }

                if (ownerImageGroups.length > 1) {
                    c.push({ type: 'text', text: '\n=== 穿搭图片结束 ===' });
                }
                break;
            }
        }
    }

    function setupInjection() {
        var origFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                if (init && init.body && typeof init.body === 'string') {
                    var nb = tryInjectBody(init.body);
                    if (nb) { init = Object.assign({}, init, { body: nb }); return origFetch.call(this, input, init); }
                }
            } catch (e) {}
            return origFetch.apply(this, arguments);
        };
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) {
            try { if (body && typeof body === 'string') { var nb = tryInjectBody(body); if (nb) return origSend.call(this, nb); } } catch (e) {}
            return origSend.apply(this, arguments);
        };
    }

    function tryInjectBody(bodyStr) {
        var p; try { p = JSON.parse(bodyStr); } catch (e) { return null; }
        if (!p || (!p.messages && p.prompt === undefined)) return null;
        var d = load();
        var pos = d.injectPosition || 'user';
        var useImg = (d.mode === 'image' || d.mode === 'both');
        var useText = (d.mode === 'text' || d.mode === 'both');

        // 收集所有owner及其激活穿搭
        var owners = [];
        // User
        var userOutfits = [];
        (d.activeIds || []).forEach(function (id) { for (var i = 0; i < d.outfits.length; i++) { if (d.outfits[i].id === id) { userOutfits.push(d.outfits[i]); break; } } });
        if (userOutfits.length > 0) owners.push({ name: 'User', outfits: userOutfits, tplSingle: d.singleTemplate, tplMulti: d.multiTemplate });
        // Chars
        if (d.chars) {
            for (var cn in d.chars) {
                var cd = d.chars[cn];
                var cos = [];
                (cd.activeIds || []).forEach(function (id) { for (var k = 0; k < (cd.outfits || []).length; k++) { if (cd.outfits[k].id === id) { cos.push(cd.outfits[k]); break; } } });
                if (cos.length > 0) owners.push({ name: cn, outfits: cos, tplSingle: d.charSingleTemplate, tplMulti: d.charMultiTemplate });
            }
        }

        if (owners.length === 0) return null;

        // ★ v19核心改动：先收集所有文本和图片，合并成一条再注入
        var allTextParts = [];
        // 图片模式：按owner收集，保留归属信息
        var ownerImageGroups = []; // [{ name, outfits: [{name, imageData, sceneTag}], isMulti }]

        owners.forEach(function (ow) {
            var active = ow.outfits;
            var isMulti = active.length > 1;

            if (isMulti) {
                var lines = active.map(function (o, i) {
                    var scene = o.sceneTag ? '【场景：' + o.sceneTag + '】' : '';
                    var desc = (o.description && o.description.trim()) ? o.description.trim() : o.name;
                    return '[' + (i + 1) + '] ' + o.name + ' ' + scene + '\n描述：' + desc;
                });
                if (useText) {
                    var wt = (ow.tplMulti || '[服装信息]\n{{charName}}的穿搭：\n{{wardrobe}}')
                        .replace(/\{\{charName\}\}/g, ow.name)
                        .replace('{{wardrobe}}', lines.join('\n\n'));
                    allTextParts.push(wt);
                }
                if (useImg) {
                    var imgOutfits = active.filter(function (o) { return !!o.imageData; });
                    if (imgOutfits.length > 0) ownerImageGroups.push({ name: ow.name, outfits: imgOutfits, isMulti: true });
                }
            } else {
                var o = active[0];
                if (useText) {
                    var desc2 = (o.description && o.description.trim()) ? o.description.trim() : o.name;
                    var st = (ow.tplSingle || '[服装信息]\n{{charName}}当前穿着：\n{{description}}')
                        .replace(/\{\{charName\}\}/g, ow.name)
                        .replace('{{description}}', desc2);
                    allTextParts.push(st);
                }
                if (useImg && o.imageData) { ownerImageGroups.push({ name: ow.name, outfits: [o], isMulti: false }); }
            }
        });

        var injected = false;

        // 合并所有文本为一条，用分隔线隔开
        if (allTextParts.length > 0) {
            var mergedText;
            if (allTextParts.length === 1) {
                mergedText = allTextParts[0];
            } else {
                // 多个owner时加总包裹
                mergedText = '=== 当前场景服装信息（必须严格遵守，不可自行编造服装）===\n\n' + allTextParts.join('\n\n---\n\n') + '\n\n=== 服装信息结束 ===';
            }
            injectText(p, mergedText, pos);
            injected = true;
        }

        // ★ 图片注入：按owner交错注入文字标签+图片，让AI知道哪张图属于谁
        if (ownerImageGroups.length > 0) {
            var imgPrompt = d.imagePrompt || '';
            var multiImgPrompt = d.multiImagePrompt || '';
            injectImageBlocks(p, ownerImageGroups, imgPrompt, multiImgPrompt);
            injected = true;
        }

        if (d.debug) {
            var summary = owners.map(function (ow) { return ow.name + ':' + ow.outfits.length + '套'; }).join(' + ');
            toast('👗 ' + summary + ' [' + d.mode + '|' + pos + ']');
        }

        return injected ? JSON.stringify(p) : null;
    }

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
        btn.addEventListener('click', openPopup);
        menu.appendChild(btn);
    }

    // ── 启动 ──────────────────────────────────────────────────
    injectStyles();
    setupInjection();
    setTimeout(injectBtn, 500);
    setInterval(injectBtn, 2000);
    setTimeout(injectFab, 1500);
    setInterval(function () { if (!document.getElementById(FAB_ID)) injectFab(); }, 3000);

    loadFromDB(function (d) {
        dataCache = d;
        var lsData = loadFromLS();
        if (lsData && lsData.outfits && lsData.outfits.length > 0 && (!d.outfits || d.outfits.length === 0)) {
            dataCache = ensureDefaults(lsData);
            saveToDB(dataCache, function () { try { localStorage.removeItem('outfit_mgr_v4'); } catch (e) {} });
        }
        updateBtn();
    });

})();
