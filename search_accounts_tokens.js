import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

// Find options/accounts and look for any text containing "token" within 5000 characters after it.
const target = 'trading/v1/options/accounts';
let pos = 0;
let count = 0;
while (true) {
  pos = content.indexOf(target, pos);
  if (pos === -1) break;
  count++;
  console.log(`\n=== Match ${count} at position ${pos} ===`);
  const chunk = content.substring(pos, pos + 5000);
  const regex = /token|oauth|session|auth/gi;
  let m;
  while ((m = regex.exec(chunk)) !== null) {
    console.log(`  Found keyword "${m[0]}" at relative pos ${m.index}:`);
    console.log(`    ${chunk.substring(m.index - 50, m.index + 150).replace(/\s+/g, ' ').trim()}`);
  }
  pos += target.length;
  if (count >= 2) break;
}
