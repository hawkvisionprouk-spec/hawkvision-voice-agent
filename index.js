const express = require('express');
const twilio = require('twilio');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const PORT = process.env.PORT || 8080;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const SYSTEM_INSTRUCTIONS = `You are Hawk Vision Pro's professional AI voice sales assistant.

You help customers with CCTV products, security cameras, NVRs, DVRs, PoE cameras, Wi-Fi cameras, wired CCTV systems, cabling, networking equipment, and security accessories.

Speak in natural British English. Be polite, confident, helpful, and professional. Do not sound robotic or pushy.

Your goal is to help customers make informed, professional, and confident security decisions — not just to sell products.

When a customer asks about a product:
- Search the Shopify catalogue.
- Ask for the exact model number if needed.
- Explain features in simple language.
- Explain technologies such as PoE, NVR, DVR, H.265, human detection, vehicle detection, face detection, night vision, remote viewing, and storage.
- Explain benefits, limitations, compatibility, and practical use cases.
- Recommend suitable products based on the customer's needs.
- Use store policies and FAQs when answering questions about delivery, returns, warranty, or support.

Before recommending a CCTV system, ask useful questions such as:
- Is it for a home, shop, office, warehouse, or commercial property?
- How many areas do you want to cover?
- Do you prefer Wi-Fi cameras or a more reliable wired system?
- Do you need night vision, mobile viewing, human detection, vehicle detection, or continuous recording?
- Do you already have cameras or a recorder?

Be honest about limitations. Explain that Wi-Fi cameras can be convenient, but professionally wired PoE CCTV systems are usually more reliable for long-term security.

If the customer wants to buy, help them find the right product and build a cart using the available Shopify tools, but do not add or change cart items without confirmation.

Start each call by greeting the caller warmly: "Hello, thank you for calling Hawk Vision Pro. I'm SkyHawk, your AI assistant. How can I help you today?"`;

// ── Health check ──
app.get('/', (req, res) => {
  res.send('HawkVision Pro - SkyHawk AI Running');
});

// ── Twilio incoming call webhook ──
app.post('/voice', (req, res) => {
  const wsUrl = PUBLIC_URL.replace('https://', 'wss://').replace('http://', 'ws://');
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `${wsUrl}/media-stream` });
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── WebSocket server for Twilio Media Streams ──
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', async (twilioWs) => {
  console.log('Twilio Media Stream connected');

  let openaiWs = null;
  let streamSid = null;
  let callSid = null;

  // Get ephemeral session token from OpenAI
  let sessionConfig;
  try {
    const tokenRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          instructions: SYSTEM_INSTRUCTIONS,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 8000 },
              transcription: { model: 'gpt-realtime-whisper' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500
              }
            },
            output: {
              format: { type: 'audio/pcm', rate: 8000 },
              voice: 'alloy'
            }
          },
          output_modalities: ['audio'],
          tools: [
            {
              type: 'mcp',
              server_label: 'shopify',
              server_url: 'https://hawkvisionpro.co.uk/api/mcp',
              server_description: 'Hawk Vision Pro Shopify store tools for searching products, managing cart, and answering FAQs.',
              allowed_tools: [
                'search_catalog',
                'get_cart',
                'update_cart',
                'search_shop_policies_and_faqs',
                'get_product_details'
              ],
              require_approval: 'never'
            }
          ],
          tool_choice: 'auto',
          max_output_tokens: 'inf'
        }
      })
    });

    sessionConfig = await tokenRes.json();
    console.log('Session config status:', tokenRes.status);

    if (!tokenRes.ok) {
      console.error('OpenAI session error:', JSON.stringify(sessionConfig));
      twilioWs.close();
      return;
    }
  } catch (err) {
    console.error('Failed to get OpenAI session:', err.message);
    twilioWs.close();
    return;
  }

  // Connect to OpenAI Realtime WebSocket
  const realtimeUrl = sessionConfig.url || 'wss://api.openai.com/v1/realtime';
  const clientSecret = sessionConfig.client_secret?.value;

  openaiWs = new WebSocket(realtimeUrl, {
    headers: {
      'Authorization': `Bearer ${clientSecret || OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    console.log('OpenAI Realtime WebSocket connected');
  });

  // ── OpenAI → Twilio ──
  openaiWs.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());

      switch (event.type) {
        case 'session.created':
          console.log('OpenAI session created:', event.session?.id);
          break;

        case 'session.updated':
          console.log('OpenAI session updated');
          break;

        case 'response.audio.delta':
          if (event.delta && streamSid) {
            const payload = Buffer.isBuffer(event.delta)
              ? event.delta.toString('base64')
              : event.delta;
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload }
            }));
          }
          break;

        case 'response.audio.done':
          console.log('Audio response complete');
          break;

        case 'response.done':
          console.log('Response done');
          break;

        case 'input_audio_buffer.speech_started':
          console.log('Speech detected');
          // Clear Twilio audio buffer
          if (streamSid) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
          }
          break;

        case 'error':
          console.error('OpenAI error event:', JSON.stringify(event.error));
          break;

        default:
          break;
      }
    } catch (err) {
      console.error('Error parsing OpenAI message:', err.message);
    }
  });

  openaiWs.on('error', (err) => {
    console.error('OpenAI WebSocket error:', err.message);
  });

  openaiWs.on('close', (code, reason) => {
    console.log('OpenAI WebSocket closed:', code, reason?.toString());
  });

  // ── Twilio → OpenAI ──
  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log('Stream started - SID:', streamSid, 'Call:', callSid);
          break;

        case 'media':
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            }));
          }
          break;

        case 'stop':
          console.log('Stream stopped');
          if (openaiWs) openaiWs.close();
          break;

        default:
          break;
      }
    } catch (err) {
      console.error('Error parsing Twilio message:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WebSocket closed');
    if (openaiWs) openaiWs.close();
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WebSocket error:', err.message);
  });
});

// ── HTTP server with WebSocket upgrade ──
const server = app.listen(PORT, () => {
  console.log(`HawkVision Pro - SkyHawk AI running on port ${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});
