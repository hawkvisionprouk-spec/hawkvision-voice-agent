const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const fetch = require('node-fetch');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'dncs2t-8m.myshopify.com';
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const callSessions = {};

app.get('/', (req, res) => {
  res.send('HawkVision Pro AI - Running');
});

// Twilio Voice Webhook — incoming call
app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From;

  callSessions[callSid] = {
    caller: callerNumber,
    startTime: Date.now(),
    messages: [
      {
        role: 'system',
        content: `You are Shahin, AI sales assistant for Hawk Vision Pro, a CCTV security shop in Sheffield UK.
RULES:
- Always respond in English only
- Keep responses SHORT — max 2 sentences
- Never ask more than one question at a time
- When customer wants WhatsApp, say "Sending now" and end with [SEND_WHATSAPP]
- When call exceeds 2 minutes or question is complex, say "Please visit our website at hawkvisionpro.co.uk, our AI chat assistant will help you" then end with [END_CALL]
- You sell ANNKE CCTV cameras, DVR/NVR systems, PoE cameras
- Website: hawkvisionpro.co.uk`
      }
    ]
  };

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Brian', language: 'en-GB' },
    'Hello, thank you for calling Hawk Vision Pro. I am Shahin, your AI assistant. How can I help you today?'
  );
  twiml.gather({
    input: 'speech',
    action: '/voice/respond',
    speechTimeout: 'auto',
    language: 'en-GB'
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Process customer speech
app.post('/voice/respond', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const session = callSessions[callSid];

  const twiml = new twilio.twiml.VoiceResponse();

  if (!session || !speechResult) {
    twiml.say({ voice: 'Polly.Brian' }, 'Sorry, I did not catch that. Goodbye.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Check call duration — 2 minutes
  const elapsed = (Date.now() - session.startTime) / 1000;
  if (elapsed > 120) {
    twiml.say({ voice: 'Polly.Brian' },
      'Please visit our website at hawk vision pro dot co dot uk. Our AI chat assistant will help you in detail. Goodbye!'
    );
    // Send WhatsApp with website link
    await sendWhatsApp(session.caller,
      '🦅 Hawk Vision Pro\nFor detailed help, visit our website:\nhttps://hawkvisionpro.co.uk\nOur AI assistant is ready to help you!'
    );
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Add customer message
  session.messages.push({ role: 'user', content: speechResult });

  // Check if customer mentions products — search Shopify
  let shopifyContext = '';
  const productKeywords = ['camera', 'cctv', 'dvr', 'nvr', 'poe', 'system', 'megapixel', 'outdoor', 'indoor'];
  if (productKeywords.some(k => speechResult.toLowerCase().includes(k))) {
    const products = await searchShopify(speechResult);
    if (products.length > 0) {
      shopifyContext = `\nAvailable products: ${products.map(p => `${p.title} £${p.price}`).join(', ')}`;
      session.messages.push({ role: 'system', content: shopifyContext });
    }
  }

  // Get AI response
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: session.messages,
    max_tokens: 150
  });

  const aiResponse = completion.choices[0].message.content;
  session.messages.push({ role: 'assistant', content: aiResponse });

  // Check for special commands
  if (aiResponse.includes('[SEND_WHATSAPP]')) {
    const cleanResponse = aiResponse.replace('[SEND_WHATSAPP]', '').trim();
    twiml.say({ voice: 'Polly.Brian' }, cleanResponse);

    // Send WhatsApp with products
    const products = await searchShopify(speechResult);
    let waMsg = '🦅 Hawk Vision Pro - Products for you:\n\n';
    if (products.length > 0) {
      products.forEach((p, i) => {
        waMsg += `${i+1}. ${p.title}\n💷 £${p.price}\n${p.url}\n\n`;
      });
    } else {
      waMsg += 'Visit us: https://hawkvisionpro.co.uk';
    }
    await sendWhatsApp(session.caller, waMsg);

    twiml.gather({
      input: 'speech',
      action: '/voice/respond',
      speechTimeout: 'auto',
      language: 'en-GB'
    });
  } else if (aiResponse.includes('[END_CALL]')) {
    const cleanResponse = aiResponse.replace('[END_CALL]', '').trim();
    twiml.say({ voice: 'Polly.Brian' }, cleanResponse);
    twiml.hangup();
  } else {
    twiml.say({ voice: 'Polly.Brian' }, aiResponse);
    twiml.gather({
      input: 'speech',
      action: '/voice/respond',
      speechTimeout: 'auto',
      language: 'en-GB'
    });
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// Search Shopify products
async function searchShopify(query) {
  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?limit=3`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
    });
    const data = await response.json();
    return (data.products || []).map(p => ({
      title: p.title,
      price: p.variants[0]?.price,
      url: `https://hawkvisionpro.co.uk/products/${p.handle}`
    }));
  } catch (err) {
    console.error('Shopify error:', err);
    return [];
  }
}

// Send WhatsApp
async function sendWhatsApp(to, message) {
  try {
    if (!to) return;
    let number = to.replace(/[\s\(\)\-]/g, '');
    if (!number.startsWith('+')) number = '+44' + number.replace(/^0/, '');
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${number}`,
      body: message
    });
  } catch (err) {
    console.error('WhatsApp error:', err);
  }
}

app.listen(PORT, () => {
  console.log(`HawkVision Pro AI running on port ${PORT}`);
});
