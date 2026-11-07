// The effects controls — a popover per Mixer strip and one for the mix.
//
// The Mixer lives in a bottom pane some 180px tall, and a strip is 86px
// wide: there is no room on it for four effects' worth of sliders. So a
// strip carries one `FX` button whose four letters show which effects are
// on, and the controls open in a popover, the way the ♫ slot picker on a
// patch row does. The global reverb and ducker get the same treatment from
// a button in the Mixer header.
//
// Two write paths, on purpose. Dragging a slider calls `onLive` on every
// tick, which app.js routes straight to the engine, so the change is heard
// as it is made. Releasing it commits to the project through the session,
// which is what persists and what every other editor re-reads — once per
// release rather than sixty times a second, because a `tracks` event
// re-renders the Section editor and the roll's legend.
//
// Commits carry the source `voicebank-fx`, not `voicebank`: the Mixer
// skips re-reading its strips on its own fader writes (it would fight the
// drag) but does want to redraw the FX letters after a popover commit.
//
// Switching an effect off commits immediately and keeps its parameters:
// it is a bypass button, not a reset button (see project-model's
// createTrackFx). The engine's bypass path makes the distinction free.

import {
    FX_FIELDS, FX_GLOBAL_FIELDS, FX_ENABLE_FIELDS,
    FX_RANGES, FX_GLOBAL_RANGES,
} from '../synth/fx-params.js';

/**
 * How the parameters group under their on/off flags, in display order.
 * test/fx-panel.test.js checks that every field in FX_FIELDS appears here
 * exactly once — a parameter the engine has and the panel does not show is
 * one nobody can set.
 */
export const TRACK_SECTIONS = [
    { flag: 'delay', label: 'Delay', letter: 'D', params: [
        ['delayTime', 'Time'], ['delayFeedback', 'Feedback'], ['delayMix', 'Mix'],
    ] },
    { flag: 'drive', label: 'Drive', letter: 'O', params: [
        ['driveAmount', 'Amount'], ['driveLevel', 'Level'],
    ] },
    { flag: 'comp', label: 'Compressor', letter: 'C', params: [
        ['compThreshold', 'Threshold'], ['compRatio', 'Ratio'],
        ['compAttack', 'Attack'], ['compRelease', 'Release'], ['compMakeup', 'Makeup'],
    ] },
    { flag: 'send', label: 'Reverb send', letter: 'R', params: [
        ['sendLevel', 'Send'],
    ] },
];

export const GLOBAL_SECTIONS = [
    { label: 'Reverb', params: [
        ['reverbDecay', 'Decay'], ['reverbDamping', 'Damping'], ['reverbLevel', 'Level'],
    ] },
    { label: 'Duck', params: [
        ['duckAmount', 'Amount'], ['duckThreshold', 'Threshold'],
        ['duckAttack', 'Attack'], ['duckRelease', 'Release'],
    ] },
];

/** The four letters a strip shows, lit or not. */
export function fxSummary(fx) {
    return TRACK_SECTIONS.map(s => ({
        letter: s.letter, label: s.label, flag: s.flag, on: !!(fx && fx[s.flag] === true),
    }));
}

// A slider step that reads as a round number at the range's scale: 0.001
// over a 0..1 range, 1 over 1..750 ms, 0.1 over -60..0 dB.
function niceStep(range) {
    if (!(range > 0)) return 1;
    return Math.pow(10, Math.floor(Math.log10(range / 200)));
}

function decimalsFor(step) {
    return Math.max(0, Math.min(3, -Math.floor(Math.log10(step))));
}

function formatValue(value, range, step) {
    const n = Number(value);
    const text = n.toFixed(decimalsFor(step));
    return range.unit ? `${text} ${range.unit}`.trim() : text;
}

// One popover at a time. Opening another closes the first, and a session
// event from any other editor closes whichever is open — the strip it
// described may no longer exist.
let current = null;

export function closeFxPopover() {
    if (current) current();
}

