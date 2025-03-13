
const axios = require('axios');

/**
 * Parses a raw transcript using a custom LLM (GPT-4o-mini or similar)
 * @param {string} rawTranscript - The raw transcript text to parse
 * @returns {Promise<Object>} - The parsed fields in JSON format
 */
async function parseTranscript(rawTranscript) {
  try {
    // Make sure we have a valid transcript
    if (!rawTranscript || rawTranscript.trim() === '') {
      throw new Error('Empty transcript provided');
    }

    // Call the LLM API (replace with your actual API endpoint)
    const llmResponse = await axios.post(process.env.LLM_API_ENDPOINT, {
      transcript: rawTranscript,
      // Add any other parameters needed for your LLM API
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LLM_API_KEY}`
      }
    });

    // Extract the parsed fields from the LLM response
    const parsedData = llmResponse.data;
    
    // Basic validation of the response format
    if (!parsedData.communication_style && 
        !parsedData.professional_goals && 
        !parsedData.values && 
        !parsedData.partnership_expectations) {
      throw new Error('LLM response missing required fields');
    }

    return parsedData;
  } catch (error) {
    console.error('Error parsing transcript with LLM:', error.message);
    throw error;
  }
}

/**
 * Updates the intake_responses record with the parsed data
 * @param {Object} pool - PostgreSQL connection pool
 * @param {number} intakeResponseId - The ID of the intake_responses record to update
 * @param {Object} parsedData - The parsed fields from the LLM
 * @returns {Promise<Object>} - The updated intake response record
 */
async function updateIntakeWithParsedData(pool, intakeResponseId, parsedData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update the intake_responses record with the parsed fields
    const result = await client.query(`
      UPDATE intake_responses 
      SET 
        communication_style = $1,
        professional_goals = $2,
        values = $3,
        partnership_expectations = $4
      WHERE id = $5
      RETURNING *
    `, [
      parsedData.communication_style || null,
      parsedData.professional_goals || null,
      parsedData.values || null, 
      parsedData.partnership_expectations || null,
      intakeResponseId
    ]);

    await client.query('COMMIT');
    
    console.log(`Updated intake response #${intakeResponseId} with parsed data`);
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating intake with parsed data:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  parseTranscript,
  updateIntakeWithParsedData
};
