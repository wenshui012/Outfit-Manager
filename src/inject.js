// ── 穿搭管理器 · 注入核心 ──────────────────────────────────
// fetch/XHR 拦截 + 穿搭信息注入到 AI 请求

import { load } from './db.js';
import { getById, SHARED_CHAR_KEY } from './data.js';
import { toast } from './utils.js';
import { state } from './bridge.js';

// 获取注入用的图片URL（server模式下优先用预解析的base64）
function getInjectImageUrl(outfit) {
    if (!outfit || !outfit.imageData) return null;
    // 检查预解析缓存
    if (state.resolvedImages && state.resolvedImages[outfit.id]) {
        var cached = state.resolvedImages[outfit.id];
        if (cached.dataUrl && cached.url === outfit.imageData) {
            return cached.dataUrl;
        }
    }
    return outfit.imageData;
}

// ── 文本注入 ─────────────────────────────────────────────
// position: 'system' | 'context' | 'user'
function injectText(p, text, position) {
    if (!p.messages || !Array.isArray(p.messages)) {
        if (typeof p.prompt === 'string') p.prompt = text + '\n\n' + p.prompt;
        return;
    }

    if (position === 'user') {
        for (var j = p.messages.length - 1; j >= 0; j--) {
            if (p.messages[j].role === 'user') {
                var c = p.messages[j].content;
                if (typeof c === 'string') p.messages[j].content = c + '\n\n' + text;
                else if (Array.isArray(c)) c.push({ type: 'text', text: '\n\n' + text });
                break;
            }
        }
    } else if (position === 'context') {
        var lastUserIdx = -1;
        for (var k = p.messages.length - 1; k >= 0; k--) {
            if (p.messages[k].role === 'user') { lastUserIdx = k; break; }
        }
        var sysMsg = { role: 'system', content: text };
        if (lastUserIdx > 0) p.messages.splice(lastUserIdx, 0, sysMsg);
        else if (lastUserIdx === 0) p.messages.unshift(sysMsg);
        else p.messages.push(sysMsg);
    } else {
        var si = -1; for (var i = 0; i < p.messages.length; i++) { if (p.messages[i].role === 'system') { si = i; break; } }
        if (si !== -1) {
            var sm = p.messages[si];
            if (typeof sm.content === 'string') sm.content += '\n\n' + text;
            else if (Array.isArray(sm.content)) sm.content.push({ type: 'text', text: '\n\n' + text });
        } else { p.messages.unshift({ role: 'system', content: text }); }
    }
}

// ── 图片注入（旧接口，保留兼容）─────────────────────────
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

