import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const target = 'authorize';
let pos = 0;
let count = 0;
while (true) {
  pos = content.indexOf(target, pos);
  if (pos === -1) break;
  count++;
  if (count < 20) {
    console.log(`\n=== Match ${count} at position ${pos} ===`);
    console.log(content.substring(pos - 150, pos + 400).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }
  pos += target.length;
}
console.log(`Total occurrences: ${count}`);
