// Personalization Webhook for ElevenLabs inbound Twilio calls
router.post('/twilio-personalization', async (req, res) => {
  try {
    // 1. (Optional) Verify a secret header if configured
    const expectedSecret = process.env.ELEVENLABS_SECRET;
    const incomingSecret = req.headers['x-el-secret'];
    if (expectedSecret && expectedSecret !== incomingSecret) {
      console.log('Invalid or missing x-el-secret in personalization webhook');
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // 2. Extract data from ElevenLabs request
    const { caller_id, agent_id, called_number, call_sid } = req.body || {};
    if (!caller_id || !call_sid) {
      console.error('Missing caller_id or call_sid in personalization webhook');
      return res.status(400).json({ error: 'Invalid payload' });
    }
    console.log('Personalization webhook triggered:', req.body);

    // 3. Look up the contact in your DB (no new contact creation)
    const pool = req.app.get('pool');
    const client = await pool.connect();

    let existingContact;
    const userName = "Chase"; // For greeting

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

        // Log unrecognized caller
        await client.query(`
          INSERT INTO call_log (call_sid, phone_number, status, created_at)
          VALUES ($1, $2, $3, NOW()) 
          ON CONFLICT (call_sid) DO NOTHING
        `, [call_sid, caller_id, 'unrecognized_caller']);
      }
    } finally {
      client.release();
    }

    // 4. If contact not found, politely reject the caller
    if (!existingContact) {
      console.log('Returning polite rejection for unrecognized caller:', caller_id);
      return res.status(200).json({
        dynamic_variables: {
          contactName: 'Unknown Caller'
        },
        conversation_config_override: {
          agent: {
            prompt: {
              prompt: `No record for this phone number. Ask them to contact Chase for adding them to the system.`
            },
            first_message: `I'm sorry, we don't have a record for this phone number. Please contact Chase. Goodbye.`,
            language: 'en'
          }
        }
      });
    }

    // 5. If contact found, build your intake conversation details
    const greeting = `Hello ${existingContact.first_name}, ${userName} asked me to learn more about your professional goals. When you're ready, let me know and we will begin.`;

    const systemPrompt = `
      You are an AI intake bot focusing on professional relationships for business leaders.
      You have four questions to ask:
       1) Communication style
       2) Professional goals
       3) Values
       4) Partnership expectations
      ...
    `;

    // 6. Return the JSON in the format ElevenLabs expects
    console.log('Returning personalization data for contact:', existingContact.first_name);
    return res.status(200).json({
      dynamic_variables: {
        caller_phone: caller_id,
        call_sid: call_sid,
        contactName: existingContact.first_name
      },
      conversation_config_override: {
        agent: {
          prompt: {
            prompt: systemPrompt
          },
          first_message: greeting,
          language: 'en'
        }
      }
    });

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
