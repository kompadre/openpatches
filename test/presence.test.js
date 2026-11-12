// presence.js: who else is editing what, for the editors to draw.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let P;
before(async () => { installBrowserEnv(); P = await import('../html/components/presence.js'); });
beforeEach(() => P.setPresence([]));

describe('presence', () => {
    test('matches by pattern, track or section; colours are checked', () => {
        P.setPresence([
            { peer: 'a', alias: 'Ann', color: '#3b8fd1', scope: { patternId: 'p1' } },
            { peer: 'b', alias: 'Bob', color: 'red', scope: { trackId: 't2' } },
            { peer: 'c', alias: 'Cy', color: '#6fa83b', scope: {} },
        ]);
        assert.deepEqual(P.presenceOn({ patternIds: ['p1', 'p9'] }).map(e => e.alias), ['Ann']);
        assert.deepEqual(P.presenceOn({ trackId: 't2' }).map(e => e.alias), ['Bob']);
        assert.equal(P.presenceOn({ trackId: 't2' })[0].color, '#f0a030', 'a bad colour falls back');
        assert.deepEqual(P.presenceOn({ sectionId: 's1' }), [], 'an empty scope marks nothing');
    });

    test('listeners hear changes only', () => {
        let n = 0;
        const off = P.onPresence(() => n++);
        P.setPresence([{ peer: 'a', alias: 'Ann', color: '#3b8fd1', scope: { patternId: 'p1' } }]);
        P.setPresence([{ peer: 'a', alias: 'Ann', color: '#3b8fd1', scope: { patternId: 'p1' } }]);
        assert.equal(n, 1);
        P.setPresence([]);
        assert.equal(n, 2);
        off();
    });

    test('markPresence: class, colour, aliases, tooltip; nobody is nothing', () => {
        const el = document.createElement('div');
        P.markPresence(el, []);
        assert.ok(!el.classList.contains('peer-editing'));
        el.title = 'Riff';
        P.markPresence(el, [{ alias: 'Ann', color: '#3b8fd1' }, { alias: 'Bob', color: '#d84a6b' }]);
        assert.ok(el.classList.contains('peer-editing'));
        assert.equal(el.style.getPropertyValue('--peer-color'), '#3b8fd1');
        assert.equal(el.dataset.peers, 'Ann, Bob');
        assert.equal(el.title, 'Riff\nAnn, Bob are editing this');
    });
});
