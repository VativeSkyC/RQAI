
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

  // Get caller phone number from the request or lookup in temp_calls table
  let callerPhone = req.body.caller_id || req.body.caller || req.body.phone_number;
  const callSid = req.body.call_sid || req.body.callSid;
  
  console.log('Received caller_id in request:', callerPhone);
  console.log('Received call_sid in request:', callSid);
  
  // If callerPhone is undefined, "unknown", or otherwise invalid, use the fallback
  if (!callerPhone || callerPhone === "unknown" || callerPhone === "") {
    console.log('Received invalid caller_id in request:', callerPhone);
    console.log('Using fallback phone number from personalization webhook');
    
    // If we have a call_sid, try to look it up in temp_calls or call_log
    if (callSid) {
      console.log('Looking up caller phone from call_sid in temp_calls:', callSid);
      
      try {
        // Try to find the phone number in temp_calls table using the call_sid
        const callResult = await client.query(
          'SELECT phone_number FROM temp_calls WHERE call_sid = $1',
          [callSid]
        );
        
        if (callResult.rows.length > 0) {
          callerPhone = callResult.rows[0].phone_number;
          console.log('Retrieved phone number from temp_calls:', callerPhone);
        } else {
          // Fallback to call_log if not found in temp_calls
          console.log('Call not found in temp_calls, checking call_log...');
          const logResult = await client.query(
            'SELECT phone_number FROM call_log WHERE call_sid = $1',
            [callSid]
          );
          
          if (logResult.rows.length > 0) {
            callerPhone = logResult.rows[0].phone_number;
            console.log('Retrieved phone number from call_log:', callerPhone);
          }
        }
      } catch (lookupError) {
        console.error('Error looking up call data:', lookupError.message);
      }
    }
  }
  
  // If still missing or invalid, use the known test number
  if (!callerPhone || callerPhone === "unknown" || callerPhone === "") {
    console.warn('⚠️ USING FALLBACK CALLER ID: No valid caller ID could be determined');
    callerPhone = '+15132017748'; // Fallback for testing
    console.log('Set callerPhone to fallback number:', callerPhone);
  }
  
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
      console.error(`❌ ERROR: No contact found with phone number: ${callerPhone}`);
      console.log('Attempting to list all available contacts to debug:');
      
      try {
        const allContacts = await client.query('SELECT id, phone_number, first_name, last_name FROM contacts LIMIT 10');
        console.log('Available contacts:', JSON.stringify(allContacts.rows, null, 2));
      } catch (listError) {
        console.error('Error listing contacts:', listError.message);
      }
      
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        error: 'Contact not found', 
        message: `No contact found with phone number: ${callerPhone}`,
        phone_attempted: callerPhone
      });
    }
    
    console.log(`✅ Successfully found contact with phone number: ${callerPhone}`);
    
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
    
    console.log('🔄 ATTEMPTING DATABASE INSERT with phone:', callerPhone);
    console.log('🔄 Contact ID:', contactId, 'User ID:', user_id);
    
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
    
    console.log('✅ DATABASE INSERT SUCCESSFUL! New intake response ID:', insertResult.rows[0].id);

    const newResponseId = insertResult.rows[0].id;
    console.log('===== TRANSACTION DETAILS =====');
    console.log('INSERT STATEMENT EXECUTED:', `
      INSERT INTO intake_responses (
        contact_id, user_id, communication_style, values, 
        professional_goals, partnership_expectations, raw_transcript, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING id`);
    console.log('PARAMETERS:', [
      contactId, 
      user_id, 
      communication_style || null, 
      values || null, 
      professional_goals || null, 
      partnership_expectations || null, 
      raw_transcript ? `${raw_transcript.length} chars` : null
    ]);
    
    await client.query('COMMIT');
    console.log('TRANSACTION COMMITTED SUCCESSFULLY ✅');

    console.log(`Successfully inserted intake data for contact #${contactId}, new intake_responses ID: ${newResponseId}`);
    
    // Clean up temp_calls if we have a callSid
    if (callSid) {
      try {
        console.log(`Updating call_log status for SID: ${callSid}`);
        await client.query(
          'UPDATE call_log SET status = $1, processed_at = NOW() WHERE call_sid = $2',
          ['processed', callSid]
        );

        console.log(`Cleaning up temp_calls for SID: ${callSid}`);
        await client.query('DELETE FROM temp_calls WHERE call_sid = $1', [callSid]);
      } catch (cleanupError) {
        console.error('Error cleaning up call data:', cleanupError.message);
      }
    }
    
    // Verify the data was inserted by fetching it back
    try {
      const verifyInsert = await pool.query(
        'SELECT id, contact_id, user_id, communication_style FROM intake_responses WHERE id = $1',
        [newResponseId]
      );
      
      if (verifyInsert.rows.length > 0) {
        console.log('VERIFICATION: Successfully retrieved inserted row:', verifyInsert.rows[0]);
      } else {
        console.error('VERIFICATION FAILED: Could not retrieve the row that was just inserted!');
      }
    } catch (verifyError) {
      console.error('Error verifying insert:', verifyError.message);
    }
    
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
