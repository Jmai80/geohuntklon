// Visar sidorna i mappen docs på http://localhost:3000 när du vill testa på datorn.
// Kör med:  npm start
// Databasen ligger i Supabase, så den här servern visar bara filerna.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAPP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');
const PORT = Number(process.env.PORT) || 3000;
const TYPER = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

http
  .createServer(async (req, res) => {
    try {
      let sokvag = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (sokvag.endsWith('/')) sokvag += 'index.html';
      const fil = path.normalize(path.join(MAPP, sokvag));
      if (!fil.startsWith(MAPP + path.sep)) throw new Error('utanför mappen');
      const info = await stat(fil);
      if (info.isDirectory()) {
        res.writeHead(301, { Location: sokvag + '/' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': TYPER[path.extname(fil)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      createReadStream(fil).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Sidan finns inte.');
    }
  })
  .listen(PORT, () => {
    console.log(`\nElev:    http://localhost:${PORT}\nLärare:  http://localhost:${PORT}/larare.html\n\nStoppa med Ctrl+C.\n`);
  });
