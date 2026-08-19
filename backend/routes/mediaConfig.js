const express = require('express');
const { readMediaConfig, writeMediaConfig } = require('../services/jsonStore');

const router = express.Router();

router.get('/', async (_request, response, next) => {
  try {
    response.json(await readMediaConfig());
  } catch (error) {
    next(error);
  }
});

router.put('/', async (request, response, next) => {
  try {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.status(400).json({ error: 'Media configuration must be a JSON object.' });
    }

    return response.json(await writeMediaConfig(request.body));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