function makePopover(title, anchor, onClose) {
    closeFxPopover();
    const pop = document.createElement('div');
    pop.className = 'fx-pop';

    const head = document.createElement('div');
    head.className = 'fx-pop-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'fx-pop-title';
    titleEl.textContent = title;
    head.appendChild(titleEl);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'fx-pop-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    head.appendChild(closeBtn);
    pop.appendChild(head);

    const body = document.createElement('div');
    body.className = 'fx-pop-body';
    pop.appendChild(body);

    function onDocClick(e) {
        if (pop.contains(e.target)) return;
        if (anchor && anchor.contains && anchor.contains(e.target)) return;
        close();
    }
    function onKeyDown(e) {
        if (e.key === 'Escape') close();
    }
    function close() {
        if (current !== close) return;
        current = null;
        pop.remove();
        document.removeEventListener('mousedown', onDocClick);
        document.removeEventListener('touchstart', onDocClick);
        document.removeEventListener('keydown', onKeyDown);
        if (onClose) onClose();
    }
    closeBtn.addEventListener('click', close);
    current = close;

    document.body.appendChild(pop);
    position(pop, anchor);
    // Deferred: the click that opened the popover is still propagating and
    // would close it on the same tick.
    setTimeout(() => {
        if (current !== close) return;
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('touchstart', onDocClick);
        document.addEventListener('keydown', onKeyDown);
    }, 0);

    return { pop, body, close };
}

// Above the anchor by default — the Mixer sits at the bottom of the page
// — and below it when there is no room above. Clamped to the viewport
// sideways. position:fixed, so neither the pane's scroll nor the strip's
// re-render (which rebuilds the anchor) moves or destroys it.
function position(pop, anchor) {
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1200;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
    const a = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    const r = pop.getBoundingClientRect ? pop.getBoundingClientRect() : { width: 280, height: 200 };
    const w = r.width || 280;
    const h = r.height || 200;
    let left = a ? a.left + a.width / 2 - w / 2 : vw / 2 - w / 2;
    left = Math.max(8, Math.min(vw - w - 8, left));
    pop.style.left = left + 'px';
    if (a && a.top - h - 8 >= 0) {
        pop.style.top = (a.top - h - 8) + 'px';
    } else if (a) {
        pop.style.top = Math.min(vh - h - 8, a.bottom + 8) + 'px';
    } else {
        pop.style.top = Math.max(8, vh / 2 - h / 2) + 'px';
    }
}

/**
 * One labelled slider. `onLive(value)` on every tick, `onCommit(value)`
 * on release. `read()` gives the current value so a reopened popover
 * shows what the project holds, not what the slider last showed.
 */
function sliderRow(field, label, range, read, onLive, onCommit) {
    const row = document.createElement('label');
    row.className = 'fx-row';
    row.dataset.field = field;

    const name = document.createElement('span');
    name.className = 'fx-row-label';
    name.textContent = label;
    row.appendChild(name);

    const step = niceStep(range.max - range.min);
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'fx-range';
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(step);
    input.value = String(read());
    input.dataset.field = field;
    row.appendChild(input);

    const value = document.createElement('span');
    value.className = 'fx-row-value';
    value.textContent = formatValue(read(), range, step);
    row.appendChild(value);

    const clamp = (v) => Math.max(range.min, Math.min(range.max, Number(v)));
    input.addEventListener('input', () => {
        const v = clamp(input.value);
        value.textContent = formatValue(v, range, step);
        if (onLive) onLive(v);
    });
    input.addEventListener('change', () => {
        const v = clamp(input.value);
        value.textContent = formatValue(v, range, step);
        onCommit(v);
    });
    // Double-click the label to go back to the engine's default.
    name.addEventListener('dblclick', () => {
        input.value = String(range.def);
        value.textContent = formatValue(range.def, range, step);
        if (onLive) onLive(range.def);
        onCommit(range.def);
    });
    return row;
}

/**
 * The popover for one strip's insert effects.
 *
 * @param anchor   the strip's FX button — the popover sits above it
 * @param slot     the channel
 * @param title    what to call it, e.g. "1 BRASS"
 * @param session  the project session; the track is looked up by slot on
 *                 every write so a swapped slot cannot write to the wrong
 *                 track
 * @param onLive   (field, value) → engine, while dragging
 * @param onClose  called once when the popover goes away
 */
