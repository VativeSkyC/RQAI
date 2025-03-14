
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const dbService = require('../services/dbService');

// View all temp_calls (for debugging/admin)
router.get('/temp-calls', verifyToken, async (req, res) => {
  try {
    const pool = req.app.get('pool');
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT call_sid, phone_number, created_at FROM temp_calls ORDER BY created_at DESC'
      );
      res.status(200).json({
        status: 'success',
        count: result.rows.length,
        data: result.rows
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error retrieving temp_calls:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve temp calls',
      error: error.message
    });
  }
});

// Clean up temp_calls older than specified interval
router.post('/cleanup-temp-calls', verifyToken, async (req, res) => {
  try {
    const { interval = '4 hours' } = req.body;
    const pool = req.app.get('pool');
    
    const count = await dbService.cleanupTempCalls(pool, interval);
    
    res.status(200).json({
      status: 'success',
      message: `Cleaned up temp_calls older than ${interval}`,
      count
    });
  } catch (error) {
    console.error('Error cleaning up temp_calls:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Failed to clean up temp calls',
      error: error.message
    });
  }
});

// Clear all temp_calls (use with caution)
router.delete('/clear-temp-calls', verifyToken, async (req, res) => {
  try {
    const pool = req.app.get('pool');
    const count = await dbService.clearAllTempCalls(pool);
    
    res.status(200).json({
      status: 'success',
      message: 'Cleared all temp_calls',
      count
    });
  } catch (error) {
    console.error('Error clearing all temp_calls:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Failed to clear temp calls',
      error: error.message
    });
  }
});

// Clear temp_calls for a specific phone number
router.delete('/clear-temp-calls/:phoneNumber', verifyToken, async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const pool = req.app.get('pool');
    
    const count = await dbService.clearTempCallsByPhone(pool, phoneNumber);
    
    res.status(200).json({
      status: 'success',
      message: `Cleared temp_calls for phone ${phoneNumber}`,
      count
    });
  } catch (error) {
    console.error('Error clearing temp_calls for phone:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Failed to clear temp calls for phone',
      error: error.message
    });
  }
});

module.exports = router;
