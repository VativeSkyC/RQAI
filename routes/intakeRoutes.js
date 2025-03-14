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

  // Get database connection directly from global app
  const pool = global.app.get('pool');
  if (!pool) {
    return res.status(500).json({ 
      error: 'Server Error', 
      message: 'Database connection not available'
    });
  }
  
  const client = await pool.connect();
  
  try {
    // Begin transaction
    await client.query('BEGIN');
    
    // Extract the key data from the request
    const { caller_id, call_sid, callSid, communication_style, values, professional_goals, partnership_expectations, raw_transcript } = req.body;
    
    // Initialize extractedData with available information
    const extractedData = {
      caller: caller_id || null,
      callSid: call_sid || callSid || null,
      communication_style: communication_style || "Not provided",
      values: values || "Not provided",
      professional_goals: professional_goals || "Not provided",
      partnership_expectations: partnership_expectations || "Not provided",
      raw_transcript: raw_transcript || "Not provided"
    };

    console.log('=== EXTRACTED DATA ===');
    console.log(JSON.stringify(extractedData, null, 2));
    
    // Identify the caller by looking up in temp_calls based on callSid first
    let phoneNumber = extractedData.caller;
    let callSidFound = false;
    
    // 1. Try to find by call_sid if available
    if (extractedData.callSid) {
      try {
        console.log(`Looking up phone number using call_sid: ${extractedData.callSid}`);
        const callResult = await client.query(
          'SELECT phone_number FROM temp_calls WHERE call_sid = $1',
          [extractedData.callSid]
        );
        
        if (callResult.rows.length > 0) {
          phoneNumber = callResult.rows[0].phone_number;
          callSidFound = true;
          console.log(`Found phone number ${phoneNumber} using call_sid lookup`);
          
          // If we found the call_sid but don't have caller_id in request, update extractedData
          if (!extractedData.caller) {
            extractedData.caller = phoneNumber;
          }
        } else {
          console.log(`No matching call_sid found in temp_calls: ${extractedData.callSid}`);
        }
      } catch (callSidError) {
        console.error('Error looking up by call_sid:', callSidError.message);
      }
    }
    
    // 2. If we couldn't find by call_sid and we have caller_id, try by caller_id
    if (!callSidFound && extractedData.caller) {
      try {
        console.log(`Looking up using phone_number: ${extractedData.caller}`);
        const phoneResult = await client.query(
          'SELECT call_sid, phone_number FROM temp_calls WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1',
          [extractedData.caller]
        );
        
        if (phoneResult.rows.length > 0) {
          phoneNumber = phoneResult.rows[0].phone_number;
          // If we didn't have a callSid before, use the one from temp_calls
          if (!extractedData.callSid) {
            extractedData.callSid = phoneResult.rows[0].call_sid;
          }
          console.log(`Found match by phone_number in temp_calls: ${phoneNumber}, call_sid: ${extractedData.callSid}`);
        } else {
          console.log(`No matching phone_number found in temp_calls: ${extractedData.caller}`);
        }
      } catch (phoneError) {
        console.error('Error looking up by phone_number:', phoneError.message);
      }
    }
    
    // 3. Last resort - if we still don't have anything, try getting the most recent call
    if (!phoneNumber && !extractedData.callSid) {
      try {
        console.log('No identifiers found, attempting to retrieve most recent call from temp_calls');
        const recentResult = await client.query(
          'SELECT call_sid, phone_number FROM temp_calls ORDER BY created_at DESC LIMIT 1'
        );
        
        if (recentResult.rows.length > 0) {
          phoneNumber = recentResult.rows[0].phone_number;
          extractedData.callSid = recentResult.rows[0].call_sid;
          extractedData.caller = phoneNumber;
          console.log(`Using most recent call from temp_calls: ${phoneNumber}, call_sid: ${extractedData.callSid}`);
        } else {
          console.log('No records found in temp_calls');
        }
      } catch (recentError) {
        console.error('Error retrieving most recent call:', recentError.message);
      }
    }
    
    // If we still don't have a phone number, we can't proceed
    if (!phoneNumber) {
      await client.query('ROLLBACK');
      console.error('Could not identify caller - no phone number available');
      return res.status(400).json({
        error: 'Identification Failed',
        message: 'Could not identify the caller - no phone number available'
      });
    }
    
    // Store/update the call info in temp_calls if we have a callSid
    if (extractedData.callSid) {
      try {
        await client.query(`
          INSERT INTO temp_calls (call_sid, phone_number, created_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (call_sid) DO UPDATE SET phone_number = $2, created_at = NOW()
        `, [extractedData.callSid, phoneNumber]);
        console.log(`Stored/updated call information in temp_calls table: ${extractedData.callSid} -> ${phoneNumber}`);
        
        // Log to call_log for reference
        await client.query(`
          INSERT INTO call_log (call_sid, phone_number, status, created_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (call_sid) DO UPDATE SET status = $3, updated_at = NOW()
        `, [extractedData.callSid, phoneNumber, 'intake_received']);
        console.log(`Updated call_log record for call_sid: ${extractedData.callSid}`);
      } catch (tempCallError) {
        console.error('Error updating call records:', tempCallError.message);
        // Continue processing even if this fails
      }
    }
    
    // Find contact using phoneNumber
    let contactId = null;
    let userId = null;
    
    try {
      const contactResult = await client.query(
        'SELECT id, user_id FROM contacts WHERE phone_number = $1 LIMIT 1',
        [phoneNumber]
      );
      
      if (contactResult.rows.length > 0) {
        contactId = contactResult.rows[0].id;
        userId = contactResult.rows[0].user_id;
        console.log(`Found contact with ID ${contactId} for phone ${phoneNumber}`);
      } else {
        console.log(`No contact found for phone ${phoneNumber}`);
      }
    } catch (contactError) {
      console.error('Error finding contact:', contactError.message);
    }
    
    console.log('Inserting data into intake_responses table...');
    
    // Insert into intake_responses with contact info if available
    const insertResult = await client.query(`
      INSERT INTO intake_responses 
      (phone_number, contact_id, user_id, communication_style, values, professional_goals, 
       partnership_expectations, raw_transcript, created_at, updated_at)
      VALUES 
      ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING id
    `, [
      phoneNumber,
      contactId,
      userId,
      extractedData.communication_style, 
      extractedData.values,
      extractedData.professional_goals,
      extractedData.partnership_expectations,
      extractedData.raw_transcript
    ]);
    
    console.log('Successfully inserted data with ID:', insertResult.rows[0]?.id);
    
    // Commit the transaction
    await client.query('COMMIT');
    
    // Send a success response
    res.status(200).json({
      status: 'success',
      message: 'Data received and processed successfully',
      intake_id: insertResult.rows[0]?.id
    });
  } catch (error) {
    console.error('Error processing intake data:', error);
    // Rollback transaction on error
    try {
      await client.query('ROLLBACK');
      console.log('Transaction rolled back due to error');
    } catch (rollbackError) {
      console.error('Error during rollback:', rollbackError.message);
    }
    
    res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  } finally {
    // Always release the client back to the pool
    if (client) {
      client.release();
      console.log('Database client released');
    }
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