const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const ngrok = require('ngrok');
const app = express();
const PORT = 5000;

// Middleware
app.use(bodyParser.json());

// PostgreSQL Connection with improved stability settings
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
});

// Function to create tables if they don't exist
const createTables = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS relationships (
        id SERIAL PRIMARY KEY,
        user1_id INTEGER REFERENCES users(id),
        user2_id INTEGER REFERENCES users(id),
        compatibility_score FLOAT,
        check_in_cadence VARCHAR(50)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(15) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const tableCheckResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'intake_responses'
      )
    `);

    if (tableCheckResult.rows[0].exists) {
      const columnCheckResult = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'intake_responses' AND column_name = 'user_id'
        )
      `);

      if (!columnCheckResult.rows[0].exists) {
        await client.query(`
          ALTER TABLE intake_responses ADD COLUMN user_id INTEGER REFERENCES users(id)
        `);
      }
    } else {
      await client.query(`
        CREATE TABLE IF NOT EXISTS intake_responses (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER REFERENCES contacts(id),
          user_id INTEGER REFERENCES users(id),
          response_text VARCHAR,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }

    await client.query('COMMIT');
    console.log('Database schema updated for relationship management');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating tables:', error.message);
  } finally {
    client.release();
  }
};

// Function to handle database connection with retry mechanism
const connectToDatabase = () => {
  pool.connect()
    .then(() => {
      console.log('Connected to PostgreSQL');
      return createTables();
    })
    .catch((error) => {
      console.error('PostgreSQL connection error:', error.message);
      console.log('Attempting to reconnect in 5 seconds...');
      setTimeout(connectToDatabase, 5000); // Try to reconnect after 5 seconds
    });
};

// Initialize database connection
connectToDatabase();

// Handle pool errors to prevent application crash
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  connectToDatabase(); // Try to reconnect on unexpected errors
});

app.get('/', (req, res) => {
  res.json({ message: "AI Relationship Agent is running" });
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  try {
    const client = await pool.connect();
    const checkUser = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    if (checkUser.rows.length > 0) {
      client.release();
      return res.status(400).json({ error: "Email already exists" });
    }
    await client.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, password]);
    client.release();
    res.status(201).json({ message: "User registered" });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(500).json({ error: "Server error during registration" });
  }
});

const jwt = require('jsonwebtoken');
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM users WHERE email = $1 AND password = $2', [email, password]);
    client.release();
    if (result.rows.length === 0) return res.status(401).json({ error: "Invalid email or password" });
    const userId = result.rows[0].id;
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: "Login successful", userId, token });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: "Server error during login" });
  }
});

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(403).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

app.post('/receive-data', verifyToken, async (req, res) => {
  const phoneNumber = req.body.From;
  const userResponse = req.body.userResponse; // Fixed to match webhook schema
  const userId = req.userId;
  if (!phoneNumber || !userResponse) return res.status(400).json({ error: "Phone number and response are required" });
  try {
    const client = await pool.connect();
    await client.query('BEGIN');
    let contactResult = await client.query('SELECT id FROM contacts WHERE phone_number = $1', [phoneNumber]);
    let contactId;
    if (contactResult.rows.length === 0) {
      const newContactResult = await client.query('INSERT INTO contacts (phone_number, user_id) VALUES ($1, $2) RETURNING id', [phoneNumber, userId]);
      contactId = newContactResult.rows[0].id;
    } else {
      contactId = contactResult.rows[0].id;
    }
    await client.query('INSERT INTO intake_responses (contact_id, user_id, response_text) VALUES ($1, $2, $3)', [contactId, userId, userResponse]);
    await client.query('COMMIT');
    console.log(`Data received - Phone: ${phoneNumber}, User ID: ${userId}, Response: ${userResponse}`);
    client.release();
    res.json({ message: "Data received" });
  } catch (error) {
    const client = await pool.connect();
    await client.query('ROLLBACK');
    client.release();
    console.error('Error processing data:', error.message);
    res.status(500).json({ error: "Server error while processing data" });
  }
});

app.post('/voice', (req, res) => {
  const twilio = require('twilio');
  const twiml = new twilio.twiml.VoiceResponse();
  console.log('Incoming call received. CallSid:', req.body.CallSid);
  twiml.say('Welcome to the AI Relationship Agent. Please hold while we connect you.');
  res.type('text/xml');
  res.send(twiml.toString());
});

const keepAlive = () => {
  setInterval(() => {
    console.log("Keeping alive...");
    // Make request to external endpoint for more reliable keep-alive
    require('https').get('https://httpbin.org/get', (res) => {
      // Process response
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        // Successful keep-alive ping
      });
    }).on('error', (err) => {
      console.error('Keep-alive request failed:', err.message);
    });
  }, 20000); // Every 20 seconds
};

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  keepAlive();
  try {
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

