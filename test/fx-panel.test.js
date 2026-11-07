// The Mixer's effect controls: the FX letters on a strip, the per-strip
// popover and the Reverb · Duck popover.
//
// What this holds:
//   * every parameter the engine has is reachable from the panel — a field
//     in FX_FIELDS that no section lists is one nobody can set;
//   * the two write paths: a slider tick goes to `onLive` and NOT to the
//     project, a release commits to the project through the session;
//   * a toggle commits at once and keeps the parameters (bypass, not reset);
//   * the popover reads the track by slot on every write, so swapping slots
//     under an open popover cannot write to the wrong track;
//   * a project switch closes whatever popover is open.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let createVoiceBank, makeProjectSession, createTrack;
let TRACK_SECTIONS, GLOBAL_SECTIONS, fxSummary, closeFxPopover;
let FX_FIELDS, FX_GLOBAL_FIELDS, FX_RANGES;

before(async () => {
    installBrowserEnv();
    ({ createVoiceBank } = await import('../html/components/voicebank.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    ({ createTrack } = await import('../html/components/project-model.js'));
    ({ TRACK_SECTIONS, GLOBAL_SECTIONS, fxSummary, closeFxPopover } =
        await import('../html/components/fx-panel.js'));
    ({ FX_FIELDS, FX_GLOBAL_FIELDS, FX_RANGES } = await import('../html/synth/fx-params.js'));
});

beforeEach(() => {
    localStorage.clear();
    closeFxPopover();
    document.body.children.length = 0;
});

function seed(tracks) {
    const session = makeProjectSession();
    session.update((project) => {
        for (const t of tracks) {
            project.tracks.push(createTrack({
                id: t.id, name: t.name || t.id, slot: t.slot,
                voiceData: t.id + '-data', patchId: t.id, fx: t.fx,
            }));
        }
    }, 'test');
    return session;
}

const popover = () => document.body.querySelector('.fx-pop');
const track = (session, slot) => session.get().tracks.find(t => t.slot === slot);

function openStrip(bank, slot) {
    const items = bank.querySelectorAll('.voicebank-item');
    const btn = items[slot].querySelector('.voicebank-fx');
    assert.ok(btn, `slot ${slot} has an FX button`);
    btn.dispatch('click', { stopPropagation() {} });
    const pop = popover();
    assert.ok(pop, 'the popover opened');
    return pop;
}

function row(pop, field) {
    return pop.querySelectorAll('.fx-row').find(r => r.dataset.field === field);
}

describe('the panel covers the engine', () => {
    test('every per-track parameter is in exactly one section', () => {
        const listed = TRACK_SECTIONS.flatMap(s => s.params.map(([f]) => f));
        assert.deepEqual(listed.slice().sort(), Object.keys(FX_FIELDS).sort());
        assert.equal(new Set(listed).size, listed.length, 'a field appears twice');
    });

    test('every section switches a real flag', () => {
        for (const s of TRACK_SECTIONS) assert.ok(s.flag in { delay: 1, drive: 1, comp: 1, send: 1 }, s.flag);
    });

    test('every global parameter is in exactly one section, or is the duck source', () => {
        const listed = GLOBAL_SECTIONS.flatMap(s => s.params.map(([f]) => f));
        const expected = Object.keys(FX_GLOBAL_FIELDS).filter(f => f !== 'duckSource');
        assert.deepEqual(listed.slice().sort(), expected.sort());
    });

    test('fxSummary lights the letters of the effects that are on', () => {
        const on = fxSummary({ delay: true, comp: true }).filter(l => l.on).map(l => l.letter);
        assert.deepEqual(on, ['D', 'C']);
        assert.deepEqual(fxSummary(null).map(l => l.on), [false, false, false, false]);
        // A stored "1" is not on — only a real true.
        assert.deepEqual(fxSummary({ delay: 1 }).map(l => l.on), [false, false, false, false]);
    });
});

describe('the strip', () => {
    test('shows an FX button with the lit letters of its track', () => {
        const session = seed([{ id: 'a', slot: 0, fx: { delay: true } }, { id: 'b', slot: 1 }]);
        const bank = createVoiceBank({ session });
        const items = bank.querySelectorAll('.voicebank-item');
        const lit = (i) => items[i].querySelectorAll('.voicebank-fx-letter').filter(l => l.classList.contains('on')).map(l => l.textContent);
        assert.deepEqual(lit(0), ['D']);
        assert.deepEqual(lit(1), []);
        assert.ok(items[0].querySelector('.voicebank-fx').classList.contains('on'));
        assert.ok(!items[1].querySelector('.voicebank-fx').classList.contains('on'));
    });

    test('an empty slot has no FX button', () => {
        const session = seed([{ id: 'a', slot: 2 }]);
        const bank = createVoiceBank({ session });
        const items = bank.querySelectorAll('.voicebank-item');
        assert.equal(items[0].querySelector('.voicebank-fx'), null);
        assert.ok(items[2].querySelector('.voicebank-fx'));
    });

    test('the header has the Reverb · Duck button and still says Mixer', () => {
        const bank = createVoiceBank({ session: seed([]) });
        assert.ok(bank.querySelector('.voicebank-global-fx'));
        assert.equal(bank.querySelector('.voicebank-header-title').textContent, 'Mixer');
    });
});

describe('the track popover', () => {
    test('opens with the track’s values and flags', () => {
        const session = seed([{ id: 'a', slot: 0, fx: { delay: true, delayTime: 125 } }]);
        const bank = createVoiceBank({ session });
        const pop = openStrip(bank, 0);

        assert.equal(pop.dataset.slot, '0');
        const toggles = pop.querySelectorAll('.fx-toggle');
        assert.deepEqual(toggles.map(t => [t.dataset.flag, !!t.checked]),
            [['delay', true], ['drive', false], ['comp', false], ['send', false]]);
        assert.equal(row(pop, 'delayTime').querySelector('.fx-range').value, '125');
        assert.equal(row(pop, 'delayTime').querySelector('.fx-row-value').textContent, '125 ms');
    });

    test('a slider tick is live only: engine yes, project no', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const live = [];
        const bank = createVoiceBank({ session, onFxLive: (slot, field, v) => live.push([slot, field, v]) });
        const pop = openStrip(bank, 0);

        const input = row(pop, 'delayMix').querySelector('.fx-range');
        input.value = '0.8';
        input.dispatch('input');

        assert.deepEqual(live, [[0, 'delayMix', 0.8]]);
        assert.equal(track(session, 0).fx.delayMix, 0.3, 'the project must not move until release');
        assert.equal(row(pop, 'delayMix').querySelector('.fx-row-value').textContent, '0.800');
    });

    test('a release commits to the project, as a tracks event from voicebank-fx', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const events = [];
        session.subscribe(ev => events.push([ev.kind, ev.source]));
        const bank = createVoiceBank({ session });
        const pop = openStrip(bank, 0);

        const input = row(pop, 'delayMix').querySelector('.fx-range');
        input.value = '0.8';
        input.dispatch('change');

        assert.equal(track(session, 0).fx.delayMix, 0.8);
        assert.ok(events.some(([k, s]) => k === 'tracks' && s === 'voicebank-fx'));
    });

    test('a committed value is clamped to the engine’s range', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const bank = createVoiceBank({ session });
        const pop = openStrip(bank, 0);
        const input = row(pop, 'delayFeedback').querySelector('.fx-range');
        input.value = '7';
        input.dispatch('change');
        assert.equal(track(session, 0).fx.delayFeedback, FX_RANGES.FX_DELAY_FEEDBACK.max);
    });

    test('the toggle commits at once and keeps the parameters', () => {
        const session = seed([{ id: 'a', slot: 0, fx: { delay: true, delayTime: 125, delayMix: 0.9 } }]);
        const bank = createVoiceBank({ session });
        const pop = openStrip(bank, 0);

        const toggle = pop.querySelectorAll('.fx-toggle').find(t => t.dataset.flag === 'delay');
        toggle.checked = false;
        toggle.dispatch('change');

        const fx = track(session, 0).fx;
        assert.equal(fx.delay, false);
        assert.equal(fx.delayTime, 125, 'bypass, not reset');
        assert.equal(fx.delayMix, 0.9);
    });

    test('the strip’s letters follow a commit', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const bank = createVoiceBank({ session });
        const pop = openStrip(bank, 0);

        const toggle = pop.querySelectorAll('.fx-toggle').find(t => t.dataset.flag === 'comp');
        toggle.checked = true;
        toggle.dispatch('change');

        const lit = bank.querySelectorAll('.voicebank-item')[0]
            .querySelectorAll('.voicebank-fx-letter').filter(l => l.classList.contains('on')).map(l => l.textContent);
        assert.deepEqual(lit, ['C']);
    });

    test('writes go to whichever track is on the slot NOW', () => {
        // Slots swap under an open popover (a drop on the Mixer, the Section
        // editor's slot select). The popover is for the slot, so the write
        // lands on the track that now plays it — never on a stale object.
        const session = seed([{ id: 'a', slot: 0 }, { id: 'b', slot: 1 }]);
        const bank = createVoiceBank({ session });
        const pop = openStrip(bank, 0);

        session.update((p) => {
            const a = p.tracks.find(t => t.id === 'a');
            const b = p.tracks.find(t => t.id === 'b');
            a.slot = 1; b.slot = 0;
        }, 'voicebank');     // the Mixer's own source does not close the popover

        const input = row(pop, 'delayMix').querySelector('.fx-range');
        input.value = '0.8';
        input.dispatch('change');

        assert.equal(session.get().tracks.find(t => t.id === 'b').fx.delayMix, 0.8);
        assert.equal(session.get().tracks.find(t => t.id === 'a').fx.delayMix, 0.3);
    });

    test('a change from another editor closes it', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const bank = createVoiceBank({ session });
        openStrip(bank, 0);
        session.update((p) => { p.tracks[0].name = 'Renamed'; }, 'section-editor', 'tracks');
        assert.equal(popover(), null);
    });

    test('opening a second popover closes the first', () => {
        const session = seed([{ id: 'a', slot: 0 }, { id: 'b', slot: 1 }]);
        const bank = createVoiceBank({ session });
        openStrip(bank, 0);
        openStrip(bank, 1);
        const pops = document.body.querySelectorAll('.fx-pop');
        assert.equal(pops.length, 1);
        assert.equal(pops[0].dataset.slot, '1');
    });

    test('a double-click on a label returns the engine default', () => {
        const session = seed([{ id: 'a', slot: 0, fx: { delayTime: 700 } }]);
        const live = [];
        const bank = createVoiceBank({ session, onFxLive: (s, f, v) => live.push(v) });
        const pop = openStrip(bank, 0);
        row(pop, 'delayTime').querySelector('.fx-row-label').dispatch('dblclick');
        assert.equal(track(session, 0).fx.delayTime, FX_RANGES.FX_DELAY_TIME.def);
        assert.deepEqual(live, [FX_RANGES.FX_DELAY_TIME.def]);
    });
});

