const path = require('node:path');
const express = require('express');
const mediaConfigRoutes = require('./routes/mediaConfig');
const sessionRoutes = require('./routes/sessions');

const app = express();
const frontendDirectory = path.resolve(__dirname, '..', 'frontend');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', service: 'multimodal-session-console' });
});

app.use('/api/media-config', mediaConfigRoutes);
app.use('/api/sessions', sessionRoutes);
app.use(express.static(frontendDirectory));

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API endpoint not found.' });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Unexpected server error.' });
});

if (require.main === module) {
  app.listen(port, host, () => {
    console.log(`Multimodal Session Console running at http://${host}:${port}`);
  });
}

module.exports = app;
