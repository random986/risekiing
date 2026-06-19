import fs from 'fs';
import readline from 'readline';

async function searchAuditLog() {
  const fileStream = fs.createReadStream('derivprinter_audit_log.txt');
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  console.log("Searching audit log...");
  let count = 0;
  for await (const line of rl) {
    if (line.toLowerCase().includes('token') || line.toLowerCase().includes('pkce') || line.toLowerCase().includes('oauth')) {
      count++;
      if (count < 100) {
        console.log(`[Match ${count}]: ${line.trim()}`);
      }
    }
  }
  console.log(`Total matches: ${count}`);
}

searchAuditLog();
