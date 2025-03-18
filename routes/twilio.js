
const express = require('express');
const router = express.Router();

// Voice route for initial Twilio call
router.post('/voice', async (req, res) => {
  const { From, CallSid } = req.body;
  console.log('Incoming call received. CallSid:', CallSid, 'From:', From);

  try {
    const pool = req.app.get('pool');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Store in temp_calls so we can track the immediate call details
      await client.query(
        'INSERT INTO temp_calls (call_sid, phone_number, created_at) VALUES ($1, $2, NOW())',
        [CallSid, From]
      );

      // Also store in call_log for debugging or a permanent record
      await client.query(
        `INSERT INTO call_log (call_sid, phone_number, status, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (call_sid) DO NOTHING`,
        [CallSid, From, 'initiated']
      );

      await client.query('COMMIT');
      console.log(`Call from ${From} with SID ${CallSid} successfully logged in temp_calls and call_log`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error storing call data:', error.message);
    } finally {
      client.release();
    }

    // Continue with your existing Twilio voice response here
    // This TwiML response would redirect to ElevenLabs or handle the call
    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Say>We're connecting you to our AI agent.</Say>
      </Response>
    `);
  } catch (error) {
    console.error('Error in voice endpoint:', error.message);
    res.status(500).send('Server error');
  }
});

// Personalization Webhook for ElevenLabs inbound Twilio calls
router.post('/twilio-personalization', async (req, res) => {
  try {
    const { caller_id, agent_id, called_number, call_sid } = req.body || {};
    console.log('Received personalization request:', { caller_id, agent_id, called_number, call_sid });

    if (!caller_id || !call_sid) {
      console.error('Missing required parameters');
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Look up contact info
    const pool = req.app.get('pool');
    const client = await pool.connect();

    try {
      // Store/update in temp_calls to ensure consistent tracking
      await client.query(`
        INSERT INTO temp_calls (call_sid, phone_number, created_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (call_sid) DO UPDATE SET phone_number = EXCLUDED.phone_number
      `, [call_sid, caller_id]);
      
      console.log(`Updated temp_calls with call_sid: ${call_sid}, phone_number: ${caller_id}`);
      const findContact = await client.query(`
        SELECT id, first_name, last_name, user_id
        FROM contacts 
        WHERE phone_number = $1 
        LIMIT 1
      `, [caller_id]);

      // Log the call
      await client.query(`
        INSERT INTO call_log (call_sid, phone_number, status, created_at)
        VALUES ($1, $2, $3, NOW()) 
        ON CONFLICT (call_sid) DO NOTHING
      `, [call_sid, caller_id, findContact.rows.length > 0 ? 'existing_contact' : 'unauthorized']);

      const contact = findContact.rows[0];
      
      // If contact doesn't exist or isn't approved, return polite rejection
      if (!contact) {
        const response = {
          dynamic_variables: {
            caller_id,
            call_sid,
            called_number,
            contact_status: 'unauthorized'
          },
          conversation_config_override: {
            agent: {
              prompt: {
                prompt: "This is an unauthorized caller. Politely inform them they need to be added to access this service."
              },
              first_message: "I apologize, but this service is currently only available to approved contacts. Please contact RQ to learn more about getting access. Thank you for your interest!",
              language: "en"
            }
          }
        };
        return res.status(200).json(response);
      }

      // For approved contacts, proceed with personalized interaction
      const systemPrompt = `
You are an AI intake bot focusing on professional relationships for business leaders.
Ask these questions sequentially, transcribe responses, and follow up with clarifications if needed:

1) "How would you describe your preferred communication style—do you lean toward direct and concise, or collaborative and detailed?"

2) "What are your top professional goals for the next year—growth, stability, or something else?"

3) "What values are most important to you in a professional relationship, like trust, innovation, or accountability?"

4) "What do you expect from a professional partnership—regular updates or strategic guidance?"

If any answer is unclear, gently ask for elaboration (e.g., 'Can you elaborate on growth?').
Once all questions are answered, say "Thank you for your time," and end the call.

Ensure to include the entire conversation in 'raw_transcript' in your final callback to /receive-data.
DO NOT ask any unrelated questions.`;

      const response = {
        dynamic_variables: {
          caller_id,
          call_sid,
          called_number,
          contact_name: contact.first_name,
          contact_id: contact.id,
          user_id: contact.user_id,
          contact_status: 'approved',
          raw_transcript: ''
        },
        conversation_config_override: {
          agent: {
            prompt: {
              prompt: systemPrompt
            },
            first_message: `Hello ${contact.first_name}, Chase asked me to learn more about your professional goals. When you're ready, let me know and we will get started.`,
            language: 'en'
          }
        }
      };

      console.log('Sending personalization response:', response);
      return res.status(200).json(response);

    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error in personalization webhook:', error.message);
    // Fallback 200 to avoid Twilio error
    return res.status(200).json({
      dynamic_variables: { contactName: 'Error' },
      conversation_config_override: {
        agent: {
          prompt: {
            prompt: 'System error encountered. Apologize and end the call.'
          },
          first_message: 'Sorry, we have a system issue. Please try again later. Goodbye.',
          language: 'en'
        }
      }
    });
  }
});

module.exports = router;
