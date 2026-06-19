import fs from 'fs';
import readline from 'readline';

async function searchEarly() {
  const fileStream = fs.createReadStream('C:\\\\Users\\\\User\\\\.gemini\\\\antigravity\\\\brain\\\\8489707d-58e9-4e64-adc0-353b1df44c5f\\\\.system_generated\\\\logs\\\\transcript.jsonl');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  
  let lineCount = 0;
  for await (const line of rl) {
    lineCount++;
    if (line.includes('33h51PQlu5tsWflEmmoxW')) {
      console.log(`\nLine ${lineCount}:`);
      console.log(line.substring(0, 1000));
      // break; // print first occurrence
    }
  }
}

searchEarly();
