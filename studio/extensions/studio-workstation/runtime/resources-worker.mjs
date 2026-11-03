import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runDatabaseHostRequest } from './database-host.mjs';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) { chunks.push(chunk); }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const write = process.stdout.write.bind(process.stdout);
  console.log = console.error;
  try {
    const value = await runDatabaseHostRequest(request);
    write(`${JSON.stringify({ value })}\n`);
  } catch (error) {
    const message = String(error.message).replaceAll(request.connection?.accessToken || '\0', '[redacted]');
    write(`${JSON.stringify({ error: message, status: error.status, source: error.source, sources: error.sources })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) { await main(); }
