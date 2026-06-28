const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 8080;

const SYSTEM_PROMPT = `You are Shahin, a professional and friendly AI phone assistant for HawkVision Pro LTD, a CCTV and security camera company based in Sheffield, UK.

Your role is to:
- Answer customer questions about CCTV cameras, NVRs, and security systems
- Help customers choose the right products for their needs
- Provide information about ANNKE products, installation, warranty, delivery, and returns
- Collect customer details for follow-up (name, address, number of cameras needed, budget)
- Always ask for the exact model number before giving technical advice
- Ask if the customer has WhatsApp to send product details after the call
- If you don't know something, say you will check and call back rather than guessing

Always speak in clear, professional British English. Be warm, helpful and concise.
Never make up product specifications or prices.

Start by greeting the customer: "Good day, thank you for calling HawkVision Pro. My name is Shahin, how can I help you today?"`;

app.post('/incoming-call', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

wss.on('connection', (twilioWs) => {
  console.log('Twilio connected');

  let openAiWs = null;
  let streamSid = null;

  const openAiConnect = () => {
    console.log('Connecting to OpenAI...');
    openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime-2',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    openAiWs.on('open', () => {
      console.log('OpenAI connected');
      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: 'alloy',
          instructions: SYSTEM_PROMPT,
          modalities: ['text', 'audio'],
          temperature: 0.8,
        },
      }));
    });

    openAiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data);
        console.log('OpenAI event:', event.type);
        if (event.type === 'error') {
          console.error('OpenAI error event:', JSON.stringify(event));
        }
        if (event.type === 'response.audio.delta' && event.delta) {
          const audioPayload = {
            event: 'media',
            streamSid,
            media: { payload: event.delta },
          };
          twilioWs.send(JSON.stringify(audioPayload));
        }
      } catch (e) {
        console.error('Failed to parse OpenAI message:', e);
      }
    });

    openAiWs.on('error', (err) => {
      console.error('OpenAI WS error:', err.message, JSON.stringify(err));
    });

    openAiWs.on('close', (code, reason) => {
      console.log('OpenAI disconnected - code:', code, 'reason:', reason.toString());
    });
  };

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log('Stream started, SID:', streamSid);
        openAiConnect();
      } else if (data.event === 'media' && openAiWs?.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: data.media.payload,
        }));
      } else if (data.event === 'stop') {
        console.log('Stream stopped');
        openAiWs?.close();
      }
    } catch (e) {
      console.error('Failed to parse Twilio message:', e);
    }
  });

  twilioWs.on('close', () => {
    openAiWs?.close();
    console.log('Twilio disconnected');
  });
});

app.get('/', (req, res) => res.send('HawkVision Pro Voice Agent Running'));

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
