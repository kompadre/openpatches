// One range input serves Morph (-1..1) and Random (0..100). Switching modes
// rewrote min/max and the browser clamped the current value into the new
// range, so the first mode's setting was destroyed by visiting the other:
// Morph at 0.8 → Random → back to Morph read 1.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv, installMidiStub } from './harness.js';

let createEditPanel, openEdit;
let env;

before(async () => {
    env = installBrowserEnv();
    installMidiStub();
    // The panel finds its own parts by id; the stub document has no index.
    env.document.getElementById = (id) => env.document.body._walk().find(el => el.id === id) || null;
    ({ createEditPanel, openEdit } = await import('../html/components/edit-panel.js'));
});

// Make the stub slider clamp like a real <input type=range>: setting min/max
// re-clamps the stored value, setting value clamps into [min, max].
function makeClamping(slider) {
    let v = parseFloat(slider.value), min = parseFloat(slider.min), max = parseFloat(slider.max);
    const clamp = () => { v = Math.min(max, Math.max(min, v)); };
    Object.defineProperties(slider, {
        value: { get: () => String(v), set: (x) => { v = parseFloat(x); clamp(); } },
        min:   { get: () => String(min), set: (x) => { min = parseFloat(x); clamp(); } },
        max:   { get: () => String(max), set: (x) => { max = parseFloat(x); clamp(); } },
    });
}

const patch = { id: 'p1', name: 'P', algorithm: 0, feedback: 0, voice_data: btoa('x'.repeat(128)), tags: [] };

function build() {
    env.document.body.children = [];
    const panel = createEditPanel({ baseUrl: '' });
    env.document.body.appendChild(panel);
    const slider = panel.querySelector('.edit-slider');
    makeClamping(slider);
    const modeBtn = (m) => panel.querySelectorAll('.edit-mode-btn').find(b => b.dataset.mode === m);
    return { panel, slider, modeBtn };
}

beforeEach(() => localStorage.clear());

describe('edit panel slider', () => {
    test('each mode keeps its own value across switches', () => {
        const { slider, modeBtn } = build();
        openEdit(patch);                       // morph mode
        assert.equal(slider.value, '0.5');
        slider.value = '0.8';
        slider.dispatch('input');

        modeBtn('random').dispatch('click');
        assert.equal(slider.min, '0');
        assert.equal(slider.max, '100');
        assert.equal(slider.value, '30', 'random starts at its own default');
        slider.value = '55';
        slider.dispatch('input');

        modeBtn('morph').dispatch('click');
        assert.equal(slider.min, '-1');
        assert.equal(slider.value, '0.8', 'morph value survived the round trip');

        modeBtn('random').dispatch('click');
        assert.equal(slider.value, '55');
    });
});