export function openTrackFxPopover({ anchor, slot, title, session, onLive, onClose }) {
    const trackOf = () => {
        const p = session && session.get();
        return p ? p.tracks.find(t => t.slot === slot) || null : null;
    };
    const track = trackOf();
    if (!track || !track.fx) return null;

    const { pop, body, close } = makePopover(`FX · ${title}`, anchor, onClose);
    pop.classList.add('fx-pop-track');
    pop.dataset.slot = String(slot);

    const commit = (field, value) => {
        session.update((p) => {
            const t = p.tracks.find(x => x.slot === slot);
            if (t && t.fx) t.fx[field] = value;
        }, 'voicebank-fx', 'tracks');
    };

    for (const sec of TRACK_SECTIONS) {
        const section = document.createElement('div');
        section.className = 'fx-section' + (track.fx[sec.flag] ? ' on' : '');
        section.dataset.flag = sec.flag;

        const head = document.createElement('label');
        head.className = 'fx-section-head';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'fx-toggle';
        toggle.dataset.flag = sec.flag;
        toggle.checked = track.fx[sec.flag] === true;
        head.appendChild(toggle);
        const name = document.createElement('span');
        name.className = 'fx-section-label';
        name.textContent = sec.label;
        head.appendChild(name);
        section.appendChild(head);

        toggle.addEventListener('change', () => {
            const on = !!toggle.checked;
            section.classList.toggle('on', on);
            commit(sec.flag, on);
        });

        for (const [field, label] of sec.params) {
            const range = FX_RANGES[FX_FIELDS[field]];
            section.appendChild(sliderRow(
                field, label, range,
                () => { const t = trackOf(); return t && t.fx ? t.fx[field] : range.def; },
                onLive ? (v) => onLive(field, v) : null,
                (v) => commit(field, v),
            ));
        }
        body.appendChild(section);
    }
    position(pop, anchor);
    return close;
}

/**
 * The popover for the mix: the shared reverb and the ducker.
 *
 * @param entries  the Mixer's strips, for the duck source's names
 * @param onLive   (field, value) → engine, while dragging
 */
export function openGlobalFxPopover({ anchor, session, entries, onLive, onClose }) {
    const project = session && session.get();
    if (!project || !project.fx) return null;

    const { pop, body, close } = makePopover('Reverb · Duck', anchor, onClose);
    pop.classList.add('fx-pop-global');

    const read = (field) => {
        const p = session.get();
        return p && p.fx ? p.fx[field] : FX_GLOBAL_RANGES[FX_GLOBAL_FIELDS[field]].def;
    };
    const commit = (field, value) => {
        session.update((p) => { if (p.fx) p.fx[field] = value; }, 'voicebank-fx', 'tracks');
    };

    for (const sec of GLOBAL_SECTIONS) {
        const section = document.createElement('div');
        section.className = 'fx-section on';
        const head = document.createElement('div');
        head.className = 'fx-section-head';
        const name = document.createElement('span');
        name.className = 'fx-section-label';
        name.textContent = sec.label;
        head.appendChild(name);
        section.appendChild(head);

        if (sec.label === 'Duck') {
            // One track is boosted and everybody else ducks under it. The
            // list is the occupied slots: a slot with no voice has nothing
            // to boost, and normalizeProject would drop the choice anyway.
            const row = document.createElement('label');
            row.className = 'fx-row fx-row-select';
            row.dataset.field = 'duckSource';
            const lbl = document.createElement('span');
            lbl.className = 'fx-row-label';
            lbl.textContent = 'Boost';
            row.appendChild(lbl);
            const select = document.createElement('select');
            select.className = 'fx-duck-source';
            const none = document.createElement('option');
            none.value = '-1';
            none.textContent = 'Nobody';
            select.appendChild(none);
            (entries || []).forEach((e, i) => {
                if (!e) return;
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = (i + 1) + '. ' + e.name;
                select.appendChild(opt);
            });
            select.value = String(read('duckSource'));
            if (select.value !== String(read('duckSource'))) select.value = '-1';
            select.addEventListener('change', () => {
                const v = parseInt(select.value, 10);
                const slot = Number.isInteger(v) ? v : -1;
                if (onLive) onLive('duckSource', slot);
                commit('duckSource', slot);
            });
            row.appendChild(select);
            section.appendChild(row);
        }

        for (const [field, label] of sec.params) {
            const range = FX_GLOBAL_RANGES[FX_GLOBAL_FIELDS[field]];
            section.appendChild(sliderRow(
                field, label, range,
                () => read(field),
                onLive ? (v) => onLive(field, v) : null,
                (v) => commit(field, v),
            ));
        }
        body.appendChild(section);
    }
    position(pop, anchor);
    return close;
}
