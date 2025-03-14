
const express = require('express');
const router = express.Router();

// Personalization Webhook for ElevenLabs inbound Twilio calls
router.post('/twilio-personalization', async (req, res) => {
  try {
    const { caller_id, agent_id, called_number, call_sid } = req.body;
    console.log('Received personalization request:', { caller_id, agent_id, called_number, call_sid });

    if (!caller_id || !call_sid) {
      console.error('Missing required parameters');
      return res.status(400).json({ error: 'Missing required parameters' });
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

    // Look up contact info
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
    `, [call_sid, caller_id, findContact.rows.length > 0 ? 'existing_contact' : 'new_contact']);

    const contact = findContact.rows[0];
    } finally {
      client.release();
    }

    // Prepare response data
    const response = {
      dynamic_variables: {
        caller_id,
        call_sid,
        called_number,
        contact_name: contact ? contact.first_name : 'Unknown',
        contact_status: contact ? 'existing' : 'new'
      },
      conversation_config_override: {
        agent: {
          prompt: {
            prompt: contact 
              ? `This is an existing contact named ${contact.first_name}. Focus on learning about their: 1) Communication style, 2) Professional goals, 3) Values, 4) Partnership expectations.`
              : `This is a new contact. Politely gather their name and then learn about their: 1) Communication style, 2) Professional goals, 3) Values, 4) Partnership expectations.`
          },
          first_message: contact
            ? `Hello ${contact.first_name}, I'd like to learn more about your professional goals. Shall we begin?`
            : "Hello! I'd like to learn more about you and your professional goals. Could you start by telling me your name?",
          language: "en"
        }
      }
    };

    console.log('Sending personalization response:', response);
    return res.status(200).json(response);

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
