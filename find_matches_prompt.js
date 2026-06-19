import fs from 'fs';
import path from 'path';

const logPath = 'C:\\Users\\User\\.gemini\\antigravity\\brain\\8dc75495-f862-4600-bb03-032f9e1d66ff\\.system_generated\\logs\\transcript.jsonl';

const lines = fs.readFileSync(logPath, 'utf8').split('\n');
console.log(`Total lines: ${lines.length}`);

let userInputs = [];
lines.forEach((line, idx) => {
  if (!line.trim()) return;
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'USER_INPUT') {
      userInputs.push({ index: idx, content: obj.content });
    }
  } catch (e) {
    // Ignore malformed json
  }
});

console.log("--- USER INPUTS ---");
userInputs.forEach((input, i) => {
  console.log(`\n[Input #${i}] Line ${input.index}:\n${input.content}`);
});
