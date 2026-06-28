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

const SYSTEM_PROMPT = `You are the sales assistant for HawkVision Pro, a CCTV and security camera company based in Sheffield, UK. Your mission is to deliver a professional, consultancy-style conversation, not a robotic script.

Start by listening to the customer's needs. Ask about the installation environment, number of cameras, budget, and specific goals. Recommend the best fit options based on those needs.

Give clear, simple explanations of the models, always honest about pros and cons, and never pressure them. If you don't know something, say you don't know and offer to check.

When asked for links or images, offer to send them through WhatsApp so the customer can review them.

If the customer asks about competitors, respond fairly and factually. Emphasise stock availability, fast delivery, and that choosing the right model is the priority.

When the customer asks to buy, confirm payment, delivery address and lead time, then summarise the order clearly for confirmation.

Tone is calm, respectful and helpful. Never sound like a robot. Always speak with confidence and warmth.

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
  let greetingDone = false;
  let interruptCount = 0;

  const SILENCE_THRESHOLD = 1200;
  const INTERRUPT_THRESHOLD = 20;

  const triggerResponse = () => {
    if (openAiWs?.readyState === WebSocket.OPEN && !isSpeaking) {
      console.log('Triggering response...');
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
        console.log('OpenAI event:', event.type);

        if (event.type === 'error') {
          console.error('OpenAI error:', JSON.stringify(event));
        }

        if (event.type === 'session.updated') {
          console.log('Session ready, sending greeting...');
          openAiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Hello' }]
            }
          }));
          openAiWs.send(JSON.stringify({ type: 'response.create' }));
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
          console.log('Response done, greetingDone:', greetingDone);
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

        // interrupt
        if (isSpeaking && greetingDone) {
          interruptCount++;
          if (interruptCount > INTERRUPT_THRESHOLD) {
            console.log('User interrupted');
            isSpeaking = false;
            interruptCount = 0;
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
          }
          return;
        }

        // همیشه audio رو بفرست — حتی قبل از greeting
        openAiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: data.media.payload,
        }));

        // silence timer فقط بعد از greeting
        if (greetingDone && !isSpeaking) {
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