describe('the Reverb · Duck popover', () => {
    function openGlobal(bank) {
        bank.querySelector('.voicebank-global-fx').dispatch('click', { stopPropagation() {} });
        const pop = popover();
        assert.ok(pop, 'the global popover opened');
        return pop;
    }

    test('lists only the occupied slots as duck sources, plus Nobody', () => {
        const session = seed([{ id: 'a', name: 'Kick', slot: 0 }, { id: 'c', name: 'Pad', slot: 3 }]);
        const bank = createVoiceBank({ session });
        const pop = openGlobal(bank);
        const options = pop.querySelector('.fx-duck-source').querySelectorAll('option');
        assert.deepEqual(options.map(o => [o.value, o.textContent]),
            [['-1', 'Nobody'], ['0', '1. Kick'], ['3', '4. Pad']]);
        assert.equal(pop.querySelector('.fx-duck-source').value, '-1');
    });

    test('choosing a source commits it and tells the engine', () => {
        const session = seed([{ id: 'a', name: 'Kick', slot: 0 }]);
        const live = [];
        const bank = createVoiceBank({ session, onFxGlobalLive: (f, v) => live.push([f, v]) });
        const pop = openGlobal(bank);
        const select = pop.querySelector('.fx-duck-source');
        select.value = '0';
        select.dispatch('change');
        assert.equal(session.get().fx.duckSource, 0);
        assert.deepEqual(live, [['duckSource', 0]]);
    });

    test('a reverb slider releases into project.fx', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const bank = createVoiceBank({ session });
        const pop = openGlobal(bank);
        const input = row(pop, 'reverbLevel').querySelector('.fx-range');
        input.value = '0.9';
        input.dispatch('change');
        assert.equal(session.get().fx.reverbLevel, 0.9);
    });

    test('shows the project’s current duck source', () => {
        const session = seed([{ id: 'a', name: 'Kick', slot: 2 }]);
        session.update((p) => { p.fx.duckSource = 2; }, 'test');
        const bank = createVoiceBank({ session });
        const pop = openGlobal(bank);
        assert.equal(pop.querySelector('.fx-duck-source').value, '2');
    });
});
