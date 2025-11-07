// History array stores objects: { data: {...}, timestamp: Date.now() }
this.oneMinHistory = this.oneMinHistory || [];

function addNewHistoryEntry(newEntry) {
  const now = Date.now();
  // Push new entry with timestamp
  this.oneMinHistory.unshift({ data: newEntry, timestamp: now });

  // Remove entries older than 30 minutes (1800000 ms)
  this.oneMinHistory = this.oneMinHistory.filter(
    entry => now - entry.timestamp <= 1800000
  );

  // Keep only latest 21 entries
  if (this.oneMinHistory.length > 21) {
    this.oneMinHistory = this.oneMinHistory.slice(0, 21);
  }
}

// When accessing history for prediction logic, get only the 'data' part
function getHistoryData() {
  return this.oneMinHistory.map(entry => entry.data);
}

// In your prediction logic call getHistoryData() instead of oneMinHistory directly
let historyData = getHistoryData();

// Use historyData for prediction, it will have max 21 entries within last 30 min
