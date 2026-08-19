const express = require('express');
const { writeSession } = require('../services/jsonStore');

const router = express.Router();

router.post('/', async (request, response, next) => {
  try {
    const session = request.body;

    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      return response.status(400).json({ error: 'Session payload must be a JSON object.' });
    }

    if (!Array.isArray(session.markers)) {
      return response.status(400).json({ error: 'Session payload must include a markers array.' });
    }

    const fileName = await writeSession(session);
    return response.status(201).json({ saved: true, fileName });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
