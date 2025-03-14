
const express = require('express');
const router = express.Router();

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
      const response = {
        dynamic_variables: {
          caller_id,
          call_sid,
          called_number,
          contact_name: contact.first_name,
          contact_status: 'approved'
        },
        conversation_config_override: {
          agent: {
            prompt: {
              prompt: `This is ${contact.first_name}. Guide them through these specific questions in order:
1) What is your preferred communication style?
2) What are your key professional goals?
3) What values are most important to you?
4) What do you expect from professional partnerships?`
            },
            first_message: `Hello ${contact.first_name}! I'd like to learn more about your professional preferences and goals. Shall we begin with your preferred communication style?`,
            language: "en"
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
