
const express = require('express');
const { Pool } = require('pg');
const app = express();
const PORT = 5000;

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test database connection
pool.connect()
  .then(() => {
    console.log('Connected to PostgreSQL');
  })
  .catch((error) => {
    console.error('PostgreSQL connection error:', error.message);
  });

app.get('/', (req, res) => {
  res.json({ message: "AI Relationship Agent is running" });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
