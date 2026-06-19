import fs from 'fs';

const logPath = 'C:\\Users\\User\\.gemini\\antigravity\\brain\\8dc75495-f862-4600-bb03-032f9e1d66ff\\.system_generated\\logs\\transcript.jsonl';

if (!fs.existsSync(logPath)) {
  console.log("transcript.jsonl does not exist");
  process.exit(0);
}

const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n');
console.log(`transcript.jsonl lines: ${lines.length}`);

let count = 0;
lines.forEach((line, idx) => {
  if (!line.trim()) return;
  if (line.toLowerCase().includes('matches') || line.toLowerCase().includes('guiding')) {
    count++;
    console.log(`\n--- Match #${count} at Line ${idx} ---`);
    try {
      const obj = JSON.parse(line);
      // Print first 500 chars of content or tool calls to avoid cluttering
      if (obj.content) {
        console.log(`Type: ${obj.type}, Source: ${obj.source}`);
        console.log(`Content (truncated): ${obj.content.substring(0, 1000)}`);
      } else if (obj.tool_calls) {
        console.log(`Tool Calls: ${JSON.stringify(obj.tool_calls).substring(0, 1000)}`);
      } else {
        console.log(`Raw (truncated): ${line.substring(0, 1000)}`);
      }
    } catch (e) {
      console.log(`Raw (truncated): ${line.substring(0, 1000)}`);
    }
  }
});
