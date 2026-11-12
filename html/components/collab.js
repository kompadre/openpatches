// Collaborative sessions: one person's project, mirrored to others, and
// edited by all.
//
// **Host-authoritative.** The host shares the open project under a room
// code; guests join with the code and get a live copy. The host's session
// events say what may have changed; changes are gathered for SEND_MS and
// sent as **parts** (collab-model.js) — a pattern, a patch, the track
// list — numbered so a guest can tell it missed one and ask for the whole
// project again.
//
// **Guests edit** (milestone 2). A guest's edits show at once and travel
// to the host as **edits** — groups of compare-and-set ops on atoms
// (collab-ops.js), diffed from what the guest last knew the host had plus
// what it has already sent. The host's **referee** (collab-referee.js)
// judges each group: applied, agreed, or rejected (a conflict the other
// side won, or an invariant it would break). What stands goes out to
// everyone as parts; the editor gets an **ack**. A rejected group takes the
// host's value back and leaves a row in `status().conflicts`; so does a
// later edit that beats one of ours (`overridden`). The host's own edits
// go through the same referee, so a guest can win against the host.
//
// Parts arriving at a guest are merged **per atom**: an atom the guest has
// changed and not yet had acked — or is still typing into (an *open* edit,
// project-session.js › beginEdit) — keeps the guest's value until the
// verdict. Nothing is sent from under an open edit: a pattern travels once
// the tracker has committed it (doubles merged), never mid-typing.
//
// **Transport is local.** Nobody's clock is synchronised and nothing plays
// in step. An edit carries how long it was open (`elapsed`, the editor's
// own monotonic clock); the host dates it on arrival. Hearing what another
// peer hears is streamed audio, later.
//
// **Transport-agnostic.** `openChannel(room, onMessage, { peer })` returns
// `{ send(msg), close(), kind }` and delivers what the *other* peers in the
// room send. `relayChannel` (the default) goes through the server's room
// relay — other machines — and falls back to `broadcastChannel`, which
// joins tabs of one browser, when there is no relay; a WebSocket
// relay or a WebRTC data channel is the same shape. Messages are plain
// JSON (collab-model.js › Messages), and whatever arrives is checked
// before it is believed.

import {
    hintFor, joinHints, readParts, diffParts, recordChanges, applyParts,
    message, readMessage, makeCode,
} from './collab-model.js';
import { readAtoms, readAtom, diffAtoms, groupOps, applyOps } from './collab-ops.js';
import { createReferee, stampEdit } from './collab-referee.js';
import { createProject, normalizeProject } from './project-model.js';
import { profileStore } from './profile-store.js';

const SEND_MS = 100;            // changes gathered this long before sending
const JOIN_TIMEOUT_MS = 3000;   // guest: no snapshot by then, no one is sharing
const MAX_CONFLICTS = 200;      // rows kept in status().conflicts

/** Tabs of this browser, through a BroadcastChannel per room. */
export function broadcastChannel(room, onMessage) {
    const ch = new BroadcastChannel('openpatches-collab-' + room);
    ch.onmessage = (e) => onMessage(e.data);
    return {
        send(msg) { ch.postMessage(msg); },
        close() { ch.close(); },
    };
}

const clone = (body) => createProject(JSON.parse(JSON.stringify(body)));

/** The atom prefix an open edit's scope covers, or null for "nothing in particular". */
function scopePrefix(scope) {
    if (!scope) return null;
    if (scope.patternId) return 'pattern/' + scope.patternId + '/';
    if (scope.trackId) return 'track/' + scope.trackId + '/';
    if (scope.sectionId) return 'section/' + scope.sectionId + '/';
    return null;
}

/** The relay's address for a room, on the server this page came from. */
export function relayUrl(room, peer, loc = globalThis.location) {
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return scheme + '//' + loc.host + '/api/room/' + encodeURIComponent(room)
        + (peer ? '?peer=' + encodeURIComponent(peer) : '');
}

/**
 * Through the room relay (server.py › /api/room/<code>: a WebSocket that
 * forwards each message to the room's other connections). What is sent
 * before the socket opens is queued. A relay that cannot be reached at
 * all — the production service has none yet — falls back to `fallback`
 * (a BroadcastChannel), queue and all, so tabs of one browser still work.
 * `kind`: 'relay', 'local' (fell back), or 'connecting'.
 */
