const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const ngrok = require('ngrok');
const http = require('http');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 5000;
const FALLBACK_PORTS = [5001, 8000, 8080, 3000];
let activePort = PORT;

// Import services and routes
const dbService = require('./services/dbService');
const authRoutes = require('./routes/auth');
const contactRoutes = require('./routes/contacts');
const messagingRoutes = require('./routes/messaging');
const twilioRoutes = require('./routes/twilio');

// Middleware
app.use(bodyParser.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Make pool available to route handlers
app.set('pool', pool);

// Database connection with retry
const connectToDatabase = () => {
  pool.connect()
    .then(() => {
      console.log('Connected to PostgreSQL');
      return dbService.createTables(pool);
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

// Register route modules
app.use('/', authRoutes);
app.use('/contacts', contactRoutes);
app.use('/', messagingRoutes);
app.use('/', twilioRoutes); // Keep the root path for twilio endpoints

// Redirect to the static version of the interface
app.get('/old-interface', (req, res) => {
  res.redirect('/');
});

// Data reception endpoint from Eleven Labs - GET route for testing
app.get('/receive-data', async (req, res) => {
  console.log('DEBUG: Received GET request to /receive-data');

  try {
    // Check if the database is accessible
    const client = await pool.connect();

    try {
      // Check if tables exist first to avoid errors
      const tableCheckResult = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'call_log'
        )
      `);

      const tableExists = tableCheckResult.rows[0].exists;
      let recentCalls = [];

      if (tableExists) {
        const callLogResult = await client.query(
          'SELECT call_sid, phone_number, status, created_at, processed_at FROM call_log ORDER BY created_at DESC LIMIT 5'
        );
        recentCalls = callLogResult.rows;
      }

      // Return a test response for easier debugging
      res.status(200).json({
        status: "success",
        message: 'This endpoint requires a POST request with callSid from Eleven Labs',
        note: 'This GET handler is for debugging only',
        server_time: new Date().toISOString(),
        database_connected: true,
        call_log_table_exists: tableExists,
        recent_calls: recentCalls,
        ngrok_url: req.headers['x-forwarded-proto'] ? 
                  `${req.headers['x-forwarded-proto']}://${req.headers.host}` : 
                  "Unknown ngrok URL",
        expected_post_format: {
          callSid: "CALL_SID_FROM_TWILIO",
          communication_style: "Sample communication style",
          goals: "Sample goals",
          values: "Sample values",
          professional_goals: "Sample professional goals",
          partnership_expectations: "Sample partnership expectations",
          raw_transcript: "Sample raw transcript"
        }
      });
    } catch (dbError) {
      console.error('Database error:', dbError.message);
      res.status(500).json({ 
        status: "error", 
        message: 'Database error', 
        error: dbError.message,
        database_connected: false,
        ngrok_url: req.headers['x-forwarded-proto'] ? 
                  `${req.headers['x-forwarded-proto']}://${req.headers.host}` : 
                  "Unknown ngrok URL"
      });
    } finally {
      client.release();
    }
  } catch (connectionError) {
    console.error('Database connection error:', connectionError.message);
    res.status(500).json({ 
      status: "error", 
      message: 'Database connection error', 
      error: connectionError.message,
      database_connected: false,
      ngrok_url: req.headers['x-forwarded-proto'] ? 
                `${req.headers['x-forwarded-proto']}://${req.headers.host}` : 
                "Unknown ngrok URL"
    });
  }
});

// Improved keep-alive mechanism
const keepAlive = () => {
  setInterval(() => {
    console.log('Keeping alive...');
    http.get(`http://0.0.0.0:${activePort}/`, (res) => {
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

// Scheduled cleanup for temp_calls table with longer retention
setInterval(async () => {
  await dbService.cleanupTempCalls(pool);
}, 60 * 60 * 1000); // Every 60 minutes

// Ping endpoint for uptime monitoring
app.get('/ping', (req, res) => {
  console.log('Received ping from UptimeRobot at', new Date().toISOString());
  res.status(200).send('OK');
});

// Debug endpoint to show current configuration
app.get('/debug-config', (req, res) => {
  const baseUrl = req.protocol + '://' + req.get('host');
  const ngrokUrl = global.ngrokUrl || baseUrl;
  
  res.json({
    base_url: baseUrl,
    ngrok_url: ngrokUrl,
    important_endpoints: {
      voice_endpoint: `${ngrokUrl}/voice`,
      personalization_endpoint: `${ngrokUrl}/twilio-personalization`,
      receive_data_endpoint: `${ngrokUrl}/receive-data`
    },
    environment_check: {
      jwt_secret_configured: !!process.env.JWT_SECRET,
      twilio_configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
      elevenlabs_secret_configured: !!process.env.ELEVENLABS_SECRET
    }
  });
});

// Start server and ngrok tunnel with port fallback
function startServer(port, fallbackIndex = 0) {
  const server = app.listen(port, '0.0.0.0', async () => {
    activePort = port;
    console.log('=======================================================');
    console.log(`⚡ Server running on port ${port}`);
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
    // First, make sure we don't have any existing tunnels
    try {
      console.log('Cleaning up any existing ngrok tunnels...');
      await ngrok.kill();
      console.log('Successfully terminated any existing ngrok processes');
    } catch (killError) {
      console.log('No existing ngrok processes to kill or error:', killError.message);
    }

    // Simplified ngrok setup approach
    let ngrokOptions = {
      addr: activePort, // Use the active port that was successfully bound
      onLogEvent: (message) => console.log(`NGROK LOG: ${message}`),
    };

    // Add authtoken and subdomain if available
    if (process.env.NGROK_AUTH_TOKEN) {
      ngrokOptions.authtoken = process.env.NGROK_AUTH_TOKEN;
      console.log('✅ Found NGROK_AUTH_TOKEN in environment variables');

      // Only try to use subdomain if we have an auth token
      if (process.env.NGROK_SUBDOMAIN) {
        ngrokOptions.subdomain = process.env.NGROK_SUBDOMAIN;
        console.log(`✅ Using custom subdomain: ${ngrokOptions.subdomain}`);
      } else {
        ngrokOptions.subdomain = 'ai-relationship-agent';
        console.log(`✅ Using default subdomain: ${ngrokOptions.subdomain}`);
      }
    } else {
      console.warn('⚠️ NGROK_AUTH_TOKEN is not set. Using random URL.');
    }

    // Connect to ngrok with our options
    console.log(`\n🔄 ESTABLISHING NGROK TUNNEL on port ${activePort}...`);
    console.log('Options:', JSON.stringify({
      ...ngrokOptions,
      authtoken: ngrokOptions.authtoken ? '***HIDDEN***' : undefined
    }, null, 2));

    const url = await ngrok.connect(ngrokOptions);

    console.log('\n\n');
    console.log('================================================================');
    console.log(`✅ NGROK TUNNEL SUCCESSFULLY ESTABLISHED!`);
    console.log('================================================================');
    console.log(`📝 IMPORTANT URLS:`);
    console.log(`🌍 Main Site: ${url}`);
    console.log(`📊 Dashboard: ${url}/dashboard.html`);
    console.log(`🔈 Voice Webhook: ${url}/voice`);
    console.log(`📥 Data Webhook: ${url}/receive-data`);
    console.log('----------------------------------------------------------------');
    console.log(`Set Twilio Webhook URL to: ${url}/voice`);
    console.log(`Set ElevenLabs Webhook URL to: ${url}/receive-data`);
    console.log('================================================================\n\n');

    // Store ngrok URL in global variable for use throughout the application
    global.ngrokUrl = url;
  } catch (error) {
    console.error('\n\n⚠️ ERROR ESTABLISHING NGROK TUNNEL:', error.message);

    if (error.message.includes('account may not run more than 1 online ngrok processes')) {
      console.log('\n👉 You already have an ngrok tunnel running elsewhere.');
      console.log('👉 Please close other ngrok instances before starting a new one.');
    } else if (error.message.includes('subdomain')) {
      console.log('\n👉 The subdomain "ai-relationship-agent" is currently in use.');
      console.log('👉 Try setting a different NGROK_SUBDOMAIN in your environment variables.');
    } else if (error.message.includes('authtoken')) {
      console.log('\n👉 Your NGROK_AUTH_TOKEN may be invalid or expired.');
      console.log('👉 Get a new token at https://dashboard.ngrok.com/get-started/your-authtoken');
    }

    console.log('\n⚙️ Server is still running locally at:');
    console.log(`🔗 Local URL: http://localhost:${PORT}`);
    console.log(`🔗 Replit URL: https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`);
  }
});

// Add error handler for process
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.log('Server will continue running if possible');
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      if (fallbackIndex < FALLBACK_PORTS.length) {
        console.log(`⚠️ Port ${port} is already in use. Trying alternative port ${FALLBACK_PORTS[fallbackIndex]}...`);
        startServer(FALLBACK_PORTS[fallbackIndex], fallbackIndex + 1);
      } else {
        console.error('❌ All ports are in use. Please restart your repl or kill the running processes.');
      }
    } else {
      console.error('Server error:', error);
    }
  });
}

// Start the server with the primary port
startServer(PORT);