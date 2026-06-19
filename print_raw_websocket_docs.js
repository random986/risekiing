import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const target = 'options/websocket';
let pos = 0;
let count = 0;
while (true) {
  pos = content.indexOf(target, pos);
  if (pos === -1) break;
  count++;
  console.log(`\n=== Match ${count} at position ${pos} ===`);
  const rawChunk = content.substring(pos - 1000, pos + 8000);
  console.log(rawChunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  pos += target.length;
}
