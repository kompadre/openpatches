// MIDI device profiles — what differs between the DX7-compatible synths we
// talk to, and how to tell them apart.
//
// Everything speaks the DX7 SysEx dialect (32-voice bank = format 9, single
// voice = format 0), which is why one transport serves them all. What varies
// is around the edges: whether the device answers a dump request at all,
// whether it can be dumped at all, whether a memory-protect switch has to
// be flipped first, what a bank dump actually overwrites, and a few things
// that matter for playback (polyphony, velocity). Those differences live
// here as data so the transport and the UI can ask instead of guessing.
//
// A profile is picked explicitly in MIDI › Devices, or auto-detected from
// the output port's name. The 'generic' profile is the DX7-dialect baseline
// for anything unrecognised: optimistic (tries the dump request) and verbose
// (shows every hint), which is the right posture for an unknown synth.

/**
 * @typedef {object} DeviceProfile
 * @property {string} id
 * @property {string} name            Short name for the select box.
 * @property {string} family          'yamaha' | 'software' | 'korg' | 'unknown'
 * @property {string[]} aliases       Other hardware this profile fits.
 * @property {number} programCount    Voice slots a bank dump lands in.
 * @property {number|null} polyphony  null = unknown.
 * @property {'full'|'ignored'} velocity
 * @property {boolean} multitimbral   Can address several channels at once.
 * @property {{supported: boolean, strategy: 'bulk'|'guided', target: string, memoryProtect: string|null}} bankSend
 *   strategy 'bulk' = one 4104-byte dump; 'guided' = one voice at a time
 *   through the edit buffer, the user saving each on the device.
 * @property {{supported: boolean, dumpRequest: boolean, manualHint: string|null, reason: string|null}} bankReceive
 * @property {string} editBufferNote  What a single-voice dump does on this device.
 * @property {string} sysexChannelNote
 * @property {string[]} notes         Free-form, shown in the settings modal.
 */

const DX7_FRONT_PANEL = 'On a DX7 Mk I, start the transfer from the front panel: ' +
    'Function › 8 › MIDI › Transmit (Sys Info Avail must be on).';

