// ── 穿搭管理器 · 安全恢复窗口 ───────────────────────────
// 初始化失败时独立于业务 UI 运行；自动诊断只读，恢复必须由用户明确触发。

import {
    diagnoseServerRecovery,
    initStorage,
    restoreServerSnapshot
} from './db.js';
import { BTN_ID, findMenu } from './ui-fab.js';
import { esc } from './utils.js';

var RECOVERY_OVERLAY_ID = 'om-recovery-overlay';
var activeError = null;
var diagnosis = null;
var diagnosisError = null;
var actionError = null;
var diagnosing = false;
var busy = false;
var autoOpened = false;
var onRecovered = null;

function errorInfo(err) {
    var details = err && err.details ? err.details : {};
    return {
        code: err && err.code ? err.code : 'SERVER_INIT_FAILED',
        message: err && err.message ? err.message : '后端数据读取失败',
        kind: details && details.kind ? details.kind : null,
        status: details && details.status ? details.status : 0,
        detail: details && details.error ? details.error : null
    };
}

function currentIssueHtml() {
    var issues = diagnosis && Array.isArray(diagnosis.issues) ? diagnosis.issues : [];
    if (issues.length > 0) {
        return '<div class="om-recovery-issues">' + issues.map(function (issue) {
            return '<div class="om-recovery-issue"><code>' + esc(issue.code || 'UNKNOWN') + '</code><span>' +
                esc(issue.message || '检测到未知数据异常') + '</span></div>';
        }).join('') + '</div>';
    }
    var info = errorInfo(activeError);
    return '<div class="om-recovery-issues"><div class="om-recovery-issue"><code>' +
        esc(info.code) + '</code><span>' + esc(info.message) + '</span></div></div>';
}

function latestSnapshot() {
    return diagnosis && diagnosis.latestSnapshot ? diagnosis.latestSnapshot : null;
}

function renderRecovery() {
    var overlay = document.getElementById(RECOVERY_OVERLAY_ID);
    if (!overlay) return;
    var snapshot = latestSnapshot();
    var info = errorInfo(activeError);
    var statusText = busy
        ? '<i class="fa-solid fa-spinner fa-spin"></i> 正在处理，请不要关闭页面…'
        : actionError
            ? '操作失败：' + esc(actionError.message || String(actionError))
            : diagnosing
                ? '<i class="fa-solid fa-spinner fa-spin"></i> 正在只读分析后端数据…'
                : diagnosisError
                    ? '自动诊断未完成：' + esc(diagnosisError.message || String(diagnosisError))
                    : diagnosis
                        ? (diagnosis.healthy ? '后端当前检查正常，可尝试重新检测。' : '已完成分析，所有普通写入仍处于关闭状态。')
                        : '等待诊断…';
    var snapshotText = snapshot
        ? '<div class="om-recovery-snapshot">找到已验证的正常快照：<strong>' +
            esc(snapshot.createdAt || snapshot.id) + '</strong></div>'
        : '<div class="om-recovery-snapshot muted">没有可用于自动恢复的正常快照。</div>';

    overlay.innerHTML = [
        '<div class="om-recovery-card" role="dialog" aria-modal="true" aria-labelledby="om-recovery-title">',
        '<button class="om-recovery-close" id="om-recovery-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>',
        '<div class="om-recovery-icon"><i class="fa-solid fa-shield-halved"></i></div>',
        '<div class="om-recovery-title" id="om-recovery-title">穿搭管理器无法安全启动</div>',
        '<div class="om-recovery-safe">已停止普通数据写入，现有后端数据不会被本地缓存自动覆盖。</div>',
        '<div class="om-recovery-status">' + statusText + '</div>',
        currentIssueHtml(),
        snapshotText,
        '<details class="om-recovery-details"><summary>查看启动错误详情</summary>',
        '<div>错误代码：<code>' + esc(info.code) + '</code></div>',
        (info.status ? '<div>HTTP 状态：<code>' + esc(info.status) + '</code></div>' : ''),
        (info.kind ? '<div>错误类型：<code>' + esc(info.kind) + '</code></div>' : ''),
        (info.detail ? '<div>详细信息：' + esc(info.detail) + '</div>' : ''),
        '</details>',
        '<div class="om-recovery-actions">',
        '<button class="om-btn om-btn-outline" id="om-recovery-export"' + (busy ? ' disabled' : '') + '><i class="fa-solid fa-download"></i> 导出诊断</button>',
        '<button class="om-btn om-btn-outline" id="om-recovery-retry"' + (busy || diagnosing ? ' disabled' : '') + '><i class="fa-solid fa-rotate"></i> 重新检测</button>',
        (snapshot && diagnosis && diagnosis.healthy === false && diagnosis.canRestore
            ? '<button class="om-btn om-btn-safe" id="om-recovery-restore"' + (busy || diagnosing ? ' disabled' : '') + '><i class="fa-solid fa-clock-rotate-left"></i> 一键恢复</button>'
            : ''),
        '</div>',
        (busy ? '<div class="om-recovery-busy"><i class="fa-solid fa-spinner fa-spin"></i> 正在处理，请不要关闭页面…</div>' : ''),
        '</div>'
    ].join('');

    overlay.querySelector('#om-recovery-close').addEventListener('click', closeRecovery);
    overlay.querySelector('#om-recovery-export').addEventListener('click', exportDiagnosis);
    overlay.querySelector('#om-recovery-retry').addEventListener('click', retryInitialization);
    var restoreBtn = overlay.querySelector('#om-recovery-restore');
    if (restoreBtn) restoreBtn.addEventListener('click', restoreLatest);
}

