import fs from 'fs';
import readline from 'readline';

async function searchTranscript() {
  const fileStream = fs.createReadStream('C:\\\\Users\\\\User\\\\.gemini\\\\antigravity\\\\brain\\\\8489707d-58e9-4e64-adc0-353b1df44c5f\\\\.system_generated\\\\logs\\\\transcript.jsonl');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  
  let count = 0;
  for await (const line of rl) {
    if (line.includes('redirect_uri') || line.includes('redirectUri')) {
      // Find where redirect_uri is defined in code blocks
      if (line.includes('const redirect') || line.includes('redirect_uri:')) {
        count++;
        console.log(`\n=== Match ${count} ===`);
        console.log(line.substring(0, 1000));
      }
    }
  }
}

searchTranscript();
