// Project management: the Projects dialog, and the File-menu actions.
//
// A Project is the piece of music — the whole workspace, not a thing the
// Section editor's toolbar should be switching between. So it lives in
// the File menu, and everything that touches the *set* of projects
// (open, new, rename, duplicate, delete) happens in one dialog rather
// than as four menu items each popping its own prompt.
//
// Switching project is cheap and instant: the session adopts the new body
// synchronously and the write follows behind. Only *opening* an existing
// one has to wait, because its body is read back out of IndexedDB.

import { el, openModal } from './modal.js';

/** "2 minutes ago" is the save light's job; here a date is more use. */
function when(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
        ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The Projects dialog.
 *
 * @param {object} opts
 * @param {object} opts.session
 * @param {function} [opts.appendLog]
 * @param {function} [opts.onChange]  after anything that switches project
 */
export function openProjectsDialog({ session, appendLog = () => {}, onChange = () => {} } = {}) {
    let close = () => {};

    const modal = openModal('Projects', (body, closeFn) => {
        close = closeFn;

        body.appendChild(el('p', 'project-intro',
            'A project is one piece of music: its sections, patterns, tracks and '
            + 'patches. Switching project swaps all of them.'));

        const list = el('div', 'project-list');
        body.appendChild(list);

        const actions = el('div', 'midi-actions project-actions');
        const newBtn = el('button', 'midi-btn project-new', '+ New project');
        actions.appendChild(newBtn);
        body.appendChild(actions);

        newBtn.addEventListener('click', () => {
            const project = session.createNew('Untitled project', 'project-menu');
            appendLog(`New project: ${project.name}`);
            onChange();
            close();
        });

        function refresh() {
            list.innerHTML = '';
            const currentId = session.getId();
            for (const entry of session.list()) {
                list.appendChild(row(entry, entry.id === currentId, refresh));
            }
        }

        function row(entry, isCurrent, refresh) {
            const item = el('div', 'project-row' + (isCurrent ? ' current' : ''));

            const main = el('button', 'project-open');
            main.appendChild(el('span', 'project-name', entry.name));
            main.appendChild(el('span', 'project-when', when(entry.modified)));
            if (isCurrent) main.appendChild(el('span', 'project-badge', 'open'));
            main.title = isCurrent ? 'Already open' : 'Open this project';
            main.addEventListener('click', async () => {
                if (isCurrent) return;
                // The one action that waits: the body comes back out of
                // IndexedDB. Everything else is already in memory.
                main.disabled = true;
                const opened = await session.open(entry.id, 'project-menu');
                if (!opened) {
                    appendLog(`Could not open ${entry.name} — its data is missing`);
                    main.disabled = false;
                    refresh();
                    return;
                }
                appendLog(`Opened project: ${opened.name}`);
                onChange();
                close();
            });
            item.appendChild(main);

            const tools = el('div', 'project-row-tools');

            const rename = el('button', 'midi-btn midi-btn-small project-rename', 'Rename');
            rename.title = 'Rename this project';
            rename.addEventListener('click', async () => {
                const wanted = prompt('Project name', entry.name);
                if (wanted == null) return;
                if (entry.id === session.getId()) {
                    session.rename(wanted, 'project-menu');
                } else {
                    // Not open, so there is no in-memory body to edit:
                    // open it, rename, and leave it open — renaming a
                    // project you cannot see would be the odder outcome.
                    if (!await session.open(entry.id, 'project-menu')) return;
                    session.rename(wanted, 'project-menu');
                    onChange();
                }
                appendLog(`Renamed project to ${session.get().name}`);
                refresh();
            });
            tools.appendChild(rename);

            const dup = el('button', 'midi-btn midi-btn-small project-duplicate', 'Duplicate');
            dup.title = 'Make a copy and open it';
            dup.addEventListener('click', async () => {
                dup.disabled = true;
                const copy = await session.duplicate(entry.id, 'project-menu');
                if (!copy) { dup.disabled = false; return; }
                appendLog(`Duplicated ${entry.name} as ${copy.name}`);
                onChange();
                close();
            });
            tools.appendChild(dup);

            const del = el('button', 'midi-btn midi-btn-small midi-btn-danger project-delete', 'Delete');
            del.title = 'Delete this project';
            del.addEventListener('click', async () => {
                if (!confirm(`Delete “${entry.name}”? This cannot be undone.`)) return;
                await session.remove(entry.id, 'project-menu');
                appendLog(`Deleted project: ${entry.name}`);
                onChange();
                refresh();
            });
            tools.appendChild(del);

            item.appendChild(tools);
            return item;
        }

        refresh();
    });

    return modal;
}
