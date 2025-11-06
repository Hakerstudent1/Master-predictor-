// index.js — hardened proxy for /api/get-history with browser-like headers + diagnostics
const express = require('express');
const fetch = require('node-fetch'); // v2.x
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname)));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/get-history', async (req, res) => {
  const apiUrl = 'https://api.bdg88zf.com/api/webapi/GetNoaverageEmerdList';

  // Build a browser-like header set; forward cookie if present
  const hdrs = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://bdg88zf.com',
    'Referer': 'https://bdg88zf.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36'
  };
  if (req.headers.cookie) hdrs['Cookie'] = req.headers.cookie;

  // Use client body AS-IS but ensure defaults for common fields
  const body = Object.assign({}, req.body || {});
  if (body.pageSize == null) body.pageSize = 10;
  if (body.pageNo == null) body.pageNo = 1;
  if (body.typeId == null) body.typeId = 1;
  if (body.language == null) body.language = 0;
  // If caller didn’t supply a timestamp, set a fresh one
  if (!body.timestamp) body.timestamp = Math.floor(Date.now() / 1000);
  // NOTE: We do NOT invent `signature` — if the API requires a valid one,
  // you must provide it (it’s typically tied to timestamp/random with a secret).

  try {
    const upstreamRes = await fetch(apiUrl, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify(body)
    });

    const ct = upstreamRes.headers.get('content-type') || '';
    const status = upstreamRes.status;
    let payload;
    try {
      payload = ct.includes('application/json') ? await upstreamRes.json() : await upstreamRes.text();
    } catch (e) {
      payload = await upstreamRes.text();
    }

    // Compact log so you can see EXACTLY why it failed
    const preview = (typeof payload === 'string' ? payload : JSON.stringify(payload)).slice(0, 500);
    console.log(`[UPSTREAM] ${status} ${ct} :: ${preview}`);

    // Forward upstream status and body 1:1 so frontend sees true error shape
    if (typeof payload === 'string') {
      return res.status(status).send(payload);
    } else {
      return res.status(status).json(payload);
    }
  } catch (err) {
    console.error('Proxy Error:', err && err.message ? err.message : err);
    return res.status(500).json({
      code: -1,
      message: 'Proxy failed',
      detail: String(err && err.message || err)
    });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
