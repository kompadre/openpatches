// Client-side DX7 .syx parser
// Parses a DX7 SysEx bulk dump (4104 bytes) and extracts 32 voice patches.

// DX7 32-voice bulk dump: F0 43 0n 09 20 00 <4096 packed> <checksum> F7
const BULK_HEADER_LEN = 6;
const BULK_DATA_LEN = 4096;
const BULK_FORMAT_32_VOICES = 0x09;

// Same formula as syx-builder's sysexChecksum: two's complement of the
// 7-bit sum of the data bytes.
function bankChecksum(view, start, len) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += view.getUint8(start + i);
    return (128 - (sum & 0x7F)) & 0x7F;
}

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

    // Format byte: 0x09 = 32-voice bank. A single-voice dump (0x00) or a
    // DX7II supplement (0x06) would otherwise be sliced into 32 garbage voices.
    const format = view.getUint8(3);
    if (format !== BULK_FORMAT_32_VOICES) {
        console.warn(`Not a DX7 32-voice bank (format byte 0x${format.toString(16)}, expected 0x09)`);
        return null;
    }

    // Checksum covers the 4096 data bytes. A mismatch is reported but not
    // fatal: hand-edited and hex-patched banks in the wild often carry a
    // stale checksum and the voices themselves are fine.
    const expected = bankChecksum(view, BULK_HEADER_LEN, BULK_DATA_LEN);
    const actual = view.getUint8(BULK_HEADER_LEN + BULK_DATA_LEN);
    const checksumOk = expected === actual;
    if (!checksumOk) {
        console.warn(`.syx checksum mismatch: file 0x${actual.toString(16)}, computed 0x${expected.toString(16)}`);
    }

    const patches = [];
    for (let slot = 0; slot < 32; slot++) {
        const offset = BULK_HEADER_LEN + slot * 128;
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

    patches.checksumOk = checksumOk;
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
