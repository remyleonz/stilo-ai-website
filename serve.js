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
    // Populate req.query from the URL search params (Vercel does this; raw node does not).
    // Preserve any pre-injected dynamic-route params (set by the router).
    const qIdx = (req.url || '').indexOf('?');
    if (qIdx >= 0) {
      const search = new URLSearchParams(req.url.slice(qIdx + 1));
      const parsed = {};
      for (const [k, v] of search) parsed[k] = v;
      req.query = Object.assign({}, parsed, req.query || {});
    } else {
      req.query = req.query || {};
    }
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

  // Route /api/<path> to the matching file. Resolution order matches Vercel:
  //   1. Exact file:        /api/foo            → api/foo.js
  //   2. Directory index:   /api/foo            → api/foo/index.js
  //   3. Dynamic segment:   /api/foo/abc-123    → api/foo/[id].js (parses :id)
  // This is needed because our /api/admin/deals routes split into
  // api/admin/deals/index.js + api/admin/deals/[id].js for Vercel.
  if (urlPath.indexOf('/api/') === 0) {
    const apiRel = urlPath.replace(/^\/+/, '').split('?')[0];
    const candidates = [
      { file: path.join(__dirname, apiRel + '.js'), params: null },
      { file: path.join(__dirname, apiRel, 'index.js'), params: null }
    ];
    // Dynamic [param] match: walk the path, look for a sibling [x].js whose
    // base name matches the directory pattern. e.g. /api/admin/deals/abc
    // looks at /api/admin/deals/ and finds [id].js there.
    try {
      const segs = apiRel.split('/');
      if (segs.length >= 2) {
        const parentDir = path.join(__dirname, ...segs.slice(0, -1));
        if (fs.existsSync(parentDir)) {
          const entries = fs.readdirSync(parentDir).filter(n => /^\[.+\]\.js$/.test(n));
          for (const entry of entries) {
            const paramName = entry.match(/^\[(.+)\]\.js$/)[1];
            candidates.push({
              file: path.join(parentDir, entry),
              params: { [paramName]: segs[segs.length - 1] }
            });
          }
        }
      }
    } catch (_) { /* best-effort */ }

    for (const { file, params } of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        delete require.cache[require.resolve(file)];
        const handler = require(file);
        // Inject dynamic params into req.query so handlers see them like on Vercel
        if (params) {
          req.query = Object.assign({}, req.query || {}, params);
        }
        return wrapHandler(handler)(req, res);
      } catch (e) {
        console.error('[api] failed to load', file, e);
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
