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
const intakeRoutes = require('./routes/intakeRoutes');

// Middleware
app.use(bodyParser.json());

// Make app available globally for service access
global.app = app;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Import connection manager and database service
const connectionManager = require('./services/connectionManager');
const retry = require('retry-as-promised');

// Initialize database connection
const initializeDatabase = () => {
  try {
    // Initialize connection manager with connection string
    const pool = connectionManager.initialize(process.env.DATABASE_URL);

    // Make pool available to route handlers
    app.set('pool', pool);

    // Try to connect and create tables
    connectionManager.getClient()
      .then(async (client) => {
        try {
          console.log('Connected to PostgreSQL');
          // Ensure tables are created
          await dbService.createTables(pool);
          console.log('Database schema initialized successfully');

          // Set up a scheduled keep-alive ping
          setInterval(() => {
            console.log('Keeping alive...');
            connectionManager.keepAlive();
          }, 60000); // Every minute
        } finally {
          client.release();
        }
      })
      .catch((error) => {
        console.error('Initial PostgreSQL connection error:', error.message);
        console.log('Retry failed after multiple attempts.');
        // Handle the case where all retries failed - you might want to exit or alert
      });
  } catch (error) {
    console.error('Error initializing database connection:', error.message);
    console.log('Retrying in 5 seconds...');
    setTimeout(initializeDatabase, 5000);
  }
};

initializeDatabase();

// Register route modules
app.use('/', authRoutes);
app.use('/contacts', contactRoutes);
app.use('/', messagingRoutes);
app.use('/', twilioRoutes); // Keep the root path for twilio endpoints
app.use('/', intakeRoutes); // Add the new intake routes

// Redirect to the static version of the interface
app.get('/old-interface', (req, res) => {
  res.redirect('/');
});

// Database health check endpoint
app.get('/db-check', async (req, res) => {
  try {
    const pool = req.app.get('pool');
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      res.json({
        status: 'connected',
        tables: result.rows.map(row => row.table_name),
        message: 'Database connection successful'
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Database check error:', error.message);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Data reception endpoint - redirected to dedicated intake routes file
app.get('/receive-data', async (req, res) => {
  console.log('DEBUG: Redirecting to new intake routes module');
  res.status(200).json({
    status: "success",
    message: 'This endpoint is now handled by the intakeRoutes module',
    note: 'For proper processing, please send a POST request to /receive-data',
    server_time: new Date().toISOString(),
    ngrok_url: req.headers['x-forwarded-proto'] ? 
              `${req.headers['x-forwarded-proto']}://${req.headers.host}` : 
              "Unknown ngrok URL",
  });
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

// Enhanced healthcheck endpoint for uptime monitoring
app.get('/ping', async (req, res) => {
  console.log('Received ping from UptimeRobot at', new Date().toISOString());

  // Check database connection as part of health check
  try {
    const pool = req.app.get('pool');
    if (!pool) {
      return res.status(503).json({
        status: 'degraded',
        database: 'not connected',
        server: 'running'
      });
    }

    // Try a simple query to verify db connection
    const client = await pool.connect();
    try {
      await client.query('SELECT 1 as connection_test');
      return res.status(200).json({
        status: 'ok',
        database: 'connected',
        server: 'running'
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Health check failed:', err.message);
    return res.status(503).json({
      status: 'degraded',
      database: 'error',
      server: 'running',
      error: err.message
    });
  }
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

// Debug endpoint to check database credentials and connection
app.get('/debug-database', async (req, res) => {
  try {
    // Show database environment variables (censored)
    const dbConfig = {
      DATABASE_URL: process.env.DATABASE_URL ? "***HIDDEN***" : undefined,
      DB_HOST: process.env.DB_HOST,
      DB_NAME: process.env.DB_NAME,
      DB_USER: process.env.DB_USER,
      DB_PORT: process.env.DB_PORT,
      DB_PASSWORD: process.env.DB_PASSWORD ? "***HIDDEN***" : undefined,
    };
    
    // Test connection
    let connectionStatus = "Unknown";
    let testResult = null;
    let tables = [];
    
    try {
      const pool = req.app.get('pool');
      if (!pool) {
        connectionStatus = "No pool available";
      } else {
        const client = await pool.connect();
        try {
          connectionStatus = "Connected";
          // Test query
          testResult = await client.query('SELECT NOW() as server_time');
          
          // Get list of tables
          const tablesResult = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
          `);
          tables = tablesResult.rows.map(row => row.table_name);
        } finally {
          client.release();
        }
      }
    } catch (error) {
      connectionStatus = `Error: ${error.message}`;
    }
    
    res.json({
      database_config: dbConfig,
      connection_status: connectionStatus,
      server_time: testResult?.rows[0]?.server_time,
      tables: tables,
      global_ngrok_url: global.ngrokUrl,
      server_port: activePort
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    // Configure ngrok with fixed subdomain
    const ngrokOptions = {
      addr: activePort,
      subdomain: 'ai-relationship-agent',
      authtoken: process.env.NGROK_AUTH_TOKEN,
      onLogEvent: (message) => console.log(`NGROK LOG: ${message}`),
    };

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

// Setup error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Keep database connection alive with a ping every 30 seconds
setInterval(() => {
  console.log('Keeping alive...');
  connectionManager.keepAlive();
}, 30000);