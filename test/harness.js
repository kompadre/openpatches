// Minimal browser-environment stub for running component modules under `node --test`.
// Deliberately dependency-free (matching the rest of the project) — this implements
// only the surface the components actually touch, not a general-purpose DOM.

// --- Canvas 2D context: accept every call, record nothing ---

function makeCtx2d() {
    return new Proxy({}, {
        get(target, prop) {
            if (prop in target) return target[prop];
            return () => {};
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        },
    });
}

// --- Element ---

class StubElement {
    constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this.listeners = {};
        this._className = '';
        this.textContent = '';
        this.disabled = false;
        this.value = '';
        this.title = '';
        // Layout: stubs report a fixed, non-zero box so geometry code has something to work with.
        this.scrollLeft = 0;
        this.scrollTop = 0;
        this.clientWidth = 800;
        this.clientHeight = 600;
        this.offsetWidth = 100;
        this.offsetHeight = 20;
        this.offsetLeft = 0;
        if (this.tagName === 'CANVAS') {
            this.width = 300;
            this.height = 150;
            this._ctx = makeCtx2d();
        }
    }

    get className() { return this._className; }
    set className(v) { this._className = String(v); }

    get classList() {
        const self = this;
        const parts = () => self._className.split(/\s+/).filter(Boolean);
        return {
            add(...names) {
                const set = new Set(parts());
                names.forEach(n => set.add(n));
                self._className = [...set].join(' ');
            },
            remove(...names) {
                self._className = parts().filter(p => !names.includes(p)).join(' ');
            },
            toggle(name, force) {
                const has = parts().includes(name);
                const want = force === undefined ? !has : force;
                if (want) this.add(name); else this.remove(name);
            },
            contains(name) { return parts().includes(name); },
        };
    }

    set innerHTML(v) { if (v === '') this.children = []; }
    get innerHTML() { return ''; }

    getContext() { return this._ctx; }

    appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        child.parentNode = null;
        return child;
    }

    remove() { if (this.parentNode) this.parentNode.removeChild(this); }

    insertBefore(node, ref) {
        const i = ref ? this.children.indexOf(ref) : -1;
        node.parentNode = this;
        if (i < 0) this.children.push(node);
        else this.children.splice(i, 0, node);
        return node;
    }

    insertAdjacentElement(_pos, node) { return this.appendChild(node); }

    addEventListener(type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
    }

    removeEventListener(type, fn) {
        const arr = this.listeners[type];
        if (!arr) return;
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
    }

    // Test helper: synchronously invoke handlers registered for `type`.
    dispatch(type, event = {}) {
        for (const fn of this.listeners[type] || []) fn({ type, target: this, ...event });
    }

    getBoundingClientRect() {
        return {
            left: 0, top: 0,
            right: this.offsetWidth, bottom: this.offsetHeight,
            width: this.offsetWidth, height: this.offsetHeight,
        };
    }

    _walk(out = []) {
        for (const c of this.children) { out.push(c); c._walk(out); }
        return out;
    }

    _matches(sel) {
        if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
        return this.tagName === sel.toUpperCase();
    }

    querySelectorAll(sel) {
        // Only single class/tag selectors and comma lists are supported.
        const sels = sel.split(',').map(s => s.trim()).filter(Boolean);
        return this._walk().filter(el => sels.some(s => el._matches(s)));
    }

    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

    closest(sel) {
        const sels = sel.split(',').map(s => s.trim()).filter(Boolean);
        let node = this;
        while (node) {
            if (sels.some(s => node._matches(s))) return node;
            node = node.parentNode;
        }
        return null;
    }

    contains(node) { return node === this || this._walk().includes(node); }
    focus() {}
}

// --- localStorage ---

function makeLocalStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear(),
    };
}

/**
 * Install browser globals. Call once per test file, before dynamic-importing
 * the module under test. Returns handles the tests can poke at.
 */
export function installBrowserEnv() {
    const documentEl = new StubElement('body');
    const docListeners = {};

    const document = {
        body: documentEl,
        createElement: (tag) => new StubElement(tag),
        createRange: () => ({ selectNodeContents() {} }),
        getElementById: () => null,
        querySelector: (s) => documentEl.querySelector(s),
        querySelectorAll: (s) => documentEl.querySelectorAll(s),
        addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
        removeEventListener: (t, fn) => {
            const arr = docListeners[t];
            if (!arr) return;
            const i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
        },
        _listeners: docListeners,
    };

    globalThis.document = document;
    globalThis.localStorage = makeLocalStorage();
    globalThis.window = globalThis;
    globalThis.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
    globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
    globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    globalThis.confirm = () => true;
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
    if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
    if (!globalThis.dispatchEvent) globalThis.dispatchEvent = () => {};

    return { document, StubElement };
}

export { StubElement };
