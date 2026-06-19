import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /auth\.deriv\.com[^\s"']*/gi;
let match;
const found = new Set();
while ((match = regex.exec(content)) !== null) {
  found.add(match[0]);
}
console.log('Found auth.deriv.com URLs in scratch_results.txt:');
found.forEach(url => console.log('  ' + url));
