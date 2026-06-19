import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const target = 'step-5-use-token';
const pos = content.indexOf(target);
if (pos !== -1) {
  const chunk = content.substring(pos, pos + 3000);
  console.log(chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
} else {
  console.log('Target not found');
}
