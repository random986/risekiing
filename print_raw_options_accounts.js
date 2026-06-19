import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const target = 'options/accounts';
const pos = content.indexOf(target);
if (pos !== -1) {
  console.log('Found match at pos:', pos);
  const rawChunk = content.substring(pos - 500, pos + 4000);
  console.log(rawChunk);
} else {
  console.log('Target not found');
}
