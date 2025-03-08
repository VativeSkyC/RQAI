const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const ngrok = require('ngrok');
const http = require('http');
const app = express();
const PORT = 5000;

// Middleware
app.use(bodyParser.json());

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Create database tables
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

// Database connection with retry
const connectToDatabase = () => {
  pool.connect()
    .then(() => {
      console.log('Connected to PostgreSQL');
      return createTables();
    })
    .catch((error) => {
      console.error('PostgreSQL connection error:', error.message);
      console.log('Retrying in 5 seconds...');
      setTimeout(connectToDatabase, 5000);
    });
};

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client:', err);
  connectToDatabase();
});

connectToDatabase();

// Root endpoint with simple login form
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>AI Relationship Agent</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          .form-container { margin-bottom: 30px; padding: 20px; border: 1px solid #ddd; border-radius: 5px; }
          input { margin-bottom: 10px; padding: 8px; width: 100%; }
          button { padding: 10px 15px; background: #4CAF50; color: white; border: none; cursor: pointer; }
          #tokenDisplay { margin-top: 20px; padding: 10px; background: #f5f5f5; word-break: break-all; }
        </style>
      </head>
      <body>
        <h1>AI Relationship Agent</h1>
        
        <div class="form-container">
          <h2>Register</h2>
          <form id="registerForm">
            <input type="email" id="registerEmail" placeholder="Email" required>
            <input type="password" id="registerPassword" placeholder="Password" required>
            <button type="submit">Register</button>
          </form>
          <div id="registerMessage"></div>
        </div>
        
        <div class="form-container">
          <h2>Login</h2>
          <form id="loginForm">
            <input type="email" id="loginEmail" placeholder="Email" required>
            <input type="password" id="loginPassword" placeholder="Password" required>
            <button type="submit">Login</button>
          </form>
          <div id="loginMessage"></div>
          <div id="tokenDisplay"></div>
        </div>
        
        <script>
          document.getElementById('registerForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('registerEmail').value;
            const password = document.getElementById('registerPassword').value;
            
            try {
              const response = await fetch('/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
              });
              
              const data = await response.json();
              document.getElementById('registerMessage').innerText = data.message || data.error;
            } catch (error) {
              document.getElementById('registerMessage').innerText = 'Error: ' + error.message;
            }
          });
          
          document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('loginEmail').value;
            const password = document.getElementById('loginPassword').value;
            
            try {
              const response = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
              });
              
              const data = await response.json();
              document.getElementById('loginMessage').innerText = data.message || data.error;
              
              if (data.token) {
                document.getElementById('tokenDisplay').innerHTML = `
                  <h3>Your JWT Token:</h3>
                  <p>${data.token}</p>
                  <p>UserId: ${data.userId}</p>
                `;
              }
            } catch (error) {
              document.getElementById('loginMessage').innerText = 'Error: ' + error.message;
            }
          });
        </script>
      </body>
    </html>
  `);
});

// User registration
app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  try {
    const client = await pool.connect();
    const checkUser = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    if (checkUser.rows.length > 0) {
      client.release();
      return res.status(400).json({ error: 'Email already exists' });
    }
    await client.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, password]);
    client.release();
    res.status(201).json({ message: 'User registered' });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// User login with JWT
const jwt = require('jsonwebtoken');
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  
  // Check if JWT_SECRET is set
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET environment variable is not set!');
    return res.status(500).json({ error: 'Server configuration error - JWT_SECRET not set' });
  }
  
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM users WHERE email = $1 AND password = $2', [email, password]);
    client.release();
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });
    const userId = result.rows[0].id;
    try {
      const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '24h' });
      res.json({ message: 'Login successful', userId, token });
    } catch (jwtError) {
      console.error('JWT signing error:', jwtError.message);
      res.status(500).json({ error: 'Error creating authentication token' });
    }
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// JWT verification middleware
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.log('No authorization header provided');
    return res.status(403).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    console.log('Token verified, proceeding with userId:', req.userId);
    next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

// Data reception endpoint
app.post('/receive-data', verifyToken, async (req, res) => {
  console.log('Received request to /receive-data');
  const phoneNumber = req.body.From;
  const userResponse = req.body.userResponse;
  const userId = req.userId;
  if (!phoneNumber || !userResponse) {
    console.log('Validation failed - Missing phoneNumber or userResponse', { phoneNumber, userResponse });
    return res.status(400).json({ error: 'Phone number and response are required' });
  }
  try {
    const client = await pool.connect();
    await client.query('BEGIN');
    let contactResult = await client.query('SELECT id FROM contacts WHERE phone_number = $1', [phoneNumber]);
    let contactId;
    if (contactResult.rows.length === 0) {
      const newContactResult = await client.query(
        'INSERT INTO contacts (phone_number, user_id) VALUES ($1, $2) RETURNING id',
        [phoneNumber, userId]
      );
      contactId = newContactResult.rows[0].id;
    } else {
      contactId = contactResult.rows[0].id;
    }
    await client.query(
      'INSERT INTO intake_responses (contact_id, user_id, response_text) VALUES ($1, $2, $3)',
      [contactId, userId, userResponse]
    );
    await client.query('COMMIT');
    console.log(`Data received - Phone: ${phoneNumber}, User ID: ${userId}, Response: ${userResponse}`);
    client.release();
    res.json({ message: 'Data received' });
  } catch (error) {
    await client.query('ROLLBACK');
    client.release();
    console.error('Error processing data:', error.message);
    res.status(500).json({ error: 'Server error while processing data' });
  }
});

// Twilio voice endpoint
app.post('/voice', (req, res) => {
  const twilio = require('twilio');
  const twiml = new twilio.twiml.VoiceResponse();
  console.log('Incoming call received. CallSid:', req.body.CallSid);
  twiml.say('Welcome to the AI Relationship Agent. Please hold while we connect you.');
  res.type('text/xml');
  res.send(twiml.toString());
});

// Improved keep-alive mechanism
const keepAlive = () => {
  setInterval(() => {
    console.log('Keeping alive...');
    http.get(`http://0.0.0.0:${PORT}/`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        console.log('Keep-alive successful - Server pinged');
      });
    }).on('error', (err) => {
      console.error('Keep-alive request failed:', err.message);
    });
  }, 20000); // Every 20 seconds
};

// Start server and ngrok tunnel
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`You can access the web interface at: https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`);
  
  // Check if JWT_SECRET is set
  if (!process.env.JWT_SECRET) {
    console.error('WARNING: JWT_SECRET environment variable is not set!');
    console.error('Login functionality will not work without JWT_SECRET.');
    console.error('Please set it in the Secrets tool (Environment Variables).');
  }
  
  keepAlive();
  try {
    const url = await ngrok.connect({
      addr: PORT,
      authtoken: process.env.NGROK_AUTH_TOKEN,
      subdomain: 'ai-relationship-agent',
      onLogEvent: (message) => console.log(message),
    });
    console.log('Ngrok tunnel established!');
    console.log(`Voice endpoint accessible at: ${url}/voice`);
    console.log('Set Twilio webhook to:', `${url}/voice`);
    console.log('Set ElevenLabs webhook to:', `${url}/receive-data`);
  } catch (error) {
    console.error('Error establishing Ngrok tunnel:', error.message);
    console.log('Ensure NGROK_AUTH_TOKEN is set in your environment variables');
  }
});