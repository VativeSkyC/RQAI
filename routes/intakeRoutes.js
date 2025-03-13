
const express = require('express');
const router = express.Router();
const intakeAgentService = require('../services/intakeAgentService');
const authMiddleware = require('../middleware/auth');

// Special middleware for ElevenLabs - allow requests with webhook data
const elevenlabsAuth = (req, res, next) => {
  console.log('Checking request for ElevenLabs webhook data...');
  
  // Check if it's an ElevenLabs webhook (has expected fields)
  if (req.body && 
     (req.body.caller_id || req.body.raw_transcript || req.body.communication_style)) {
    console.log('ElevenLabs webhook detected, bypassing authentication');
    return next();
  }
  
  console.log('Not an ElevenLabs webhook, applying regular JWT auth');
  // Otherwise, apply regular JWT auth
  authMiddleware.verifyToken(req, res, next);
};

// Endpoint to receive raw transcript data from ElevenLabs
router.post('/receive-data', elevenlabsAuth, async (req, res) => {
  console.log('===========================================');
  console.log('🔄 RECEIVED DATA FROM ELEVEN LABS');
  console.log('===========================================');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  // Log the timestamp for debugging purposes
  console.log('Timestamp:', new Date().toISOString());

  try {
    // Extract the key data from the request
    const { caller_id, communication_style, values, professional_goals, partnership_expectations, raw_transcript } = req.body;

    const extractedData = {
      caller: caller_id,
      communication_style,
      values,
      professional_goals,
      partnership_expectations,
      raw_transcript
    };

    console.log('=== EXTRACTED DATA ===');
    console.log(JSON.stringify(extractedData, null, 2));

    // Pass the data to the intake service for processing
    const result = await intakeAgentService.processIntakeData(extractedData);

    // Send a success response
    res.status(200).json({
      status: 'success',
      message: 'Data received and processed successfully',
      result
    });
  } catch (error) {
    console.error('Error processing intake data:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
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
