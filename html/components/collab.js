// Collaborative sessions: one person's project, mirrored to others.
//
// **Host-authoritative.** The host shares the open project under a room
// code; guests join with the code and get a live copy they can play. The
// host's session events say what may have changed; changes are gathered
// for SEND_MS and sent as **parts** (collab-model.js) — a pattern, a patch,
// the track list — numbered so a guest can tell it missed one and ask for
// the whole project again.
//
// **Guests watch** (milestone 1). The host's project opens ephemeral
// (project-session.js › guest mode): playable, never saved here. A local
// edit is put back to the host's version — what was changed is reverted
// part by part, and the status says so — until guest edits travel too.
// When the host stops, the guest keeps the project on screen and chooses:
// keep a copy as a project of their own, or go back to their own.
//
// **Transport-agnostic.** `openChannel(room, onMessage)` returns
// `{ send(msg), close() }` and delivers what the *other* peers in the room
// send. `broadcastChannel` below joins tabs of one browser; a WebSocket
// relay or a WebRTC data channel is the same shape. Messages are plain
// JSON (collab-model.js › Messages), and whatever arrives is checked
// before it is believed.

import {
    hintFor, joinHints, readParts, diffParts, recordChanges, applyParts, divergence,
    message, readMessage, makeCode,
} from './collab-model.js';

const SEND_MS = 100;            // host: changes gathered this long before sending
const JOIN_TIMEOUT_MS = 3000;   // guest: no snapshot by then, no one is sharing

/** Tabs of this browser, through a BroadcastChannel per room. */
export function broadcastChannel(room, onMessage) {
    const ch = new BroadcastChannel('openpatches-collab-' + room);
    ch.onmessage = (e) => onMessage(e.data);
    return {
        send(msg) { ch.postMessage(msg); },
        close() { ch.close(); },
    };
}

/**
 * @param {object} opts
 * @param {object} opts.session          the project session
 * @param {Function} [opts.openChannel]  (room, onMessage) → { send, close }
 * @param {Function} [opts.onBench]      the patch side changed: redraw the canvas
 * @param {Function} [opts.random]       for room codes and peer ids
 */
