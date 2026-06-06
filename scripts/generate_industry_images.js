#!/usr/bin/env node
/**
 * One-off: generate the 3 new industry photos (Insurance, Marketing & Web
 * Agencies, Professional Services) to match the existing warm, cinematic,
 * golden-hour photoreal style of homeservices.png / medspas.png / etc.
 * Uses Google Imagen via the Gemini API (key read from ../.env.local).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const KEY = (env.match(/^GEMINI_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!KEY) { console.error('No GEMINI_API_KEY in .env.local'); process.exit(1); }

const STYLE =
  'Photorealistic cinematic editorial commercial photograph, warm golden-hour ' +
  'natural lighting, soft window light, shallow depth of field, premium and ' +
  'aspirational, real candid professionals, high-end magazine quality, no text, ' +
  'no logos, no watermarks.';

const JOBS = [
  { file: 'professional.png', prompt:
    'Interior office scene. A well-dressed accountant in a suit sits at a desk ' +
    'inside a modern upscale office, smiling while reviewing printed financial ' +
    'documents and a laptop with a seated client across the desk. A bookshelf ' +
    'with binders and a large window with city buildings behind them. Indoor ' +
    'corporate setting, business attire. ' + STYLE },
];

async function gen(job) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt: job.prompt }],
      parameters: { sampleCount: 1, aspectRatio: '16:9', personGeneration: 'allow_adult' },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${job.file}: HTTP ${res.status} ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error(`${job.file}: no image in response ${text.slice(0, 400)}`);
  fs.writeFileSync(path.join(ROOT, 'assets', job.file), Buffer.from(b64, 'base64'));
  console.log(`✓ wrote assets/${job.file}`);
}

(async () => {
  for (const job of JOBS) {
    try { await gen(job); } catch (e) { console.error('✗ ' + e.message); }
  }
})();
