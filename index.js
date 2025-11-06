const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// JSON + static
app.use(express.json());
app.use(express.static(path.join(__dirname))); // serves index.html and assets

// Proxy to upstream API — hides keys from the browser and avoids CORS issues
app.post('/api/get-history', async (req, res) => {
  try {
    const apiUrl = 'https://api.bdg88zf.com/api/webapi/GetNoaverageEmerdList';

    // Allow only needed fields from client body
    const {
      pageSize = 10,
      pageNo = 1,
      typeId = 1,
      language = 0,
      random,
      signature,
      timestamp
    } = req.body || {};

    const upstreamRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pageSize, pageNo, typeId, language, random, signature, timestamp
      })
    });

    const data = await upstreamRes.json();
    res.status(upstreamRes.status).json(data);
  } catch (err) {
    console.error('Proxy Error:', err);
    res.status(500).json({ code: -1, message: 'Proxy failed', detail: String(err && err.message || err) });
  }
});

// Serve app
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});