export function createCollab(opts) {
    const { session } = opts;
    const openChannel = opts.openChannel || broadcastChannel;
    const onBench = opts.onBench || (() => {});
    const random = opts.random || Math.random;
    const setTimer = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = opts.clearTimeout || ((t) => clearTimeout(t));
    const sendMs = opts.sendMs == null ? SEND_MS : opts.sendMs;
    const joinTimeoutMs = opts.joinTimeoutMs == null ? JOIN_TIMEOUT_MS : opts.joinTimeoutMs;

    let role = null;            // null | 'host' | 'guest'
    let room = null;
    let ch = null;
    const listeners = new Set();

    // Host
    let known = null;           // the parts as last sent
    let v = 0;                  // the last version sent
    let hint = null;            // what may have changed since
    let sendTimer = null;
    let hostedId = null;
    const peers = new Set();

    // Guest
    let peer = null;
    let state = null;           // 'joining' | 'watching' | 'ended'
    let mirror = null;          // the parts as the host has them
    let gv = -1;                // the last version applied
    let hostName = '';
    let joinTimer = null;
    let revertTimer = null;
    let resyncing = false;
    let joined = null;          // { resolve, reject } for join()

    function status() {
        return {
            role, room, state,
            peers: peers.size,
            hostName,
        };
    }

    function emit(notice) {
        const s = status();
        if (notice) s.notice = notice;
        for (const fn of [...listeners]) {
            try { fn(s); } catch (e) { console.warn('[collab] listener failed:', e); }
        }
    }

    function send(t, fields) {
        if (ch) ch.send(message(room, t, fields));
    }

    function closeChannel() {
        if (ch) { try { ch.close(); } catch { /* already */ } }
        ch = null;
    }

    // --- Host ---

    function host() {
        if (role) throw new Error('Already in a collab session');
        const project = session.get();
        if (!project) throw new Error('No project open');
        room = makeCode(random);
        role = 'host';
        known = readParts(project);
        v = 0;
        hint = null;
        hostedId = project.id;
        peers.clear();
        ch = openChannel(room, onHostMessage);
        emit();
        return room;
    }

    function onHostMessage(raw) {
        const m = readMessage(raw, room);
        if (!m || role !== 'host') return;
        if (m.t === 'join' || m.t === 'resync') {
            const fresh = !peers.has(m.peer);
            peers.add(m.peer);
            flushNow();                  // the snapshot is then exactly version v
            sendSnapshot(m.peer);
            if (fresh) emit();
        } else if (m.t === 'leave') {
            if (peers.delete(m.peer)) emit();
        }
    }

    function sendSnapshot(to) {
        const project = session.get();
        send('snapshot', {
            to, v,
            body: JSON.stringify(project),
            sectionId: session.getSectionId(),
            name: project.name,
        });
    }

    function onHostSession(ev) {
        if (ev.kind === 'saving') return;
        // Another project opened: that is what is shared now.
        if (ev.kind === 'project' && ev.projectId !== hostedId) {
            hostedId = ev.projectId;
            clearTimer(sendTimer); sendTimer = null; hint = null;
            known = readParts(session.get());
            v++;
            sendSnapshot(null);
            return;
        }
        hint = joinHints(hint, hintFor(ev));
        if (sendTimer == null) sendTimer = setTimer(flushNow, sendMs);
    }

    /** Send what changed, now. */
    function flushNow() {
        if (sendTimer != null) { clearTimer(sendTimer); sendTimer = null; }
        if (role !== 'host' || !hint || !session.get()) return;
        const changes = diffParts(known, session.get(), hint);
        hint = null;
        if (Object.keys(changes).length === 0) return;
        v++;
        send('parts', { v, changes });
    }

    function stopHosting() {
        flushNow();
        send('bye');
        closeChannel();
        role = null; room = null; known = null; peers.clear();
        emit();
    }

    // --- Guest ---

    function join(code) {
        if (role) return Promise.reject(new Error('Already in a collab session'));
        room = code;
        role = 'guest';
        state = 'joining';
        peer = makeCode(random, 10);
        gv = -1;
        mirror = null;
        hostName = '';
        const done = new Promise((resolve, reject) => { joined = { resolve, reject }; });
        joinTimer = setTimer(() => {
            if (state !== 'joining') return;
            const j = joined;
            dropOut();
            emit('No one is sharing with code ' + code);
            if (j) j.reject(new Error('No one is sharing with code ' + code));
        }, joinTimeoutMs);
        ch = openChannel(room, onGuestMessage);
        emit();
        send('join', { peer });
        return done;
    }

    function onGuestMessage(raw) {
        const m = readMessage(raw, room);
        if (!m || role !== 'guest') return;
        if (m.t === 'snapshot') {
            if (m.to != null && m.to !== peer) return;
            if (state === 'ended') return;
            let body;
            try { body = JSON.parse(m.body); } catch { return; }
            const first = state === 'joining';
            clearTimer(joinTimer); joinTimer = null;
            session.joinAsGuest(body, { sectionId: first ? m.sectionId : session.getSectionId() }, 'collab');
            mirror = readParts(session.get());
            gv = m.v;
            hostName = typeof m.name === 'string' ? m.name : '';
            state = 'watching';
            resyncing = false;
            onBench();
            emit();
            if (first && joined) { joined.resolve(status()); joined = null; }
        } else if (m.t === 'parts') {
            if (state !== 'watching' || m.v <= gv) return;
            if (m.v !== gv + 1) {
                // Missed one: ask for it all, once, and wait for it.
                if (!resyncing) { resyncing = true; send('resync', { peer }); }
                return;
            }
            if (resyncing) return;
            gv = m.v;
            recordChanges(mirror, m.changes);
            applyHere(m.changes);
        } else if (m.t === 'bye') {
            if (state !== 'watching' && state !== 'joining') return;
            const wasJoining = state === 'joining';
            state = 'ended';
            clearTimer(joinTimer); joinTimer = null;
            closeChannel();
            if (wasJoining) {
                const j = joined;
                dropOut();
                if (j) j.reject(new Error('The host stopped sharing'));
            }
            emit('The host stopped sharing');
        }
    }

    /** Changes into the open (watched) project, announced as 'collab'. */
    function applyHere(changes) {
        const moved = applyParts(session.get(), changes);
        if (moved.structure) session.update(() => {}, 'collab', 'project');
        else for (const id of moved.patterns) session.notifyPattern(id, 'collab');
        if (moved.bench) {
            session.update(() => {}, 'collab', 'patches');
            onBench();
        }
        return moved;
    }

    function onGuestSession(ev) {
        if (ev.source === 'collab' || ev.kind === 'saving' || ev.kind === 'section') return;
        // Another project opened here: that ends watching.
        if (!session.isGuest()) {
            if (state === 'watching' || state === 'ended') {
                send('leave', { peer });
                dropOut();
                emit();
            }
            return;
        }
        if (state !== 'watching' || revertTimer != null) return;
        revertTimer = setTimer(revert, 0);
    }

    /** View only: whatever was changed here goes back to the host's. */
    function revert() {
        revertTimer = null;
        if (role !== 'guest' || state !== 'watching' || !session.isGuest()) return;
        const changes = divergence(mirror, session.get());
        if (Object.keys(changes).length === 0) return;
        applyHere(changes);
        emit('View only — your edit was undone');
    }

    function dropOut() {
        clearTimer(joinTimer); joinTimer = null;
        clearTimer(revertTimer); revertTimer = null;
        closeChannel();
        role = null; room = null; state = null; mirror = null; joined = null;
        hostName = '';
    }

    /** Stop watching: back to our own project, or keep a copy of theirs. */
    async function leave({ keepCopy = false } = {}) {
        if (role !== 'guest') return;
        if (state === 'watching') send('leave', { peer });
        const j = joined;
        dropOut();
        if (j) j.reject(new Error('Left'));
        await session.leaveGuest('collab', { keepCopy });
        onBench();
        emit();
    }

    session.subscribe((ev) => {
        if (role === 'host') onHostSession(ev);
        else if (role === 'guest') onGuestSession(ev);
    });

    return {
        host,
        stopHosting,
        join,
        leave,
        status,
        /** Send what is pending now — for tests and the e2e. */
        flush: flushNow,
        /** Page going away: say goodbye so the others are not left waiting. */
        close() {
            if (role === 'host') stopHosting();
            else if (role === 'guest') {
                if (state === 'watching') send('leave', { peer });
                dropOut();
            }
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
