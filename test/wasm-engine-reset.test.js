// Regression: offline renders must be independent of each other, and resetting
// the engine between them must not leak WASM memory.
//
// Two bugs shared one root cause in msfa_bridge.cpp:
//   * `init_engine()` did `synth = new SynthUnit(&rb)` without deleting the old
//     one. SynthUnit embeds 16 heap Dx7Notes and a ~13 MB channel buffer, so
//     every preview grew WASM memory permanently.
//   * `batchRenderWaveforms` called `init_engine()` once per batch, then rendered
//     each patch with a note-on and no note-off. Later thumbnails therefore
//     contained every earlier patch still ringing (16-voice polyphony), which
//     is why canvas thumbnails looked alike on load but changed after a preview
//     (the preview path re-initialised, i.e. rendered clean).
//
// Runs the real msfa.wasm under Node against patches from html/DEMO.syx.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSyxFile } from '../html/components/syx-parser.js';

const WASM_URL = new URL('../html/synth/wasm/msfa.wasm', import.meta.url);
const SYX_URL = new URL('../html/DEMO.syx', import.meta.url);
const SR = 44100;
const N_SAMPLES = Math.ceil(SR * 0.8);  // same 800 ms window as the thumbnail renderer

let exp;        // wasm exports
let patches;    // [{ name, raw: number[128] }]

// Stub every import the module asks for (WASI + env) — none are exercised by rendering.
async function instantiate() {
    const bytes = readFileSync(WASM_URL);
    const mod = await WebAssembly.compile(bytes);
    const imports = {};
    for (const { module, name } of WebAssembly.Module.imports(mod)) {
        (imports[module] = imports[module] || {})[name] = () => 0;
    }
    const inst = await WebAssembly.instantiate(mod, imports);
    return inst.exports;
}

function loadPatch(raw) {
    const view = new Uint8Array(exp.memory.buffer, exp.get_patch_buffer(), 128);
    view.set(raw);
    exp.load_voice_from_buffer();
}

// Render one note of `raw` on a freshly reset engine, as the fixed JS callers do.
function renderClean(raw, midi = 60) {
    exp.reset_engine();
    return renderOnCurrentEngine(raw, midi);
}

// Render without resetting first — the pre-fix thumbnail behaviour.
function renderOnCurrentEngine(raw, midi = 60) {
    loadPatch(raw);
    exp.note_on(midi, 100);
    const ptr = exp.render_audio(N_SAMPLES);
    assert.ok(ptr, 'render_audio returned a buffer');
    return Int16Array.from(new Int16Array(exp.memory.buffer, ptr, N_SAMPLES));
}

const energy = (s) => s.reduce((a, v) => a + Math.abs(v), 0);

before(async () => {
    exp = await instantiate();
    exp.init_engine(SR);
    const syx = readFileSync(SYX_URL);
    patches = parseSyxFile(syx.buffer.slice(syx.byteOffset, syx.byteOffset + syx.byteLength));
    assert.ok(patches && patches.length === 32, 'DEMO.syx parsed');
});

describe('msfa.wasm engine reset', () => {
    test('exports reset_engine', () => {
        assert.equal(typeof exp.reset_engine, 'function');
    });

    test('a render is unaffected by whatever was rendered before it', () => {
        // Pick an A that is still ringing at the end of its window (so it would
        // bleed into B without a reset) and a B that makes sound at all.
        const tail = (s) => energy(s.subarray(s.length - SR * 0.1));
        const a = patches.find(p => tail(renderClean(p.raw)) > 0);
        const b = patches.find(p => p !== a && energy(renderClean(p.raw)) > 0);
        assert.ok(a && b, 'found two audible demo patches');

        const bAlone = renderClean(b.raw);

        // Pre-fix path: A then B with no reset in between → A's held note bleeds in.
        renderClean(a.raw);
        const bAfterAUnreset = renderOnCurrentEngine(b.raw);
        assert.notDeepEqual(bAfterAUnreset, bAlone, 'without a reset the previous note leaks into the render');

        // Fixed path: reset between renders → identical to rendering B on its own.
        renderClean(a.raw);
        const bAfterA = renderClean(b.raw);
        assert.deepEqual(bAfterA, bAlone, 'reset_engine makes renders independent');
    });

    test('repeated resets do not grow WASM memory', () => {
        const p = patches[0].raw;
        for (let i = 0; i < 3; i++) renderClean(p);  // warm up allocator
        const before = exp.memory.buffer.byteLength;
        for (let i = 0; i < 40; i++) renderClean(p);
        assert.equal(exp.memory.buffer.byteLength, before, 'memory stable across 40 reset+render cycles');
    });
});
