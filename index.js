const express = require('express');
const http = require('http');
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const PORT = process.env.PORT || 8080;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Health check
app.get('/', (req, res) => {
  res.send('HawkVision Pro - WhatsApp Service Running');
});

// Send WhatsApp message (called by Vapi tool)
app.post('/send-whatsapp', async (req, res) => {
  try {
    const { to, message, mediaUrl } = req.body;

    if (!to || !message) {
      return res.status(400).json({ error: 'Missing to or message' });
    }

    const toWhatsApp = `whatsapp:${to}`;

    const msgOptions = {
      from: TWILIO_WHATSAPP_FROM,
      to: toWhatsApp,
      body: message,
    };

    if (mediaUrl) {
      msgOptions.mediaUrl = [mediaUrl];
    }

    const result = await client.messages.create(msgOptions);

    console.log('WhatsApp sent:', result.sid);
    res.json({ success: true, sid: result.sid });

  } catch (err) {
    console.error('WhatsApp error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`HawkVision Pro WhatsApp Service running on port ${PORT}`);
});
