
const { Pool } = require('pg');

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
      connectionString: this.connectionString,
      max: 5, // Reduced from 10 to decrease connection pressure
      idleTimeoutMillis: 30000,
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
        this.createPool();
        console.log('Database pool recreated after interruption');
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
    if (!this.pool) {
      throw new Error('Connection pool not initialized');
    }
    
    const client = await this.getClient();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }
}

// Export as singleton
const connectionManager = new ConnectionManager();
module.exports = connectionManager;
