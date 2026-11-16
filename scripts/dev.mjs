// `npm run dev`: pick free ports for the server and the web UI once, up front,
// then run both. The ports are fixed for the whole run so a `tsx watch` restart
// keeps its port and the Vite proxy keeps pointing at it.
import { createServer } from 'node:net';
import concurrently from 'concurrently';

// A port only counts as free if nothing listens on it on any of these. On macOS
// binding `::` succeeds even when another app holds 127.0.0.1, which would
// silently shadow that app on localhost.
const HOSTS = ['127.0.0.1', '0.0.0.0', '::1', '::'];

function freeOn(port, host) {
  return new Promise((resolve) => {
    const srv = createServer();
    // Only EADDRINUSE/EACCES mean taken; e.g. EADDRNOTAVAIL means no IPv6 here.
    srv.once('error', (e) => resolve(e.code !== 'EADDRINUSE' && e.code !== 'EACCES'));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

async function findFreePort(start, skip = []) {
  for (let p = start; p < start + 100; p++) {
    if (skip.includes(p)) continue;
    let free = true;
    for (const h of HOSTS) if (!(free = await freeOn(p, h))) break;
    if (free) return p;
  }
  throw new Error(`no free port in ${start}-${start + 99}`);
}

const serverPort = await findFreePort(Number(process.env.PORT ?? 4010));
const webPort = await findFreePort(Number(process.env.STEFFE_WEB_PORT ?? 3000), [serverPort]);

console.log(`steffe: server on :${serverPort}, web on http://localhost:${webPort}`);

const env = {
  PORT: String(serverPort),
  STEFFE_SERVER: `http://localhost:${serverPort}`,
  STEFFE_WEB_PORT: String(webPort),
};

const { result } = concurrently(
  [
    { command: 'npm run dev --workspace=@steffe/server', name: 'server', env },
    { command: 'npm run dev --workspace=@steffe/web', name: 'web', env },
  ],
  // raw: tsx watch never started under prefixed output.
  { killOthersOn: ['failure', 'success'], raw: true },
);
result.then(
  () => process.exit(0),
  () => process.exit(1),
);
