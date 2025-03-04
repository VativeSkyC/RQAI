
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const ngrok = require('ngrok');
const app = express();
const PORT = 5000;

// Middleware
app.use(bodyParser.json());

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

// Register a new user
app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  
  try {
    const client = await pool.connect();
    
    // Check if user already exists
    const checkUser = await client.query(
      'SELECT * FROM users WHERE email = $1', 
      [email]
    );
    
    if (checkUser.rows.length > 0) {
      client.release();
      return res.status(400).json({ error: "Email already exists" });
    }
    
    // Insert new user
    await client.query(
      'INSERT INTO users (email, password) VALUES ($1, $2)',
      [email, password] // In a production app, password should be hashed
    );
    
    client.release();
    res.status(201).json({ message: "User registered" });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(500).json({ error: "Server error during registration" });
  }
});

// Login user
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  
  try {
    const client = await pool.connect();
    
    // Check if user exists and password matches
    const result = await client.query(
      'SELECT * FROM users WHERE email = $1 AND password = $2', 
      [email, password] // In a production app, password comparison would be different
    );
    
    client.release();
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    
    res.json({ message: "Login successful", userId: result.rows[0].id });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: "Server error during login" });
  }
});

// Create a /voice endpoint
app.post('/voice', (req, res) => {
  res.json({ message: "Voice endpoint is active" });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Start ngrok
  try {
    // Connect ngrok to the specific /voice route
    const url = await ngrok.connect({
      addr: PORT,
      authtoken: process.env.NGROK_AUTH_TOKEN,
      subdomain: 'ai-relationship-agent',
      onLogEvent: (message) => console.log(message)
    });
    
    console.log(`Ngrok tunnel established!`);
    console.log(`Voice endpoint accessible at: ${url}/voice`);
    console.log('Use this URL for your Twilio webhook configuration');
  } catch (error) {
    console.error('Error establishing Ngrok tunnel:', error);
    console.log('Make sure NGROK_AUTH_TOKEN is set in your environment variables');
  }
});
