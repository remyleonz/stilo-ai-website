const http = require('http');
const fs = require('fs');
const path = require('path');

// Load env from .env.local so /api handlers see Supabase/Stripe keys locally.
try {
  const envFile = path.join(__dirname, '.env.local');
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(function (line) {
      var m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) return;
      var k = m[1];
      var v = m[2].replace(/^"|"$/g, '').replace(/^'|'$/g, '');
      if (!process.env[k]) process.env[k] = v;
    });
  }
} catch (e) { console.warn('[env] could not load .env.local:', e.message); }

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// Minimal Vercel-compatible wrapper: map POST JSON onto a handler signature.
// Enough to run the serverless handlers in `api/` during local dev.
function wrapHandler(handler) {
  return function (req, res) {
    // req gets `.body` set if content-type is JSON, matching Vercel.
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', function (c) { raw += c; });
    req.on('end', async function () {
      if (raw && (req.headers['content-type'] || '').indexOf('application/json') !== -1) {
        try { req.body = JSON.parse(raw); } catch (e) { req.body = {}; }
      }
      // Shim Vercel's res.status / res.json
      res.status = function (code) { res.statusCode = code; return res; };
      res.json = function (obj) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
        return res;
      };
      try { await handler(req, res); }
      catch (err) {
        console.error('[api] handler threw:', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Internal error', message: String(err.message || err) }));
        }
      }
    });
  };
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Route /api/<name> to api/<name>.js if the file exists.
  if (urlPath.indexOf('/api/') === 0) {
    const apiRel = urlPath.replace(/^\/+/, '').split('?')[0];
    const apiFile = path.join(__dirname, apiRel + '.js');
    if (fs.existsSync(apiFile)) {
      try {
        delete require.cache[require.resolve(apiFile)];
        const handler = require(apiFile);
        return wrapHandler(handler)(req, res);
      } catch (e) {
        console.error('[api] failed to load', apiFile, e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Handler load failed', message: String(e.message) }));
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found', path: urlPath }));
  }

  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath);

  // If no extension, try as directory with index.html
  if (!ext) {
    const dirIndex = path.join(filePath, 'index.html');
    if (fs.existsSync(dirIndex)) {
      filePath = dirIndex;
    } else if (fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    }
  }

  const resolvedExt = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[resolvedExt] || 'text/plain' });
    res.end(data);
  });
});
server.listen(8081, () => console.log('Server running on http://localhost:8081'));
