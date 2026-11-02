// Canvas bookkeeping around containers:
//  - a patch added by hand to a grouped (WAV-match) container was stored in
//    ctr.patchIds only, and grouped containers render only their groups —
//    the patch was invisible;
//  - removing a patch left it in the group it came from;
//  - touch-reorder moved it in ctr.patchIds while the rows on screen came
//    from group.patchIds, so nothing visibly moved;
//  - a tap (no movement) on a floating patch's header dropped it into any
//    container whose box it overlapped;
//  - initCanvas() runs after every import and stacked a fresh set of drop
//    handlers on the sky element each time.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, StubElement } from './harness.js';

let canvas, canvasStore, patchStore, createPatch, reorderContainerPatch;
let bindProjectSession, makeProjectSession;
let sky;
let env;

before(async () => {
    env = installBrowserEnv();
    env.document.getElementById = (id) => (id === 'night-sky' ? sky : null);
    canvas = await import('../html/components/canvas.js');
    ({ canvasStore, patchStore, createPatch } = await import('../html/components/patch-model.js'));
    // Patches and the canvas live in the open project now, so the store
    // needs one to read and write.
    ({ bindProjectSession } = await import('../html/components/patch-model.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    ({ reorderContainerPatch } = await import('../html/components/patch-row.js'));
});

const voice = (n) => btoa(String.fromCharCode(n).repeat(128));

function storePatch(name, n) {
    const p = createPatch({ name, voice_data: voice(n), source: 'test' });
    patchStore.put(p);
    return p;
}

function groupedContainer(id = 'ctr_g') {
    const a = storePatch('A', 1), b = storePatch('B', 2), c = storePatch('C', 3);
    canvasStore.putContainer({
        id, name: 'wav', left: 0, top: 0, width: 260,
        patchIds: [a.id, b.id, c.id],
        groups: [{ label: 'NEAREST', patchIds: [a.id, b.id] }, { label: 'FULL', patchIds: [c.id] }],
    });
    for (const p of [a, b, c]) canvasStore.putCanvasPatch(p.id, { containerId: id, left: 0, top: 0, minified: true });
    return { a, b, c };
}

function rowIds(containerEl) {
    return containerEl.querySelectorAll('.patch-row').map(r => r.dataset.patchId);
}

beforeEach(() => {
    localStorage.clear();
    // Patches and the canvas live in the open project now.
    bindProjectSession(makeProjectSession());
    sky = new StubElement('div');
    canvas.initCanvas({});
});

describe('grouped containers', () => {
    test('a patch added by hand lands in an ADDED group and is rendered', () => {
        groupedContainer();
        const d = storePatch('D', 4);
        canvas.addPatchToContainer(d.id, 'ctr_g');

        const ctr = canvasStore.getContainer('ctr_g');
        assert.ok(ctr.patchIds.includes(d.id));
        const added = ctr.groups.find(g => g.label === canvas.ADDED_GROUP_LABEL);
        assert.deepEqual(added.patchIds, [d.id]);

        const el = sky.querySelector('.sky-container');
        assert.ok(rowIds(el).includes(d.id), 'the new patch has a row on screen');

        // a second add reuses the group
        const e = storePatch('E', 5);
        canvas.addPatchToContainer(e.id, 'ctr_g');
        const groups = canvasStore.getContainer('ctr_g').groups;
        assert.equal(groups.filter(g => g.label === canvas.ADDED_GROUP_LABEL).length, 1);
        assert.deepEqual(groups.find(g => g.label === canvas.ADDED_GROUP_LABEL).patchIds, [d.id, e.id]);
    });

    test('a flat container is left alone (no groups invented)', () => {
        canvasStore.putContainer({ id: 'ctr_f', name: 'flat', left: 0, top: 0, width: 260, patchIds: [] });
        const d = storePatch('D', 4);
        canvas.addPatchToContainer(d.id, 'ctr_f');
        assert.equal(canvasStore.getContainer('ctr_f').groups, undefined);
    });

    test('removing a patch from the canvas also takes it out of its group', () => {
        const { a, b } = groupedContainer();
        canvas.removePatchFromCanvas(a.id);
        const ctr = canvasStore.getContainer('ctr_g');
        assert.deepEqual(ctr.patchIds.includes(a.id), false);
        assert.deepEqual(ctr.groups[0].patchIds, [b.id]);
    });

    test('touch reorder moves the row inside its group, and in the flat list', () => {
        const { a, b, c } = groupedContainer();
        assert.equal(reorderContainerPatch('ctr_g', b.id, a.id, true), true);
        const ctr = canvasStore.getContainer('ctr_g');
        assert.deepEqual(ctr.groups[0].patchIds, [b.id, a.id]);
        assert.deepEqual(ctr.patchIds, [b.id, a.id, c.id]);
    });

    test('touch reorder across groups is refused rather than half-applied', () => {
        const { a, c } = groupedContainer();
        const before = JSON.stringify(canvasStore.getContainer('ctr_g'));
        assert.equal(reorderContainerPatch('ctr_g', c.id, a.id, true), false);
        assert.equal(JSON.stringify(canvasStore.getContainer('ctr_g')), before);
    });

    test('touch reorder in a flat container works as before', () => {
        const a = storePatch('A', 1), b = storePatch('B', 2);
        canvasStore.putContainer({ id: 'ctr_f', name: 'flat', left: 0, top: 0, width: 260, patchIds: [a.id, b.id] });
        assert.equal(reorderContainerPatch('ctr_f', a.id, b.id, false), true);
        assert.deepEqual(canvasStore.getContainer('ctr_f').patchIds, [b.id, a.id]);
    });
});

describe('floating patch header', () => {
    const evt = (extra = {}) => ({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 5, ...extra });
    const docFire = (type, e) => (env.document._listeners[type] || []).slice().forEach(fn => fn(e));

    test('a tap does not drop the patch into an overlapping container', () => {
        canvasStore.putContainer({ id: 'ctr_1', name: 'c', left: 0, top: 0, width: 260, patchIds: [] });
        const p = storePatch('P', 7);
        canvas.addPatchToCanvas(p.id, 10, 10, null);

        const float = sky.querySelector('.patch-float');
        const header = float.querySelector('.sky-container-header');
        // The stub reports the same box for every element, so the container
        // "is under" the pointer — exactly the condition that absorbed taps.
        header.dispatch('mousedown', evt({ target: header }));
        docFire('mouseup', evt());

        assert.equal(canvasStore.getCanvasPatch(p.id).containerId, null, 'still free-floating');
        assert.deepEqual(canvasStore.getContainer('ctr_1').patchIds, []);
    });

    test('a real drag onto a container still absorbs it', () => {
        canvasStore.putContainer({ id: 'ctr_1', name: 'c', left: 0, top: 0, width: 260, patchIds: [] });
        const p = storePatch('P', 7);
        canvas.addPatchToCanvas(p.id, 10, 10, null);

        const header = sky.querySelector('.patch-float').querySelector('.sky-container-header');
        header.dispatch('mousedown', evt({ target: header }));
        docFire('mousemove', evt({ clientX: 40, clientY: 12 }));
        docFire('mouseup', evt({ clientX: 40, clientY: 12 }));

        assert.equal(canvasStore.getCanvasPatch(p.id).containerId, 'ctr_1');
        assert.deepEqual(canvasStore.getContainer('ctr_1').patchIds, [p.id]);
    });
});

describe('initCanvas re-entry', () => {
    test('does not stack drop handlers on the sky element', () => {
        const count = () => (sky.listeners.drop || []).length;
        assert.equal(count(), 1);
        canvas.initCanvas({});
        canvas.initCanvas({});
        assert.equal(count(), 1);
    });

    test('the more-menu close handlers are dropped with their elements on re-render', () => {
        canvasStore.putContainer({ id: 'ctr_1', name: 'c', left: 0, top: 0, width: 260, patchIds: [] });
        canvas.refreshCanvas();
        const n = (env.document._listeners.click || []).length;
        canvas.refreshCanvas();
        canvas.refreshCanvas();
        assert.equal((env.document._listeners.click || []).length, n, 'one close handler per rendered menu, not per render');
    });
});
