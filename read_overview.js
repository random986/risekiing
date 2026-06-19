import fs from 'fs';
import path from 'path';

const overviewPath = 'C:\\Users\\User\\.gemini\\antigravity\\brain\\8dc75495-f862-4600-bb03-032f9e1d66ff\\.system_generated\\logs\\overview.txt';

if (!fs.existsSync(overviewPath)) {
  console.log("overview.txt does not exist");
  process.exit(0);
}

const content = fs.readFileSync(overviewPath, 'utf8');
const lines = content.split('\n');
console.log(`overview.txt lines: ${lines.length}`);

let found = [];
lines.forEach((line, idx) => {
  if (line.toLowerCase().includes('match')) {
    found.push({ index: idx, line: line.trim() });
  }
});

console.log(`Found ${found.length} lines matching 'match':`);
found.forEach((f, i) => {
  if (i < 50) {
    console.log(`[Line ${f.index}]: ${f.line}`);
  }
});
