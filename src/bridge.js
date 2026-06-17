// ── 穿搭管理器 · 共享状态桥 ──────────────────────────────
// 各模块注册回调到此处，避免循环依赖
// UI 状态变量也集中存放

export var state = {
    darkMode: false,
    curCat: '__all__',
    curSubCat: null,        // 当前子分类筛选，null=全部（在父分类下）
    catDrillParent: null,   // 分类下钻的父分类名，null=在顶级
    batchMode: false,
    batchSelected: [],
    searchOpen: false,
    searchQuery: '',
    detailOpen: false,
    collapsedGroups: {},
    resolvedImages: {}   // server模式下预解析的图片缓存 { outfitId: { url, dataUrl } }
};

// 函数注册表：各模块把自己的函数注册进来，其他模块通过 fn.xxx() 调用
export var fn = {};