function openRecovery() {
    var overlay = document.getElementById(RECOVERY_OVERLAY_ID);
    if (!overlay) {
        if (!document.body) {
            setTimeout(openRecovery, 100);
            return;
        }
        overlay = document.createElement('div');
        overlay.id = RECOVERY_OVERLAY_ID;
        overlay.className = 'om-recovery-overlay';
        document.body.appendChild(overlay);
    }
    renderRecovery();
    if (!diagnosis && !diagnosing) runDiagnosis();
}

function closeRecovery() {
    var overlay = document.getElementById(RECOVERY_OVERLAY_ID);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
}

function runDiagnosis() {
    diagnosing = true;
    diagnosis = null;
    diagnosisError = null;
    actionError = null;
    renderRecovery();
    diagnoseServerRecovery(function (err, result) {
        diagnosing = false;
        diagnosisError = err || null;
        diagnosis = result || null;
        renderRecovery();
    });
}

function retryInitialization() {
    if (busy) return;
    busy = true;
    actionError = null;
    renderRecovery();
    initStorage(function (err) {
        busy = false;
        if (err) {
            activeError = err;
            diagnosis = null;
            diagnosisError = null;
            actionError = null;
            renderRecovery();
            runDiagnosis();
            return;
        }
        deactivateRecovery();
        if (onRecovered) onRecovered();
    });
}

function restoreLatest() {
    var snapshot = latestSnapshot();
    if (!snapshot || busy) return;
    var label = snapshot.createdAt || snapshot.id;
    if (!confirm(
        '恢复到正常快照「' + label + '」？\n\n' +
        '后端会先保存当前故障数据，再执行恢复和完整校验。'
    )) return;
    busy = true;
    actionError = null;
    renderRecovery();
    restoreServerSnapshot(snapshot.id, function (err) {
        if (err) {
            busy = false;
            actionError = err;
            renderRecovery();
            return;
        }
        busy = false;
        retryInitialization();
    });
}

function exportDiagnosis() {
    var info = errorInfo(activeError);
    var payload = {
        exportedAt: new Date().toISOString(),
        startupError: info,
        diagnosis: diagnosis,
        diagnosisError: diagnosisError ? {
            message: diagnosisError.message || String(diagnosisError),
            status: diagnosisError.status || 0
        } : null,
        actionError: actionError ? {
            message: actionError.message || String(actionError),
            status: actionError.status || 0
        } : null
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'outfit-manager-diagnosis-' + Date.now() + '.json';
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
    URL.revokeObjectURL(url);
}

function injectRecoveryBtn() {
    var existing = document.getElementById(BTN_ID);
    if (existing && existing.dataset && existing.dataset.omRecovery === '1') return;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var menu = findMenu();
    if (!menu) return;
    var btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.className = 'list-group-item flex-container flexGap5 interactable';
    btn.title = '穿搭管理';
    btn.dataset.omRecovery = '1';
    btn.innerHTML = '<i class="fa-solid fa-shirt"></i><span>穿搭管理</span>';
    btn.addEventListener('click', openRecovery);
    menu.appendChild(btn);
}

function activateRecovery(err, recoveredHandler) {
    activeError = err;
    onRecovered = recoveredHandler || null;
    diagnosis = null;
    diagnosisError = null;
    actionError = null;
    busy = false;
    injectRecoveryBtn();
    if (!autoOpened) {
        autoOpened = true;
        setTimeout(openRecovery, 0);
    } else {
        renderRecovery();
    }
}

function deactivateRecovery() {
    closeRecovery();
    activeError = null;
    diagnosis = null;
    diagnosisError = null;
    actionError = null;
    diagnosing = false;
    busy = false;
    autoOpened = false;
    var btn = document.getElementById(BTN_ID);
    if (btn && btn.dataset && btn.dataset.omRecovery === '1' && btn.parentNode) {
        btn.parentNode.removeChild(btn);
    }
}

export {
    activateRecovery,
    deactivateRecovery,
    injectRecoveryBtn,
    openRecovery
};
