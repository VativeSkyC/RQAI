const express = require('express');
const router = express.Router();
const intakeAgentService = require('../services/intakeAgentService');
const authMiddleware = require('../middleware/auth');

// IMPORTANT: Special handling for ElevenLabs webhook
// This route must accept webhook requests without token authentication
router.post('/receive-data', async (req, res) => {
  console.log('===========================================');
  console.log('🔄 RECEIVED DATA FROM ELEVEN LABS');
  console.log('===========================================');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  console.log('Timestamp:', new Date().toISOString());

  try {
    // Extract the key data from the request
    const { caller_id, call_sid, callSid, communication_style, values, professional_goals, partnership_expectations, raw_transcript } = req.body;

    if (!caller_id) {
      console.error('Missing caller_id in request');
      return res.status(400).json({ 
        error: 'Bad Request', 
        message: 'caller_id is required'
      });
    }

    const extractedData = {
      caller: caller_id,
      callSid: call_sid || callSid || null,
      communication_style: communication_style || "Not provided",
      values: values || "Not provided",
      professional_goals: professional_goals || "Not provided",
      partnership_expectations: partnership_expectations || "Not provided",
      raw_transcript: raw_transcript || "Not provided"
    };

    console.log('=== EXTRACTED DATA ===');
    console.log(JSON.stringify(extractedData, null, 2));

    // Get database connection directly from global app
    const pool = global.app.get('pool');
    if (!pool) {
      throw new Error('Database connection not available');
    }

    console.log('Inserting data directly into intake_responses table...');

    // If we have a callSid, also log it to the call_log table for reference
    if (extractedData.callSid) {
      try {
        await pool.query(`
          INSERT INTO call_log (call_sid, phone_number, status, created_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (call_sid) DO UPDATE SET status = $3, updated_at = NOW()
        `, [extractedData.callSid, extractedData.caller, 'intake_received']);
        console.log(`Updated call_log record for call_sid: ${extractedData.callSid}`);
      } catch (logError) {
        console.error('Warning: Failed to update call_log:', logError.message);
        // Continue processing even if this fails
      }
    }

    // Direct database insert
    const insertResult = await pool.query(`
      INSERT INTO intake_responses 
      (phone_number, call_sid, communication_style, values, professional_goals, 
       partnership_expectations, raw_transcript, created_at, updated_at)
      VALUES 
      ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING id
    `, [
      extractedData.caller,
      extractedData.callSid,
      extractedData.communication_style, 
      extractedData.values,
      extractedData.professional_goals,
      extractedData.partnership_expectations,
      extractedData.raw_transcript
    ]);

    console.log('Successfully inserted data with ID:', insertResult.rows[0]?.id);

    // Send a success response
    res.status(200).json({
      status: 'success',
      message: 'Data received and processed successfully',
      intake_id: insertResult.rows[0]?.id
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

// Routes below this point will use authentication
// Endpoint to manually trigger parsing for an existing intake response
router.post('/parse-transcript/:intakeId', authMiddleware.verifyToken, async (req, res) => {
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