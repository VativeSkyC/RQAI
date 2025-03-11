
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// Twilio voice endpoint with Eleven Labs integration
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
    const twiml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Redirect method="POST">https://api.us.elevenlabs.io/twilio/inbound_call?caller=${encodeURIComponent(From)}</Redirect>
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
router.post('/personalization', async (req, res) => {
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
              prompt: `We have no record for this caller. Politely explain that they need to be added to our system by an existing user before they can use this service. Then end the call.`
            },
            first_message: `I'm sorry, I don't have a record for this phone number in our system. To use this service, please contact someone who already uses our platform and ask them to add you as a contact. Thank you for your interest, goodbye.`,
            language: 'en'
          }
        }
      });
    }

    // 5. If contact found, respond with normal dynamic variables
    const dynamicVariables = {
      contactName: existingContact.first_name || 'Caller',
      contactId: existingContact.id
    };

    const conversationConfigOverride = {
      agent: {
        prompt: {
          prompt: `You are speaking with ${existingContact.first_name} (ID: ${existingContact.id}). Be welcoming and professional.`
        },
        first_message: `Hello ${existingContact.first_name}! Thanks for calling. I'm the AI relationship assistant. How can I help you today?`,
        language: 'en'
      }
    };

    // 6. Return a success JSON (200)
    console.log('Returning personalization for existing contact:', dynamicVariables);
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

    console.log('Processing Eleven Labs data:', 
      callSid ? `callSid: ${callSid}` : `caller: ${caller}`);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    try {
      const pool = req.app.get('pool');
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        let phoneNumber = null;
        
        // If we have a caller phone number directly, use it
        if (caller) {
          phoneNumber = caller;
          console.log(`Using direct caller phone number: ${phoneNumber}`);
          
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
                  console.log(`Using phone_number from payload: ${req.body.phone_number}`);
                  phoneNumber = req.body.phone_number;
                  
                  // Create a record in call_log for this session
                  await client.query(
                    'INSERT INTO call_log (call_sid, phone_number, status, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (call_sid) DO NOTHING',
                    [callSid, phoneNumber, 'from_payload']
                  );
                } else {
                  console.error(`ERROR: Could not find call record for SID: ${callSid}`);
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
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            error: 'Missing caller information',
            message: 'Either callSid, caller, or phone_number must be provided'
          });
        }

        // Find the corresponding contact
        const contactResult = await client.query('SELECT id, user_id FROM contacts WHERE phone_number = $1', [phoneNumber]);

        if (contactResult.rows.length === 0) {
          console.error('Contact not found for phone number:', phoneNumber);
          console.log('Will return error to Eleven Labs. Contact needs to be created manually.');
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Contact not found for phone number: ' + phoneNumber });
        }

        const contactId = contactResult.rows[0].id;
        userId = contactResult.rows[0].user_id;
        console.log(`Found contact (ID: ${contactId}) for user (ID: ${userId})`);

        // Store intake data
        await client.query(
          `INSERT INTO intake_responses (
            contact_id, user_id, communication_style, goals, values, 
            professional_goals, partnership_expectations, raw_transcript, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            contactId, 
            userId, 
            communication_style || null, 
            goals || null, 
            values || null, 
            professional_goals || null, 
            partnership_expectations || null, 
            raw_transcript || null
          ]
        );

        // Update call_log to mark as processed if we have a callSid
        if (callSid) {
          await client.query(
            'UPDATE call_log SET status = $1, processed_at = NOW() WHERE call_sid = $2',
            ['processed', callSid]
          );

          // Clean up temp_calls (if it exists there)
          await client.query('DELETE FROM temp_calls WHERE call_sid = $1', [callSid]);
        }

        await client.query('COMMIT');
        console.log(`Successfully stored Eleven Labs data for contact ID ${contactId}, user ID ${userId}`);
        
        return res.status(200).json({ message: 'Data stored successfully' });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error; // Pass to outer catch
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error processing Eleven Labs data:', error.message);
      return res.status(500).json({ error: 'Failed to store data', details: error.message });
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
