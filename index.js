// index.js — Single-fetch(12) background updater, robust parsing, 21-size rolling cache, debug endpoints

const express = require('express');
const fetch = require('node-fetch'); // v2.x
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// === Upstream endpoint ===
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://api.bdg88zf.com/api/webapi/GetNoaverageEmerdList';

// === Background + cache config ===
const DESIRED_CACHE = 21;     // keep 21 newest
const FETCH_PAGE_SIZE = 12;   // fetch exactly 12 each cycle (only one call)
const REFRESH_MS = 12_000;    // 12s cadence

let historyCache = [];        // newest-first: { period, number, isBig, label }
let lastUpdate = 0;
let isUpdating = false;

// Keep the very last upstream payload for debugging
let lastUpstream = { status: null, bodyPreview: null, raw: null };

// --- Helpers ---
const now = () => Date.now();

// lenient getter for nested arrays: try common spots
function extractList(payload) {
  if (!payload) return [];
  // common: { code: 0, data: { list: [...] } }
  if (payload?.data?.list && Array.isArray(payload.data.list)) return payload.data.list;
  // some APIs: { data: [...] }
  if (Array.isArray(payload?.data)) return payload.data;
  // uppercase keys
  if (payload?.data?.List && Array.isArray(payload.data.List)) return payload.data.List;
  // direct list at top
  if (Array.isArray(payload?.list)) return payload.list;
  // otherwise search any array of objects that look like issues
  for (const k of Object.keys(payload || {})) {
    const v = payload[k];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      // heuristic: object contains a number/result-ish field
      if ('issueNumber' in v[0] || 'issue' in v[0] || 'period' in v[0]) return v;
    }
  }
  return [];
}

// map one item defensively
function mapItem(item) {
  // accept a bunch of common field names
  const period = String(
    item.issueNumber ??
    item.issue ??
    item.period ??
    item.issue_no ??
    item.IssueNumber ??
    item.Issue ??
    ''
  ).trim();

  // number can be 'number', 'result', 'openNumber', 'open_no', etc.
  const rawNum = (item.number ?? item.result ?? item.openNumber ?? item.open_no ?? item.No ?? item.no);
  const n = Number.parseInt(String(rawNum ?? '').trim(), 10);
  const safe = Number.isFinite(n) ? Math.abs(n) % 10 : NaN;

  if (!period || Number.isNaN(safe)) return null;

  const isBig = safe >= 5;
  return {
    period,
    number: safe,
    isBig,
    label: isBig ? 'BIG' : 'SMALL'
  };
}

// Merge page items -> unique by period -> newest-first -> cap 21
function mergeIntoCache(mappedItems) {
  if (!Array.isArray(mappedItems) || mappedItems.length === 0) return;
  const seen = new Set(historyCache.map(i => i.period));
  for (const it of mappedItems) {
    if (!seen.has(it.period)) {
      seen.add(it.period);
      historyCache.push(it);
    }
  }
  // sort by period DESC — if not numeric, fallback to string compare
  historyCache.sort((a, b) => {
    try {
      const A = BigInt(a.period);
      const B = BigInt(b.period);
      return A < B ? 1 : A > B ? -1 : 0;
    } catch {
      // string fallback
      return a.period < b.period ? 1 : a.period > b.period ? -1 : 0;
    }
  });
  if (historyCache.length > DESIRED_CACHE) {
    historyCache = historyCache.slice(0, DESIRED_CACHE);
  }
  lastUpdate = now();
}

// One upstream call per cycle (pageSize=12); tolerant to weird envelopes
async function fetchOnce() {
  const payload = {
    pageSize: FETCH_PAGE_SIZE,
    pageNo: 1,
    typeId: 1,
    language: 0,
    random: Math.random().toString(36).slice(2),
    signature: '', // if you have a real signer, compute it here
    timestamp: Math.floor(Date.now() / 1000)
  };

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://bdg88zf.com',
    'Referer': 'https://bdg88zf.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36'
  };

  let status = null;
  let body = null;

  try {
    const r = await fetch(UPSTREAM_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    status = r.status;
    const ct = r.headers.get('content-type') || '';
    try {
      body = ct.includes('application/json') ? await r.json() : await r.text();
    } catch {
      body = await r.text();
    }
  } catch (e) {
    status = 599;
    body = { code: -1, message: String(e?.message || e) };
  }

  // Save for debug (short preview to avoid console spam)
  lastUpstream.status = status;
  lastUpstream.raw = body;
  try {
    lastUpstream.bodyPreview = typeof body === 'string' ? body.slice(0, 800) : JSON.stringify(body).slice(0, 800);
  } catch {
    lastUpstream.bodyPreview = '[unserializable]';
  }

  // Accept if it contains a usable list, even if code isn’t exactly number 0
  const list = extractList(typeof body === 'string' ? safeJson(body) : body);
  return { status, list };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

async function updateOnce() {
  if (isUpdating) return;
  isUpdating = true;
  try {
    const { status, list } = await fetchOnce();

    if (status === 200 && Array.isArray(list) && list.length) {
      const mapped = list.map(mapItem).filter(Boolean);
      if (mapped.length) {
        mergeIntoCache(mapped);
        return;
      }
    }

    // If we reach here, nothing mapped this cycle; keep old cache
    console.warn('[Updater] No mappable items this cycle. status=', status, 'listLen=', Array.isArray(list) ? list.length : 'n/a');
  } catch (e) {
    console.error('[Updater] Error:', e?.message || e);
  } finally {
    isUpdating = false;
  }
}

// schedule: one call per cycle
(async function scheduler() {
  await updateOnce();               // prime once
  setInterval(updateOnce, REFRESH_MS);
})();

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname))); // serve index.html and assets

