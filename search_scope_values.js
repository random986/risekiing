import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /scope/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 20) {
  count++;
  console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
  const sub = content.substring(match.index - 200, match.index + 300);
  console.log(sub.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}
