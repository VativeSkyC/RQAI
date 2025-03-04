
const express = require('express');
const app = express();
const PORT = 5000;

app.get('/', (req, res) => {
  res.json({ message: "AI Relationship Agent is running" });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
