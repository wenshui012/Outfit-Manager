// ── 穿搭管理器 · 注入核心 ──────────────────────────────────
// fetch/XHR 拦截 + 穿搭信息注入到 AI 请求

import { load } from './db.js';
import { getById } from './data.js';
import { toast } from './utils.js';

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
                        c.push({ type: 'text', text: '\n(' + (i + 1) + ') ' + o.name + (o.sceneTag ? ' [场景：' + o.sceneTag + ']' : '') + '：' });
                        c.push({ type: 'image_url', image_url: { url: o.imageData } });
                    });
                } else {
                    var o = grp.outfits[0];
                    c.push({ type: 'text', text: '\n[' + grp.name + '当前穿着]' });
                    c.push({ type: 'image_url', image_url: { url: o.imageData } });
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

    if (d.chars) {
        for (var cn in d.chars) {
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
