// cursors.js: the others' positions, drawn only inside what is on screen here.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let C;
before(async () => { installBrowserEnv(); C = await import('../html/components/cursors.js'); });
beforeEach(() => { C.clearRemoteCursors(); for (const e of Object.keys(C.myCursors())) C.reportCursor(e, null); });

describe('cursors', () => {
    test('a remote position is kept per editor, validated, latest wins; filtered by section or pattern', () => {
        let n = 0;
        const off = C.onCursors(() => n++);
        C.setRemoteCursor('b', 'Bob', '#d84a6b', { tracker: { sectionId: 's1', slot: 0, lane: 1, col: 7 } });
        C.setRemoteCursor('b', 'Bob', '#d84a6b', { roll: { patternId: 'p1', notes: [[0, 60], ['x', 1], [4, 64]] } });
        C.setRemoteCursor('b', 'Bob', '#d84a6b', { tracker: { sectionId: 's1', slot: 0, lane: 1, col: 7 } });   // same: no event
        assert.equal(n, 2);
        assert.deepEqual(C.cursorsIn('tracker', { sectionId: 's1' }).map(r => [r.alias, r.where.col]), [['Bob', 7]]);
        assert.deepEqual(C.cursorsIn('tracker', { sectionId: 's2' }), [], 'another section: not drawn');
        assert.deepEqual(C.cursorsIn('roll', { patternId: 'p1' })[0].where.notes, [[0, 60], [4, 64]], 'bad notes dropped');
        assert.deepEqual(C.cursorsIn('roll', { patternId: 'p2' }), []);
        C.setRemoteCursor('b', 'Bob', '#d84a6b', { tracker: { sectionId: 's1', slot: 0, lane: 1, col: 9 } });
        assert.equal(C.cursorsIn('tracker', { sectionId: 's1' })[0].where.col, 9, 'latest wins');
        C.setRemoteCursor('b', 'Bob', '#d84a6b', { tracker: null });
        assert.deepEqual(C.cursorsIn('tracker', { sectionId: 's1' }), [], 'left the tracker');
        C.setRemoteCursor('c', 'Cy', 'red', { section: { sectionId: 's1', clipIds: ['c1', 2] } });
        const cy = C.cursorsIn('section', { sectionId: 's1' })[0];
        assert.equal(cy.color, '#f0a030', 'a bad colour falls back');
        assert.deepEqual(cy.where.clipIds, ['c1']);
        C.dropRemoteCursor('c');
        assert.deepEqual(C.cursorsIn('section', { sectionId: 's1' }), []);
        off();
    });

    test('own reports: deduplicated, remembered per editor, cleared with null', () => {
        const heard = [];
        const off = C.onLocalCursor((e, w) => heard.push([e, w && w.col]));
        C.reportCursor('tracker', { sectionId: 's1', slot: 0, lane: 0, col: 3 });
        C.reportCursor('tracker', { sectionId: 's1', slot: 0, lane: 0, col: 3 });
        C.reportCursor('tracker', { sectionId: 's1', slot: 0, lane: 0, col: 4 });
        C.reportCursor('roll', { patternId: 'p1', notes: [] });
        assert.deepEqual(heard, [['tracker', 3], ['tracker', 4], ['roll', undefined]]);
        assert.deepEqual(Object.keys(C.myCursors()).sort(), ['roll', 'tracker']);
        C.reportCursor('roll', null);
        assert.deepEqual(Object.keys(C.myCursors()), ['tracker']);
        off();
    });
});
