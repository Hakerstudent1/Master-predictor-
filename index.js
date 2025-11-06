// index.js — robust proxy with diagnostics
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

  // Use AbortController for timeouts with node-fetch v2
  const AbortController = global.AbortController || (await import('abort-controller')).default;

  const controller = new AbortController();
  const timeoutMs = 10000; // 10s
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Forward the body AS-IS to avoid dropping required fields.
    const upstreamRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'User-Agent': 'DurveshVIP/1.0 (+node-fetch)'
      },
      body: JSON.stringify(req.body || {}),
      signal: controller.signal
    });

    const contentType = upstreamRes.headers.get('content-type') || '';
    const status = upstreamRes.status;

    // Try JSON first; if it fails or not JSON, fall back to text
    let data, raw;
    if (contentType.includes('application/json')) {
      try {
        data = await upstreamRes.json();
      } catch (e) {
        raw = await upstreamRes.text();
      }
    } else {
      raw = await upstreamRes.text();
    }

    // Log a compact summary for debugging
    const preview = (data ? JSON.stringify(data).slice(0, 300) : String(raw).slice(0, 300));
    console.log(`[Upstream] ${status} ${contentType} :: ${preview}`);

    // If upstream not OK, forward status and the body so you see the real reason
    if (!upstreamRes.ok) {
      if (data) {
        return res.status(status).json(data);
      } else {
        return res.status(status).send(raw || '');
      }
    }

    // Upstream OK — ensure JSON shape for client
    if (data) {
      return res.status(status).json(data);
    } else {
      // Non-JSON success (unlikely) — send as text
      return res.status(status).send(raw || '');
    }
  } catch (err) {
    // Timeouts or network errors land here
    console.error('Proxy Error:', err && err.message ? err.message : err);
    return res.status(500).json({
      code: -1,
      message: 'Proxy failed',
      detail: String(err && err.message || err)
    });
  } finally {
    clearTimeout(t);
  }
});

// Serve the app
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
