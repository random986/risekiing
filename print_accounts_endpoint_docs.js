import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const target = 'options/accounts';
let pos = 0;
let count = 0;
while (true) {
  pos = content.indexOf(target, pos);
  if (pos === -1) break;
  count++;
  console.log(`\n=== Match ${count} at position ${pos} ===`);
  const chunk = content.substring(pos - 100, pos + 2500);
  console.log(chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  pos += target.length;
  if (count >= 4) break;
}
