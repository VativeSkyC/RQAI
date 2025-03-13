const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

/**
 * Parses a raw transcript using OpenAI's API (GPT-4o-mini)
 * @param {string} rawTranscript - The raw transcript text to parse
 * @returns {Promise<Object>} - The parsed fields in JSON format
 */
async function parseTranscript(rawTranscript) {
  try {
    // Make sure we have a valid transcript
    if (!rawTranscript || rawTranscript.trim() === '') {
      throw new Error('Empty transcript provided');
    }

    // In a real implementation, this would call OpenAI API
    // For now, we'll return mock data
    return {
      communication_style: "Parsed communication style",
      values: "Parsed values",
      professional_goals: "Parsed professional goals",
      partnership_expectations: "Parsed partnership expectations"
    };
  } catch (error) {
    console.error('Error parsing transcript:', error);
    throw error;
  }
}

/**
 * Updates an intake response with parsed data
 * @param {Object} pool - Database connection pool
 * @param {number} intakeResponseId - ID of the intake response to update
 * @param {Object} parsedData - The parsed data to update with
 * @returns {Promise<Object>} - The updated intake response
 */
async function updateIntakeWithParsedData(pool, intakeResponseId, parsedData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE intake_responses
      SET
        communication_style = $1,
        values = $2,
        professional_goals = $3,
        partnership_expectations = $4,
        updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [
      parsedData.communication_style,
      parsedData.values,
      parsedData.professional_goals,
      parsedData.partnership_expectations,
      intakeResponseId
    ]);

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating intake with parsed data:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Process intake data from ElevenLabs
 * @param {Object} data - The data from ElevenLabs
 * @returns {Promise<Object>} - Processing result
 */
async function processIntakeData(data) {
  try {
    console.log('=== INTAKE FIELDS ANALYSIS ===');
    console.log('callSid:', data.callSid ? data.callSid : 'NOT PROVIDED');
    console.log('caller:', data.caller);
    console.log('communication_style:', data.communication_style ? 'PRESENT' : 'MISSING');
    console.log('values:', data.values ? 'PRESENT' : 'MISSING');
    console.log('professional_goals:', data.professional_goals ? 'PRESENT' : 'MISSING');
    console.log('partnership_expectations:', data.partnership_expectations ? 'PRESENT' : 'MISSING');
    console.log('raw_transcript:', data.raw_transcript ? `PRESENT (${data.raw_transcript.length} chars)` : 'MISSING');

    // Generate idempotency key
    const timestamp = Date.now();
    const randomPart = crypto.randomBytes(6).toString('hex');
    const idempotencyKey = `elevenlabs-${timestamp}-${randomPart}`;
    console.log('Processing with idempotency key:', idempotencyKey);

    // Use direct pool query like in auth.js, which works with Supabase
    try {
      console.log('Getting database pool directly from global app');
      const pool = global.app.get('pool');
      if (!pool) {
        throw new Error('Database connection not available');
      }

      console.log('Checking if phone number already exists:', data.caller);
      // Check if record exists
      const checkResult = await pool.query(
        'SELECT id FROM intake_responses WHERE phone_number = $1',
        [data.caller]
      );

      let intakeId;
      if (checkResult.rows.length > 0) {
        // Update existing record - using direct pool query
        intakeId = checkResult.rows[0].id;
        console.log(`Updating existing intake record #${intakeId} for phone ${data.caller}`);

        await pool.query(`
          UPDATE intake_responses
          SET 
            communication_style = $1,
            values = $2,
            professional_goals = $3,
            partnership_expectations = $4,
            raw_transcript = $5,
            updated_at = NOW()
          WHERE id = $6
        `, [
          data.communication_style,
          data.values,
          data.professional_goals,
          data.partnership_expectations,
          data.raw_transcript,
          intakeId
        ]);

        console.log(`Successfully updated intake record #${intakeId}`);
      } else {
        // Insert new record - using direct pool query like in auth.js
        console.log(`Creating new intake record for phone ${data.caller}`);

        const insertResult = await pool.query(`
          INSERT INTO intake_responses 
          (phone_number, communication_style, values, professional_goals, 
           partnership_expectations, raw_transcript, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
          RETURNING id
        `, [
          data.caller,
          data.communication_style, 
          data.values,
          data.professional_goals,
          data.partnership_expectations,
          data.raw_transcript
        ]);

        intakeId = insertResult.rows[0].id;
        console.log(`Successfully inserted new intake record with ID: ${intakeId}`);
      }

      console.log(`Successfully saved intake data with ID: ${intakeId}`);

      return {
        status: 'saved',
        idempotency_key: idempotencyKey,
        intake_id: intakeId,
        fields_received: {
          caller_id: !!data.caller,
          communication_style: !!data.communication_style,
          values: !!data.values,
          professional_goals: !!data.professional_goals,
          partnership_expectations: !!data.partnership_expectations,
          raw_transcript: !!data.raw_transcript
        }
      };
    } catch (error) {
      console.error('Database error saving intake data:', error);
      throw error;
    }
  } catch (error) {
    console.error('Error processing intake data:', error);
    throw error;
  }
}


module.exports = {
  processIntakeData,
  parseTranscript,
  updateIntakeWithParsedData
};