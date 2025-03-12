
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// Twilio voice endpoint with Eleven Labs integration
// Ensure this endpoint is accessible at /voice
router.post('/voice', async (req, res) => {
  const { From, CallSid } = req.body;
  console.log('Incoming call received. CallSid:', CallSid, 'From:', From);

  try {
    // Store call details in both temp and permanent tables
    const pool = req.app.get('pool');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Store in temp_calls for immediate use
      await client.query(
        'INSERT INTO temp_calls (call_sid, phone_number, created_at) VALUES ($1, $2, NOW())',
        [CallSid, From]
      );
      
      // Also store in permanent call_log for debugging and recovery
      await client.query(
        'INSERT INTO call_log (call_sid, phone_number, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (call_sid) DO NOTHING',
        [CallSid, From]
      );
      
      await client.query('COMMIT');
      console.log(`Call from ${From} with SID ${CallSid} successfully logged`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Redirect to Eleven Labs with caller phone number as query parameter
    // Add webhook parameter to notify ElevenLabs where to send personalization requests
    const ngrokUrl = global.ngrokUrl || req.protocol + '://' + req.get('host');
    const twiml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Redirect method="POST">https://api.us.elevenlabs.io/twilio/inbound_call?caller=${encodeURIComponent(From)}&webhook=${encodeURIComponent(ngrokUrl + '/twilio-personalization')}</Redirect>
      </Response>
    `;

    res.type('text/xml').send(twiml);
    console.log('Call redirected to Eleven Labs with caller param:', From);
  } catch (error) {
    console.error('Error in voice endpoint:', error.message);
    // Fallback in case of error
    const twilio = require('twilio');
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('We are experiencing technical difficulties. Please try again later.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// Personalization Webhook for ElevenLabs inbound Twilio calls
// Ensure this endpoint is accessible at /twilio-personalization
router.post('/twilio-personalization', async (req, res) => {
  try {
    // 1. Optional: Verify a secret header if you configured it in ElevenLabs
    const expectedSecret = process.env.ELEVENLABS_SECRET;
    const incomingSecret = req.headers['x-el-secret'];
    if (expectedSecret && expectedSecret !== incomingSecret) {
      console.log('Invalid or missing x-el-secret in personalization webhook');
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // 2. Extract data from ElevenLabs
    const { caller_id, agent_id, called_number, call_sid } = req.body || {};
    if (!caller_id || !call_sid) {
      console.error('Missing caller_id or call_sid in personalization webhook');
      return res.status(400).json({ error: 'Invalid payload' });
    }
    console.log('Personalization webhook triggered:', req.body);

    // 3. Look up the contact WITHOUT creating a new one
    const pool = req.app.get('pool');
    const client = await pool.connect();
    let existingContact;
    const userName = "Chase"; // Hardcoded name as specified in the requirements
    
    try {
      const findContact = await client.query(`
        SELECT id, first_name, last_name, user_id
        FROM contacts
        WHERE phone_number = $1
        LIMIT 1
      `, [caller_id]);

      if (findContact.rows.length > 0) {
        existingContact = findContact.rows[0];
        console.log('Found existing contact:', existingContact);

        // Log to call_log
        await client.query(`
          INSERT INTO call_log (call_sid, phone_number, status, created_at)
          VALUES ($1, $2, $3, NOW()) 
          ON CONFLICT (call_sid) DO NOTHING
        `, [call_sid, caller_id, 'existing_contact_personalization']);
      } else {
        console.log('No existing contact for phone:', caller_id);
        // Log that we do not recognize the caller
        await client.query(`
          INSERT INTO call_log (call_sid, phone_number, status, created_at)
          VALUES ($1, $2, $3, NOW()) 
          ON CONFLICT (call_sid) DO NOTHING
        `, [call_sid, caller_id, 'unrecognized_caller']);
      }
    } finally {
      client.release();
    }

    // 4. If contact does not exist, end gracefully (200) so Twilio doesn't error
    if (!existingContact) {
      console.log('Returning polite rejection for unrecognized caller:', caller_id);
      return res.status(200).json({
        dynamic_variables: {
          contactName: 'Unknown Caller'
        },
        conversation_config_override: {
          agent: {
            prompt: {
              prompt: `You do not have a record of this caller. Politely inform them they must be added by ${userName} first, then end the call.`
            },
            first_message: `I'm sorry, I don't have a record for this phone number in our system. Please contact ${userName} to be added to the system. Thank you for your interest, goodbye.`,
            language: 'en'
          }
        }
      });
    }

    // 5. If contact found, respond with intake questionnaire instructions
    const dynamicVariables = {
      contactName: existingContact.first_name || 'Caller',
      contactId: existingContact.id
    };

    // The greeting that mentions Chase and asks user to confirm readiness
    const greeting = `Hello ${existingContact.first_name}, ${userName} asked me to learn more about your professional goals. When you're ready, let me know and we will get started.`;

    // System prompt with the 4-question intake flow
    const systemPrompt = `
      You are an AI intake bot focusing on professional relationships for business leaders.
      You have four questions to ask the caller, in this sequence:

      1) Communication style:
         "How would you describe your preferred communication style—do you lean toward direct and concise, or collaborative and detailed? Please elaborate."
         Store the answer under "communication_style".

      2) Professional goals:
         "What are your top professional goals for the next year—growth, stability, or something else?"
         Store the answer under "professional_goals".

      3) Values:
         "What values are most important to you in a professional relationship, such as trust, innovation, or accountability?"
         Store the answer under "values".

      4) Partnership expectations:
         "What do you expect from a professional partnership—regular updates or strategic guidance?"
         Store the answer under "partnership_expectations".

      After each question, if the caller's answer is unclear, gently ask for clarification, e.g. "Can you elaborate on growth?"
      Once all four questions are answered, say "Thank you for your time," and end the call.

      Ensure to include the entire conversation in "raw_transcript" in your final callback to /receive-data. 
      DO NOT ask any unrelated questions. Your mission is just these four questions.
    `;

    const conversationConfigOverride = {
      agent: {
        prompt: {
          prompt: systemPrompt
        },
        first_message: greeting,
        language: 'en'
      }
    };

    // 6. Return a success JSON (200)
    console.log('Returning intake questionnaire for contact:', existingContact.first_name);
    return res.status(200).json({
      dynamic_variables: dynamicVariables,
      conversation_config_override: conversationConfigOverride
    });

  } catch (error) {
    console.error('Error in personalization webhook:', error.message);
    // Return a fallback 200 so we don't cause a Twilio "application error" 
    return res.status(200).json({
      dynamic_variables: { contactName: 'Error' },
      conversation_config_override: {
        agent: {
          prompt: {
            prompt: `There was a system error. Apologize and end the call.`
          },
          first_message: 'I apologize, but we have encountered a technical issue with our system. Please try calling back later. Goodbye.',
          language: 'en'
        }
      }
    });
  }
});

// Data reception endpoint from Eleven Labs
router.post('/receive-data', async (req, res) => {
  console.log('Received request to /receive-data from Eleven Labs');
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  // Handle both authentication methods: direct user requests with JWT and Eleven Labs callbacks
  let isElevenLabsCallback = false;
  let userId = null;

  // Check if this is a verifiable Eleven Labs callback with callSid or caller
  if (req.body.callSid || req.body.caller) {
    isElevenLabsCallback = true;
    console.log('Eleven Labs callback detected', 
      req.body.callSid ? `with callSid: ${req.body.callSid}` : `with caller: ${req.body.caller}`);
  } else {
    // Standard JWT verification for direct API calls
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(403).json({ error: 'No token provided' });
      }
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.userId;
      console.log('Token verified, proceeding with userId:', userId);
    } catch (error) {
      console.error('Token verification failed:', error.message);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Handle Eleven Labs callback data
  if (isElevenLabsCallback) {
    const { 
      callSid, 
      caller,
      communication_style, 
      goals, 
      values, 
      professional_goals, 
      partnership_expectations, 
      raw_transcript 
    } = req.body;

    console.log('=== PROCESSING ELEVENLABS CALLBACK DATA ===');
    console.log('Identifier:', callSid ? `CallSID: ${callSid}` : `Caller: ${caller}`);
    console.log('Complete request body:', JSON.stringify(req.body, null, 2));
    
    // Detailed logging of key fields
    console.log('=== INTAKE FIELDS RECEIVED ===');
    console.log('- communication_style:', typeof communication_style, communication_style || 'NULL');
    console.log('- professional_goals:', typeof professional_goals, professional_goals || 'NULL');
    console.log('- values:', typeof values, values || 'NULL');
    console.log('- partnership_expectations:', typeof partnership_expectations, partnership_expectations || 'NULL');
    console.log('- raw_transcript:', raw_transcript ? `${raw_transcript.substring(0, 100)}... (${raw_transcript.length} chars)` : 'NULL');
    
    try {
      const pool = req.app.get('pool');
      const client = await pool.connect();
      
      try {
        console.log('Starting database transaction (BEGIN)');
        await client.query('BEGIN');
        
        let phoneNumber = null;
        
        // If we have a caller phone number directly, use it
        if (caller) {
          // Normalize phone number by removing all non-numeric characters except leading +
          const normalizedCaller = caller.replace(/^(\+)/, 'PLUS').replace(/[^0-9]/g, '').replace('PLUS', '+');
          phoneNumber = normalizedCaller;
          console.log(`Using direct caller phone number: Original=${caller}, Normalized=${phoneNumber}`);
          
          // Create a record in call_log for reference
          await client.query(
            'INSERT INTO call_log (call_sid, phone_number, status, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (call_sid) DO NOTHING',
            [callSid || `caller-${Date.now()}`, phoneNumber, 'direct_caller']
          );
        } 
        // Otherwise try to find by callSid as before
        else if (callSid) {
          console.log('Looking up phone number by callSid:', callSid);
          
          // First try to match call from temp_calls
          let callResult = await client.query('SELECT phone_number FROM temp_calls WHERE call_sid = $1', [callSid]);
          
          // If not found in temp_calls, try the call_log table as fallback
          if (callResult.rows.length === 0) {
            console.log('Call not found in temp_calls, checking call_log fallback...');
            
            // Perform case-insensitive search to handle potential formatting issues
            callResult = await client.query('SELECT phone_number FROM call_log WHERE LOWER(call_sid) = LOWER($1)', [callSid]);
            
            if (callResult.rows.length === 0) {
              console.log('Call not found in logs with exact match, trying partial match...');
              
              // Try partial match as fallback (in case SID format changed)
              callResult = await client.query("SELECT phone_number FROM call_log WHERE call_sid LIKE $1", [`%${callSid.slice(-8)}%`]);
              
              if (callResult.rows.length === 0) {
                // If we receive a phone_number in the payload, use that
                if (req.body.phone_number) {
                  const normalizedPhone = req.body.phone_number.replace(/^(\+)/, 'PLUS').replace(/[^0-9]/g, '').replace('PLUS', '+');
                  console.log(`Using phone_number from payload: Original=${req.body.phone_number}, Normalized=${normalizedPhone}`);
                  phoneNumber = normalizedPhone;
                  
                  // Create a record in call_log for this session
                  await client.query(
                    'INSERT INTO call_log (call_sid, phone_number, status, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (call_sid) DO NOTHING',
                    [callSid, phoneNumber, 'from_payload']
                  );
                } else {
                  console.error(`ERROR: Could not find call record for SID: ${callSid}`);
                  console.log('Performing ROLLBACK due to missing phone number');
                  await client.query('ROLLBACK');
                  return res.status(404).json({ 
                    error: 'Call not found',
                    message: 'No matching call found in database. Please include phone_number or caller in your request.'
                  });
                }
              } else {
                console.log(`Found call via partial SID match: ${callResult.rows[0].phone_number}`);
                phoneNumber = callResult.rows[0].phone_number;
              }
            } else {
              console.log('Call found in permanent call_log table');
              phoneNumber = callResult.rows[0].phone_number;
            }
          } else {
            phoneNumber = callResult.rows[0].phone_number;
            console.log(`Found phone number ${phoneNumber} for callSid: ${callSid}`);
          }
        } else {
          console.log('Performing ROLLBACK due to missing caller information');
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            error: 'Missing caller information',
            message: 'Either callSid, caller, or phone_number must be provided'
          });
        }

        // Normalize phone number for lookup
        const normalizedPhone = phoneNumber.replace(/^(\+)/, 'PLUS').replace(/[^0-9]/g, '').replace('PLUS', '+');
        
        // Try to find contact with exact match first
        console.log(`Looking for contact with exact phone number: ${normalizedPhone}`);
        let contactResult = await client.query('SELECT id, user_id FROM contacts WHERE phone_number = $1', [normalizedPhone]);
        
        // If not found with exact match, try with just the digits (removing +)
        if (contactResult.rows.length === 0) {
          const digitsOnly = normalizedPhone.replace(/^\+/, '');
          console.log(`Contact not found with exact match, trying with digits only: ${digitsOnly}`);
          
          // Try to match with or without country code
          contactResult = await client.query(
            'SELECT id, user_id FROM contacts WHERE ' +
            'phone_number = $1 OR ' +
            'phone_number = $2 OR ' +
            'phone_number LIKE $3 OR ' +
            'REPLACE(REPLACE(phone_number, \'+\', \'\'), \'-\', \'\') = $4',
            [
              digitsOnly,                      // Without +
              '+' + digitsOnly,                // With +
              '%' + digitsOnly.slice(-10) + '%', // Last 10 digits with wildcards
              digitsOnly.replace(/[^0-9]/g, '') // All non-numeric chars removed
            ]
          );
        }

        if (contactResult.rows.length === 0) {
          console.error('ERROR: Contact not found for phone number:', normalizedPhone);
          console.log('Performing ROLLBACK since no matching contact was found');
          await client.query('ROLLBACK');
          return res.status(404).json({ 
            error: 'Contact not found', 
            message: 'No contact found for phone number: ' + normalizedPhone,
            normalized_phone: normalizedPhone
          });
        }

        const contactId = contactResult.rows[0].id;
        userId = contactResult.rows[0].user_id;
        console.log(`SUCCESS: Found contact (ID: ${contactId}) for user (ID: ${userId})`);

        // Prepare and log the data we're going to insert
        console.log('=== INSERTING INTO INTAKE_RESPONSES ===');
        console.log('- contact_id:', contactId);
        console.log('- user_id:', userId);
        console.log('- communication_style:', communication_style || 'NULL');
        console.log('- values:', values || 'NULL');
        console.log('- professional_goals:', professional_goals || 'NULL');
        console.log('- partnership_expectations:', partnership_expectations || 'NULL');
        console.log('- raw_transcript length:', raw_transcript ? raw_transcript.length : 0);

        // Store intake data with proper transaction and clear logging
        console.log('Executing INSERT query...');
        const insertResult = await client.query(
          `INSERT INTO intake_responses (
            contact_id, user_id, communication_style, values, 
            professional_goals, partnership_expectations, raw_transcript, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          RETURNING id`,
          [
            contactId, 
            userId, 
            communication_style || null, 
            values || null, 
            professional_goals || null, 
            partnership_expectations || null, 
            raw_transcript || null
          ]
        );
        
        console.log(`INSERT successful. New intake_responses row ID: ${insertResult.rows[0]?.id || 'unknown'}`);

        // Update call_log to mark as processed if we have a callSid
        if (callSid) {
          console.log(`Updating call_log status for SID: ${callSid}`);
          await client.query(
            'UPDATE call_log SET status = $1, processed_at = NOW() WHERE call_sid = $2',
            ['processed', callSid]
          );

          // Clean up temp_calls (if it exists there)
          console.log(`Cleaning up temp_calls for SID: ${callSid}`);
          await client.query('DELETE FROM temp_calls WHERE call_sid = $1', [callSid]);
        }

        console.log('Committing transaction (COMMIT)');
        await client.query('COMMIT');
        console.log(`Successfully stored Eleven Labs intake data for contact ID ${contactId}, user ID ${userId}`);
        
        return res.status(200).json({ 
          message: 'Data stored successfully',
          contact_id: contactId,
          intake_id: insertResult.rows[0]?.id
        });
      } catch (error) {
        console.error('ERROR in database operations:', error.message);
        console.log('Performing ROLLBACK due to error');
        await client.query('ROLLBACK');
        throw error; // Pass to outer catch
      } finally {
        client.release();
        console.log('Database client released');
      }
    } catch (error) {
      console.error('CRITICAL ERROR processing Eleven Labs data:', error.message);
      console.error(error.stack);
      return res.status(500).json({ 
        error: 'Failed to store data', 
        details: error.message,
        stack: error.stack
      });
    }
  } 
  // Handle standard API request with JWT auth
  else {
    const phoneNumber = req.body.From;
    const userResponse = req.body.userResponse;

    if (!phoneNumber || !userResponse) {
      console.log('Validation failed - Missing phoneNumber or userResponse', { phoneNumber, userResponse });
      return res.status(400).json({ error: 'Phone number and response are required' });
    }

    try {
      const pool = req.app.get('pool');
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        let contactResult = await client.query('SELECT id FROM contacts WHERE phone_number = $1', [phoneNumber]);
        let contactId;

        if (contactResult.rows.length === 0) {
          const newContactResult = await client.query(
            'INSERT INTO contacts (phone_number, user_id) VALUES ($1, $2) RETURNING id',
            [phoneNumber, userId]
          );
          contactId = newContactResult.rows[0].id;
        } else {
          contactId = contactResult.rows[0].id;
        }

        await client.query(
          'INSERT INTO intake_responses (contact_id, user_id, response_text) VALUES ($1, $2, $3)',
          [contactId, userId, userResponse]
        );

        await client.query('COMMIT');
        console.log(`Data received - Phone: ${phoneNumber}, User ID: ${userId}, Response: ${userResponse}`);

        return res.json({ message: 'Data received' });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error; // Pass to outer catch
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error processing data:', error.message);
      return res.status(500).json({ error: 'Server error while processing data', details: error.message });
    }
  }
});

// Debug endpoint to check contacts by phone number (optional)
router.get('/debug/contacts/:phoneNumber', async (req, res) => {
  try {
    const phoneNumber = req.params.phoneNumber;
    console.log(`Looking up contact with phone number: ${phoneNumber}`);
    
    const pool = req.app.get('pool');
    const client = await pool.connect();
    try {
      const contactResult = await client.query(
        'SELECT id, first_name, last_name, phone_number, user_id, created_at FROM contacts WHERE phone_number = $1',
        [phoneNumber]
      );
      
      if (contactResult.rows.length === 0) {
        return res.status(404).json({ 
          error: 'No contact found',
          message: 'No contact found with this phone number'
        });
      }
      
      return res.json({
        success: true,
        contact: contactResult.rows[0],
        message: 'Contact found'
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error looking up contact:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

module.exports = router;
