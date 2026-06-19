import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('Bearer') || line.includes('access_token') || line.includes('token')) {
    if (i > 0 && lines[i-1].includes('authorize')) {
      console.log(`Line ${i}:`, lines[i-1].substring(0, 100), '...', line.substring(0, 100));
    }
  }
}

// Let's do a wider search for token usage
console.log('--- WIDER SEARCH ---');
const regex = /(ws:\/\/|wss:\/\/).*?websockets\/v3/g;
let match;
while ((match = regex.exec(content)) !== null) {
  console.log(content.substring(match.index - 200, match.index + 800).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}