// ── 按owner交错注入 文字标签+图片 ────────────────────────
function injectImageBlocks(p, ownerImageGroups, imgPrompt, multiImgPrompt) {
    if (!p.messages || !Array.isArray(p.messages)) return;
    for (var j = p.messages.length - 1; j >= 0; j--) {
        if (p.messages[j].role === 'user') {
            var c = p.messages[j].content;
            if (typeof c === 'string') {
                c = [{ type: 'text', text: c }];
                p.messages[j].content = c;
            }

            if (ownerImageGroups.length > 1) {
                c.push({ type: 'text', text: '\n\n=== 穿搭图片参考 ===' });
            }

            var hasMulti = false;
            ownerImageGroups.forEach(function (grp) {
                if (grp.isMulti) {
                    hasMulti = true;
                    c.push({ type: 'text', text: '\n[' + grp.name + '的可选穿搭 - 共' + grp.outfits.length + '套]' });
                    grp.outfits.forEach(function (o, i) {
                        c.push({ type: 'text', text: '\n(穿搭' + (i + 1) + ')' + (o.sceneTag ? ' [场景：' + o.sceneTag + ']' : '') + '：' });
                        c.push({ type: 'image_url', image_url: { url: getInjectImageUrl(o) } });
                    });
                } else {
                    var o = grp.outfits[0];
                    c.push({ type: 'text', text: '\n[' + grp.name + '当前穿着]' });
                    c.push({ type: 'image_url', image_url: { url: getInjectImageUrl(o) } });
                }
            });

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

// ── 请求体注入逻辑 ─────────────────────────────────────
function tryInjectBody(bodyStr) {
    var p; try { p = JSON.parse(bodyStr); } catch (e) { return null; }
    if (!p || (!p.messages && p.prompt === undefined)) return null;
    var d = load();
    var pos = d.injectPosition || 'user';
    var useImg = (d.mode === 'image' || d.mode === 'both');
    var useText = (d.mode === 'text' || d.mode === 'both');

    // 收集所有owner及其激活穿搭
    var owners = [];
    var userOutfits = [];
    (d.activeIds || []).forEach(function (id) { for (var i = 0; i < d.outfits.length; i++) { if (d.outfits[i].id === id) { userOutfits.push(d.outfits[i]); break; } } });
    if (userOutfits.length > 0) owners.push({ name: 'User', outfits: userOutfits, tplSingle: d.singleTemplate, tplMulti: d.multiTemplate });

    // ── 角色衣柜：通用 vs 单人互斥 ──
    var sharedOutfits = [];
    if (d.chars && d.chars[SHARED_CHAR_KEY]) {
        var scd = d.chars[SHARED_CHAR_KEY];
        (scd.activeIds || []).forEach(function (id) { for (var k = 0; k < (scd.outfits || []).length; k++) { if (scd.outfits[k].id === id) { sharedOutfits.push(scd.outfits[k]); break; } } });
    }

    if (sharedOutfits.length > 0) {
        // 通用衣柜有激活 → 用当前角色卡名字注入，忽略所有单人衣柜
        var charName2 = '';
        try { charName2 = SillyTavern.getContext().name2 || ''; } catch (e) {}
        if (charName2) {
            owners.push({ name: charName2, outfits: sharedOutfits, tplSingle: d.charSingleTemplate, tplMulti: d.charMultiTemplate });
        }
    } else if (d.chars) {
        // 通用衣柜无激活 → 使用单人衣柜
        for (var cn in d.chars) {
            if (cn === SHARED_CHAR_KEY) continue;
            var cd = d.chars[cn];
            var cos = [];
            (cd.activeIds || []).forEach(function (id) { for (var k = 0; k < (cd.outfits || []).length; k++) { if (cd.outfits[k].id === id) { cos.push(cd.outfits[k]); break; } } });
            if (cos.length > 0) owners.push({ name: cn, outfits: cos, tplSingle: d.charSingleTemplate, tplMulti: d.charMultiTemplate });
        }
    }

    if (owners.length === 0) return null;

    var allTextParts = [];
    var ownerImageGroups = [];

    owners.forEach(function (ow) {
        var active = ow.outfits;
        var isMulti = active.length > 1;

        if (isMulti) {
            var lines = active.map(function (o, i) {
                var scene = o.sceneTag ? '【场景：' + o.sceneTag + '】' : '';
                var desc = (o.description && o.description.trim()) ? o.description.trim() : '';
                return '[穿搭' + (i + 1) + '] ' + scene + (desc ? '\n' + desc : '');
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
                var desc2 = (o.description && o.description.trim()) ? o.description.trim() : '';
                if (desc2) {
                    var st = (ow.tplSingle || '[服装信息]\n{{charName}}当前穿着：\n{{description}}')
                        .replace(/\{\{charName\}\}/g, ow.name)
                        .replace('{{description}}', desc2);
                    allTextParts.push(st);
                }
            }
            if (useImg && o.imageData) { ownerImageGroups.push({ name: ow.name, outfits: [o], isMulti: false }); }
        }
    });

    var injected = false;

    if (allTextParts.length > 0) {
        var mergedText;
        if (allTextParts.length === 1) {
            mergedText = allTextParts[0];
        } else {
            mergedText = '=== 当前场景服装信息（必须严格遵守，不可自行编造服装）===\n\n' + allTextParts.join('\n\n---\n\n') + '\n\n=== 服装信息结束 ===';
        }
        injectText(p, mergedText, pos);
        injected = true;
    }

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

// ── 安装拦截器 ─────────────────────────────────────────
export function setupInjection() {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            // 跳过插件内部的 API 调用
            if (init && init.headers && init.headers['X-OM-Internal']) {
                return origFetch.apply(this, arguments);
            }
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
