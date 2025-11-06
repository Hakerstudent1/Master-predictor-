// server.js (CommonJS version)
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/get-history", (req, res) => {
  const list = Array.from({ length: 21 }, (_, i) => ({
    issueNumber: String(100000 + i),
    number: Math.floor(Math.random() * 1000).toString()
  }));
  res.json({ code: 0, data: { list } });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
