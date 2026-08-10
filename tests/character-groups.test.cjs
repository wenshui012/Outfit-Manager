'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function loadDataModule() {
    const file = path.resolve(__dirname, '..', 'src', 'data.js');
    const context = vm.createContext({ Object, Array, String, Number, Boolean, Date, Math });
    const mod = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { context, identifier: file });
    await mod.link(() => { throw new Error('data.js must not import other modules'); });
    await mod.evaluate();
    return mod.namespace;
}

async function run() {
    const data = await loadDataModule();

    // 改名保留成员和原有显示顺序，重复名/保留名不得覆盖现有分组。
    {
        const members = ['Alice', 'Bob'];
        const state = { charGroups: { Friends: members, Others: ['Cara'] } };
        assert.deepEqual(
            JSON.parse(JSON.stringify(data.renameCharGroup(state, 'Friends', 'Main Cast'))),
            { ok: true, oldName: 'Friends', newName: 'Main Cast' }
        );
        assert.deepEqual(Object.keys(state.charGroups), ['Main Cast', 'Others']);
        assert.equal(state.charGroups['Main Cast'], members, 'rename must preserve the member array');
        assert.equal(data.renameCharGroup(state, 'Main Cast', 'Others').code, 'GROUP_NAME_EXISTS');
        assert.equal(data.renameCharGroup(state, 'Main Cast', '__proto__').code, 'GROUP_NAME_INVALID');
        assert.deepEqual(Object.keys(state.charGroups), ['Main Cast', 'Others'], 'failed rename must not mutate groups');
    }

    // 仅解散分组：角色、衣柜、收藏和当前角色全部保留。
    {
        const aliceWardrobe = { outfits: [{ id: 'alice-outfit' }] };
        const state = {
            charNames: ['Alice', 'Bob'],
            chars: { Alice: aliceWardrobe, Bob: { outfits: [] } },
            charFavorites: ['Alice'],
            charGroups: { Team: ['Alice', 'Bob'], Other: ['Bob'] },
            currentChar: 'Alice'
        };
        const result = data.deleteCharGroup(state, 'Team', false);
        assert.equal(result.ok, true);
        assert.deepEqual(Array.from(result.releasedNames), ['Alice', 'Bob']);
        assert.equal(state.chars.Alice, aliceWardrobe);
        assert.deepEqual(Array.from(state.charNames), ['Alice', 'Bob']);
        assert.deepEqual(Array.from(state.charFavorites), ['Alice']);
        assert.equal(state.currentChar, 'Alice');
        assert.equal(Object.prototype.hasOwnProperty.call(state.charGroups, 'Team'), false);
        assert.deepEqual(Array.from(state.charGroups.Other), ['Bob']);
    }

    // 删除组内衣柜：一次性清理角色、收藏、其他分组引用，并安全回退当前角色。
    {
        const caraWardrobe = { outfits: [{ id: 'keep-me' }] };
        const state = {
            charNames: ['Alice', 'Bob', 'Cara'],
            chars: {
                Alice: { outfits: [{ id: 'a' }] },
                Bob: { outfits: [{ id: 'b' }] },
                Cara: caraWardrobe
            },
            charFavorites: ['Bob', 'Cara'],
            charGroups: {
                DeleteMe: ['Alice', 'Bob', 'Alice', 'stale-name'],
                Mixed: ['Alice', 'Cara', 'Bob']
            },
            currentChar: 'Bob'
        };
        const result = data.deleteCharGroup(state, 'DeleteMe', true);
        assert.deepEqual(Array.from(result.deletedNames), ['Alice', 'Bob']);
        assert.deepEqual(Array.from(state.charNames), ['Cara']);
        assert.deepEqual(Object.keys(state.chars), ['Cara']);
        assert.equal(state.chars.Cara, caraWardrobe, 'unrelated wardrobe must remain byte-for-byte/object-identical');
        assert.deepEqual(Array.from(state.charFavorites), ['Cara']);
        assert.deepEqual(Array.from(state.charGroups.Mixed), ['Cara']);
        assert.equal(state.currentChar, data.SHARED_CHAR_KEY);
    }

    console.log('character groups: pass (rename / disband / delete member wardrobes / reference cleanup)');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
