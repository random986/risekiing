import fs from 'fs';
import readline from 'readline';

async function searchTranscript() {
  const fileStream = fs.createReadStream('C:\\\\Users\\\\User\\\\.gemini\\\\antigravity\\\\brain\\\\8489707d-58e9-4e64-adc0-353b1df44c5f\\\\.system_generated\\\\logs\\\\transcript.jsonl');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'USER_INPUT') {
        console.log(`\n=== USER INPUT (Step ${obj.step_index}, Time ${obj.created_at}) ===`);
        console.log(obj.content);
      }
    } catch (e) {
      // Ignored
    }
  }
}

searchTranscript();
