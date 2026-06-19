import fs from 'fs';
import path from 'path';

const logPath = path.join(process.cwd(), 'derivprinter_audit_log.txt');
const lines = fs.readFileSync(logPath, 'utf8').split('\n');
console.log(`Total lines in audit log: ${lines.length}`);
console.log("--- Tail of audit log ---");
lines.slice(-30).forEach(l => console.log(l));
