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
let fxOnCount, fxSummaryText, hideFxTooltip;
let FX_FIELDS, FX_GLOBAL_FIELDS, FX_RANGES;

before(async () => {
    installBrowserEnv();
    ({ createVoiceBank } = await import('../html/components/voicebank.js'));
    ({ makeProjectSession } = await import('./project-fixture.js'));
    ({ createTrack } = await import('../html/components/project-model.js'));
    ({ TRACK_SECTIONS, GLOBAL_SECTIONS, fxSummary, closeFxPopover,
       fxOnCount, fxSummaryText, hideFxTooltip } =
        await import('../html/components/fx-panel.js'));
    ({ FX_FIELDS, FX_GLOBAL_FIELDS, FX_RANGES } = await import('../html/synth/fx-params.js'));
});

beforeEach(() => {
    localStorage.clear();
    closeFxPopover();
    hideFxTooltip();
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

    test('every live section switches a real flag', () => {
        for (const s of TRACK_SECTIONS) {
            if (s.disabled) continue;
            assert.ok(s.flag in { delay: 1, drive: 1, comp: 1, send: 1 }, s.flag);
        }
    });

    test('a placeholder section carries no parameters and no engine flag', () => {
        // The whole point of the placeholder: it must not have leaked into
        // the persisted contract. A field here would end up in saved
        // projects and in the enable mask.
        const placeholders = TRACK_SECTIONS.filter(s => s.disabled);
        assert.ok(placeholders.length > 0, 'there is a placeholder to check');
        for (const s of placeholders) {
            assert.deepEqual(s.params, [], `${s.flag} must have no params`);
            assert.ok(!(s.flag in FX_FIELDS), `${s.flag} must not be a saved field`);
        }
    });

    test('every global parameter is in exactly one section, or is the duck source', () => {
        const listed = GLOBAL_SECTIONS.flatMap(s => s.params.map(([f]) => f));
        const expected = Object.keys(FX_GLOBAL_FIELDS).filter(f => f !== 'duckSource');
        assert.deepEqual(listed.slice().sort(), expected.sort());
    });

    test('fxSummary flags the effects that are on, and skips placeholders', () => {
        const on = fxSummary({ delay: true, comp: true }).filter(l => l.on).map(l => l.letter);
        assert.deepEqual(on, ['D', 'C']);
        assert.deepEqual(fxSummary(null).map(l => l.on), [false, false, false, false]);
        // A stored "1" is not on — only a real true.
        assert.deepEqual(fxSummary({ delay: 1 }).map(l => l.on), [false, false, false, false]);
        // The placeholder is not one of the four: it can never be on, so
        // counting it would overstate what the track is doing.
        assert.deepEqual(fxSummary({ crush: true }).map(l => l.on), [false, false, false, false]);
        assert.equal(fxOnCount({ crush: true }), 0);
    });

    test('fxSummaryText names the effects that are on', () => {
        assert.equal(fxSummaryText({ delay: true, comp: true }),
            'Effects: Delay, Compressor');
        assert.equal(fxSummaryText(null), 'Effects: none');
    });
});

