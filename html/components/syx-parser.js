// Client-side DX7 .syx parser
// Parses a DX7 SysEx bulk dump (4104 bytes) and extracts 32 voice patches.

// parseSyxFile reads an ArrayBuffer and returns an array of 32 voice patches.
// Each patch has: name, algorithm, feedback, ops[6], raw (128 bytes).
// Returns null if the file is not a valid DX7 .syx.
export function parseSyxFile(arrayBuffer) {
    const view = new DataView(arrayBuffer);

    // Minimum size: 6 header + 4096 bank + 1 checksum + 1 end = 4104
    if (arrayBuffer.byteLength < 4104) {
        console.warn('.syx file too small:', arrayBuffer.byteLength);
        return null;
    }

    // Check SysEx start
    if (view.getUint8(0) !== 0xF0) {
        console.warn('Not a SysEx file (missing 0xF0 header)');
        return null;
    }

    // Check Yamaha DX7 signature
    if (view.getUint8(1) !== 0x43) {
        console.warn('Not a Yamaha SysEx file');
        return null;
    }

    const patches = [];
    for (let slot = 0; slot < 32; slot++) {
        const offset = 6 + slot * 128;
        const raw = new Uint8Array(arrayBuffer, offset, 128);

        // Extract voice name (bytes 118-127)
        let name = '';
        for (let i = 118; i < 128; i++) {
            const ch = raw[i];
            if (ch === 0) break;
            name += String.fromCharCode(ch);
        }
        name = name.trimEnd();

        // Extract algorithm (byte 110, bits 0-4)
        const algorithm = raw[110] & 0x1F;

        // Extract feedback (byte 111, bits 0-2)
        const feedback = raw[111] & 0x07;

        // Extract operator parameters
        const ops = [];
        for (let op = 0; op < 6; op++) {
            const base = op * 17;
            ops.push({
                rate1: raw[base + 0],
                rate2: raw[base + 1],
                rate4: raw[base + 3],
                level3: raw[base + 6],
                outputLevel: raw[base + 14],
                mode: raw[base + 15] & 1,
                freqCoarse: (raw[base + 15] >> 1) & 0x1F,
                freqFine: raw[base + 16],
            });
        }

        patches.push({
            slot,
            name: name || `Voice ${slot + 1}`,
            algorithm,
            feedback,
            ops,
            raw: Array.from(raw), // store as plain array for JSON serialization
        });
    }

    return patches;
}

// decodeVoiceDataToBase64 converts a raw 128-byte patch array to base64 string.
export function voiceRawToBase64(raw) {
    let binary = '';
    for (let i = 0; i < raw.length; i++) {
        binary += String.fromCharCode(raw[i]);
    }
    return btoa(binary);
}
