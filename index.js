// server.js
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// === GET HISTORY API ===
app.post("/api/get-history", async (req, res) => {
  try {
    // Example: generate fake history for testing
    const now = Date.now();
    const list = Array.from({ length: 21 }, (_, i) => ({
      issueNumber: String(100000 + i),
      number: Math.floor(Math.random() * 1000).toString()
    }));

    res.json({
      code: 0,
      data: { list }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 1, msg: "Server error" });
  }
});

// === START SERVER ===
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
