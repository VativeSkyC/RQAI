// Database service for shared database operations

/**
 * Creates all required database tables if they don't exist
 * @param {Object} pool - PostgreSQL connection pool
 */
const createTables = async (pool) => {
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
        is_approved BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create SMS messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sms_messages (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER REFERENCES contacts(id),
        user_id INTEGER REFERENCES users(id),
        message TEXT NOT NULL,
        twilio_sid VARCHAR(50),
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create SMS log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sms_log (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER REFERENCES contacts(id),
        user_id INTEGER REFERENCES users(id),
        message_type VARCHAR(50) NOT NULL,
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

    // Create permanent call_log table for debugging and recovery
    await client.query(`
      CREATE TABLE IF NOT EXISTS call_log (
        id SERIAL PRIMARY KEY,
        call_sid VARCHAR(50) UNIQUE NOT NULL,
        phone_number VARCHAR(15) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP
      )
    `);

    // Check if intake_responses table exists
    const tableCheckResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'intake_responses'
      )
    `);

    if (tableCheckResult.rows[0].exists) {
      console.log('Intake responses table exists, checking for required columns...');

      // Check for each required column and add if missing
      // Note: Removed 'goals' from the list as it's not part of the new intake flow
      // and added the four specific columns needed for the intake questionnaire
      const requiredColumns = [
        'user_id', 'communication_style', 'values', 
        'professional_goals', 'partnership_expectations', 'raw_transcript'
      ];

      for (const column of requiredColumns) {
        const columnExists = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.columns 
            WHERE table_name = 'intake_responses' AND column_name = $1
          )
        `, [column]);

        if (!columnExists.rows[0].exists) {
          console.log(`Adding missing column '${column}' to intake_responses table`);
          await client.query(`ALTER TABLE intake_responses ADD COLUMN ${column} TEXT`);
        }
      }
    } else {
      // Create the intake_responses table with all required columns
      console.log('Creating intake_responses table with all required columns');
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
          response_text TEXT,
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

/**
 * Cleans up old records from temp_calls table based on time interval
 * @param {Object} pool - PostgreSQL connection pool
 * @param {string} interval - PostgreSQL interval string (e.g., '4 hours', '1 day')
 */
const cleanupTempCalls = async (pool, interval = '4 hours') => {
  try {
    const result = await pool.query(`DELETE FROM temp_calls WHERE created_at < NOW() - INTERVAL '${interval}'`);
    console.log(`Cleaned up temp_calls table: ${result.rowCount} old records removed (older than ${interval})`);
    return result.rowCount;
  } catch (error) {
    console.error('Error cleaning up temp_calls:', error.message);
    throw error;
  }
};

/**
 * Cleans up all temp_calls records
 * @param {Object} pool - PostgreSQL connection pool
 */
const clearAllTempCalls = async (pool) => {
  try {
    const result = await pool.query('DELETE FROM temp_calls');
    console.log(`Cleared all records from temp_calls table: ${result.rowCount} records removed`);
    return result.rowCount;
  } catch (error) {
    console.error('Error clearing temp_calls:', error.message);
    throw error;
  }
};

/**
 * Cleans up temp_calls records for a specific phone number
 * @param {Object} pool - PostgreSQL connection pool
 * @param {string} phoneNumber - Phone number to remove
 */
const clearTempCallsByPhone = async (pool, phoneNumber) => {
  try {
    const result = await pool.query('DELETE FROM temp_calls WHERE phone_number = $1', [phoneNumber]);
    console.log(`Cleared temp_calls for phone ${phoneNumber}: ${result.rowCount} records removed`);
    return result.rowCount;
  } catch (error) {
    console.error(`Error clearing temp_calls for ${phoneNumber}:`, error.message);
    throw error;
  }
};

module.exports = {
  createTables,
  cleanupTempCalls,
  clearAllTempCalls,
  clearTempCallsByPhone
};