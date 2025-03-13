const { Pool } = require('pg');
const { retryAsPromised } = require('retry-as-promised');

// Create a pool with connection parameters from environment variables
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'twilio_project',
  password: process.env.DB_PASSWORD || 'postgres',
  port: process.env.DB_PORT || 5432,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Log connection events for debugging
pool.on('connect', () => {
  console.log('Database connection established');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client:', err.message);
});

// Function to get a pool connection with retry logic
async function getClient() {
  return retryAsPromised(async () => {
    try {
      const client = await pool.connect();
      console.log('Pool connection acquired');
      return client;
    } catch (err) {
      console.error('Initial PostgreSQL connection error:', err.message);
      console.log('Retrying in 5 seconds...');
      throw err; // Throw the error so retry-as-promised can catch it
    }
  }, {
    max: 5, // Maximum number of retries
    timeout: 60000, // Overall timeout for all retries
    backoffBase: 1000, // Initial backoff duration
    backoffExponent: 1.5, // Backoff factor
    report: (message) => {
      console.log('Retry attempt:', message);
    },
    name: 'Database connection retry'
  });
}

// Test connection function
async function testConnection() {
  let client;
  try {
    client = await getClient();
    const result = await client.query('SELECT NOW() as current_time');
    console.log('Database connection test successful:', result.rows[0].current_time);
    return true;
  } catch (err) {
    console.error('Database connection test failed:', err.message);
    return false;
  } finally {
    if (client) {
      client.release();
      console.log('Connection released after test');
    }
  }
}

module.exports = {
  pool,
  getClient,
  testConnection
};