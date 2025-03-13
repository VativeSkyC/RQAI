
const axios = require('axios');

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

    // OpenAI API endpoint should be something like: https://api.openai.com/v1/chat/completions
    const endpoint = process.env.LLM_API_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
    
    // Call the OpenAI API
    const response = await axios.post(endpoint, {
      model: "gpt-4o-mini", // The model you're using
      messages: [
        {
          role: "system", 
          content: "You are an assistant that extracts information from intake call transcripts. Return ONLY a JSON object with these fields: communication_style, professional_goals, values, partnership_expectations. Do not include any other text in your response."
        },
        {
          role: "user",
          content: `Please analyze this intake call transcript and extract the key information into structured fields:\n\n${rawTranscript}`
        }
      ],
      temperature: 0.3, // Lower temperature for more consistent extraction
      response_format: { type: "json_object" } // Request JSON format directly
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LLM_API_KEY}`
      }
    });

    // Extract the parsed fields from the OpenAI response
    const parsedData = JSON.parse(response.data.choices[0].message.content);
    
    // Log the raw response from OpenAI
    console.log('=== RAW LLM RESPONSE ===');
    console.log(JSON.stringify(response.data.choices[0].message.content, null, 2));
    
    // Basic validation of the response format
    const fieldsPresent = {
      communication_style: !!parsedData.communication_style || !!parsedData.communicationStyle || !!parsedData.communication_Style,
      professional_goals: !!parsedData.professional_goals || !!parsedData.professionalGoals,
      values: !!parsedData.values,
      partnership_expectations: !!parsedData.partnership_expectations || !!parsedData.partnershipExpectations
    };
    
    console.log('=== FIELDS PRESENT IN RESPONSE ===');
    console.log(JSON.stringify(fieldsPresent, null, 2));
    
    if (!fieldsPresent.communication_style || 
        !fieldsPresent.professional_goals || 
        !fieldsPresent.values || 
        !fieldsPresent.partnership_expectations) {
      console.warn('⚠️ OpenAI response missing some required fields:', parsedData);
    }

    return parsedData;
  } catch (error) {
    console.error('Error parsing transcript with OpenAI:', error.message);
    if (error.response) {
      console.error('OpenAI API error details:', error.response.data);
    }
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

    console.log('=== NORMALIZING FIELDS FROM PARSED DATA ===');
    console.log('Raw parsed data:', JSON.stringify(parsedData, null, 2));
    
    // Normalize field names from the API response (handle all possible variations)
    const normalizedData = {
      communication_style: parsedData.communication_style || parsedData.communicationStyle || parsedData.communication_Style || null,
      professional_goals: parsedData.professional_goals || parsedData.professionalGoals || parsedData.professional_goals || null,
      values: parsedData.values || null,
      partnership_expectations: parsedData.partnership_expectations || parsedData.partnershipExpectations || null
    };
    
    console.log('Normalized data:', JSON.stringify(normalizedData, null, 2));

    // Update the intake_responses record with the normalized fields
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
      normalizedData.communication_style,
      normalizedData.professional_goals,
      normalizedData.values, 
      normalizedData.partnership_expectations,
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
const { v4: uuidv4 } = require('uuid');

/**
 * Process intake data from ElevenLabs
 * @param {Object} data - The data from ElevenLabs
 * @returns {Promise<Object>} - Processing result
 */
async function processIntakeData(data) {
  try {
    console.log('=== INTAKE FIELDS ANALYSIS ===');
    console.log('callSid:', data.call_sid || 'NOT PROVIDED');
    console.log('caller:', data.caller || 'NOT PROVIDED');
    console.log('communication_style:', data.communication_style ? 'PRESENT' : 'MISSING');
    console.log('values:', data.values ? 'PRESENT' : 'MISSING');
    console.log('professional_goals:', data.professional_goals ? 'PRESENT' : 'MISSING');
    console.log('partnership_expectations:', data.partnership_expectations ? 'PRESENT' : 'MISSING');
    console.log('raw_transcript:', data.raw_transcript ? `PRESENT (${data.raw_transcript.length} chars)` : 'MISSING');

    // Generate an idempotency key
    const timestamp = new Date().getTime();
    const randomPart = uuidv4().split('-')[0];
    const idempotencyKey = `elevenlabs-${timestamp}-${randomPart}`;
    console.log('Processing with idempotency key:', idempotencyKey);

    // Here you would store the data in your database
    // For now, let's return a success response
    return {
      status: 'received',
      idempotency_key: idempotencyKey,
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
    console.error('Error processing intake data:', error);
    throw error;
  }
}

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

    // OpenAI API endpoint should be something like: https://api.openai.com/v1/chat/completions
    const endpoint = process.env.LLM_API_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
    
    // Call the OpenAI API
    const response = await axios.post(endpoint, {
      model: "gpt-4o-mini", // The model you're using
      messages: [
        {
          role: "system", 
          content: "You are an assistant that extracts information from intake call transcripts. Return ONLY a JSON object with these fields: communication_style, professional_goals, values, partnership_expectations. Do not include any other text in your response."
        },
        {
          role: "user",
          content: `Please analyze this intake call transcript and extract the key information into structured fields:\n\n${rawTranscript}`
        }
      ],
      temperature: 0.3, // Lower temperature for more consistent extraction
      response_format: { type: "json_object" } // Request JSON format directly
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LLM_API_KEY}`
      }
    });

    // Extract the parsed fields from the OpenAI response
    const parsedData = JSON.parse(response.data.choices[0].message.content);
    
    // Log the raw response from OpenAI
    console.log('=== RAW LLM RESPONSE ===');
    console.log(JSON.stringify(response.data.choices[0].message.content, null, 2));
    
    // Basic validation of the response format
    const fieldsPresent = {
      communication_style: !!parsedData.communication_style || !!parsedData.communicationStyle || !!parsedData.communication_Style,
      professional_goals: !!parsedData.professional_goals || !!parsedData.professionalGoals,
      values: !!parsedData.values,
      partnership_expectations: !!parsedData.partnership_expectations || !!parsedData.partnershipExpectations
    };
    
    console.log('=== FIELDS PRESENT IN RESPONSE ===');
    console.log(JSON.stringify(fieldsPresent, null, 2));
    
    if (!fieldsPresent.communication_style || 
        !fieldsPresent.professional_goals || 
        !fieldsPresent.values || 
        !fieldsPresent.partnership_expectations) {
      console.warn('⚠️ OpenAI response missing some required fields:', parsedData);
    }

    return parsedData;
  } catch (error) {
    console.error('Error parsing transcript with OpenAI:', error.message);
    if (error.response) {
      console.error('OpenAI API error details:', error.response.data);
    }
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

    console.log('=== NORMALIZING FIELDS FROM PARSED DATA ===');
    console.log('Raw parsed data:', JSON.stringify(parsedData, null, 2));
    
    // Normalize field names from the API response (handle all possible variations)
    const normalizedData = {
      communication_style: parsedData.communication_style || parsedData.communicationStyle || parsedData.communication_Style || null,
      professional_goals: parsedData.professional_goals || parsedData.professionalGoals || parsedData.professional_goals || null,
      values: parsedData.values || null,
      partnership_expectations: parsedData.partnership_expectations || parsedData.partnershipExpectations || null
    };
    
    console.log('Normalized data:', JSON.stringify(normalizedData, null, 2));

    // Update the intake_responses record with the normalized fields
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
      normalizedData.communication_style,
      normalizedData.professional_goals,
      normalizedData.values, 
      normalizedData.partnership_expectations,
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
  processIntakeData,
  parseTranscript,
  updateIntakeWithParsedData
};
