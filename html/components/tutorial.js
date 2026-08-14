// Tutorial — guided tour of app features.
// Each step highlights an element, opens a menu, and shows a modal.
// Steps are extensible: add objects to STEPS array for new tutorial pages.

const STORAGE_KEY = 'openpatches_tutorial';

const STEPS = [
    {
        id: 'welcome',
        title: 'Welcome to OpenPatches',
        illustration: '<div class="tutorial-illustration-placeholder">\uD83C\uDF10</div>',
        description:
            'OpenPatches is a next-generation <strong>Sound Archeology</strong> and <strong>FM Curation</strong> platform.<br><br>' +
            '<strong>Recover & Archive:</strong> Reverse-engineer audio into constituent DX7 parameters using linear approximation. Curate bespoke banks (Digital Cartridges) and export them for use in hardware or software.<br><br>' +
            '<strong>Mutate & Compose:</strong> Blend timbres with spectral morphing or generate mutations. Use the unique 8-channel <strong>multitimbral sequencer</strong> to hear how your patches work together in realtime.<br><br>' +
            '<strong>The FM Advantage:</strong> Experience noiseless, pure mathematical oscillation that scales perfectly across all pitches without the artifacts of traditional sampling.',
    },
    {
        id: 'import-wav',
        title: 'Import a .WAV file',
        openMenu: 'file',
        illustration: null,
        description:
            'Import any audio recording to find its closest DX7 match.<br><br>' +
            '<strong>The process:</strong><br>' +
            '1. Select a <strong>.WAV</strong> file from your computer<br>' +
            '2. The server <em>probes</em> it — analyzing attack, decay, brightness, and harmonicity<br>' +
            '3. You review and adjust the detected parameters<br>' +
            '4. <em>Matching</em> begins — linear approximation searches for the best DX7 patch<br>' +
            '5. Results appear as patches in a container on the canvas<br><br>' +
            'Each patch is a 128-byte DX7 voice that reproduces the original sound using FM synthesis.',
    },
    {
        id: 'load-syx',
        title: 'Load a .SYX bank',
        openMenu: 'file',
        illustration: null,
        description:
            'Load a standard DX7 SysEx file (.SYX) containing up to <strong>32 voices</strong>.<br><br>' +
            '<strong>What happens:</strong><br>' +
            '1. The .SYX file is parsed into individual 128-byte patches<br>' +
            '2. All non-empty voices appear in a new <strong>container</strong> on the canvas<br>' +
            '3. Click any patch to preview its sound<br>' +
            '4. Use the <strong>♫</strong> button to assign patches to the voice bank for use in the piano roll<br><br>' +
            'Try loading the built-in <strong>DEMO.SYX</strong> if you haven\'t already!',
    },
    {
        id: 'containers',
        title: 'Patch Containers',
        highlight: '.sky-container',
        fallbackHighlight: '#night-sky',
        noBlur: true,
        illustration: null,
        description:
            'Patches live inside <strong>containers</strong> on the canvas — the dark starfield area.<br><br>' +
            '<strong>Interactions:</strong><br>' +
            '• <strong>Click</strong> a patch to preview its sound<br>' +
            '• <strong>♫</strong> assigns patches to the voice bank (up to 8) for the piano roll<br>' +
            '• <strong>★</strong> drag handle — drag patches between containers or onto the canvas<br>' +
            '• <strong>↕</strong> sorts patches by algorithm number<br>' +
            '• <strong>💾</strong> exports the container as a .SYX file<br>' +
            '• Drag the <strong>header</strong> to move a container, drag the <strong>bottom-right corner</strong> to resize<br><br>' +
            'Your DEMO container is a good starting point — try clicking some patches!',
    },
    {
        id: 'pianoroll',
        title: 'Piano Roll',
        highlight: '#piano-dock .dock-tabs',
        noBlur: true,
        illustration: null,
        description:
            'The <strong>Piano Roll</strong> lets you draw note sequences using the voices from your voice bank.<br><br>' +
            '<strong>Getting started:</strong><br>' +
            '1. Assign patches from a container using the <strong>♫</strong> button (up to 8 voices)<br>' +
            '2. Select a voice in the voice bank on the left — its notes are fully opaque<br>' +
            '3. <strong>Click+drag</strong> on the grid to draw notes (snaps to pitch and timing)<br>' +
            '4. <strong>Double-click</strong> a note to remove it<br>' +
            '5. <strong>Drag</strong> a note to move it<br>' +
            '6. Press <strong>▶ Play</strong> to hear the sequence<br><br>' +
            'Notes from other voices appear dimmed. Only the selected voice\'s notes can be edited.',
    },
    {
        id: 'edit',
        title: 'Edit Patches',
        highlight: '#piano-dock .dock-tab:nth-child(3)',
        selectTab: '#piano-dock .dock-tab:nth-child(3)',
        clickElement: '.sky-container .patch-edit-btn',
        noBlur: true,
        illustration: null,
        description:
            'The <strong>Edit</strong> tab lets you morph, tweak, and mutate patches.<br><br>' +
            '<strong>Morph</strong> — Blend two patches together. Assign patch <strong>A</strong> and <strong>B</strong> from the canvas (🔧 button), then slide the morph distance to find the sweet spot.<br><br>' +
            '<strong>Params</strong> — View and modify individual DX7 parameters of a single patch.<br><br>' +
            '<strong>Random</strong> — Generate mutations of a patch with adjustable mutation strength. Great for exploring new sounds near a known good patch.<br><br>' +
            'Use the <strong>🔧</strong> button on any canvas patch to load it into the Edit tab.',
    },
    // Future steps:
    // { id: 'export', title: 'Export .SYX', openMenu: 'file', ... },
];

