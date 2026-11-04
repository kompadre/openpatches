// A visible mouse pointer for the demo recording.
//
// Playwright moves a real cursor, but neither a screen capture nor
// Playwright's own video shows it — so a tour recorded straight looks like
// the UI operating itself. This draws a fake pointer that follows every
// move, and flashes a ripple on click.
//
// Injected with addInitScript, so it survives reloads. Everything lives in a
// shadow root and is pointer-events: none, so it cannot affect the app's
// layout or intercept the clicks it is drawing.

export const CURSOR_INIT = () => {
    const install = () => {
        if (document.getElementById('__demo_cursor_host')) return;

        const host = document.createElement('div');
        host.id = '__demo_cursor_host';
        host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
        const root = host.attachShadow({ mode: 'open' });

        root.innerHTML = `
            <style>
                .dot {
                    position: fixed; top: 0; left: 0;
                    width: 22px; height: 22px; margin: -3px 0 0 -3px;
                    pointer-events: none;
                    transition: transform 40ms linear;
                    filter: drop-shadow(0 2px 3px rgba(0,0,0,.6));
                }
                .ring {
                    position: fixed; top: 0; left: 0;
                    width: 14px; height: 14px; margin: -7px 0 0 -7px;
                    border-radius: 50%;
                    border: 2px solid #ffd54a;
                    opacity: 0;
                    pointer-events: none;
                }
                .ring.go { animation: ripple 450ms ease-out; }
                @keyframes ripple {
                    from { opacity: .9; transform: scale(.4); }
                    to   { opacity: 0;  transform: scale(3.4); }
                }
            </style>
            <svg class="dot" viewBox="0 0 24 24">
                <path d="M5 2 L5 20 L10 15.5 L13 22 L16 20.5 L13 14.5 L19.5 14 Z"
                      fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>
            </svg>
            <div class="ring"></div>
        `;

        (document.body || document.documentElement).appendChild(host);

        const dot = root.querySelector('.dot');
        const ring = root.querySelector('.ring');

        const place = (x, y) => {
            dot.style.transform = `translate(${x}px, ${y}px)`;
            ring.style.transform = `translate(${x}px, ${y}px)`;
        };
        place(-100, -100);

        window.addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);

        // The ripple is driven from the harness rather than a click listener:
        // the harness fires it *before* the click lands, so the flash is
        // visible on the control rather than on whatever replaces it.
        window.__demoClickRipple = (x, y) => {
            place(x, y);
            ring.classList.remove('go');
            void ring.offsetWidth;   // restart the animation
            ring.classList.add('go');
        };
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
        install();
    }
};
