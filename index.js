// index.js — one fetch(12)/cycle → rolling cache(21) → compute 10 blocks in background

const express = require('express');
const fetch = require('node-fetch'); // v2.x
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// ====== CONFIG ======
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://api.bdg88zf.com/api/webapi/GetNoaverageEmerdList';
const FETCH_PAGE_SIZE = 12;   // ONLY 1 fetch of 12 each cycle
const CACHE_SIZE = 21;        // keep 21 newest
const REFRESH_MS = 12000;     // every 12s
const WINDOWS = [1,5,7,9,11,13,15,17,19,21]; // blocks 1..10

// ====== STATE ======
let historyCache = []; // newest-first: [{period, number, isBig, label}]
let lastUpdate = 0;
let isUpdating = false;
let lastUpstream = { status: null, preview: null };

// ====== HELPERS ======
const now = () => Date.now();

function extractList(payload) {
  if (!payload) return [];
  if (payload?.data?.list && Array.isArray(payload.data.list)) return payload.data.list;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.list)) return payload.list;
  if (payload?.data?.List && Array.isArray(payload.data.List)) return payload.data.List;
  // heuristic fallback
  for (const k of Object.keys(payload || {})) {
    const v = payload[k];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
}

function mapItem(item) {
  const period = String(
    item.issueNumber ?? item.issue ?? item.period ?? item.issue_no ?? item.IssueNumber ?? item.Issue ?? ''
  ).trim();

  const rawNum = (item.number ?? item.result ?? item.openNumber ?? item.open_no ?? item.No ?? item.no);
  const n = Number.parseInt(String(rawNum ?? '').trim(), 10);
  const safe = Number.isFinite(n) ? Math.abs(n) % 10 : NaN;

  if (!period || Number.isNaN(safe)) return null;
  const isBig = safe >= 5;
  return { period, number: safe, isBig, label: isBig ? 'BIG' : 'SMALL' };
}

function mergeIntoCache(items) {
  if (!Array.isArray(items) || !items.length) return;
  const seen = new Set(historyCache.map(i => i.period));
  for (const it of items) {
    if (!seen.has(it.period)) {
      seen.add(it.period);
      historyCache.push(it);
    }
  }
  // newest-first by period (numeric if possible, else string)
  historyCache.sort((a, b) => {
    try {
      const A = BigInt(a.period), B = BigInt(b.period);
      return A < B ? 1 : A > B ? -1 : 0;
    } catch {
      return a.period < b.period ? 1 : a.period > b.period ? -1 : 0;
    }
  });
  if (historyCache.length > CACHE_SIZE) historyCache = historyCache.slice(0, CACHE_SIZE);
  lastUpdate = now();
}

function computeAllPredictions() {
  return WINDOWS.map((win, idx) => {
    if (historyCache.length < win) {
      return { block: idx + 1, window: win, ready: false, prediction: 'WAIT', big: 0, small: 0 };
    }
    const slice = historyCache.slice(0, win); // newest-first window
    const big = slice.reduce((a, i) => a + (i.isBig ? 1 : 0), 0);
    const small = win - big;
    return {
      block: idx + 1,
      window: win,
      ready: true,
      prediction: big >= small ? 'BIG' : 'SMALL',
      big, small
    };
  });
}

// one upstream fetch (no paging)
async function fetchOnceViaHTTP() {
  const payload = {
    pageSize: FETCH_PAGE_SIZE,
    pageNo: 1,
    typeId: 1,
    language: 0,
    random: Math.random().toString(36).slice(2),
    signature: '',
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

  const r = await fetch(UPSTREAM_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
  const status = r.status;
  const ct = r.headers.get('content-type') || '';
  let body;
  try { body = ct.includes('application/json') ? await r.json() : await r.text(); }
  catch { body = await r.text(); }

  lastUpstream.status = status;
  try { lastUpstream.preview = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500); }
  catch { lastUpstream.preview = '[unserializable]'; }

  return { status, body };
}

// optional Puppeteer fallback (only used if installed)
async function fetchOnceViaPuppeteerIfAvailable() {
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
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
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
          body: JSON.stringify(payload)
        });
        const ct = r.headers.get('content-type') || '';
        let data;
        try { data = ct.includes('application/json') ? await r.json() : await r.text(); }
        catch { data = await r.text(); }
        return { status: r.status, data };
      } catch (e) {
        return { status: 599, data: String(e) };
      }
    }, { url: UPSTREAM_URL, payload });

    await browser.close();
    lastUpstream.status = result.status;
    try { lastUpstream.preview = typeof result.data === 'string' ? result.data.slice(0, 500) : JSON.stringify(result.data).slice(0, 500); }
    catch { lastUpstream.preview = '[unserializable]'; }
    return { status: result.status, body: result.data };
  } catch {
    return { status: 598, body: { code: -1, message: 'Puppeteer not installed/available' } };
  }
}

async function updateOnce() {
  if (isUpdating) return;
  isUpdating = true;
  try {
    let out = await fetchOnceViaHTTP();

    const list = extractList(typeof out.body === 'object' ? out.body : {});
    const ok = out.status === 200 && Array.isArray(list) && list.length > 0;

    if (!ok) {
      const pup = await fetchOnceViaPuppeteerIfAvailable();
      const list2 = extractList(typeof pup.body === 'object' ? pup.body : {});
      if (pup.status === 200 && Array.isArray(list2) && list2.length) {
        const mapped = list2.map(mapItem).filter(Boolean);
        mergeIntoCache(mapped);
        return;
      }
    } else {
      const mapped = list.map(mapItem).filter(Boolean);
      mergeIntoCache(mapped);
      return;
    }

    console.warn('[Updater] No usable data this cycle; keeping previous cache.');
  } catch (e) {
    console.error('[Updater] Error:', e?.message || e);
  } finally {
    isUpdating = false;
  }
}

// prime + schedule
(async () => {
  await updateOnce();
  setInterval(updateOnce, REFRESH_MS);
})();

// ====== EXPRESS ======
app.use(express.json());
app.use(express.static(path.join(__dirname))); // serves index.html

app.get('/api/predictions', (req, res) => {
  res.json({ updatedAt: lastUpdate, predictions: computeAllPredictions() });
});

app.get('/api/history', (req, res) => {
  res.json({ updatedAt: lastUpdate, size: historyCache.length, list: historyCache });
});

app.get('/api/debug', (req, res) => {
  res.json({ lastUpstream, cacheSize: historyCache.length, lastUpdate });
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
