
const express = require('express');
const { Pool } = require('pg');
const app = express();
const PORT = 5000;

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Function to create tables if they don't exist
const createTables = async () => {
  const client = await pool.connect();
  try {
    // Start a transaction
    await client.query('BEGIN');
    
    // Create users table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      )
    `);
    
    // Create relationships table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS relationships (
        id SERIAL PRIMARY KEY,
        user1_id INTEGER REFERENCES users(id),
        user2_id INTEGER REFERENCES users(id),
        compatibility_score FLOAT,
        check_in_cadence VARCHAR(50)
      )
    `);
    
    // Commit the transaction
    await client.query('COMMIT');
    console.log('Tables created');
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    console.error('Error creating tables:', error.message);
  } finally {
    // Release the client back to the pool
    client.release();
  }
};

// Test database connection and create tables
pool.connect()
  .then(() => {
    console.log('Connected to PostgreSQL');
    return createTables();
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
