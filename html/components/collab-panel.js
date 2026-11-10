// The face of collab.js: a chip in the menu bar while a session is on,
// and one dialog (File › Collaborate…) that shows what fits the moment —
//
//   idle      Start sharing this project · Join with a code
//   sharing   the code, who is watching, a watching tab, Stop sharing
//   joining   …and Cancel
//   watching  whose project, view only · Keep a copy · Leave
//   ended     the host stopped · Keep a copy · Back to my project
//
// Notices from the session (a reverted edit, a host gone) show in the chip
// for a moment and go to the log.

import { openModal, el } from './modal.js';
import { readCode } from './collab-model.js';

const NOTICE_MS = 4000;

/** The chip's words for a status, or '' when there is no session. */
export function chipText(s) {
    if (!s || !s.role) return '';
    if (s.role === 'host') return `⇄ Sharing ${s.room} · ${s.peers} watching`;
    if (s.state === 'joining') return `⇄ Joining ${s.room}…`;
    if (s.state === 'ended') return '⇄ Session ended';
    return `⇄ Watching ${s.hostName || s.room} · view only`;
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
        function render() {
            body.innerHTML = '';
            body.classList.add('collab-dialog');
            const s = collab.status();
            if (!s.role) {
                body.appendChild(el('h4', null, 'Share this project'));
                body.appendChild(el('p', 'collab-hint',
                    'Others can watch “' + (session.get() ? session.get().name : '') + '” live and play it. '
                    + 'For now they join from this browser (another tab or window); other computers come next.'));
                body.appendChild(row(button('Start sharing', 'collab-host-btn', () => {
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
                    if (!code) { error = 'That is not a session code'; render(); return; }
                    error = '';
                    collab.join(code)
                        .then(() => appendLog('Collab: watching ' + (collab.status().hostName || code)))
                        .catch((e) => { error = e.message; render(); });
                });
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
                body.appendChild(row(input, joinBtn));
            } else if (s.role === 'host') {
                body.appendChild(el('p', null, 'Sharing “' + session.get().name + '”. The code:'));
                body.appendChild(el('div', 'collab-code', s.room));
                body.appendChild(el('p', 'collab-peers', s.peers === 1 ? '1 person watching' : s.peers + ' people watching'));
                body.appendChild(row(
                    button('Open a watching tab', 'collab-tab-btn', () => openTab && openTab(s.room)),
                    button('Stop sharing', 'collab-stop-btn', () => {
                        collab.stopHosting();
                        appendLog('Collab: stopped sharing');
                    }),
                ));
            } else if (s.state === 'joining') {
                body.appendChild(el('p', null, 'Joining ' + s.room + '…'));
                body.appendChild(row(button('Cancel', 'collab-leave-btn', () => collab.leave())));
            } else {
                const ended = s.state === 'ended';
                body.appendChild(el('p', null, ended
                    ? 'The host stopped sharing. What is on screen is still their project, as it was.'
                    : 'Watching “' + (s.hostName || s.room) + '” (code ' + s.room + '). '
                        + 'It plays here; edits stay with the host for now — yours are undone.'));
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
            }
            if (error) body.appendChild(el('p', 'collab-error', error));
        }
        off = collab.subscribe(() => { error = ''; render(); });
        render();
    }, { onClose: () => off && off() });
    return modal;
}
