const { Pool } = require('pg');
const retry = require('retry-as-promised');

// Singleton connection manager to handle reconnections
class ConnectionManager {
  constructor() {
    this.pool = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 3000; // Start with 3 seconds
  }

  initialize(connectionString) {
    this.connectionString = connectionString;

    // Process the connection string to use Neon's connection pooler
    // This can help with stability in Replit environment
    this.poolerConnectionString = connectionString;
    if (connectionString && connectionString.includes('.us-east-2')) {
      this.poolerConnectionString = connectionString.replace('.us-east-2', '-pooler.us-east-2');
      console.log('Using connection pooler for improved stability');
    }

    if (!this.pool) {
      this.createPool();

      // Set up event listeners for pool errors
      this.pool.on('error', (err) => {
        console.error('Unexpected database pool error:', err.message);

        if (err.code === '57P01') {
          console.log('⚠️ Database connection terminated by administrator command. Will attempt reconnection.');
          this.handleReconnect();
        }
      });
    }

    return this.pool;
  }

  createPool() {
    this.pool = new Pool({
      connectionString: this.poolerConnectionString,
      max: 3, // Reduced to 3 to decrease connection pressure on Replit
      idleTimeoutMillis: 10000, // Reduced idle timeout
      connectionTimeoutMillis: 5000,
      // Add exponential backoff on connection failures
      retryDelay: this.calculateBackoff.bind(this),
    });

    console.log('Created new database connection pool');
    this.reconnectAttempts = 0; // Reset counter on successful creation
  }

  calculateBackoff(retryCount) {
    // Exponential backoff: 1s, 2s, 4s, 8s, etc. up to 60s
    return Math.min(1000 * Math.pow(2, retryCount), 60000);
  }

  async handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`Failed to reconnect after ${this.maxReconnectAttempts} attempts. Giving up.`);
      return;
    }

    this.reconnectAttempts++;
    console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);

    try {
      // Properly end the existing pool
      if (this.pool) {
        try {
          await this.pool.end();
        } catch (e) {
          console.log('Error ending pool:', e.message);
        }
      }

      // Wait with exponential backoff
      const delay = this.calculateBackoff(this.reconnectAttempts);
      console.log(`Waiting ${delay}ms before reconnecting...`);

      setTimeout(() => {
        try {
          this.createPool();
          console.log('Database pool recreated after interruption');

          // Test the connection immediately
          this.pool.query('SELECT 1')
            .then(() => console.log('✅ Connection test successful'))
            .catch(err => console.error('❌ Connection test failed:', err.message));
        } catch (err) {
          console.error('Error recreating pool:', err.message);
        }
      }, delay);
    } catch (error) {
      console.error('Error during reconnection:', error.message);
    }
  }

  getPool() {
    return this.pool;
  }

  async getClient() {
    if (!this.pool) {
      throw new Error('Connection pool not initialized');
    }

    try {
      return await this.pool.connect();
    } catch (err) {
      if (err.code === '57P01') {
        console.log('Connection terminated during client acquisition, attempting reconnect');
        this.handleReconnect();
        throw new Error('Database connection unavailable, please retry in a few seconds');
      }
      throw err;
    }
  }

  async query(text, params) {
    try {
      if (!this.pool) {
        console.error('No pool available for query. Attempting to reconnect...');
        this.createPool();
      }

      // Use retry-as-promised for robust query execution
      return await this.retry(async () => {
        try {
          const client = await this.pool.connect();
          try {
            const result = await client.query(text, params);
            return result;
          } finally {
            client.release();
          }
        } catch (err) {
          if (err.code === '57P01') {
            console.log('Connection terminated by administrator during query. Retrying...');
            // Force reconnection on next attempt
            this.pool.end().catch(e => console.error('Error ending pool:', e.message));
            this.pool = null;
            this.createPool();
          }
          throw err; // rethrow for retry
        }
      }, {
        max: 5, // Maximum 5 retry attempts
        backoffBase: 1000, // Start with 1 second delay
        backoffExponent: 1.5, // Exponential backoff
        report: (attempt, delay) => {
          console.log(`Query attempt ${attempt}. Retrying in ${delay}ms`);
        },
        match: [
          /53300/, // Too many connections
          /57P01/, // Terminating connection due to administrator command
          /ECONNRESET/,
          /ETIMEDOUT/,
          /EPIPE/
        ]
      });
    } catch (error) {
      console.error('Query failed after retries:', error.message);
      // Handle 57P01 error (terminating connection due to administrator command)
      if (error.code === '57P01') {
        console.error('Connection terminated by administrator. Attempting to reconnect...');
        this.handleReconnect(error);
      }
      throw error;
    }
  }
}

// Export as singleton
const connectionManager = new ConnectionManager();
module.exports = connectionManager;