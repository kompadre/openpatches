// The face of collab.js: a chip in the menu bar while a session is on,
// and one dialog (File › Collaborate…) that shows what fits the moment —
//
//   idle      who you are (asked once) · Start sharing · Join with a code
//   sharing   the code, who is in, who is editing what, Stop sharing
//   joining   …and Cancel
//   watching  whose project, who is editing what · Keep a copy · Leave
//   ended     the host stopped · Keep a copy · Back to my project
//
// and, in a session, the **Conflicts** table: what was contested, your
// value, theirs (who, from which editor), who kept it and why, and
// **Reapply mine**, which sends your value again as a fresh edit.
//
// Notices from the session (a lost conflict, a host gone) show in the chip
// for a moment and go to the log; the chip also counts the conflicts.

import { openModal, el } from './modal.js';
import { readCode } from './collab-model.js';
import { parseAtom } from './collab-ops.js';
import { profileStore, PEER_COLORS } from './profile-store.js';
import { noteName } from './tracker-model.js';
import { COLS_PER_MEASURE } from './project-model.js';

const NOTICE_MS = 4000;

/** The chip's words for a status, or '' when there is no session. */
export function chipText(s) {
    if (!s || !s.role) return '';
    const warn = (s.conflicts && s.conflicts.length ? ` · ⚠ ${s.conflicts.length}` : '')
        + (s.recording && s.recording.length ? ` · ● ${s.recording.map(r => r.alias).join(', ')} recording` : '');
    if (s.role === 'host') return `⇄ Sharing ${s.room} · ${s.link === 'reconnecting' ? 'reconnecting…' : s.peers + ' in'}${warn}`;
    if (s.state === 'joining') return `⇄ Joining ${s.room}…`;
    if (s.state === 'ended') return '⇄ Session ended';
    if (s.link === 'reconnecting') return '⇄ Reconnecting…' + warn;
    if (s.hostAway) return '⇄ Waiting for the host…' + warn;
    return `⇄ With ${s.hostName || s.room}${warn}`;
}

const FIELD_WORDS = {
    name: 'name', bpm: 'tempo', bpmEnd: 'end tempo', color: 'colour', measures: 'length', kind: 'kind',
    slot: 'slot', volume: 'volume', mute: 'mute', solo: 'solo', compact: 'compact view', divider: 'clock divider',
    patchId: 'patch', voiceData: 'voice', startCol: 'position', repeats: 'repeats', lengthCols: 'length', loop: 'loop',
    trackId: 'track', patternId: 'pattern', tags: 'tags', created: 'created',
};
const word = (f) => FIELD_WORDS[f] || f;

/**
 * An atom in words, with the project's names where it has them:
 * "Riff › C-4 at 1.1", "Keys › volume", "Intro › clip › position".
 */
export function describeAtom(atom, body) {
    const a = parseAtom(atom);
    if (!a) return atom;
    const pattern = (id) => (body && body.patterns && body.patterns[id] && body.patterns[id].name) || 'a pattern';
    const track = (id) => { const t = body && (body.tracks || []).find(x => x.id === id); return t ? t.name : 'a track'; };
    const section = (id) => { const s = body && (body.sections || []).find(x => x.id === id); return s ? s.name : 'a section'; };
    switch (a.kind) {
    case 'top': return 'project › ' + word(a.field);
    case 'fx': return 'project effects › ' + a.field;
    case 'pattern': return pattern(a.id);
    case 'patternField': return pattern(a.id) + ' › ' + word(a.field);
    case 'note': return pattern(a.id) + ' › ' + noteName(a.midi) + ' at ' + (Math.floor(a.start / COLS_PER_MEASURE) + 1) + '.' + (a.start % COLS_PER_MEASURE + 1);
    case 'track': return track(a.id);
    case 'trackField': return track(a.id) + ' › ' + word(a.field);
    case 'trackFx': return track(a.id) + ' › effects › ' + a.field;
    case 'section': return section(a.id);
    case 'sectionField': return section(a.id) + ' › ' + word(a.field);
    case 'order': return 'the order of sections';
    case 'clip': return section(a.sectionId) + ' › a clip';
    case 'clipField': return section(a.sectionId) + ' › clip › ' + word(a.field);
    case 'patch': return 'patch ' + a.id;
    case 'patchName': return 'patch name ' + a.id;
    case 'job': return 'job ' + a.id;
    case 'canvasWhole': return 'canvas › ' + a.key;
    case 'canvasItem': return 'canvas › ' + a.key.replace(/s$/, '') + ' ' + a.id;
    case 'canvasField': return 'canvas › ' + a.key.replace(/s$/, '') + ' ' + a.id + ' › ' + a.field;
    default: return atom;
    }
}

/** A value's JSON text in words: 'null' → "—", a removal → "removed", strings unquoted. */
export function describeValue(text) {
    if (text == null) return 'removed';
    try {
        const v = JSON.parse(text);
        if (v == null) return '—';
        if (v === '1' && text === '1') return 'present';
        if (typeof v === 'string') return v || '""';
        if (typeof v === 'object') return Array.isArray(v) ? v.length + ' items' : '{…}';
        return String(v);
    } catch { return text; }
}

