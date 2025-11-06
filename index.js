const express = require('express');
const fetch = require('node-fetch'); // Heroku needs this
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware to parse JSON bodies and serve static files
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serves your index.html

// Your new API proxy route. The browser sends the request here.
app.post('/api/get-history', async (req, res) => {
    try {
        const apiUrl = 'https://api.bdg88zf.com/api/webapi/GetNoaverageEmerdList';
        
        // This server forwards the request to the real API
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body) // Pass along the body from the browser
        });

        if (!response.ok) {
            throw new Error(`API error! Status: ${response.status}`);
        }

        const data = await response.json();
        res.json(data); // Send the data back to your browser script

    } catch (error) {
        console.error('Proxy Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Route to serve your main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});