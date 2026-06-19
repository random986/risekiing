import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /oauth2\/auth/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 10) {
  count++;
  console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
  const sub = content.substring(match.index - 500, match.index + 1000);
  console.log(sub.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}