/** "Bob is editing Riff", "Ann is editing Keys", "Ann is editing" */
export function describePresence(e, body) {
    const sc = e.scope || {};
    const what = sc.patternId ? describeAtom('pattern/' + sc.patternId, body)
        : sc.trackId ? describeAtom('track/' + sc.trackId, body)
            : sc.sectionId ? describeAtom('section/' + sc.sectionId, body) : '';
    if (sc.recording) return (e.alias || e.peer) + ' is recording — best not to edit until the take lands';
    return (e.alias || e.peer) + ' is editing' + (what ? ' ' + what : '');
}

/**
 * Keep the chip current. Click opens the dialog.
 * @returns {Function} detach
 */
export function attachCollabChip({ collab, chip, appendLog = () => {}, openDialog, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let noticeTimer = null;
    let notice = '';
    function render() {
        const s = collab.status();
        const text = chipText(s);
        chip.style.display = text ? '' : 'none';
        chip.textContent = notice || text;
        chip.classList.toggle('collab-notice', !!notice);
        chip.classList.toggle('collab-host', s.role === 'host');
        chip.classList.toggle('collab-guest', s.role === 'guest');
        chip.title = text ? 'Collaborative session — click for details' : '';
    }
    const off = collab.subscribe((s) => {
        if (s.notice) {
            appendLog('Collab: ' + s.notice);
            notice = s.role ? s.notice : '';
            clearTimer(noticeTimer);
            if (notice) noticeTimer = setTimer(() => { notice = ''; render(); }, NOTICE_MS);
        }
        render();
    });
    chip.addEventListener('click', () => openDialog && openDialog());
    render();
    return () => { off(); clearTimer(noticeTimer); };
}

/** File › Collaborate… */
export function openCollabDialog({ collab, session, appendLog = () => {}, openTab }) {
    let error = '';
    let off = null;
    const modal = openModal('Collaborate', (body) => {
        function button(text, cls, onClick) {
            const b = el('button', 'midi-btn ' + cls, text);
            b.addEventListener('click', onClick);
            return b;
        }
        function row(...children) {
            const r = el('div', 'collab-row');
            for (const c of children) r.appendChild(c);
            return r;
        }

        /** Who you are: asked before the first Share or Join, editable after. */
        function identityBlock() {
            const have = profileStore.identity();
            const wrap = el('div', 'collab-identity');
            wrap.appendChild(el('h4', null, have ? 'You' : 'Who are you?'));
            if (!have) wrap.appendChild(el('p', 'collab-hint', 'Others see this name on what you edit.'));
            const input = el('input', 'collab-alias-input');
            input.placeholder = 'Your name';
            input.maxLength = 24;
            input.autocomplete = 'off';
            input.value = have ? have.alias : '';
            let color = have ? have.color : null;
            const swatches = el('div', 'collab-swatches');
            const paint = () => {
                for (const b of swatches.children) b.classList.toggle('selected', b.dataset.color === color);
            };
            for (const c of PEER_COLORS) {
                const b = el('button', 'collab-swatch');
                b.type = 'button';
                b.dataset.color = c;
                b.style.background = c;
                b.title = c;
                b.addEventListener('click', () => { color = c; paint(); });
                swatches.appendChild(b);
            }
            paint();
            wrap.appendChild(row(input, swatches));
            /** Store what is typed; null (and an error) when no name. */
            wrap.save = () => {
                const id = profileStore.setIdentity({ alias: input.value, color });
                if (!id) showError('Pick a name first');
                return id;
            };
            wrap.input = input;
            return wrap;
        }

        function presenceBlock(s) {
            const list = (s.editing || []);
            if (!list.length) return null;
            const wrap = el('div', 'collab-presence');
            for (const e of list) wrap.appendChild(el('div', 'collab-editing', describePresence(e, session.get())));
            return wrap;
        }

        const when = (x) => (x.start != null && x.end != null && x.end > x.start ? ', ' + Math.round((x.end - x.start) / 1000) + ' s' : '');

        function conflictsBlock(s) {
            const rows = s.conflicts || [];
            const wrap = el('div', 'collab-conflicts');
            const head = el('h4', null, rows.length ? `Conflicts (${rows.length})` : 'Conflicts');
            wrap.appendChild(head);
            if (!rows.length) {
                wrap.appendChild(el('p', 'collab-hint', 'None. When two of you change the same thing, the one who started first keeps it; the other side gets a row here.'));
                return wrap;
            }
            const table = el('table', 'collab-table');
            const thead = el('thead');
            const tr = el('tr');
            for (const h of ['What', 'You', 'Them', 'Kept', '']) tr.appendChild(el('th', null, h));
            thead.appendChild(tr);
            table.appendChild(thead);
            const tbody = el('tbody');
            const project = session.get();
            for (const r of rows.slice().reverse()) {
                const line = el('tr', 'collab-conflict-row collab-' + r.kind);
                const whats = r.atoms.map(a => describeAtom(a, project));
                line.appendChild(el('td', 'collab-what', whats.length > 2 ? whats[0] + ' (+' + (whats.length - 1) + ')' : whats.join(', ')));
                const mine = r.mine.map(m => describeValue(m.value));
                line.appendChild(el('td', 'collab-mine', (mine.length > 2 ? mine[0] + ' …' : mine.join(', ')) + (r.module ? ' (' + r.module + ')' : '')));
                const t = r.theirs[0];
                line.appendChild(el('td', 'collab-theirs', t
                    ? (t.alias || 'someone') + ': ' + describeValue(t.value) + (t.module ? ' (' + t.module + when(t) + ')' : '')
                    : r.kind === 'invariant' ? 'the project as it was' : '—'));
                const who = r.kind === 'invariant' ? 'Theirs' : (t && t.alias ? t.alias : 'Theirs');
                line.appendChild(el('td', 'collab-kept', r.reason.startsWith(who) ? r.reason : who + ' — ' + r.reason));
                const act = el('td', 'collab-act');
                act.appendChild(button('Reapply mine', 'collab-reapply-btn', () => {
                    if (collab.reapply(r)) appendLog('Collab: reapplied ' + whats.join(', '));
                }));
                line.appendChild(act);
                tbody.appendChild(line);
            }
            table.appendChild(tbody);
            wrap.appendChild(table);
            wrap.appendChild(row(button('Clear', 'collab-clear-btn', () => collab.clearConflicts())));
            return wrap;
        }

        /** An error under what is typed, without rebuilding (and so clearing) the inputs. */
        function showError(msg) {
            error = msg;
            let e = body.querySelector('.collab-error');
            if (!e) { e = el('p', 'collab-error'); body.appendChild(e); }
            e.textContent = msg;
        }

        function render() {
            body.innerHTML = '';
            body.classList.add('collab-dialog');
            const s = collab.status();
            if (!s.role) {
                const who = identityBlock();
                body.appendChild(who);
                body.appendChild(el('h4', null, 'Share this project'));
                body.appendChild(el('p', 'collab-hint',
                    'Others can edit “' + (session.get() ? session.get().name : '') + '” with you, live. '
                    + 'They join with the code — from another tab, or another computer using this same server.'));
                body.appendChild(row(button('Start sharing', 'collab-host-btn', () => {
                    if (!who.save()) return;
                    try {
                        const code = collab.host();
                        appendLog('Collab: sharing with code ' + code);
                    } catch (e) { error = e.message; render(); }
                })));
                body.appendChild(el('h4', null, 'Join a session'));
                const input = el('input', 'collab-code-input');
                input.placeholder = 'Code';
                input.maxLength = 14;
                input.autocomplete = 'off';
                input.spellcheck = false;
                const joinBtn = button('Join', 'collab-join-btn', () => {
                    const code = readCode(input.value);
                    if (!code) { showError('That is not a session code'); return; }
                    if (!who.save()) return;
                    error = '';
                    collab.join(code)
                        .then(() => appendLog('Collab: with ' + (collab.status().hostName || code)))
                        .catch((e) => { error = e.message; render(); });
                });
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
                body.appendChild(row(input, joinBtn));
            } else if (s.role === 'host') {
                body.appendChild(el('p', null, 'Sharing “' + session.get().name + '”. The code:'));
                body.appendChild(el('div', 'collab-code', s.room));
                body.appendChild(el('p', 'collab-peers', s.peers === 1 ? '1 person in' : s.peers + ' people in'));
                const p = presenceBlock(s);
                if (p) body.appendChild(p);
                body.appendChild(row(
                    button('Open a tab', 'collab-tab-btn', () => openTab && openTab(s.room)),
                    button('Stop sharing', 'collab-stop-btn', () => {
                        collab.stopHosting();
                        appendLog('Collab: stopped sharing');
                    }),
                ));
                body.appendChild(conflictsBlock(s));
            } else if (s.state === 'joining') {
                body.appendChild(el('p', null, 'Joining ' + s.room + '…'));
                body.appendChild(row(button('Cancel', 'collab-leave-btn', () => collab.leave())));
            } else {
                const ended = s.state === 'ended';
                body.appendChild(el('p', null, ended
                    ? 'The host stopped sharing. What is on screen is still their project, as it was.'
                    : 'With “' + (s.hostName || s.room) + '” (code ' + s.room + '). '
                        + 'Your edits go to the host; when two of you change the same thing, the one who started first keeps it.'));
                if (!ended) { const p = presenceBlock(s); if (p) body.appendChild(p); }
                body.appendChild(row(
                    button('Keep a copy', 'collab-copy-btn', async () => {
                        await collab.leave({ keepCopy: true });
                        appendLog('Collab: kept a copy as “' + session.get().name + '”');
                    }),
                    button(ended ? 'Back to my project' : 'Leave', 'collab-leave-btn', async () => {
                        await collab.leave();
                        appendLog('Collab: back to “' + session.get().name + '”');
                    }),
                ));
                if (!ended) body.appendChild(conflictsBlock(s));
            }
            if (error) body.appendChild(el('p', 'collab-error', error));
        }
        off = collab.subscribe(() => { error = ''; render(); });
        render();
    }, { onClose: () => off && off() });
    return modal;
}