/** @type {Record<string, DeviceProfile>} */
export const DEVICE_PROFILES = {
    generic: {
        id: 'generic',
        name: 'Generic DX7-compatible',
        family: 'unknown',
        aliases: [],
        programCount: 32,
        polyphony: null,
        velocity: 'full',
        multitimbral: false,
        bankSend: {
            supported: true,
            strategy: 'bulk',
            target: 'all 32 voices in the device’s bank memory',
            memoryProtect: 'If the synth has a memory protect switch, turn it off first; ' +
                'with protection on the dump is ignored silently.',
        },
        bankReceive: {
            supported: true,
            dumpRequest: true,
            manualHint: 'If nothing arrives, the synth may not answer dump requests — ' +
                'start the transfer from its own front panel.',
            reason: null,
        },
        editBufferNote: 'A single-voice dump goes to the edit buffer and plays immediately.',
        sysexChannelNote: 'Set Device channel to the synth’s SysEx (basic) channel.',
        notes: ['Unrecognised device: assumes the plain DX7 SysEx dialect and tries everything.'],
    },

    dx7: {
        id: 'dx7',
        name: 'Yamaha DX7 (Mk I)',
        family: 'yamaha',
        aliases: ['DX7', 'TX7'],
        programCount: 32,
        polyphony: 16,
        velocity: 'full',
        multitimbral: false,
        bankSend: {
            supported: true,
            strategy: 'bulk',
            target: 'all 32 internal voices',
            memoryProtect: 'Turn memory protect off first: Function › Memory Protect › Internal: OFF. ' +
                'With protection on the DX7 ignores the dump silently.',
        },
        bankReceive: {
            supported: true,
            // The Mk I does not implement dump requests at all.
            dumpRequest: false,
            manualHint: DX7_FRONT_PANEL,
            reason: null,
        },
        editBufferNote: 'A single-voice dump replaces the edit buffer (the voice being played), ' +
            'not any stored voice.',
        sysexChannelNote: 'Device channel = the DX7’s MIDI receive channel; SysEx is only accepted ' +
            'while Sys Info Avail is on.',
        notes: [
            'Does not answer dump requests: bank backups are started from the front panel.',
            'Memory protect must be off before a bank can be written.',
            '16-voice polyphonic, one channel.',
        ],
    },

    dx7ii: {
        id: 'dx7ii',
        name: 'Yamaha DX7 II / DX7s / TX802',
        family: 'yamaha',
        aliases: ['DX7 II-D', 'DX7 II-FD', 'DX7s', 'TX802'],
        programCount: 32,
        polyphony: 16,
        velocity: 'full',
        multitimbral: false,
        bankSend: {
            supported: true,
            strategy: 'bulk',
            target: 'the 32 voices of the selected internal bank',
            memoryProtect: 'Turn memory protect off first (Edit › Utility › Memory Protect), ' +
                'or the dump is ignored.',
        },
        bankReceive: {
            supported: true,
            dumpRequest: true,
            manualHint: 'If nothing arrives, check that System Exclusive is enabled in the MIDI ' +
                'utility pages and that Device channel matches the synth.',
            reason: null,
        },
        editBufferNote: 'A single-voice dump goes to the edit buffer. The II-series’ extra ' +
            'parameters (ACED) are left at their defaults.',
        sysexChannelNote: 'Device channel = the synth’s basic receive channel.',
        notes: [
            'Answers dump requests, so backups run unattended.',
            'Only the classic 32-voice format is exchanged; II-series performance data is not touched.',
            'Memory protect must be off before a bank can be written.',
        ],
    },

    dexed: {
        id: 'dexed',
        name: 'Dexed',
        family: 'software',
        aliases: ['Dexed (plugin or standalone)'],
        programCount: 32,
        polyphony: 16,
        velocity: 'full',
        multitimbral: false,
        bankSend: {
            supported: true,
            strategy: 'bulk',
            target: 'the 32 programs of the currently loaded cartridge (in memory, not on disk until you save it in Dexed)',
            memoryProtect: null,
        },
        bankReceive: {
            supported: false,
            dumpRequest: false,
            manualHint: null,
            reason: 'Dexed does not answer dump requests or transmit banks over MIDI. ' +
                'Save the cartridge from Dexed’s own Cart manager instead.',
        },
        editBufferNote: 'A single-voice dump replaces the current program and is heard immediately.',
        sysexChannelNote: 'Device channel must match Dexed’s SysEx channel setting.',
        notes: [
            'Receives banks and single voices; cannot be dumped from here.',
            'No memory protect: a bank dump replaces the loaded cartridge at once.',
        ],
    },

    volcafm: {
        id: 'volcafm',
        name: 'Korg volca fm',
        family: 'korg',
        aliases: ['volca fm'],
        programCount: 32,
        polyphony: 3,
        velocity: 'ignored',
        multitimbral: false,
        bankSend: {
            supported: true,
            // A single 4104-byte bulk dump is not in the volca's MIDI
            // implementation chart and did not land in testing — either the
            // CPU cannot drain it at wire speed or it is simply ignored. So
            // voices go one at a time through the edit buffer, the user
            // saving each on the device between steps.
            strategy: 'guided',
            target: 'one voice at a time, each saved by hand on the volca',
            memoryProtect: null,
        },
        bankReceive: {
            supported: false,
            dumpRequest: false,
            manualHint: null,
            reason: 'The volca fm receives DX7 voices but never transmits them, so its programs ' +
                'cannot be backed up from here.',
        },
        editBufferNote: 'A single-voice dump replaces the current program’s sound until another ' +
            'program is selected or it is saved on the volca.',
        sysexChannelNote: 'Device channel = the volca’s MIDI channel.',
        notes: [
            'Receive-only: its programs cannot be backed up from here.',
            'Bank sends are guided, one voice at a time — save each on the volca when asked.',
            '3-voice polyphonic — busy piano-roll parts will steal voices.',
            'Ignores note velocity (the fm2 does not).',
        ],
    },

    volcafm2: {
        id: 'volcafm2',
        name: 'Korg volca fm2 (mk2)',
        family: 'korg',
        aliases: ['volca fm2', 'volca fm mk2'],
        programCount: 64,
        polyphony: 6,
        // The fm2 added velocity response over the original.
        velocity: 'full',
        multitimbral: false,
        bankSend: {
            supported: true,
            // Same story as the original: no bulk dump in the manual, none
            // in testing (reported from a real mk2) — guided it is.
            strategy: 'guided',
            target: 'one voice at a time, each saved by hand on the volca',
            memoryProtect: null,
        },
        bankReceive: {
            supported: false,
            dumpRequest: false,
            manualHint: null,
            reason: 'The volca fm2 receives DX7 voices but never transmits them, so its programs ' +
                'cannot be backed up from here.',
        },
        editBufferNote: 'A single-voice dump replaces the current program’s sound until another ' +
            'program is selected or it is saved on the volca.',
        sysexChannelNote: 'Device channel = the volca’s MIDI channel.',
        notes: [
            'Receive-only: its programs cannot be backed up from here.',
            'Bank sends are guided, one voice at a time — save each on the volca when asked.',
            '6-voice polyphonic, 64 program slots.',
            'Responds to note velocity (the original volca fm does not).',
        ],
    },
};

export const DEVICE_TYPE_AUTO = 'auto';

/** Ids in the order the settings select shows them (auto first). */
export function listDeviceTypes() {
    return [DEVICE_TYPE_AUTO, 'dx7', 'dx7ii', 'dexed', 'volcafm', 'volcafm2', 'generic'];
}

export function isDeviceType(id) {
    return id === DEVICE_TYPE_AUTO || Object.prototype.hasOwnProperty.call(DEVICE_PROFILES, id);
}

// Most specific first: "DX7II" also contains "DX7".
const DETECT_RULES = [
    // No word boundary after II/2: "DX7 IIFD" and "DX7IID" are real names.
    ['dx7ii', /dx7\s*-?\s*(ii|2)|dx7s\b|tx802/i],
    ['dx7', /\bdx\s*-?7\b|\btx7\b/i],
    ['dexed', /dexed/i],
    // fm2 before fm: "volca fm2" also contains "volca fm".
    ['volcafm2', /volca\s*-?\s*fm\s*-?\s*(2|mk\s*-?\s*(ii|2))/i],
    ['volcafm', /volca\s*-?\s*fm/i],
];

/**
 * Guess a profile id from a port name. Falls back to 'generic'.
 * @param {string|null|undefined} portName
 */
export function detectDeviceType(portName) {
    const name = String(portName || '');
    for (const [id, re] of DETECT_RULES) {
        if (re.test(name)) return id;
    }
    return 'generic';
}

/** Profile for an id; unknown ids resolve to generic rather than throwing. */
export function getProfile(id) {
    return DEVICE_PROFILES[id] || DEVICE_PROFILES.generic;
}
