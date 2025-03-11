
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');

// Get contacts endpoint with intake status
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const pool = req.app.get('pool');
    const client = await pool.connect();
    
    // Modified query to include intake status
    const result = await client.query(`
      SELECT c.id, c.first_name, c.last_name, c.phone_number, c.company_name, c.linkedin_url, c.created_at,
      CASE WHEN ir.id IS NOT NULL THEN true ELSE false END AS has_intake
      FROM contacts c
      LEFT JOIN (
        SELECT DISTINCT contact_id, id
        FROM intake_responses
        WHERE user_id = $1
      ) ir ON c.id = ir.contact_id
      WHERE c.user_id = $1
      ORDER BY c.created_at DESC
    `, [userId]);
    
    client.release();
    res.json({ contacts: result.rows });
  } catch (error) {
    console.error('Error fetching contacts:', error.message);
    res.status(500).json({ error: 'Failed to retrieve contacts' });
  }
});

// Add contact endpoint with text message notification
router.post('/', verifyToken, async (req, res) => {
  try {
    const { first_name, last_name, company_name, linkedin_url, phone_number } = req.body;
    const userId = req.userId; // From the verifyToken middleware

    // Validate required fields
    if (!first_name || !last_name || !phone_number) {
      return res.status(400).json({ error: 'Missing required fields (first_name, last_name, and phone_number are required)' });
    }

    // Validate phone number format (optional)
    const phoneRegex = /^\+?[1-9]\d{1,14}$/; // Basic E.164 format check
    if (!phoneRegex.test(phone_number)) {
      return res.status(400).json({ error: 'Invalid phone number format. Please use E.164 format (e.g., +12125551234)' });
    }

    const pool = req.app.get('pool');
    // Add contact to database
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO contacts (first_name, last_name, company_name, linkedin_url, phone_number, user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id`,
        [first_name, last_name, company_name || null, linkedin_url || null, phone_number, userId]
      );
      const contactId = result.rows[0].id;

      // Send automated text if Twilio credentials are configured
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
        const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

        await twilioClient.messages.create({
          body: `Hi ${first_name}! Please call this number to connect with our AI Relationship Agent: ${process.env.TWILIO_PHONE_NUMBER}`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone_number
        });
        console.log(`Text message sent to ${phone_number}`);
      } else {
        console.log('Twilio credentials not configured - skipping text message');
      }

      await client.query('COMMIT');
      console.log(`Contact added: ${first_name} ${last_name} (${phone_number}), ID: ${contactId}`);
      res.status(201).json({ 
        message: 'Contact added successfully', 
        contact_id: contactId,
        text_sent: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER)
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error; // Pass to outer catch block
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error adding contact:', error.message);
    // Handle specific PostgreSQL errors
    if (error.code === '23505') { // Unique violation
      return res.status(400).json({ error: 'Phone number already exists in contacts' });
    }
    res.status(500).json({ error: 'Failed to add contact', details: error.message });
  }
});

// Update contact endpoint
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const contactId = req.params.id;
    const userId = req.userId;
    const { first_name, last_name, phone_number, company_name, linkedin_url } = req.body;
    
    // Validate required fields
    if (!first_name || !last_name || !phone_number) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const pool = req.app.get('pool');
    const client = await pool.connect();
    
    // Verify contact belongs to user
    const checkResult = await client.query(
      'SELECT id FROM contacts WHERE id = $1 AND user_id = $2',
      [contactId, userId]
    );
    
    if (checkResult.rows.length === 0) {
      client.release();
      return res.status(403).json({ error: 'Contact not found or access denied' });
    }
    
    // Update contact
    await client.query(
      `UPDATE contacts 
       SET first_name = $1, last_name = $2, phone_number = $3, company_name = $4, linkedin_url = $5
       WHERE id = $6 AND user_id = $7`,
      [first_name, last_name, phone_number, company_name || null, linkedin_url || null, contactId, userId]
    );
    
    client.release();
    res.json({ message: 'Contact updated successfully' });
  } catch (error) {
    console.error('Error updating contact:', error.message);
    // Handle specific PostgreSQL errors
    if (error.code === '23505') { // Unique violation
      return res.status(400).json({ error: 'Phone number already exists in contacts' });
    }
    res.status(500).json({ error: 'Failed to update contact', details: error.message });
  }
});

// Get intake responses endpoint
router.get('/:contactId/intake', verifyToken, async (req, res) => {
  try {
    const contactId = req.params.contactId;
    const userId = req.userId;
    const pool = req.app.get('pool');
    const client = await pool.connect();
    
    // First verify the contact belongs to the user
    const contactCheck = await client.query(
      'SELECT id FROM contacts WHERE id = $1 AND user_id = $2',
      [contactId, userId]
    );
    
    if (contactCheck.rows.length === 0) {
      client.release();
      return res.status(403).json({ error: 'Contact not found or access denied' });
    }
    
    // Get all intake responses for this contact
    const result = await client.query(
      `SELECT 
        id, 
        communication_style, 
        goals, 
        values, 
        professional_goals, 
        partnership_expectations, 
        raw_transcript,
        created_at 
      FROM intake_responses 
      WHERE contact_id = $1 AND user_id = $2
      ORDER BY created_at DESC`,
      [contactId, userId]
    );
    
    client.release();
    res.json({ intake_responses: result.rows });
  } catch (error) {
    console.error('Error fetching intake responses:', error.message);
    res.status(500).json({ error: 'Failed to retrieve intake responses' });
  }
});

module.exports = router;
