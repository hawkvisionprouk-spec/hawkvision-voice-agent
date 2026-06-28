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
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'dncs2t-8m.myshopify.com';
const PORT = process.env.PORT || 8080;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

app.get('/', (req, res) => {
  res.send('HawkVision Pro - Voice Agent Service Running');
});

// Combined tool — search Shopify and optionally send WhatsApp
app.post('/hawk-action', async (req, res) => {
  try {
    const { action, query, to, message, mediaUrl } = req.body;

    // SEND WHATSAPP
    if (action === 'send_whatsapp') {
      if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
      const msgOptions = {
        from: TWILIO_WHATSAPP_FROM,
        to: `whatsapp:${to}`,
        body: message
      };
      if (mediaUrl) msgOptions.mediaUrl = [mediaUrl];
      const result = await client.messages.create(msgOptions);
      return res.json({ success: true, sid: result.sid });
    }

    // SEARCH SHOPIFY
    if (action === 'search_shopify') {
      if (!query) return res.status(400).json({ error: 'Missing query' });
      const url = `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?title=${encodeURIComponent(query)}&limit=5`;
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json();
      const products = data.products.map(p => ({
        title: p.title,
        price: p.variants[0]?.price,
        url: `https://hawkvisionpro.co.uk/products/${p.handle}`,
        available: p.variants[0]?.inventory_quantity > 0
      }));
      return res.json({ products });
    }

    // SEARCH AND SEND — search Shopify then auto-send WhatsApp
    if (action === 'search_and_send') {
      if (!query || !to) return res.status(400).json({ error: 'Missing query or to' });
      const url = `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?title=${encodeURIComponent(query)}&limit=3`;
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json();
      const products = data.products.slice(0, 3);
      if (products.length === 0) return res.json({ success: false, message: 'No products found' });
      const msgLines = products.map(p =>
        `*${p.title}*\nPrice: £${p.variants[0]?.price}\nhttps://hawkvisionpro.co.uk/products/${p.handle}`
      );
      const msgBody = `Here are the products from Hawk Vision Pro:\n\n${msgLines.join('\n\n')}`;
      const result = await client.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to: `whatsapp:${to}`,
        body: msgBody
      });
      return res.json({ success: true, sid: result.sid, products: products.map(p => p.title) });
    }

    res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`HawkVision Pro service running on port ${PORT}`);
});
