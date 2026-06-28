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
  let isSpeaking = false;
  let silenceTimer = null;
  let hasGreeted = false;
  let greetingDone = false;
  let interruptCount = 0;

  const SILENCE_THRESHOLD = 1500;
  const INTERRUPT_THRESHOLD = 20;

  const triggerResponse = () => {
    if (openAiWs?.readyState === WebSocket.OPEN && !isSpeaking) {
      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  };

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
          type: 'realtime',
          model: 'gpt-realtime-2',
          instructions: SYSTEM_PROMPT,
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: null
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: 'alloy'
            }
          }
        },
      }));
    });

    openAiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data);

        if (event.type === 'error') {
          console.error('OpenAI error:', JSON.stringify(event));
        }

        if (event.type === 'session.updated' && !hasGreeted) {
          hasGreeted = true;
          console.log('Sending greeting...');
          setTimeout(() => {
            if (openAiWs?.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'response.create' }));
            }
          }, 300);
        }

        if (event.type === 'response.created') {
          isSpeaking = true;
          interruptCount = 0;
        }

        if (event.type === 'response.output_audio.delta' && event.delta) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: event.delta },
          }));
        }

        if (event.type === 'response.done') {
          isSpeaking = false;
          greetingDone = true;
          interruptCount = 0;
          if (openAiWs?.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
          }
        }

      } catch (e) {
        console.error('Parse error:', e);
      }
    });

    openAiWs.on('error', (err) => console.error('OpenAI WS error:', err.message));
    openAiWs.on('close', (code, reason) => console.log('OpenAI disconnected:', code, reason.toString()));
  };

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log('Stream started:', streamSid);
        openAiConnect();
      } else if (data.event === 'media' && openAiWs?.readyState === WebSocket.OPEN) {

        if (isSpeaking && greetingDone) {
          interruptCount++;
          if (interruptCount > INTERRUPT_THRESHOLD) {
            console.log('User interrupted Shahin');
            isSpeaking = false;
            interruptCount = 0;
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
          }
          return;
        }

        if (!isSpeaking) {
          openAiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.media.payload,
          }));

          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            triggerResponse();
          }, SILENCE_THRESHOLD);
        }

      } else if (data.event === 'stop') {
        if (silenceTimer) clearTimeout(silenceTimer);
        openAiWs?.close();
      }
    } catch (e) {
      console.error('Twilio parse error:', e);
    }
  });

  twilioWs.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    openAiWs?.close();
    console.log('Twilio disconnected');
  });
});

app.get('/', (req, res) => res.send('HawkVision Pro Voice Agent Running'));

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
