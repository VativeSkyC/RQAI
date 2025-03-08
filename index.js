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
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      )
    `);
    
    // Create relationships table
    await client.query(`
      CREATE TABLE IF NOT EXISTS relationships (
        id SERIAL PRIMARY KEY,
        user1_id INTEGER REFERENCES users(id),
        user2_id INTEGER REFERENCES users(id),
        compatibility_score FLOAT,
        check_in_cadence VARCHAR(50)
      )
    `);
    
    // Create contacts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(15) UNIQUE NOT NULL,
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        company_name VARCHAR(100),
        linkedin_url VARCHAR(255),
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Check if contacts table needs column updates
    const columnCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'contacts' 
      AND column_name = 'first_name'
    `);
    
    // If first_name doesn't exist, add all possibly missing columns
    if (columnCheck.rows.length === 0) {
      console.log('Migrating contacts table - adding missing columns');
      await client.query(`
        ALTER TABLE contacts
        ADD COLUMN IF NOT EXISTS first_name VARCHAR(100),
        ADD COLUMN IF NOT EXISTS last_name VARCHAR(100),
        ADD COLUMN IF NOT EXISTS company_name VARCHAR(100),
        ADD COLUMN IF NOT EXISTS linkedin_url VARCHAR(255)
      `);
    }
    
    // Create temp_calls table
    await client.query(`
      CREATE TABLE IF NOT EXISTS temp_calls (
        id SERIAL PRIMARY KEY,
        call_sid VARCHAR(50) UNIQUE NOT NULL,
        phone_number VARCHAR(15) NOT NULL,
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
          communication_style TEXT,
          goals TEXT,
          values TEXT,
          professional_goals TEXT,
          partnership_expectations TEXT,
          raw_transcript TEXT,
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
                document.getElementById('tokenDisplay').innerHTML = 
                  "<h3>Your JWT Token:</h3>" +
                  "<p>" + data.token + "</p>" +
                  "<p>UserId: " + data.userId + "</p>";
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

// Add contact endpoint with text message notification
app.post('/add-contact', verifyToken, async (req, res) => {
  try {
    const { first_name, last_name, company_name, linkedin_url, phone_number } = req.body;
    const userId = req.userId; // From the verifyToken middleware

    // Validate required fields
    if (!first_name || !last_name || !phone_number) {
      return res.status(400).json({ error: 'Missing required fields (first_name, last_name, and phone_number are required)' });
    }

    // Validate phone number format (optional)
    const phoneRegex = /^\+?[1-9]\d{1,14}$/; // Basic E.164 format check
    if (!phoneRegex.test(phone_number)) {
      return res.status(400).json({ error: 'Invalid phone number format. Please use E.164 format (e.g., +12125551234)' });
    }

    // Add contact to database
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO contacts (first_name, last_name, company_name, linkedin_url, phone_number, user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id`,
        [first_name, last_name, company_name || null, linkedin_url || null, phone_number, userId]
      );
      const contactId = result.rows[0].id;

      // Send automated text if Twilio credentials are configured
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
        const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        
        await twilioClient.messages.create({
          body: `Hi ${first_name}! Please call this number to connect with our AI Relationship Agent: ${process.env.TWILIO_PHONE_NUMBER}`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone_number
        });
        console.log(`Text message sent to ${phone_number}`);
      } else {
        console.log('Twilio credentials not configured - skipping text message');
      }

      await client.query('COMMIT');
      console.log(`Contact added: ${first_name} ${last_name} (${phone_number}), ID: ${contactId}`);
      res.status(201).json({ 
        message: 'Contact added successfully', 
        contact_id: contactId,
        text_sent: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER)
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error; // Pass to outer catch block
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error adding contact:', error.message);
    // Handle specific PostgreSQL errors
    if (error.code === '23505') { // Unique violation
      return res.status(400).json({ error: 'Phone number already exists in contacts' });
    }
    res.status(500).json({ error: 'Failed to add contact', details: error.message });
  }
});


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

