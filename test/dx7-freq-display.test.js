// Regression: freqDisplay() used `coarse * 100 + fine` for fixed mode and
// `coarse + fine/100` for ratio mode. The DX7 uses 10^(coarse%4 + fine/100) Hz
// for fixed, and coarse * (1 + fine/100) for ratio (coarse 0 meaning 0.5).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freqDisplay } from '../html/components/dx7-params.js';

describe('freqDisplay', () => {
    test('fixed mode uses the decade scale, not coarse*100', () => {
        assert.equal(freqDisplay(1, 0, 0), '1.00 Hz');
        assert.equal(freqDisplay(1, 1, 0), '10.0 Hz');
        assert.equal(freqDisplay(1, 2, 0), '100.0 Hz');
        assert.equal(freqDisplay(1, 3, 0), '1000.0 Hz');
    });

    test('fixed mode ignores all but the low 2 bits of coarse', () => {
        assert.equal(freqDisplay(1, 4, 0), freqDisplay(1, 0, 0));
        assert.equal(freqDisplay(1, 31, 0), freqDisplay(1, 3, 0));
    });

    test('fixed mode max is ~9772 Hz', () => {
        assert.equal(freqDisplay(1, 3, 99), '9772.4 Hz');
    });

    test('ratio mode treats coarse 0 as 0.5', () => {
        assert.equal(freqDisplay(0, 0, 0), '0.50×');
        assert.equal(freqDisplay(0, 1, 0), '1.00×');
        assert.equal(freqDisplay(0, 2, 0), '2.00×');
    });

    test('ratio mode fine is a percentage of coarse, not an addend', () => {
        assert.equal(freqDisplay(0, 2, 50), '3.00×');
        assert.equal(freqDisplay(0, 1, 50), '1.50×');
        assert.equal(freqDisplay(0, 0, 50), '0.75×');
    });
});
