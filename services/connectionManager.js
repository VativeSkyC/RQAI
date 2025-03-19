
const { Pool } = require('pg');
const retryPromised = require('retry-as-promised').default;

let pool = null;

// Initialize the pool with connection parameters
function initialize(connectionString) {
  console.log('Initializing database connection with URL:', 
              connectionString ? 'CONNECTION_STRING_PROVIDED' : 'No connection string provided');
  
  // Get connection string and modify for production pooling if needed
  let dbUrl = connectionString || process.env.DATABASE_URL;
  // Don't modify Supabase URLs - they're already configured for pooling
  if (dbUrl && !dbUrl.includes('supabase.co')) {
    dbUrl = dbUrl.replace('.us-east-2', '-pooler.us-east-2');
  }
  
  // Create connection configuration
  const poolConfig = {
    connectionString: dbUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  };

  // Simple SSL configuration that works in both environments
  poolConfig.ssl = {
    rejectUnauthorized: false
  };
  
  console.log('Creating pool with config:', {
    ...poolConfig,
    password: poolConfig.password ? '***HIDDEN***' : undefined,
    connectionString: poolConfig.connectionString ? '***HIDDEN***' : undefined
  });
  
  pool = new Pool(poolConfig);

  // Log connection events for debugging
  pool.on('connect', () => {
    console.log('Database connection established');
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle client:', err.message);
  });

  return pool;
}

// Function to get a pool connection with retry logic
async function getClient() {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initialize() first.');
  }
  
  return retryPromised(async () => {
    try {
      const client = await pool.connect();
      console.log('Pool connection acquired');
      return client;
    } catch (err) {
      console.error('PostgreSQL connection error:', err.message);
      console.log('Retrying in 5 seconds...');
      throw err; // Throw the error so retry can catch it
    }
  }, {
    max: 5, // Maximum number of retries
    timeout: 60000, // Overall timeout in milliseconds
    backoffBase: 1000, // Initial backoff duration in milliseconds
    backoffExponent: 1.5, // Exponent for exponential backoff
    report: (message) => console.log(`Retry status: ${message}`)
  });
}

// Function to keep the connection alive
async function keepAlive() {
  if (!pool) {
    console.log('No pool to keep alive. Initialize database first.');
    return;
  }
  
  let client;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    console.log('Database keep-alive ping successful');
  } catch (err) {
    console.error('Keep-alive ping failed:', err.message);
  } finally {
    if (client) {
      client.release();
    }
  }
}

// Test connection function
async function testConnection() {
  if (!pool) {
    console.log('No pool to test. Initialize database first.');
    return false;
  }
  
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time');
    console.log('Database connection test successful:', result.rows[0].current_time);
    return true;
  } catch (err) {
    console.error('Database connection test failed:', err.message);
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
}

module.exports = {
  initialize,
  getClient,
  testConnection,
  keepAlive
};
