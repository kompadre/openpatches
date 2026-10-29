const fs = require('fs');

// Read your sysex file
const buffer = fs.readFileSync('DEMO.syx');

// DX7 bulk data bytes start at index 6 (after F0 43 00 09 20 00)
// and run up to the second-to-last byte (before F7)
const dataBytes = buffer.subarray(6, buffer.length - 2);

// Sum all data bytes
let sum = 0;
for (let i = 0; i < dataBytes.length; i++) {
    sum += dataBytes[i];
}

// Yamaha 7-bit two's complement checksum formula
const checksum = (-sum) & 0x7F;

console.log(`Current file checksum byte: 0x${buffer[buffer.length - 2].toString(16)}`);
console.log(`Calculated correct checksum: 0x${checksum.toString(16)}`);

// Overwrite the checksum byte (second to last byte)
buffer[buffer.length - 2] = checksum;

// Save out a corrected file
fs.writeFileSync('DEMO_fixed.syx', buffer);
console.log('Saved DEMO_fixed.syx! Try loading this one into Synthmata.');
