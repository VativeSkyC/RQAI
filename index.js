
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
    
    // Create contacts table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(15) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Check if intake_responses table exists
    const tableCheckResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'intake_responses'
      )
    `);
    
    if (tableCheckResult.rows[0].exists) {
      // Check if user_id column exists in intake_responses
      const columnCheckResult = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'intake_responses' AND column_name = 'user_id'
        )
      `);
      
      if (!columnCheckResult.rows[0].exists) {
        // Add user_id column to intake_responses
        await client.query(`
          ALTER TABLE intake_responses ADD COLUMN user_id INTEGER REFERENCES users(id)
        `);
      }
    } else {
      // Create intake_responses table
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
    
    // Commit the transaction
    await client.query('COMMIT');
    console.log('Database schema updated for relationship management');
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
  const jwt = require('jsonwebtoken');
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
    
    const userId = result.rows[0].id;
    
    // Generate JWT token with user_id in payload
    const token = jwt.sign(
      { userId: userId },
      process.env.JWT_SECRET || 'your-secret-key', // Use environment variable in production
      { expiresIn: '24h' }
    );
    
    res.json({ 
      message: "Login successful", 
      userId: userId,
      token: token 
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: "Server error during login" });
  }
});

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const jwt = require('jsonwebtoken');
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(403).json({ error: 'No token provided' });
  }
  
  const token = authHeader.split(' ')[1]; // Format: "Bearer TOKEN"
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

// Endpoint to receive data from Twilio
app.post('/receive-data', verifyToken, async (req, res) => {
  // Extract phone number from Twilio request
  const phoneNumber = req.body.From;
  const userResponse = req.body.Body; // Text message content
  const userId = req.userId; // From JWT token
  
  if (!phoneNumber || !userResponse) {
    return res.status(400).json({ error: "Phone number and response are required" });
  }
  
  try {
    const client = await pool.connect();
    
    // Start transaction
    await client.query('BEGIN');
    
    // Check if contact exists, if not create one
    let contactResult = await client.query(
      'SELECT id FROM contacts WHERE phone_number = $1',
      [phoneNumber]
    );
    
    let contactId;
    
    if (contactResult.rows.length === 0) {
      // Create new contact
      const newContactResult = await client.query(
        'INSERT INTO contacts (phone_number, user_id) VALUES ($1, $2) RETURNING id',
        [phoneNumber, userId]
      );
      contactId = newContactResult.rows[0].id;
    } else {
      contactId = contactResult.rows[0].id;
    }
    
    // Store the response in intake_responses
    await client.query(
      'INSERT INTO intake_responses (contact_id, user_id, response_text) VALUES ($1, $2, $3)',
      [contactId, userId, userResponse]
    );
    
    // Commit transaction
    await client.query('COMMIT');
    
    // Log the data
    console.log(`Data received - Phone: ${phoneNumber}, User ID: ${userId}, Response: ${userResponse}`);
    
    client.release();
    res.json({ message: "Data received" });
  } catch (error) {
    // Rollback in case of error
    const client = await pool.connect();
    await client.query('ROLLBACK');
    client.release();
    
    console.error('Error processing data:', error.message);
    res.status(500).json({ error: "Server error while processing data" });
  }
});

// Create a /voice endpoint for Twilio
app.post('/voice', (req, res) => {
  const twilio = require('twilio');
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Log the CallSid to the console
  console.log('Incoming call received. CallSid:', req.body.CallSid);
  
  // Add a message to say to the caller
  twiml.say('Welcome to the AI Relationship Agent. Please hold while we connect you.');
  
  // Set the content type to XML and send the TwiML response
  res.type('text/xml');
  res.send(twiml.toString());
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
