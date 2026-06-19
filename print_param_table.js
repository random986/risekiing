import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const pos = 4453;
const chunk = content.substring(pos - 100, pos + 4000);
console.log(chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