let currentStep = 0;
let active = false;

export function isTutorialActive() {
    return active;
}

export function startTutorial() {
    if (localStorage.getItem(STORAGE_KEY)) return;
    if (document.querySelectorAll('.menu-item.open').length > 0) return;
    currentStep = 0;
    active = true;
    showStep(currentStep);
}

export function skipTutorial() {
    localStorage.setItem(STORAGE_KEY, 'skipped');
    hide();
}

export function restartTutorial() {
    localStorage.removeItem(STORAGE_KEY);
    currentStep = 0;
    active = true;
    showStep(currentStep);
}

function completeTutorial() {
    localStorage.setItem(STORAGE_KEY, 'completed');
    hide();
}

function showStep(index) {
    const step = STEPS[index];
    if (!step) { completeTutorial(); return; }

    const modal = document.getElementById('tutorial-modal');
    document.getElementById('tutorial-title').textContent = step.title;
    document.getElementById('tutorial-description').innerHTML = step.description;
    document.getElementById('tutorial-step-indicator').textContent =
        'Step ' + (index + 1) + ' of ' + STEPS.length;

    // Illustration
    const illust = document.getElementById('tutorial-illustration');
    if (step.illustration) {
        illust.innerHTML = step.illustration;
        illust.style.display = '';
    } else {
        illust.innerHTML = '<div class="tutorial-illustration-placeholder">\uD83D\uDCCA</div>';
        illust.style.display = '';
    }

    // Clear previous state
    clearHighlights();

    // Blur page content (unless step opts out — e.g. canvas steps)
    var pageContent = document.getElementById('page-content');
    if (pageContent && !step.noBlur) pageContent.classList.add('page-blurred');

    // Lift menu bar above the overlay
    var menuBar = document.querySelector('.menu-bar');
    if (menuBar) menuBar.classList.add('tutorial-highlight');

    // Open menu if specified
    if (step.openMenu) {
        var menuItem = document.querySelector('.menu-item[data-menu="' + step.openMenu + '"]');
        if (menuItem) {
            menuItem.classList.add('open');
            menuItem.dataset.tutorialOpen = '1';
        }
    }

    // Select tab if specified (e.g. activate Edit tab in toolbar)
    if (step.selectTab) {
        var tab = document.querySelector(step.selectTab);
        if (tab) tab.click();
    }

    // Click an element if specified (e.g. open a patch in Edit slot)
    if (step.clickElement) {
        var clickTarget = document.querySelector(step.clickElement);
        if (clickTarget) clickTarget.click();
    }

    // Highlight target element (with fallback)
    var highlightTarget = null;
    var usedFallback = false;
    if (step.highlight) {
        highlightTarget = document.querySelector(step.highlight);
        if (!highlightTarget && step.fallbackHighlight) {
            highlightTarget = document.querySelector(step.fallbackHighlight);
            usedFallback = true;
        }
    }

    // Cut a hole in the overlay around the highlighted element (skip on mobile)
    var isMobile = window.innerWidth <= 600;
    if (highlightTarget && !isMobile) {
        var rect = highlightTarget.getBoundingClientRect();
        var pad = 6;
        var lx = ((rect.left - pad) / window.innerWidth * 100).toFixed(2);
        var ly = ((rect.top - pad) / window.innerHeight * 100).toFixed(2);
        var rx = ((rect.right + pad) / window.innerWidth * 100).toFixed(2);
        var ry = ((rect.bottom + pad) / window.innerHeight * 100).toFixed(2);

        // Polygon: outer rectangle (clockwise) + inner hole (counter-clockwise)
        var clip = 'polygon(' +
            '0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ' +
            lx + '% ' + ly + '%, ' +
            lx + '% ' + ry + '%, ' +
            rx + '% ' + ry + '%, ' +
            rx + '% ' + ly + '%, ' +
            lx + '% ' + ly + '%)';
        modal.style.clipPath = clip;

        // Also add a glow border around the cutout
        highlightTarget.classList.add('tutorial-highlight');
    } else {
        modal.style.clipPath = '';
        if (highlightTarget && !isMobile) highlightTarget.classList.add('tutorial-highlight');
    }

    // Position modal relative to highlight target (skip container-based positioning on mobile)
    var dialog = modal.querySelector('.tutorial-dialog');
    if (dialog) {
        dialog.classList.remove('tutorial-centered');
        dialog.style.margin = '';

        if (isMobile || usedFallback || !highlightTarget) {
            dialog.classList.add('tutorial-centered');
        } else if (highlightTarget.classList.contains('sky-container')) {
            var rect = highlightTarget.getBoundingClientRect();
            var screenCenter = window.innerWidth / 2;
            var containerCenter = rect.left + rect.width / 2;

            if (containerCenter < screenCenter) {
                dialog.style.margin = '48px 0 0 ' + (rect.right + 16) + 'px';
            } else {
                dialog.style.margin = '48px 0 0 ' + Math.max(8, rect.left - 436) + 'px';
            }
        }
    }

    // Update nav buttons
    var nextBtn = document.getElementById('tutorial-next');
    nextBtn.textContent = index < STEPS.length - 1 ? 'Next \u2192' : 'Got it!';

    modal.style.display = '';
}

