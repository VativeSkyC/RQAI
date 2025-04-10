
const { Pool } = require('pg');
const retryPromised = require('retry-as-promised').default;

let pool = null;

function initialize(connectionString) {
  console.log('=== Database Connection Initialization ===');
  console.log('Environment:', {
    REPL_SLUG: process.env.REPL_SLUG,
    REPL_ID: process.env.REPL_ID,
    NODE_ENV: process.env.NODE_ENV
  });

  let dbUrl = connectionString || process.env.DATABASE_URL;
  if (dbUrl && !dbUrl.includes('supabase.co')) {
    dbUrl = dbUrl.replace('.us-east-2', '-pooler.us-east-2');
  }

  const poolConfig = {
    connectionString: dbUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.NODE_ENV === 'production' ? {
      rejectUnauthorized: false
    } : false
  };

  console.log('Creating pool with config:', {
    ...poolConfig,
    connectionString: '***HIDDEN***'
  });

  pool = new Pool(poolConfig);

  pool.on('connect', () => {
    console.log('Database connection established');
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle client:', err.message);
  });

  return pool;
}

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
      throw err;
    }
  }, {
    max: 5,
    timeout: 60000,
    backoffBase: 1000,
    backoffExponent: 1.5,
    report: (message) => console.log(`Retry status: ${message}`)
  });
}

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
