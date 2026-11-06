// Pattern thumbnails — a pattern's notes as a coarse density map.
//
// The exact pitch and position of every note would be unreadable at clip
// size, so the map rounds up: one cell per **beat** (four columns) per
// **octave**. A cell is marked when any note sounds in that beat in that
// octave, and is more opaque the more notes touch it — a held note leaves
// a faint trail, a busy chord a solid dot. Time runs down, as in the
// Section grid, so beats are rows and octaves are columns, low to high.
//
// The image is drawn once per pattern state and size and cached: clips are
// re-rendered on every edit and the map only changes when the pattern
// does. The key is the pattern's notes and length; a stale entry is
// replaced the next time it is asked for. (Data URLs, not blob URLs: they
// are made synchronously, so a clip renders with its dots the first time,
// and there is nothing to revoke.)

import { COLS_PER_MEASURE } from './project-model.js';

const COLS_PER_BEAT = 4;

const octaveOf = (midi) => Math.floor(midi / 12) - 1;   // MIDI 60 = C4

/**
 * The density map. `cells[beat][octave - lowOctave]` is how many notes
 * touch that beat in that octave; `max` is the largest count.
 * @returns {{beats:number, lowOctave:number, octaves:number, cells:number[][], max:number}}
 */
export function thumbCells(pattern) {
    const beats = Math.max(1, Math.ceil(((pattern && pattern.measures) || 1) * COLS_PER_MEASURE / COLS_PER_BEAT));
    const notes = (pattern && pattern.notes) || [];
    if (notes.length === 0) return { beats, lowOctave: 0, octaves: 0, cells: [], max: 0 };
    let low = Infinity, high = -Infinity;
    for (const n of notes) {
        const o = octaveOf(n.midi);
        if (o < low) low = o;
        if (o > high) high = o;
    }
    const octaves = high - low + 1;
    const cells = Array.from({ length: beats }, () => new Array(octaves).fill(0));
    let max = 0;
    for (const n of notes) {
        const o = octaveOf(n.midi) - low;
        const first = Math.floor(n.start / COLS_PER_BEAT);
        const last = Math.floor((n.start + Math.max(1, n.dur) - 1) / COLS_PER_BEAT);
        for (let b = Math.max(0, first); b <= Math.min(beats - 1, last); b++) {
            const v = ++cells[b][o];
            if (v > max) max = v;
        }
    }
    return { beats, lowOctave: low, octaves, cells, max };
}

/** Opacity for a count: anything present shows, the busiest cell is solid. */
export function cellAlpha(count, max) {
    if (!count || !max) return 0;
    return 0.3 + 0.7 * (count / max);
}

const cache = new Map();   // `id|w×h` → { key, url } — clips and the library draw different sizes

function signature(pattern, width, height) {
    let s = `${pattern.measures}|${width}x${height}|`;
    for (const n of pattern.notes || []) s += `${n.midi},${n.start},${n.dur};`;
    return s;
}

/**
 * The thumbnail of one pass of the pattern, `width` × `height` CSS pixels,
 * as an image URL — or null for an empty pattern, or where there is no
 * canvas to draw with (the unit tests).
 */
export function thumbURL(pattern, width, height) {
    if (!pattern || typeof document === 'undefined') return null;
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    const key = signature(pattern, width, height);
    const slot = `${pattern.id}|${width}x${height}`;
    const hit = cache.get(slot);
    if (hit && hit.key === key) return hit.url;

    const map = thumbCells(pattern);
    let url = null;
    if (map.max > 0) {
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        const ctx = canvas.getContext && canvas.getContext('2d');
        if (ctx && canvas.toDataURL) {
            ctx.scale(dpr, dpr);
            const cw = width / map.octaves;
            const ch = height / map.beats;
            const r = Math.max(1, Math.min(cw, ch) * 0.32);
            for (let b = 0; b < map.beats; b++) {
                for (let o = 0; o < map.octaves; o++) {
                    const a = cellAlpha(map.cells[b][o], map.max);
                    if (!a) continue;
                    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
                    ctx.beginPath();
                    ctx.arc((o + 0.5) * cw, (b + 0.5) * ch, r, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            url = canvas.toDataURL('image/png');
        }
    }
    cache.set(slot, { key, url });
    return url;
}

/** Tests: forget every cached image. */
export function _clearThumbCache() { cache.clear(); }
