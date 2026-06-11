// ══════════════════════════════════════════════════════════
// 穿搭管理器 Outfit Manager 正式版v1.5.0
// by 温水 & 克洛宜
// ══════════════════════════════════════════════════════════

import { injectStyles } from './src/styles.js';
import { loadFromDB, saveToDB, load, setCache, loadFromLS, removeLSData } from './src/db.js';
import { ensureDefaults } from './src/data.js';
import { setupInjection } from './src/inject.js';
import { state, fn } from './src/bridge.js';
import { registerMainFn } from './src/ui-main.js';
import { registerSheetsFn } from './src/ui-sheets.js';
import { FAB_ID, injectFab, updateBtn, injectBtn, registerFabFn } from './src/ui-fab.js';

// ── 注册跨模块函数 ─────────────────────────────────────
registerMainFn();
registerSheetsFn();
registerFabFn();

// ── 启动 ──────────────────────────────────────────────────
injectStyles();
setupInjection();
setTimeout(injectBtn, 500);
setInterval(injectBtn, 2000);
setTimeout(injectFab, 1500);
setInterval(function () { if (!document.getElementById(FAB_ID)) injectFab(); }, 3000);

loadFromDB(function (d) {
    setCache(d);
    var lsData = loadFromLS();
    if (lsData && lsData.outfits && lsData.outfits.length > 0 && (!d.outfits || d.outfits.length === 0)) {
        setCache(ensureDefaults(lsData));
        saveToDB(ensureDefaults(lsData), function () { removeLSData(); });
    }
    updateBtn();
});