// Health and debug
app.get('/health', (_req, res) => res.json({ ok: true, cacheSize: historyCache.length, lastUpdate }));
app.get('/api/debug-upstream', (_req, res) => {
  res.json({
    status: lastUpstream.status,
    preview: lastUpstream.bodyPreview,
    cacheSize: historyCache.length,
    lastUpdate
  });
});

// Frontend uses this; newest-first; up to 21 items
app.get('/api/history', (_req, res) => {
  res.json({ code: 0, updatedAt: lastUpdate, size: historyCache.length, list: historyCache });
});

// Serve app
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
// Single fetch via Puppeteer (headless browser)
async function fetchOnceViaPuppeteer() {
  if (!puppeteer) {
    try {
      puppeteer = require('puppeteer');
    } catch (e) {
      // Puppeteer not installed; return a faux-403 so caller can handle
      return { status: 599, body: { code: -1, message: 'Puppeteer not installed' } };
    }
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://bdg88zf.com',
    'Referer': 'https://bdg88zf.com/'
  });

  const payload = {
    pageSize: FETCH_PAGE_SIZE,
    pageNo: 1,
    typeId: 1,
    language: 0,
    random: Math.random().toString(36).slice(2),
    signature: '',
    timestamp: Math.floor(Date.now() / 1000)
  };

  const result = await page.evaluate(async ({ url, payload }) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*'
        },
        body: JSON.stringify(payload)
      });
      const ct = r.headers.get('content-type') || '';
      let data;
      try {
        data = ct.includes('application/json') ? await r.json() : await r.text();
      } catch (e) {
        data = await r.text();
      }
      return { status: r.status, data };
    } catch (e) {
      return { status: 599, data: String(e) };
    }
  }, { url: UPSTREAM_URL, payload });

  await browser.close();
  return { status: result.status, body: result.data };
}

// Background updater: one call per cycle (size 12) → merge → keep 21
async function updateOnce() {
  if (isUpdating) return;
  isUpdating = true;
  try {
    // Try normal HTTP first
    let out = await fetchOnceViaHTTP();
    if (out.status === 200 && out.body && out.body.code === 0 && Array.isArray(out.body?.data?.list)) {
      const pageItems = mapList(out.body.data.list);
      mergeIntoCache(pageItems);
      return;
    }

    // If forbidden or malformed, try Puppeteer once (optional)
    if (out.status === 403 || out.status === 401 || out.status === 409) {
      const pup = await fetchOnceViaPuppeteer();
      if (pup.status === 200 && pup.body && pup.body.code === 0 && Array.isArray(pup.body?.data?.list)) {
        const pageItems = mapList(pup.body.data.list);
        mergeIntoCache(pageItems);
        return;
      }
    }

    // If we got here, we didn't improve the cache this cycle; keep old cache
    console.warn('[Updater] Upstream did not yield data this cycle:', out.status, out.body?.code || out.body);
  } catch (e) {
    console.error('[Updater] Error:', e?.message || e);
  } finally {
    isUpdating = false;
  }
}

// Kick off background loop
(async function scheduler() {
  // Prime once on boot, then loop
  await updateOnce();
  setInterval(updateOnce, REFRESH_MS);
})();

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname))); // serve index.html and assets

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, cacheSize: historyCache.length, lastUpdate }));

// Main API that the frontend uses: returns up-to-21 cache (newest-first)
app.get('/api/history', async (req, res) => {
  // If cache is empty at first hit, try to update (with a small wait)
  if (historyCache.length === 0 && !isUpdating) {
    try { await updateOnce(); } catch {}
  }
  return res.json({
    code: 0,
    updatedAt: lastUpdate,
    size: historyCache.length,
    list: historyCache
  });
});

// Serve app
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
