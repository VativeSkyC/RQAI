
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

  // Extract the raw transcript
  const { raw_transcript } = req.body;

  // Identify the contact or create a new row in intake_responses
  const callerPhone = req.body.caller || req.body.phone_number; // or fallback
  const pool = req.app.get('pool');
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Step A: find contactId (or create a new contact if you prefer)
    const contactResult = await client.query(
      'SELECT id, user_id FROM contacts WHERE phone_number = $1 LIMIT 1',
      [callerPhone]
    );
    
    if (contactResult.rows.length === 0) {
      // handle unknown contact or do a fallback
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Contact not found for phone:', callerPhone });
    }
    
    const { id: contactId, user_id } = contactResult.rows[0];

    // Step B: Insert a new record in intake_responses with only raw_transcript
    //         (Leave communication_style, etc. as null for now)
    const insertResult = await client.query(`
      INSERT INTO intake_responses (
        contact_id,
        user_id,
        raw_transcript,
        created_at
      ) VALUES ($1, $2, $3, NOW())
      RETURNING id
    `, [contactId, user_id, raw_transcript || null]);

    const newResponseId = insertResult.rows[0].id;
    await client.query('COMMIT');

    console.log(`Inserted raw transcript for contact #${contactId}, new intake_responses ID: ${newResponseId}`);
    
    // Start the async parsing process
    processTranscriptAsync(pool, newResponseId, raw_transcript);
    
    return res.json({ 
      message: 'Raw transcript stored', 
      intakeResponseId: newResponseId 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error storing raw transcript:', error.message);
    return res.status(500).json({ 
      error: 'DB error storing raw transcript', 
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
