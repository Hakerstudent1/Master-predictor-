// index.js — Single-fetch(12) background updater, 21-size rolling cache, optional Puppeteer fallback

const express = require('express');
const fetch = require('node-fetch'); // v2.x
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// === Upstream endpoint ===
// If your provider changes the domain, just update this constant:
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://api.bdg88zf.com/api/webapi/GetNoaverageEmerdList';

// === Cache & scheduler ===
const DESIRED_CACHE = 21;       // we keep 21 in memory
const FETCH_PAGE_SIZE = 12;     // we fetch only 12 each cycle
const REFRESH_MS = 12_000;      // background refresh interval

let historyCache = [];          // newest-first, each: { period, number, isBig, label }
let lastUpdate = 0;
let isUpdating = false;

// Try Puppeteer only if needed (lazy load)
let puppeteer = null;

// Minimal utilities
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();

// Merge a page into cache -> unique by period -> sort desc -> cap 21
function mergeIntoCache(items) {
  const seen = new Set(historyCache.map(i => i.period));
  for (const it of items) {
    if (!seen.has(it.period)) {
      seen.add(it.period);
      historyCache.push(it);
    }
  }
  // sort by period descending (parse as big integer if needed)
  historyCache.sort((a, b) => {
    // periods are often numerics in string; compare numerically when possible
    const A = BigInt(a.period);
    const B = BigInt(b.period);
    return (A < B) ? 1 : (A > B) ? -1 : 0;
  });
  // cap to 21
  if (historyCache.length > DESIRED_CACHE) {
    historyCache = historyCache.slice(0, DESIRED_CACHE);
  }
  lastUpdate = now();
}

// Map upstream record -> our internal format
function mapList(list) {
  return list.map(item => {
    const num = (parseInt(item.number, 10) % 10);
    return {
      period: item.issueNumber,
      number: num,
      isBig: num >= 5,
      label: num >= 5 ? 'BIG' : 'SMALL'
    };
  });
}

// Fetch once with node-fetch (browser-like headers)
async function fetchOnceViaHTTP() {
  const payload = {
    pageSize: FETCH_PAGE_SIZE,
    pageNo: 1,
    typeId: 1,
    language: 0,
    random: Math.random().toString(36).slice(2),
    signature: '', // if you own a real signing algo, compute it here; leaving blank is typical for public lists
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

  const r = await fetch(UPSTREAM_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const ct = r.headers.get('content-type') || '';
  let body;
  try {
    body = ct.includes('application/json') ? await r.json() : await r.text();
  } catch {
    body = await r.text();
  }

  return { status: r.status, body };
}

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