function hide() {
    active = false;
    var modal = document.getElementById('tutorial-modal');
    modal.style.display = 'none';
    clearHighlights();
}

function clearHighlights() {
    // Reset overlay clip-path
    var modal = document.getElementById('tutorial-modal');
    if (modal) modal.style.clipPath = '';

    // Remove blur from page content
    var pageContent = document.getElementById('page-content');
    if (pageContent) pageContent.classList.remove('page-blurred');

    // Remove menu bar highlight
    var menuBar = document.querySelector('.menu-bar');
    if (menuBar) menuBar.classList.remove('tutorial-highlight');

    // Remove highlight from all highlighted elements
    document.querySelectorAll('.tutorial-highlight').forEach(function(el) {
        el.classList.remove('tutorial-highlight');
    });

    // Close menus we opened (but not ones the user opened manually)
    document.querySelectorAll('.menu-item').forEach(function(el) {
        if (el.dataset.tutorialOpen) {
            el.classList.remove('open');
            delete el.dataset.tutorialOpen;
        }
    });
}

export function initTutorial() {
    document.getElementById('tutorial-close').addEventListener('click', skipTutorial);
    document.getElementById('tutorial-skip').addEventListener('click', skipTutorial);
    document.getElementById('tutorial-next').addEventListener('click', function() {
        currentStep++;
        if (currentStep >= STEPS.length) {
            completeTutorial();
        } else {
            showStep(currentStep);
        }
    });

    // Click outside modal dismisses
    document.getElementById('tutorial-modal').addEventListener('click', function(e) {
        if (e.target === e.currentTarget) skipTutorial();
    });
}
