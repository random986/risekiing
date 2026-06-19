import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const pos = 8000;
const chunk = content.substring(pos, pos + 4000);
console.log(chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
