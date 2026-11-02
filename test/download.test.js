// Saving a file from the browser.
//
// Small, but it is the one path between "the app made some bytes" and
// "the user has a file", and phase 5's project export goes through it
// too. The filename rules are the part with judgement in them.

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserEnv } from './harness.js';

let downloadBlob, downloadBytes, downloadJson, safeFilename;
let made, revoked;

before(async () => {
    installBrowserEnv();
    globalThis.Blob = class {
        constructor(parts, opts = {}) { this.parts = parts; this.type = opts.type || ''; }
    };
    globalThis.URL = {
        createObjectURL: (blob) => { made.push(blob); return 'blob:' + made.length; },
        revokeObjectURL: (url) => revoked.push(url),
    };
    ({ downloadBlob, downloadBytes, downloadJson, safeFilename } =
        await import('../html/components/download.js'));
});

beforeEach(() => { made = []; revoked = []; });

/** The anchor the helper creates, clicks and removes. */
function lastAnchor() {
    const clicked = [];
    const realCreate = document.createElement;
    document.createElement = (tag) => {
        const node = realCreate(tag);
        if (tag === 'a') clicked.push(node);
        return node;
    };
    return { clicked, restore: () => { document.createElement = realCreate; } };
}

describe('downloadBlob', () => {
    test('names the file and starts the download', () => {
        const trap = lastAnchor();
        const ok = downloadBlob('thing.syx', new Blob(['x']));
        trap.restore();

        assert.equal(ok, true);
        assert.equal(trap.clicked.length, 1);
        assert.equal(trap.clicked[0].download, 'thing.syx');
        assert.match(trap.clicked[0].href, /^blob:/);
    });

    test('the object URL is revoked later, not in the same task', () => {
        // Revoking inside the click's task cancels the download in some
        // browsers, so this is deliberately deferred.
        downloadBlob('thing.syx', new Blob(['x']));
        assert.deepEqual(revoked, [], 'not yet');
    });

    test('says so rather than throwing where there is no URL API', async () => {
        const real = globalThis.URL;
        globalThis.URL = {};
        assert.equal(downloadBlob('x', new Blob([''])), false);
        globalThis.URL = real;
    });
});

describe('downloadBytes', () => {
    test('copies the bytes — a view of a reused buffer would change under us', () => {
        const buf = new Uint8Array([1, 2, 3]);
        downloadBytes('bank.syx', buf);
        const [blob] = made;
        buf[0] = 99;
        assert.deepEqual(Array.from(blob.parts[0]), [1, 2, 3]);
        assert.equal(blob.type, 'application/octet-stream');
    });
});

describe('downloadJson', () => {
    test('serialises and labels it', () => {
        downloadJson('project.json', { name: 'Nocturne', bpm: 96 });
        const [blob] = made;
        assert.deepEqual(JSON.parse(blob.parts[0]), { name: 'Nocturne', bpm: 96 });
        assert.equal(blob.type, 'application/json');
    });
});

describe('safeFilename', () => {
    test('keeps ordinary names', () => {
        assert.equal(safeFilename('My Bank'), 'My Bank');
        assert.equal(safeFilename('take-2_final'), 'take-2_final');
    });

    test('drops characters a filename should not carry', () => {
        assert.equal(safeFilename('a/b\\c:d*e?'), 'abcde');
    });

    test('collapses whitespace and trims', () => {
        assert.equal(safeFilename('  two   words  '), 'two words');
    });

    test('falls back when nothing survives', () => {
        assert.equal(safeFilename('///'), 'export');
        assert.equal(safeFilename('', { fallback: 'patches' }), 'patches');
        assert.equal(safeFilename(null, { fallback: 'patches' }), 'patches');
    });

    test('strips the extension the caller is about to add again', () => {
        assert.equal(safeFilename('bank.syx', { strip: 'syx' }), 'bank');
        assert.equal(safeFilename('bank.SYX', { strip: 'syx' }), 'bank');
        assert.equal(safeFilename('my.bank', { strip: 'syx' }), 'my.bank', 'only that one');
    });
});
