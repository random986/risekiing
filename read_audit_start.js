import fs from 'fs';

const buf = fs.readFileSync('derivprinter_audit_log.txt');
console.log("Buffer length:", buf.length);
// Detect encoding or just print first 500 characters
console.log("First 500 bytes as hex:", buf.toString('hex', 0, 100));
console.log("First 500 characters as utf8:", buf.toString('utf8', 0, 500));
console.log("First 500 characters as utf16le:", buf.toString('utf16le', 0, 500));