describe('the strip', () => {
    test('shows one FX button, not a letter per effect, and no count', () => {
        const session = seed([
            { id: 'a', slot: 0, fx: { delay: true, comp: true } },
            { id: 'b', slot: 1 },
        ]);
        const bank = createVoiceBank({ session });
        const items = bank.querySelectorAll('.voicebank-item');
        const fxOf = (i) => items[i].querySelector('.voicebank-fx');

        assert.equal(fxOf(0).querySelectorAll('.voicebank-fx-letter').length, 0,
            'the per-effect letters are gone');
        assert.equal(fxOf(0).querySelectorAll('.voicebank-fx-count').length, 0,
            'the count badge is gone — colour carries it');
        assert.equal(fxOf(0).querySelector('.voicebank-fx-label').textContent, 'FX');
        assert.ok(fxOf(0).classList.contains('on'));
        assert.ok(!fxOf(1).classList.contains('on'));
    });

    test('the button carries its count as data-fx-count, for the tint', () => {
        // CSS ramps the colour off this, so it has to track the rack
        // exactly — including the nought that paints the neutral state.
        const session = seed([
            { id: 'a', slot: 0 },
            { id: 'b', slot: 1, fx: { delay: true } },
            { id: 'c', slot: 2, fx: { delay: true, drive: true, comp: true, send: true } },
            // A placeholder flag must not tint anything: it is not an effect.
            { id: 'd', slot: 3, fx: { crush: true } },
        ]);
        const bank = createVoiceBank({ session });
        const items = bank.querySelectorAll('.voicebank-item');
        const count = (i) => items[i].querySelector('.voicebank-fx').dataset.fxCount;
        assert.equal(count(0), '0');
        assert.equal(count(1), '1');
        assert.equal(count(2), '4');
        assert.equal(count(3), '0');
    });

    test('FX joins M / S / preview in the action row; remove sits apart', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const bank = createVoiceBank({ session });
        const item = bank.querySelectorAll('.voicebank-item')[0];
        const meta = item.querySelector('.voicebank-meta');
        assert.ok(meta.querySelector('.voicebank-vol'), 'volume sits on the readout line');
        assert.equal(meta.querySelector('.voicebank-fx'), null, 'FX no longer does');
        const controls = item.querySelector('.voicebank-strip-controls');
        assert.ok(controls.querySelector('.voicebank-fx'), 'FX is in the action row');
        assert.equal(controls.querySelector('.voicebank-remove'), null, 'remove is not');
        assert.ok(item.querySelector('.voicebank-remove'), 'remove is still on the strip');
    });

    test('the button carries its state in aria-label, and sets no title', () => {
        // A native `title` would race the real tooltip and win, slowly.
        const session = seed([{ id: 'a', slot: 0, fx: { drive: true } }]);
        const bank = createVoiceBank({ session });
        const btn = bank.querySelectorAll('.voicebank-item')[0].querySelector('.voicebank-fx');
        assert.equal(btn._attrs['aria-label'], 'Effects: Drive. Click to edit.');
        assert.ok(!btn.title);
    });

    test('an empty slot has no FX button', () => {
        const session = seed([{ id: 'a', slot: 2 }]);
        const bank = createVoiceBank({ session });
        const items = bank.querySelectorAll('.voicebank-item');
        assert.equal(items[0].querySelector('.voicebank-fx'), null);
        assert.ok(items[2].querySelector('.voicebank-fx'));
    });

    test('focus raises the tooltip, naming every effect and its state', () => {
        // Focus, not hover: a keyboard focus is deliberate, so it skips the
        // dwell delay that stops a mouse sweep strobing eight tooltips.
        const session = seed([{ id: 'a', name: 'Kick', slot: 0, fx: { delay: true } }]);
        const bank = createVoiceBank({ session });
        const btn = bank.querySelectorAll('.voicebank-item')[0].querySelector('.voicebank-fx');

        btn.dispatch('focus');
        const tip = document.body.querySelector('.fx-tip');
        assert.ok(tip, 'the tooltip appeared');
        assert.equal(tip.querySelector('.fx-tip-head').textContent, '1 Kick');

        const rows = tip.querySelectorAll('.fx-tip-row')
            .map(r => [r.dataset.flag, r.querySelector('.fx-tip-state').textContent]);
        assert.deepEqual(rows, [
            ['delay', 'On'], ['drive', '–'], ['comp', '–'],
            ['send', '–'], ['crush', 'Soon'],
        ]);

        btn.dispatch('blur');
        assert.equal(document.body.querySelector('.fx-tip'), null, 'blur took it away');
    });

    test('the tooltip reads the track at show time, not at render time', () => {
        const session = seed([{ id: 'a', name: 'Kick', slot: 0 }]);
        const bank = createVoiceBank({ session });
        const btn = () => bank.querySelectorAll('.voicebank-item')[0].querySelector('.voicebank-fx');

        const state = () => {
            const t = document.body.querySelector('.fx-tip');
            return t.querySelectorAll('.fx-tip-row').find(r => r.dataset.flag === 'comp')
                .querySelector('.fx-tip-state').textContent;
        };
        btn().dispatch('focus');
        assert.equal(state(), '–');
        btn().dispatch('blur');

        session.update((p) => { p.tracks[0].fx.comp = true; }, 'voicebank-fx', 'tracks');
        btn().dispatch('focus');
        assert.equal(state(), 'On');
    });

    test('opening the popover takes the tooltip away', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const bank = createVoiceBank({ session });
        const btn = bank.querySelectorAll('.voicebank-item')[0].querySelector('.voicebank-fx');
        btn.dispatch('focus');
        assert.ok(document.body.querySelector('.fx-tip'));
        btn.dispatch('click', { stopPropagation() {} });
        assert.equal(document.body.querySelector('.fx-tip'), null);
        assert.ok(popover(), 'and the popover is what is left');
    });

    test('a re-render takes the tooltip away with the button it pointed at', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const bank = createVoiceBank({ session });
        bank.querySelectorAll('.voicebank-item')[0].querySelector('.voicebank-fx').dispatch('focus');
        assert.ok(document.body.querySelector('.fx-tip'));
        session.update((p) => { p.tracks[0].fx.send = true; }, 'voicebank-fx', 'tracks');
        assert.equal(document.body.querySelector('.fx-tip'), null);
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
            [['delay', true], ['drive', false], ['comp', false], ['send', false],
             ['crush', false]]);
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

    test('the strip’s count follows a commit', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const bank = createVoiceBank({ session });
        const pop = openStrip(bank, 0);

        const toggle = pop.querySelectorAll('.fx-toggle').find(t => t.dataset.flag === 'comp');
        toggle.checked = true;
        toggle.dispatch('change');

        const btn = bank.querySelectorAll('.voicebank-item')[0].querySelector('.voicebank-fx');
        assert.equal(btn.dataset.fxCount, '1');
        assert.ok(btn.classList.contains('on'));
        assert.equal(btn._attrs['aria-label'], 'Effects: Compressor. Click to edit.');
    });

    test('the bit crusher placeholder shows, disabled, and writes nothing', () => {
        const session = seed([{ id: 'a', slot: 0 }]);
        const events = [];
        session.subscribe(ev => events.push(ev.source));
        const bank = createVoiceBank({ session });
        const pop = openStrip(bank, 0);

        const section = pop.querySelectorAll('.fx-section').find(s => s.dataset.flag === 'crush');
        assert.ok(section, 'the placeholder section is there');
        assert.ok(section.classList.contains('disabled'));
        assert.equal(section.querySelector('.fx-section-label').textContent, 'Bit crusher');
        assert.equal(section.querySelector('.fx-section-soon').textContent, 'Soon');
        assert.equal(section.querySelectorAll('.fx-row').length, 0, 'no controls yet');

        const toggle = section.querySelector('.fx-toggle');
        assert.equal(toggle.disabled, true);
        // Even forced, it has no listener and so no path into the project.
        toggle.checked = true;
        toggle.dispatch('change');
        assert.equal(track(session, 0).fx.crush, undefined);
        assert.ok(!events.includes('voicebank-fx'), 'nothing was committed');
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