export function relayChannel(room, onMessage, { peer, WebSocketImpl, fallback = broadcastChannel, url } = {}) {
    const WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    let queue = [];
    let alt = null;
    let ws = null;
    let opened = false;
    let closed = false;
    function toFallback() {
        if (closed || alt) return;
        ws = null;
        alt = fallback(room, onMessage);
        for (const m of queue) alt.send(m);
        queue = null;
    }
    if (!WS) toFallback();
    else {
        try { ws = new WS(url || relayUrl(room, peer)); } catch { toFallback(); }
        if (ws) {
            ws.onopen = () => {
                opened = true;
                for (const m of queue) ws.send(JSON.stringify(m));
                queue = null;
            };
            ws.onmessage = (e) => {
                let m;
                try { m = JSON.parse(e.data); } catch { return; }
                onMessage(m);
            };
            ws.onerror = () => { if (!opened) toFallback(); };
            ws.onclose = () => { if (!opened) toFallback(); };
        }
    }
    return {
        send(msg) {
            if (alt) alt.send(msg);
            else if (queue) queue.push(msg);
            else if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
        },
        close() {
            closed = true;
            queue = null;
            if (alt) alt.close();
            if (ws) { ws.onclose = null; ws.onerror = null; try { ws.close(); } catch { /* already */ } }
        },
        get kind() { return alt ? 'local' : opened ? 'relay' : 'connecting'; },
    };
}

/**
 * @param {object} opts
 * @param {object} opts.session          the project session
 * @param {Function} [opts.openChannel]  (room, onMessage, { peer }) → { send, close, kind }
 * @param {Function} [opts.onBench]      the patch side changed: redraw the canvas
 * @param {Function} [opts.random]       for room codes and peer ids
 * @param {Function} [opts.now]          a monotonic clock in ms (performance.now)
 */
