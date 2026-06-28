const express = require('express');
const http = require('http');
const twilio = require('twilio');
const https = require('https');

const app = express();
const server = http.createServer(app);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'dncs2t-8m.myshopify.com';
const PORT = process.env.PORT || 8080;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Health check
app.get('/', (req, res) => {
  res.send('HawkVision Pro - WhatsApp Service Running');
});

// Send WhatsApp message
app.post('/send-whatsapp', async (req, res) => {
  try {
    const { to, message, mediaUrl } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
    const toWhatsApp = `whatsapp:${to}`;
    const msgOptions = { from: TWILIO_WHATSAPP_FROM, to: toWhatsApp, body: message };
    if (mediaUrl) msgOptions.mediaUrl = [mediaUrl];
    const result = await client.messages.create(msgOptions);
    res.json({ success: true, sid: result.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search Shopify products
app.post('/shopify-search', async (req, res) => {
  try {
    const { query } = req.body;
    const url = `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?title=${encodeURIComponent(query)}&limit=5`;
    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    const products = data.products.map(p => ({
      id: p.id,
      title: p.title,
      price: p.variants[0]?.price,
      url: `https://hawkvisionpro.co.uk/products/${p.handle}`,
      available: p.variants[0]?.inventory_quantity > 0
    }));
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`HawkVision Pro service running on port ${PORT}`);
});
