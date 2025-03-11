
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');

// Send SMS endpoint
router.post('/send-sms', verifyToken, async (req, res) => {
  try {
    const { contactId, message } = req.body;
    const userId = req.userId;
    
    if (!contactId || !message) {
      return res.status(400).json({ error: 'Contact ID and message are required' });
    }
    
    // Check if Twilio credentials are configured
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
      console.error('Missing Twilio credentials in environment variables');
      return res.status(400).json({ 
        error: 'Twilio credentials not configured',
        details: 'The administrator needs to set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER environment variables'
      });
    }
    
    const pool = req.app.get('pool');
    // Get contact phone number
    const client = await pool.connect();
    const contactResult = await client.query(
      'SELECT phone_number, first_name, last_name FROM contacts WHERE id = $1 AND user_id = $2',
      [contactId, userId]
    );
    
    if (contactResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Contact not found or access denied' });
    }
    
    const { phone_number, first_name } = contactResult.rows[0];
    
    // Send SMS using Twilio
    const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const twilioResponse = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone_number
    });
    
    // Log the message
    await client.query(
      'INSERT INTO sms_messages (contact_id, user_id, message, twilio_sid, sent_at) VALUES ($1, $2, $3, $4, NOW())',
      [contactId, userId, message, twilioResponse.sid]
    ).catch(err => {
      console.log('Failed to log SMS message, table might not exist:', err.message);
      // Continue execution even if logging fails
    });
    
    client.release();
    
    console.log(`SMS sent to ${first_name} at ${phone_number}: "${message.substring(0, 30)}..."`);
    
    res.status(200).json({ 
      message: 'SMS sent successfully',
      sid: twilioResponse.sid,
      status: twilioResponse.status
    });
  } catch (error) {
    console.error('Error sending SMS:', error.message);
    res.status(500).json({ 
      error: 'Failed to send SMS', 
      details: error.message 
    });
  }
});

// Send intake SMS endpoint
router.post('/send-intake-sms/:contactId', verifyToken, async (req, res) => {
  const contactId = req.params.contactId;
  const userId = req.userId;

  try {
    const pool = req.app.get('pool');
    const client = await pool.connect();
    try {
      const contactResult = await client.query(
        'SELECT * FROM contacts WHERE id = $1 AND user_id = $2',
        [contactId, userId]
      );

      if (contactResult.rows.length === 0) {
        client.release();
        return res.status(404).json({ error: 'Contact not found' });
      }

      const contact = contactResult.rows[0];
      const userResult = await client.query('SELECT email FROM users WHERE id = $1', [userId]);
      const userName = userResult.rows[0].email.split('@')[0]; // Extract name from email

      // Check if Twilio credentials are configured
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
        console.error('Missing Twilio credentials in environment variables for intake SMS');
        client.release();
        return res.status(400).json({ 
          error: 'Twilio credentials not configured',
          details: 'The administrator needs to set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER environment variables'
        });
      }

      // Send SMS via Twilio
      const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const message = await twilioClient.messages.create({
        body: `Hi ${contact.first_name}, ${userName} would like to connect with you. Please call ${process.env.TWILIO_PHONE_NUMBER} to complete your intake with our AI relationship assistant.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: contact.phone_number
      });

      // Log the SMS in the database
      await client.query(
        'INSERT INTO sms_log (contact_id, user_id, message_type, created_at) VALUES ($1, $2, $3, NOW())',
        [contactId, userId, 'intake_invitation']
      );

      // Also log in sms_messages for consistency
      await client.query(
        'INSERT INTO sms_messages (contact_id, user_id, message, twilio_sid, sent_at) VALUES ($1, $2, $3, $4, NOW())',
        [contactId, userId, `Intake invitation: Hi ${contact.first_name}, ${userName} would like to connect with you.`, message.sid]
      );

      client.release();
      res.status(200).json({ message: 'Intake SMS sent successfully' });
    } catch (error) {
      client.release();
      throw error;
    }
  } catch (error) {
    console.error('Error sending intake SMS:', error.message);
    res.status(500).json({ error: 'Failed to send SMS', details: error.message });
  }
});

module.exports = router;
