// The effect parameter IDs are a contract between two files in two
// languages: external/msfa-wasm/fx_params.h and html/synth/fx-params.js.
// Nothing at runtime notices when they drift — a renumbered enum just
// quietly points every saved project's "delay time" at something else.
//
// This parses the header's enums and asserts the JS tables match, name for
// name and value for value, in order.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    FX_CHANNELS, FxEnable, FxParam, FxGlobalParam,
    FX_RANGES, FX_GLOBAL_RANGES,
    FX_FIELDS, FX_GLOBAL_FIELDS, FX_ENABLE_FIELDS, fxEnableMask,
} from '../html/synth/fx-params.js';

const HEADER = readFileSync(
    new URL('../external/msfa-wasm/fx_params.h', import.meta.url), 'utf8');

/**
 * Pull one `enum Name { ... }` out of the header as an ordered
 * `{ name: value }` object. Handles both bare members (which take the
 * previous value plus one) and `= <expr>` initialisers, where the expr is
 * either an integer or the `1 << n` shape the bitmask uses.
 */
function parseEnum(name) {
    const m = HEADER.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `enum ${name} not found in fx_params.h`);
    const body = m[1].replace(/\/\/[^\n]*/g, '');
    const out = {};
    let next = 0;
    for (const raw of body.split(',')) {
        const entry = raw.trim();
        if (!entry) continue;
        const eq = entry.indexOf('=');
        if (eq < 0) {
            out[entry] = next++;
            continue;
        }
        const key = entry.slice(0, eq).trim();
        const expr = entry.slice(eq + 1).trim();
        const shift = expr.match(/^1\s*<<\s*(\d+)$/);
        const value = shift ? 1 << Number(shift[1]) : Number(expr);
        assert.ok(Number.isInteger(value), `cannot parse ${key} = ${expr}`);
        out[key] = value;
        next = value + 1;
    }
    return out;
}

function assertMirrors(enumName, jsTable) {
    const fromHeader = parseEnum(enumName);
    assert.deepEqual(
        Object.keys(jsTable), Object.keys(fromHeader),
        `${enumName}: member names differ (or are out of order) between ` +
        `fx_params.h and fx-params.js`);
    assert.deepEqual(jsTable, fromHeader, `${enumName}: values differ`);
}

describe('fx params: header and JS mirror agree', () => {
    test('FxEnable', () => assertMirrors('FxEnable', FxEnable));
    test('FxParam', () => assertMirrors('FxParam', FxParam));
    test('FxGlobalParam', () =>
        assertMirrors('FxGlobalParam', FxGlobalParam));

    test('FX_CHANNELS', () => {
        const m = HEADER.match(/#define\s+FX_CHANNELS\s+(\d+)/);
        assert.ok(m, '#define FX_CHANNELS not found');
        assert.equal(FX_CHANNELS, Number(m[1]));
    });
});

describe('fx params: ranges cover every parameter', () => {
    // A parameter with no range is one the Mixer cannot draw a control for
    // and the project model has no bounds to clamp to.
    test('every FxParam except the count has a range', () => {
        const expected = Object.keys(FxParam).filter(k => k !== 'FX_PARAM_COUNT');
        assert.deepEqual(Object.keys(FX_RANGES), expected);
    });

    test('every FxGlobalParam except the count has a range', () => {
        const expected = Object.keys(FxGlobalParam)
            .filter(k => k !== 'FX_G_PARAM_COUNT');
        assert.deepEqual(Object.keys(FX_GLOBAL_RANGES), expected);
    });

    test('defaults sit inside their own bounds', () => {
        for (const [name, r] of Object.entries(
                { ...FX_RANGES, ...FX_GLOBAL_RANGES })) {
            assert.ok(r.min <= r.def && r.def <= r.max,
                `${name}: default ${r.def} outside [${r.min}, ${r.max}]`);
        }
    });

    test('the counts are the member counts', () => {
        assert.equal(FxParam.FX_PARAM_COUNT, Object.keys(FX_RANGES).length);
        assert.equal(FxGlobalParam.FX_G_PARAM_COUNT,
            Object.keys(FX_GLOBAL_RANGES).length);
    });
});

describe('fx params: persisted field names', () => {
    // track.fx / project.fx are exported JSON, so they carry readable keys
    // rather than enum numbers. A parameter missing from these tables is one
    // that silently never reaches the engine and never persists.
    const sorted = o => Object.values(o).slice().sort();

    test('every FxParam has exactly one field', () => {
        assert.deepEqual(
            sorted(FX_FIELDS),
            Object.keys(FX_RANGES).slice().sort());
        assert.equal(new Set(Object.values(FX_FIELDS)).size,
            Object.keys(FX_FIELDS).length, 'two fields point at one param');
    });

    test('every FxGlobalParam has exactly one field', () => {
        assert.deepEqual(
            sorted(FX_GLOBAL_FIELDS),
            Object.keys(FX_GLOBAL_RANGES).slice().sort());
        assert.equal(new Set(Object.values(FX_GLOBAL_FIELDS)).size,
            Object.keys(FX_GLOBAL_FIELDS).length);
    });

    test('every FxEnable bit has a field', () => {
        assert.deepEqual(sorted(FX_ENABLE_FIELDS),
            Object.keys(FxEnable).slice().sort());
    });

    test('field names do not collide across the two tables', () => {
        for (const k of Object.keys(FX_FIELDS)) {
            assert.ok(!(k in FX_ENABLE_FIELDS),
                `${k} is both a parameter and an enable flag`);
        }
    });

    test('fxEnableMask builds the bitmask the engine expects', () => {
        assert.equal(fxEnableMask(null), 0);
        assert.equal(fxEnableMask({}), 0);
        assert.equal(fxEnableMask({ delay: true }), FxEnable.FX_EN_DELAY);
        assert.equal(fxEnableMask({ delay: true, send: true }),
            FxEnable.FX_EN_DELAY | FxEnable.FX_EN_SEND);
        // Only a real `true` counts — a stored "1" or "on" is not a flag.
        assert.equal(fxEnableMask({ delay: 1, drive: 'yes' }), 0);
    });
});