export function createCollab(opts) {
    const { session } = opts;
    const openChannel = opts.openChannel || relayChannel;
    const onBench = opts.onBench || (() => {});
    const random = opts.random || Math.random;
    const now = opts.now || (() => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()));
    const setTimer = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = opts.clearTimeout || ((t) => clearTimeout(t));
    const sendMs = opts.sendMs == null ? SEND_MS : opts.sendMs;
    const joinTimeoutMs = opts.joinTimeoutMs == null ? JOIN_TIMEOUT_MS : opts.joinTimeoutMs;

    let role = null;            // null | 'host' | 'guest'
    let room = null;
    let ch = null;
    let alias = '';
    const listeners = new Set();
    const conflicts = [];       // rows for the Conflicts table, oldest first
    let editSeq = 0;

    // Both: when the edit being gathered began (our clock), and the
    // module (session source) that made it.
    let firstTouch = null;
    let touchBase = 0;          // guest: the version we were at when it began
    let lastModule = '';

    // Host
    let known = null;           // the parts as last sent
    let v = 0;                  // the last version sent
    let hint = null;            // what may have changed since
    let sendTimer = null;
    let hostedId = null;
    const peers = new Set();
    let shadow = null;          // the body as the referee has judged it (= what guests have at v)
    let referee = null;
    const editing = new Map();  // peer → { alias, scope, at }: presence (host keeps; guests get it relayed)

    // Guest
    let peer = null;
    let state = null;           // 'joining' | 'watching' | 'ended'
    let mirror = null;          // the parts as the host has them
    let gv = -1;                // the last version applied
    let hostName = '';
    let joinTimer = null;
    let editTimer = null;
    let resyncing = false;
    let joined = null;          // { resolve, reject } for join()
    let confirmed = null;       // body: the host's project as we last heard it
    let knownLive = null;       // atoms: the live body as we last reconciled it
    const pending = [];         // edits sent, no ack yet: { id, ops, groups }
    let begun = false;          // a 'begin' sent, no edit since
    let begunScope = '';

    function status() {
        return {
            role, room, state,
            peers: peers.size,
            link: ch ? (ch.kind || 'local') : null,
            hostName,
            alias,
            conflicts: conflicts.slice(),
            pending: pending.length,
            editing: [...editing.entries()].map(([p, e]) => ({ peer: p, ...e })),
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

    function identity() {
        const id = profileStore.identity();
        return id ? id.alias : '';
    }

    /** Atoms under the session's open edits: not to be sent, not to be overwritten. */
    function openPrefixes() {
        return (session.openEdits ? session.openEdits() : []).map(e => scopePrefix(e.scope)).filter(Boolean);
    }
    const underOpen = (atom, prefixes) => prefixes.some(p => atom.startsWith(p));
    // The referee's and the parts' version are one counter: `v` here, and
    // `referee.version` is set to it after every parts message.

    /** The elapsed time of the edit being gathered, and forget it. */
    function takeElapsed() {
        const e = firstTouch == null ? 0 : Math.max(0, now() - firstTouch);
        firstTouch = null;
        return e;
    }

    function noteTouch(ev) {
        if (firstTouch == null) { firstTouch = now(); touchBase = gv; }
        if (ev.kind !== 'begin' && ev.source) lastModule = ev.source;
    }

    function addConflicts(rows) {
        for (const r of rows) conflicts.push(r);
        if (conflicts.length > MAX_CONFLICTS) conflicts.splice(0, conflicts.length - MAX_CONFLICTS);
    }

    /** Table rows for an edit's rejected groups, from our side. */
    function rowsForRejected(edit, rejected) {
        return rejected.map(r => ({
            kind: r.kind,
            reason: r.reason,
            edit: edit.id,
            module: edit.module,
            atoms: r.group.map(op => op.atom),
            mine: r.group.map(op => ({ atom: op.atom, value: op.after })),
            theirs: (r.conflicts || []).map(c => ({ atom: c.atom, value: c.theirs.after, alias: c.theirs.alias, module: c.theirs.module, start: c.theirs.start, end: c.theirs.end })),
            kept: 'theirs',
            at: Date.now(),
        }));
    }

    /** Table rows for atoms of ours a later edit beat. */
    function rowsForOverridden(rows) {
        return rows.map(r => ({
            kind: 'overridden',
            reason: (r.theirs.alias || 'someone') + ' started first',
            edit: r.mine.edit,
            module: r.mine.module,
            atoms: [r.atom],
            mine: [{ atom: r.atom, value: r.mine.after }],
            theirs: [{ atom: r.atom, value: r.theirs.after, alias: r.theirs.alias, module: r.theirs.module, start: r.theirs.start, end: r.theirs.end }],
            kept: 'theirs',
            at: Date.now(),
        }));
    }

    /** Ops into the open project, announced as 'collab'. */
    function applyLive(ops, { normalize = false } = {}) {
        const body = session.get();
        const moved = applyOps(body, ops);
        if (moved.structure && normalize) normalizeProject(body);
        if (moved.structure) session.update(() => {}, 'collab', 'project');
        else for (const id of moved.patterns) session.notifyPattern(id, 'collab');
        if (moved.bench) {
            session.update(() => {}, 'collab', 'patches');
            onBench();
        }
        return moved;
    }

    // --- Host ---

    function host() {
        if (role) throw new Error('Already in a collab session');
        const project = session.get();
        if (!project) throw new Error('No project open');
        room = makeCode(random);
        role = 'host';
        alias = identity();
        known = readParts(project);
        v = 0;
        hint = null;
        hostedId = project.id;
        peers.clear();
        editing.clear();
        shadow = clone(project);
        referee = createReferee({ version: 0 });
        firstTouch = null;
        ch = openChannel(room, onHostMessage, { peer: 'host' });
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
            if (editing.delete(m.peer)) sendPresence();
            if (peers.delete(m.peer)) emit();
        } else if (m.t === 'begin') {
            editing.set(m.peer, { alias: typeof m.alias === 'string' ? m.alias : m.peer, scope: m.scope || {}, at: Date.now() });
            sendPresence();
            emit();
        } else if (m.t === 'edit') {
            if (m.project === hostedId) onGuestEdit(m);   // not one for a project we no longer share
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

    /** Who is editing what, to every guest (the host's own open edits included). */
    function sendPresence() {
        const list = [...editing.entries()].map(([p, e]) => ({ peer: p, alias: e.alias, scope: e.scope }));
        for (const e of (session.openEdits ? session.openEdits() : [])) list.push({ peer: 'host', alias: alias || 'host', scope: e.scope });
        send('presence', { editing: list });
    }

    /** A guest's edit: judged, applied, sent round, answered. */
    function onGuestEdit(m) {
        const edit = stampEdit({ ...m.edit, peer: m.peer }, now());
        if (!edit) return;
        if (editing.delete(m.peer)) sendPresence();
        flushNow();                                   // our own edits first, in order
        const out = referee.judge(edit, shadow);
        if (out.applied.length) {
            applyLive(out.applied);
            flushNow();                               // v = out.version
        }
        send('ack', {
            to: m.peer, id: edit.id, v,
            accepted: out.accepted.map(a => edit.groups.indexOf(a.group)),
            rejected: out.rejected.map(r => ({
                i: edit.groups.indexOf(r.group), kind: r.kind, reason: r.reason, conflicts: r.conflicts,
            })),
        });
        dispatchOverridden(out.overridden);
        emit();
    }

    /** Rows for whoever a verdict displaced: ours stay here, theirs travel. */
    function dispatchOverridden(rows) {
        const byPeer = new Map();
        for (const r of rows) {
            if (r.mine.peer === 'host') { addConflicts(rowsForOverridden([r])); continue; }
            if (!byPeer.has(r.mine.peer)) byPeer.set(r.mine.peer, []);
            byPeer.get(r.mine.peer).push(r);
        }
        for (const [to, list] of byPeer) send('overridden', { to, rows: list });
    }

    /**
     * The host's own edits since the last flush, through the referee: an
     * atom a guest has since written is a conflict like any other, and a
     * losing group goes back to the shared value. Atoms under an open
     * edit wait for it to close.
     */
    function judgeOwn() {
        const live = session.get();
        const prefixes = openPrefixes();
        const ops = diffAtoms(shadow, live).filter(op => !underOpen(op.atom, prefixes));
        if (!ops.length) return;
        const edit = stampEdit({
            id: 'h' + (++editSeq), peer: 'host', alias: alias || 'host', module: lastModule,
            base: referee.version, elapsed: takeElapsed(), groups: groupOps(ops),
        }, now());
        const out = referee.judge(edit, shadow);
        if (out.rejected.length) {
            const back = out.rejected.flatMap(r => r.group.map(op => ({ atom: op.atom, before: op.after, after: readAtom(shadow, op.atom) })));
            applyLive(back, { normalize: true });
            addConflicts(rowsForRejected(edit, out.rejected));
            emit(out.rejected.length === 1 ? 'Your edit lost a conflict — see Collaborate' : out.rejected.length + ' of your edits lost conflicts — see Collaborate');
        }
        dispatchOverridden(out.overridden);
    }

    function onHostSession(ev) {
        if (ev.kind === 'saving') return;
        if (ev.kind === 'begin') { noteTouch(ev); sendPresence(); return; }
        // Another project opened: that is what is shared now.
        if (ev.kind === 'project' && ev.projectId !== hostedId) {
            hostedId = ev.projectId;
            editing.clear();
            clearTimer(sendTimer); sendTimer = null; hint = null;
            known = readParts(session.get());
            shadow = clone(session.get());
            referee = createReferee({ version: v + 1 });
            v++;
            firstTouch = null;
            sendSnapshot(null);
            return;
        }
        if (ev.source !== 'collab') noteTouch(ev);
        hint = joinHints(hint, hintFor(ev));
        if (sendTimer == null) sendTimer = setTimer(flushNow, sendMs);
    }

    /** Judge our own edits and send what changed, now. */
    function flushNow() {
        if (sendTimer != null) { clearTimer(sendTimer); sendTimer = null; }
        if (role !== 'host' || !session.get()) return;
        judgeOwn();
        if (!hint) return;
        const changes = diffParts(known, session.get(), hint);
        hint = null;
        if (Object.keys(changes).length === 0) return;
        v++;
        referee.version = v;
        send('parts', { v, changes });
    }

    function stopHosting() {
        flushNow();
        send('bye');
        closeChannel();
        role = null; room = null; known = null; shadow = null; referee = null;
        peers.clear(); editing.clear();
        emit();
    }

    // --- Guest ---

    function join(code) {
        if (role) return Promise.reject(new Error('Already in a collab session'));
        room = code;
        role = 'guest';
        state = 'joining';
        alias = identity();
        peer = makeCode(random, 10);
        gv = -1;
        mirror = null;
        confirmed = null;
        knownLive = null;
        pending.length = 0;
        firstTouch = null;
        begun = false;
        hostName = '';
        const done = new Promise((resolve, reject) => { joined = { resolve, reject }; });
        joinTimer = setTimer(() => {
            if (state !== 'joining') return;
            const j = joined;
            dropOut();
            emit('No one is sharing with code ' + code);
            if (j) j.reject(new Error('No one is sharing with code ' + code));
        }, joinTimeoutMs);
        ch = openChannel(room, onGuestMessage, { peer });
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
            const same = !first && session.isGuest() && session.getId() === body.id;
            // Its own copy: the factories keep the bench maps (patches,
            // canvas…) by reference, and the live body gets this one.
            confirmed = clone(body);
            gv = m.v;
            hostName = typeof m.name === 'string' ? m.name : '';
            state = 'watching';
            resyncing = false;
            if (same) {
                // A resync of the project on screen: merge, keeping what
                // we are typing; what we had sent and not heard back on is
                // taken as ours to send again (rebased on this version).
                mirror = readParts(confirmed);
                for (const e of pending.splice(0)) {
                    for (const op of e.ops) { if (op.before == null) knownLive.delete(op.atom); else knownLive.set(op.atom, op.before); }
                }
                reconcile();
                if (editTimer == null) editTimer = setTimer(sendEdit, sendMs);
            } else {
                session.joinAsGuest(body, { sectionId: first ? m.sectionId : session.getSectionId() }, 'collab');
                mirror = readParts(session.get());
                knownLive = readAtoms(session.get());
                pending.length = 0;
                firstTouch = null;
            }
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
            applyParts(confirmed, m.changes);
            reconcile();
        } else if (m.t === 'ack') {
            if (m.to !== peer || state !== 'watching') return;
            onAck(m);
        } else if (m.t === 'presence') {
            if (state !== 'watching') return;
            editing.clear();
            for (const e of m.editing) {
                if (e && typeof e.peer === 'string' && e.peer !== peer) editing.set(e.peer, { alias: String(e.alias || e.peer), scope: e.scope || {}, at: Date.now() });
            }
            emit();
        } else if (m.t === 'overridden') {
            if (m.to !== peer || state !== 'watching') return;
            const rows = m.rows.filter(r => r && typeof r.atom === 'string' && r.mine && r.theirs);
            if (!rows.length) return;
            addConflicts(rowsForOverridden(rows));
            emit(rows.length === 1 ? 'A later edit beat one of yours — see Collaborate' : 'Later edits beat ' + rows.length + ' of yours — see Collaborate');
        } else if (m.t === 'bye') {
            if (state !== 'watching' && state !== 'joining') return;
            const wasJoining = state === 'joining';
            state = 'ended';
            clearTimer(joinTimer); joinTimer = null;
            clearTimer(editTimer); editTimer = null;
            closeChannel();
            if (wasJoining) {
                const j = joined;
                dropOut();
                if (j) j.reject(new Error('The host stopped sharing'));
            }
            emit('The host stopped sharing');
        }
    }

    /** What we expect the host to have: confirmed plus what we have sent. */
    function expectedAtoms() {
        if (!pending.length) return readAtoms(confirmed);
        const body = clone(confirmed);
        for (const e of pending) applyOps(body, e.ops);
        return readAtoms(body);
    }

    /**
     * Bring the live body to what we expect the host to have, atom by
     * atom — except what we have changed here since we last looked
     * (unsent, or typed into an open edit). Those keep our value, and
     * `knownLive` keeps their old one, so the next edit's `before` is
     * honest and the referee sees the conflict.
     */
    function reconcile() {
        if (!confirmed || !knownLive || !session.isGuest()) return;
        const expected = expectedAtoms();
        const dirty = new Set(diffAtoms(knownLive, session.get()).map(op => op.atom));
        const ops = diffAtoms(knownLive, expected).filter(op => !dirty.has(op.atom));
        if (ops.length) applyLive(ops, { normalize: true });
        const next = new Map(expected);
        for (const atom of dirty) {
            if (knownLive.has(atom)) next.set(atom, knownLive.get(atom)); else next.delete(atom);
        }
        knownLive = next;
    }

    function onAck(m) {
        const i = pending.findIndex(e => e.id === m.id);
        if (i < 0) return;
        const [e] = pending.splice(i, 1);
        const rejected = m.rejected
            .filter(r => r && Number.isInteger(r.i) && e.groups[r.i])
            .map(r => ({ group: e.groups[r.i], kind: r.kind === 'invariant' ? 'invariant' : 'conflict', reason: String(r.reason || 'conflict'), conflicts: Array.isArray(r.conflicts) ? r.conflicts : [] }));
        reconcile();
        if (rejected.length) {
            addConflicts(rowsForRejected(e, rejected));
            emit(rejected.length === 1 ? 'Your edit lost a conflict — see Collaborate' : rejected.length + ' of your edits lost conflicts — see Collaborate');
        } else {
            emit();
        }
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
        if (state !== 'watching') return;
        noteTouch(ev);
        if (ev.kind === 'begin') {
            if (!begun || JSON.stringify(ev.scope || {}) !== begunScope) {
                begun = true; begunScope = JSON.stringify(ev.scope || {});
                send('begin', { peer, alias, scope: ev.scope || {} });
            }
            return;
        }
        if (editTimer != null) clearTimer(editTimer);
        editTimer = setTimer(sendEdit, sendMs);
    }

    /** What we changed here, as one edit to the host. */
    function sendEdit() {
        editTimer = null;
        if (role !== 'guest' || state !== 'watching' || !session.isGuest() || !knownLive) return;
        const prefixes = openPrefixes();
        const ops = diffAtoms(knownLive, session.get()).filter(op => !underOpen(op.atom, prefixes));
        if (!ops.length) return;
        const groups = groupOps(ops);
        // `base` is the version we were at when this began, not now: an
        // atom we changed keeps our value through the parts that arrive
        // meanwhile, so what we saw of it is that older version's.
        const edit = {
            id: peer + '-' + (++editSeq), peer, alias, module: lastModule,
            base: Math.max(0, Math.min(touchBase, gv)), elapsed: takeElapsed(), groups,
        };
        begun = false;
        pending.push({ id: edit.id, ops, groups, module: edit.module });
        for (const op of ops) { if (op.after == null) knownLive.delete(op.atom); else knownLive.set(op.atom, op.after); }
        send('edit', { peer, project: session.getId(), edit });
        emit();
    }

    function dropOut() {
        clearTimer(joinTimer); joinTimer = null;
        clearTimer(editTimer); editTimer = null;
        closeChannel();
        role = null; room = null; state = null; mirror = null; joined = null;
        confirmed = null; knownLive = null; pending.length = 0;
        hostName = '';
    }

    /** Stop watching: back to our own project, or keep a copy of theirs. */
    async function leave({ keepCopy = false } = {}) {
        if (role !== 'guest') return;
        if (state === 'watching') { sendEdit(); send('leave', { peer }); }
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
    }, { begin: true });

    return {
        host,
        stopHosting,
        join,
        leave,
        status,
        /** Send what is pending now — for tests and the e2e. */
        flush() { if (role === 'host') flushNow(); else if (role === 'guest') sendEdit(); },
        /** Forget the conflict rows. */
        clearConflicts() { conflicts.length = 0; emit(); },
        /**
         * Reapply mine: put a row's values back into the project here, as
         * a fresh edit on the current version — it goes to the referee
         * like any other (and may lose again). The row is dropped.
         */
        reapply(row) {
            const i = conflicts.indexOf(row);
            if (i < 0 || !role || (role === 'guest' && state !== 'watching')) return false;
            conflicts.splice(i, 1);
            const body = session.get();
            const ops = row.mine.map(m => ({ atom: m.atom, before: readAtom(body, m.atom), after: m.value })).filter(op => op.before !== op.after);
            if (ops.length) {
                const moved = applyOps(body, ops);
                if (moved.structure) normalizeProject(body);
                // Announced from a source of its own, so it travels like an edit made here.
                if (moved.structure || moved.bench) session.update(() => {}, 'reapply', moved.bench && !moved.structure ? 'patches' : 'project');
                else for (const id of moved.patterns) session.notifyPattern(id, 'reapply');
                if (moved.bench) onBench();
            }
            emit();
            return true;
        },
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
