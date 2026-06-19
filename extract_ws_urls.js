import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /wss:\/\/ws\.derivws\.com[^\s"']*/gi;
let match;
while ((match = regex.exec(content)) !== null) {
  console.log(match[0]);
}
