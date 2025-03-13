
const express = require('express');
const router = express.Router();
const intakeAgentService = require('../services/intakeAgentService');

// Endpoint to receive raw transcript data from ElevenLabs
router.post('/receive-data', async (req, res) => {
  console.log('===========================================');
  console.log('🔄 RECEIVED DATA FROM ELEVEN LABS');
  console.log('===========================================');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  // Extract fields from the request - prefer communication style fields sent directly
  const communication_style = req.body.communication_style;
  const values = req.body.values;
  const professional_goals = req.body.professional_goals;
  const partnership_expectations = req.body.partnership_expectations;
  const raw_transcript = req.body.raw_transcript;

  console.log('=== INTAKE FIELDS ANALYSIS ===');
  console.log('communication_style:', communication_style ? 'PRESENT' : 'MISSING');
  console.log('values:', values ? 'PRESENT' : 'MISSING');
  console.log('professional_goals:', professional_goals ? 'PRESENT' : 'MISSING');
  console.log('partnership_expectations:', partnership_expectations ? 'PRESENT' : 'MISSING');
  console.log('raw_transcript:', raw_transcript ? `PRESENT (${raw_transcript.length} chars)` : 'MISSING');

  // Get caller phone number from the cached personalization data or directly from request
  // This caller should match what was sent during the personalization webhook
  const callerPhone = req.body.caller_id || req.body.caller || req.body.phone_number;
  console.log('Looking up contact with phone number:', callerPhone);
  
  const pool = req.app.get('pool');
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    console.log('=== STARTING DATABASE OPERATIONS ===');

    // Find the contact using the caller_id that was previously validated in the personalization webhook
    const contactResult = await client.query(
      'SELECT id, user_id FROM contacts WHERE phone_number = $1 LIMIT 1',
      [callerPhone]
    );
    
    if (contactResult.rows.length === 0) {
      console.error(`ERROR: No contact found with phone number: ${callerPhone}`);
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        error: 'Contact not found', 
        message: `No contact found with phone number: ${callerPhone}`
      });
    }
    
    const { id: contactId, user_id } = contactResult.rows[0];
    console.log(`Found contact ID: ${contactId} for phone: ${callerPhone}`);

    // Step B: Insert a new record in intake_responses with all available fields
    console.log('=== INSERTING INTO INTAKE_RESPONSES ===');
    console.log('- contact_id:', contactId);
    console.log('- user_id:', user_id);
    console.log('- communication_style:', communication_style || 'NULL');
    console.log('- values:', values || 'NULL');
    console.log('- professional_goals:', professional_goals || 'NULL');
    console.log('- partnership_expectations:', partnership_expectations || 'NULL');
    console.log('- raw_transcript:', raw_transcript ? 'PRESENT' : 'NULL');
    
    const insertResult = await client.query(`
      INSERT INTO intake_responses (
        contact_id,
        user_id,
        communication_style,
        values,
        professional_goals,
        partnership_expectations,
        raw_transcript,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING id
    `, [
      contactId, 
      user_id, 
      communication_style || null, 
      values || null, 
      professional_goals || null, 
      partnership_expectations || null, 
      raw_transcript || null
    ]);

    const newResponseId = insertResult.rows[0].id;
    await client.query('COMMIT');

    console.log(`Successfully inserted intake data for contact #${contactId}, new intake_responses ID: ${newResponseId}`);
    
    // Only start async parsing if we don't already have the structured fields
    // and we have a raw transcript to process
    if (raw_transcript && (!communication_style || !values || !professional_goals || !partnership_expectations)) {
      console.log('Starting async parsing of raw transcript...');
      processTranscriptAsync(pool, newResponseId, raw_transcript);
    } else {
      console.log('All fields already present, skipping transcript parsing');
    }
    
    return res.json({ 
      message: 'Intake data stored successfully', 
      intakeResponseId: newResponseId 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error storing intake data:', error.message);
    return res.status(500).json({ 
      error: 'Database error storing intake data', 
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Endpoint to manually trigger parsing for an existing intake response
router.post('/parse-transcript/:intakeId', async (req, res) => {
  const { intakeId } = req.params;
  const pool = req.app.get('pool');
  const client = await pool.connect();
  
  try {
    // Retrieve the raw transcript from the database
    const intakeResult = await client.query(
      'SELECT id, raw_transcript FROM intake_responses WHERE id = $1',
      [intakeId]
    );
    
    if (intakeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Intake response not found' });
    }
    
    const { id, raw_transcript } = intakeResult.rows[0];
    
    if (!raw_transcript) {
      return res.status(400).json({ error: 'No raw transcript available to parse' });
    }
    
    // Start processing the transcript
    processTranscriptAsync(pool, id, raw_transcript)
      .then(() => {
        console.log(`Manual parsing of intake #${id} completed`);
      })
      .catch(error => {
        console.error(`Error in manual parsing of intake #${id}:`, error.message);
      });
    
    return res.json({ 
      message: 'Transcript parsing started',
      intakeResponseId: id
    });
  } catch (error) {
    console.error('Error starting transcript parsing:', error.message);
    return res.status(500).json({ 
      error: 'Error starting transcript parsing', 
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Async function to process the transcript without blocking the response
async function processTranscriptAsync(pool, intakeResponseId, rawTranscript) {
  try {
    console.log(`Starting transcript parsing for intake response #${intakeResponseId}`);
    
    // Parse the transcript with the LLM
    const parsedData = await intakeAgentService.parseTranscript(rawTranscript);
    console.log('Transcript parsed successfully:', JSON.stringify(parsedData, null, 2));
    
    // Update the database with the parsed data
    const updatedResponse = await intakeAgentService.updateIntakeWithParsedData(
      pool, 
      intakeResponseId, 
      parsedData
    );
    
    console.log(`Intake response #${intakeResponseId} updated with parsed data`);
    return updatedResponse;
  } catch (error) {
    console.error(`Error processing transcript for intake #${intakeResponseId}:`, error.message);
    throw error;
  }
}

module.exports = router;
