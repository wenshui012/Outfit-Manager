// ── 穿搭管理器 · 数据模型 ──────────────────────────────────
// 默认值、数据迁移、视角数据访问辅助

// ── 通用衣柜保留键 ─────────────────────────────────────────
export var SHARED_CHAR_KEY = '__shared__';
export var SHARED_CHAR_LABEL = '通用衣柜';

// ── 默认数据结构 ─────────────────────────────────────────
export function def() {
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
        tagOrder: [],        // 场景标签排序记忆
        // 界面状态
        currentView: 'user',
        currentChar: '',
        showBall: true,
        fabImage: '',        // 悬浮球自定义图片（base64）
        fabSize: 38,         // 悬浮球大小（28-64px）
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
        apiVision: { endpoint: '', key: '', model: '', prompt: '用JSON回复（不要代码块）：{"name":"穿搭名称6字以内","description":"描述服装类型颜色材质款式搭配，只写服装不写人，100-200字"}', overwrite: false }
    };
}

// ── v17兼容：迁移旧数据 ─────────────────────────────────────
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
    if (d.charActiveIds) {
        for (var cn2 in d.charActiveIds) {
            if (!d.chars[cn2]) d.chars[cn2] = { outfits: [], categories: [], activeIds: [] };
            d.chars[cn2].activeIds = d.charActiveIds[cn2];
        }
        delete d.charActiveIds;
    }
}

// ── 分类迁移：扁平数组 → 树形结构 ─────────────────────────
function migrateCategories(cats) {
    if (!Array.isArray(cats) || cats.length === 0) return cats;
    // 已经是新格式
    if (cats[0] && typeof cats[0] === 'object' && cats[0].name !== undefined) return cats;
    // 旧格式：['夏装','春装'] → [{name:'夏装',children:[]}, ...]
    return cats.map(function (c) { return { name: c, children: [] }; });
}

function migrateCategoriesInData(d) {
    d.categories = migrateCategories(d.categories);
    if (d.chars) {
        for (var cn in d.chars) {
            if (d.chars[cn].categories) {
                d.chars[cn].categories = migrateCategories(d.chars[cn].categories);
            }
        }
    }
    if (Array.isArray(d.presets)) {
        d.presets.forEach(function (p) {
            if (p && p.categories) p.categories = migrateCategories(p.categories);
        });
    }
}

// ── 数据规范化 ─────────────────────────────────────────────
export function ensureDefaults(d) {
    var dd = def();
    if (!d) return dd;
    for (var k in dd) { if (d[k] === undefined) d[k] = dd[k]; }
    if (d.activeId && !d.activeIds) d.activeIds = [d.activeId];
    if (!Array.isArray(d.activeIds)) d.activeIds = [];
    if (!Array.isArray(d.presets)) d.presets = [];
    if (!d.chars) d.chars = {};
    if (!d.charNames) d.charNames = [];
    if (!Array.isArray(d.tagOrder)) d.tagOrder = [];
    if (!d.apiVision) d.apiVision = def().apiVision;
    else {
        var dv = def().apiVision;
        for (var vk in dv) { if (d.apiVision[vk] === undefined) d.apiVision[vk] = dv[vk]; }
        if (d.apiVision.batchSize && !d.apiVision.concurrency) { d.apiVision.concurrency = Math.min(d.apiVision.batchSize, 5); }
        delete d.apiVision.batchSize;
    }
    migrateV17(d);
    migrateCategoriesInData(d);
    return d;
}

// ── 分类辅助函数 ─────────────────────────────────────────
// 获取父分类名列表（用于分类栏顶级渲染）
export function getCatNames(cats) {
    if (!Array.isArray(cats)) return [];
    return cats.map(function (c) { return typeof c === 'object' ? c.name : c; });
}

// 获取某个父分类的子分类列表
export function getSubCats(cats, parentName) {
    if (!Array.isArray(cats)) return [];
    for (var i = 0; i < cats.length; i++) {
        var c = cats[i];
        if (typeof c === 'object' && c.name === parentName) return c.children || [];
    }
    return [];
}

// 查找父分类对象
export function findCatObj(cats, name) {
    if (!Array.isArray(cats)) return null;
    for (var i = 0; i < cats.length; i++) {
        if (typeof cats[i] === 'object' && cats[i].name === name) return cats[i];
    }
    return null;
}

// 判断某个父分类是否有子分类
export function hasSubCats(cats, parentName) {
    return getSubCats(cats, parentName).length > 0;
}

// 判断 outfit 是否属于某个父分类（包括其所有子分类下的）
export function outfitInCategory(o, catName) {
    return o.category === catName;
}

// 判断 outfit 是否属于某个子分类
export function outfitInSubCategory(o, catName, subCatName) {
    return o.category === catName && o.subCategory === subCatName;
}

// ── Char数据访问辅助 ─────────────────────────────────────
export function getCharData(d, charName) {
    if (!d.chars) d.chars = {};
    if (!d.chars[charName]) d.chars[charName] = { outfits: [], categories: [], activeIds: [] };
    return d.chars[charName];
}

export function currentOwner(d) {
    if (d.currentView === 'char' && d.currentChar) return d.currentChar;
    return 'user';
}

export function getViewOutfits(d) {
    if (d.currentView === 'char' && d.currentChar) return getCharData(d, d.currentChar).outfits;
    return d.outfits;
}

export function getViewCategories(d) {
    if (d.currentView === 'char' && d.currentChar) return getCharData(d, d.currentChar).categories;
    return d.categories;
}

export function getViewActiveIds(d) {
    if (d.currentView === 'char' && d.currentChar) return getCharData(d, d.currentChar).activeIds;
    return d.activeIds;
}

export function setViewActiveIds(d, ids) {
    if (d.currentView === 'char' && d.currentChar) { getCharData(d, d.currentChar).activeIds = ids; }
    else { d.activeIds = ids; }
}

export function getById(d, id) {
    for (var i = 0; i < d.outfits.length; i++) { if (d.outfits[i].id === id) return d.outfits[i]; }
    if (d.chars) { for (var cn in d.chars) { var co = d.chars[cn].outfits || []; for (var j = 0; j < co.length; j++) { if (co[j].id === id) return co[j]; } } }
    return null;
}

export function getViewById(d, id) {
    var list = getViewOutfits(d);
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return null;
}

export function isActive(d, id) {
    return getViewActiveIds(d).indexOf(id) !== -1;
}
