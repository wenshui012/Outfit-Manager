// ══════════════════════════════════════════════════════════
// 穿搭管理器 Outfit Manager v2.0.0
// by 温水 & 克洛宜
// 存储分包架构 · meta + partition
// ══════════════════════════════════════════════════════════

import { injectStyles } from './src/styles.js';
import { initStorage } from './src/db.js';
import { setupInjection } from './src/inject.js';
import { state, fn } from './src/bridge.js';
import { registerMainFn, preResolveActiveImages } from './src/ui-main.js';
import { registerSheetsFn, createSheet, closeSheet, getAllTagSuggestions } from './src/ui-sheets.js';
import { registerBatchFn, initBatchDeps } from './src/ui-batch.js';
import { FAB_ID, injectFab, updateBtn, injectBtn, registerFabFn } from './src/ui-fab.js';

// ── 注册跨模块函数 ─────────────────────────────────────
registerMainFn();
registerSheetsFn();
initBatchDeps(createSheet, closeSheet, getAllTagSuggestions);
registerBatchFn();
registerFabFn();

// ── 启动 ──────────────────────────────────────────────────
// 样式可以先注入（不依赖数据）
injectStyles();

// 初始化存储：探测后端 → 加载 meta → 迁移 → 预加载 partitions
// 所有依赖数据的操作（注入拦截、悬浮球、按钮）放在回调里
initStorage(function () {
    // 安装 fetch/XHR 拦截
    setupInjection();

    // 按钮和悬浮球
    setTimeout(injectBtn, 300);
    setInterval(injectBtn, 2000);
    setTimeout(injectFab, 500);
    setInterval(function () { if (!document.getElementById(FAB_ID)) injectFab(); }, 3000);

    updateBtn();
    preResolveActiveImages();
});
