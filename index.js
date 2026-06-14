// ══════════════════════════════════════════════════════════
// 穿搭管理器 Outfit Manager 正式版v1.7.0
// by 温水 & 克洛宜
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
injectStyles();
setupInjection();
setTimeout(injectBtn, 500);
setInterval(injectBtn, 2000);
setTimeout(injectFab, 1500);
setInterval(function () { if (!document.getElementById(FAB_ID)) injectFab(); }, 3000);

// 初始化存储：自动探测后端，可用则 server 模式，不可用则本地
initStorage(function (d) {
    updateBtn();
    preResolveActiveImages();
});