// Data reception endpoint from Eleven Labs
app.post('/receive-data', async (req, res) => {
  console.log('Received request to /receive-data from Eleven Labs');
  
  // Handle both authentication methods: direct user requests with JWT and Eleven Labs callbacks
  let isElevenLabsCallback = false;
  let userId = null;
  
  // Check if this is a verifiable Eleven Labs callback with callSid
  if (req.body.callSid) {
    isElevenLabsCallback = true;
    console.log('Eleven Labs callback detected with callSid:', req.body.callSid);
  } else {
    // Standard JWT verification for direct API calls
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(403).json({ error: 'No token provided' });
      }
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.userId;
      console.log('Token verified, proceeding with userId:', userId);
    } catch (error) {
      console.error('Token verification failed:', error.message);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  
  // Handle Eleven Labs callback data
  if (isElevenLabsCallback) {
    const { 
      callSid, 
      communication_style, 
      goals, 
      values, 
      professional_goals, 
      partnership_expectations, 
      raw_transcript 
    } = req.body;
    
    console.log('Processing Eleven Labs data for callSid:', callSid);

    try {
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // Match call to contact
        const callResult = await client.query('SELECT phone_number FROM temp_calls WHERE call_sid = $1', [callSid]);
        
        if (callResult.rows.length === 0) {
          console.error('Call not found for callSid:', callSid);
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Call not found' });
        }
        
        const phoneNumber = callResult.rows[0].phone_number;
        console.log(`Found phone number ${phoneNumber} for callSid: ${callSid}`);
        
        // Find the corresponding contact
        const contactResult = await client.query('SELECT id, user_id FROM contacts WHERE phone_number = $1', [phoneNumber]);
        
        if (contactResult.rows.length === 0) {
          console.error('Contact not found for phone number:', phoneNumber);
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Contact not found' });
        }
        
        const contactId = contactResult.rows[0].id;
        userId = contactResult.rows[0].user_id;
        console.log(`Found contact (ID: ${contactId}) for user (ID: ${userId})`);
        
        // Store call data
        await client.query(
          `INSERT INTO intake_responses (
            contact_id, user_id, communication_style, goals, values, 
            professional_goals, partnership_expectations, raw_transcript, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            contactId, 
            userId, 
            communication_style || null, 
            goals || null, 
            values || null, 
            professional_goals || null, 
            partnership_expectations || null, 
            raw_transcript || null
          ]
        );
        
        // Clean up temp_calls
        await client.query('DELETE FROM temp_calls WHERE call_sid = $1', [callSid]);
        
        await client.query('COMMIT');
        console.log(`Successfully stored Eleven Labs data for contact ID ${contactId}, user ID ${userId}`);
        
        return res.status(200).json({ message: 'Data stored successfully' });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error; // Pass to outer catch
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error processing Eleven Labs data:', error.message);
      return res.status(500).json({ error: 'Failed to store data', details: error.message });
    }
  } 
  // Handle standard API request with JWT auth
  else {
    const phoneNumber = req.body.From;
    const userResponse = req.body.userResponse;
    
    if (!phoneNumber || !userResponse) {
      console.log('Validation failed - Missing phoneNumber or userResponse', { phoneNumber, userResponse });
      return res.status(400).json({ error: 'Phone number and response are required' });
    }
    
    try {
      const client = await pool.connect();
      
      try {
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
        
        return res.json({ message: 'Data received' });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error; // Pass to outer catch
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error processing data:', error.message);
      return res.status(500).json({ error: 'Server error while processing data', details: error.message });
    }
  }
});

// Twilio voice endpoint with Eleven Labs integration
app.post('/voice', async (req, res) => {
  const { From, CallSid } = req.body;
  console.log('Incoming call received. CallSid:', CallSid, 'From:', From);

  try {
    // Store call details temporarily
    const client = await pool.connect();
    await client.query(
      'INSERT INTO temp_calls (call_sid, phone_number, created_at) VALUES ($1, $2, NOW())',
      [CallSid, From]
    );
    client.release();

    // Redirect to Eleven Labs
    const twiml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Redirect method="POST">https://api.us.elevenlabs.io/twilio/inbound_call</Redirect>
      </Response>
    `;

    res.type('text/xml').send(twiml);
    console.log('Call redirected to Eleven Labs');
  } catch (error) {
    console.error('Error in voice endpoint:', error.message);
    // Fallback in case of error
    const twilio = require('twilio');
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('We are experiencing technical difficulties. Please try again later.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
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

// Scheduled cleanup for temp_calls table
setInterval(async () => {
  try {
    const result = await pool.query('DELETE FROM temp_calls WHERE created_at < NOW() - INTERVAL \'1 hour\'');
    console.log(`Cleaned up temp_calls table: ${result.rowCount} old records removed`);
  } catch (error) {
    console.error('Error cleaning up temp_calls:', error.message);
  }
}, 30 * 60 * 1000); // Every 30 minutes

// Start server and ngrok tunnel
const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log('=======================================================');
  console.log(`⚡ Server running on port ${PORT}`);
  console.log(`🌐 Web interface: https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`);

  // Check if JWT_SECRET is set
  if (!process.env.JWT_SECRET) {
    console.error('⚠️ WARNING: JWT_SECRET environment variable is not set!');
    console.error('⚠️ Login functionality will not work without JWT_SECRET.');
    console.error('⚠️ Please set it in the Secrets tool (Environment Variables).');
  } else {
    console.log('✅ JWT_SECRET is configured');
  }

  // Check if Twilio credentials are set
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.error('⚠️ WARNING: Twilio credentials are not fully configured!');
    console.error('⚠️ Contact messaging functionality will not work without TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.');
    console.error('⚠️ Please set them in the Secrets tool (Environment Variables).');
  } else {
    console.log('✅ Twilio credentials are configured');
  }

  console.log('📊 Starting keep-alive service...');
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