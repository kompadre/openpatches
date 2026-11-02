// The modal shell the panels share, and the little element helper that
// goes with it.
//
// Lifted out of midi-panel.js when the Projects dialog needed the same
// thing: one overlay, a header with a close button, a body the caller
// fills, and dismissal on the close button or a click on the backdrop.
// Matches the static modals in index.html.

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

export function openModal(title, buildBody, { onClose } = {}) {
    const overlay = el('div', 'modal-overlay');
    overlay.style.zIndex = '620';

    const dialog = el('div', 'modal-dialog');
    const header = el('div', 'modal-header');
    header.appendChild(el('h3', null, title));
    const closeBtn = el('button', 'modal-close', '×');
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = el('div', 'modal-body');
    dialog.appendChild(body);
    overlay.appendChild(dialog);

    function close() {
        overlay.remove();
        if (onClose) onClose();
    }

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    buildBody(body, close, dialog);
    document.body.appendChild(overlay);
    return { overlay, close };
}

