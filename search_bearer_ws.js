import fs from 'fs';

const content = fs.readFileSync('scratch_token_results.txt', 'utf8');

const regex = /ws\.derivws\.com/gi;
let match = regex.exec(content);
if (match) {
  console.log(`Found ws.derivws.com in scratch_token_results.txt at index ${match.index}`);
  console.log(content.substring(match.index - 500, match.index + 1500).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
} else {
  console.log('ws.derivws.com not found in scratch_token_results.txt');
}
