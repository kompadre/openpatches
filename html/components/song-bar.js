// Song bar — "Song: [name          ] [Save]" above the piano roll.
//
// One input, one button, and the button's meaning follows the state:
//   typing   → Save. Saving under a name that is taken fails with
//              "Song exists"; it never overwrites.
//   loaded   → the input is disabled and shows the song's name, the button
//              is Delete, and a small ✕ detaches (keeps the notes, drops the
//              name) so the user can save under a new one.
// Suggestions are a custom dropdown rather than a <datalist>: picking a name
// from the list loads the song, whereas typing the very same name does not —
// a datalist cannot tell the two apart.

import { songStore } from './patch-model.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/**
 * @param {{
 *   getSong: () => object,          // snapshot to store on Save
 *   loadSong: (data: object) => void,
 *   log?: (msg: string) => void,
 * }} opts
 */
export function createSongBar(opts) {
    const { getSong, loadSong } = opts;
    const log = opts.log || (() => {});

    const bar = el('div', 'song-bar');
    const label = el('label', 'song-label', 'Song:');
    bar.appendChild(label);

    const field = el('div', 'song-field');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'song-input';
    input.placeholder = 'Song name';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    field.appendChild(input);

    const suggest = el('div', 'song-suggest');
    suggest.style.display = 'none';
    field.appendChild(suggest);
    bar.appendChild(field);

    const actionBtn = el('button', 'pianoroll-btn song-action');
    bar.appendChild(actionBtn);

    const newBtn = el('button', 'pianoroll-btn song-new', '✕');
    newBtn.title = 'New song — keeps the notes, drops the name';
    bar.appendChild(newBtn);

    const status = el('span', 'song-status');
    bar.appendChild(status);

    let loaded = null;   // name of the song currently loaded, or null

    function setStatus(text, kind) {
        status.textContent = text || '';
        status.className = 'song-status' + (kind ? ' ' + kind : '');
    }

    function render() {
        if (loaded) {
            input.disabled = true;
            input.value = loaded;
            actionBtn.textContent = 'Delete';
            actionBtn.title = 'Delete song';
            actionBtn.className = 'pianoroll-btn song-action song-delete';
            actionBtn.disabled = false;
            newBtn.style.display = '';
            hideSuggest();
        } else {
            input.disabled = false;
            actionBtn.textContent = 'Save';
            actionBtn.title = 'Save song';
            actionBtn.className = 'pianoroll-btn song-action song-save';
            actionBtn.disabled = input.value.trim() === '';
            newBtn.style.display = 'none';
        }
    }

    function hideSuggest() {
        suggest.style.display = 'none';
        suggest.innerHTML = '';
    }

    function showSuggest() {
        if (loaded) return;
        const q = input.value.trim().toLowerCase();
        const names = songStore.list().filter(n => !q || n.toLowerCase().includes(q));
        suggest.innerHTML = '';
        if (names.length === 0) {
            suggest.style.display = 'none';
            return;
        }
        for (const name of names) {
            const item = el('div', 'song-suggest-item', name);
            // mousedown would blur the input (and hide this list) before the
            // click lands; keep focus where it is.
            item.addEventListener('mousedown', (e) => e.preventDefault());
            item.addEventListener('click', () => select(name));
            suggest.appendChild(item);
        }
        suggest.style.display = '';
    }

    function select(name) {
        const song = songStore.get(name);
        if (!song) {
            // Deleted in another tab between listing and clicking.
            setStatus('Song not found', 'error');
            showSuggest();
            return;
        }
        loadSong(song.data);
        loaded = song.name;
        render();
        setStatus('Loaded “' + song.name + '”', 'ok');
        log('Loaded song “' + song.name + '”');
    }

    function save() {
        const name = input.value.trim();
        if (!name) return;
        if (songStore.has(name)) {
            setStatus('Song exists', 'error');
            log('Song “' + name + '” exists — not saved');
            return;
        }
        try {
            songStore.create(name, getSong());
        } catch (err) {
            setStatus(err.message, 'error');
            return;
        }
        loaded = name;
        render();
        setStatus('Saved “' + name + '”', 'ok');
        log('Saved song “' + name + '”');
    }

    function remove() {
        const name = loaded;
        if (!confirm('Delete song “' + name + '”? The notes stay in the piano roll.')) return;
        songStore.remove(name);
        loaded = null;
        // Leave the name in the (now editable) box so a slip can be undone
        // with one click on Save.
        input.value = name;
        render();
        setStatus('Deleted “' + name + '”', 'ok');
        log('Deleted song “' + name + '”');
    }

    function detach() {
        loaded = null;
        input.value = '';
        render();
        setStatus('', '');
        input.focus();
    }

    input.addEventListener('input', () => { setStatus('', ''); render(); showSuggest(); });
    input.addEventListener('focus', showSuggest);
    input.addEventListener('blur', hideSuggest);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') hideSuggest();
    });
    actionBtn.addEventListener('click', () => { if (loaded) remove(); else save(); });
    newBtn.addEventListener('click', detach);

    render();

    // Test seams / programmatic access.
    bar._getLoadedName = () => loaded;
    bar._select = select;
    bar._detach = detach;
    return bar;
}
