/* Tiny dev helper: accepts POST /upload?name=file.mp4 from the browser and writes it to tests/out/. Not part of the app. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const PORT = 8766;
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.method === 'POST' && req.url.startsWith('/upload')) {
    const name = path.basename(new URL(req.url, 'http://x').searchParams.get('name') || 'out.bin');
    const file = path.join(outDir, name);
    const ws = fs.createWriteStream(file);
    req.pipe(ws);
    ws.on('finish', () => { res.end(JSON.stringify({ ok: true, file, size: fs.statSync(file).size })); });
    return;
  }
  res.statusCode = 404; res.end('not found');
}).listen(PORT, '127.0.0.1', () => console.log('upload server on ' + PORT + ' -> ' + outDir));
