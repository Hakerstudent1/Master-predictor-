{
  "name": "heroku-predictor",
  "version": "1.0.0",
  "description": "Wingo predictor app for Heroku",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "node-fetch": "^2.6.7"
  },
  "engines": {
    "node": "16.x"
  }
}// Route to serve your main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
