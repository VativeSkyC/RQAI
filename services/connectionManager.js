
const { Pool } = require('pg');
const retry = require('retry-as-promised');

let pool;
let pingCounter = 0;

/**
 * Initialize the database connection pool
 * @param {string} connectionString - PostgreSQL connection string
 * @returns {Pool} The connection pool
 */
function initialize(connectionString) {
  if (!pool) {
    try {
      // Validate connection string
      if (!connectionString) {
        throw new Error('Connection string is required');
      }

      // Create a connection pool
      pool = new Pool({
        connectionString,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      console.log('Created new database connection pool');
    } catch (error) {
      console.error('Error initializing pool:', error.message);
      throw error;
    }
  }
  return pool;
}

/**
 * Get a database client with retry logic
 * @returns {Promise<Client>} PostgreSQL client
 */
async function getClient() {
  if (!pool) {
    throw new Error('Pool not initialized');
  }

  return retry(async () => {
    const client = await pool.connect();
    return client;
  }, {
    max: 5,                  // Maximum amount of tries
    timeout: 10000,          // Timeout between retries in ms
    backoffBase: 1000,       // Initial backoff duration in ms
    backoffExponent: 1.5,    // Exponential factor
    name: 'pg-connect',      // If name is provided, logs will have prefix
    match: [
      /Connection terminated/,
      /Connection refused/,
      /timeout exceeded/,
      /ECONNREFUSED/,
      /ENOTFOUND/
    ],
    report: (message, attempt, err) => {
      console.log(`Database connection attempt ${attempt}: ${err.message}`);
    }
  });
}

/**
 * Keep the database connection alive
 * @returns {Promise<boolean>} True if ping succeeds
 */
async function keepAlive() {
  pingCounter++;
  try {
    const client = await retry(async () => {
      return await pool.connect();
    }, {
      max: 3,
      timeout: 5000,
      backoffBase: 1000,
      backoffExponent: 1.5,
      name: 'pg-ping',
      report: (message, attempt, err) => {
        console.log(`Keep-alive attempt ${attempt}: ${err.message}`);
      }
    });

    try {
      await client.query('SELECT 1');
      console.log('Keep-alive successful - Server pinged');
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Keep-alive ping failed:', error.message);
    return false;
  }
}

module.exports = {
  initialize,
  getClient,
  keepAlive
};
