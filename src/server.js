require('dotenv').config();
const WebSocket = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');

const PORT = process.env.WS_PORT || 8888;
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket server running on ws://localhost:${PORT}`);

wss.on('connection', async (ws) => {
  console.log('Client connected');
  
  let geminiSession = null;
  let isRecording = false;
  let responseTimer = null;
  
  // Token usage tracking
  let sessionTokenCount = 0;
  let sessionStartTime = Date.now();

  // Client-specific configuration
  let clientConfig = {
    locale: 'en-US',
    voiceName: 'Orus',
    productName: null,
    productDescription: null,
    productFeatures: [],
    greeting: null, // Will be set from localization
    systemInstruction: null, // Will be set from localization
    responseTimeout: 800
  };

  async function initGeminiSession() {
    try {
      if (geminiSession) {
        geminiSession.close();
      }

      console.log('Initializing Gemini session...');
      const client = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
      });

      // Try different models in order of preference (using newer model from reference)
      const modelsToTry = [
        process.env.GEMINI_MODEL,
        'gemini-2.5-flash-native-audio-preview-09-2025',
        'gemini-live-2.5-flash-preview',
        'gemini-2.5-flash-preview-native-audio-dialog'
      ].filter(Boolean);

      let lastError;
      for (const model of modelsToTry) {
        try {
          geminiSession = await client.live.connect({
            model: model,
            callbacks: {
              onopen: () => {
                console.log('Gemini session opened');
                // Don't send connection status to UI - keep it clean
              },
              onmessage: async (message) => {
                // Handle token usage tracking
                if (message.usageMetadata) {
                  const currentTotal = message.usageMetadata.totalTokenCount || 0;
                  sessionTokenCount += currentTotal;
                  
                  console.log('🔢 Token Usage - This Turn: %s tokens | Session Total: %s tokens', 
                    currentTotal, sessionTokenCount);
                  
                  if (message.usageMetadata.candidatesTokenCount) {
                    console.log('   📝 Candidates: %s tokens', message.usageMetadata.candidatesTokenCount);
                  }
                  
                  if (message.usageMetadata.promptTokenCount) {
                    console.log('   💬 Prompt: %s tokens', message.usageMetadata.promptTokenCount);
                  }
                  
                  if (message.usageMetadata.responseTokensDetails) {
                    console.log('   📊 Response token breakdown:');
                    for (const detail of message.usageMetadata.responseTokensDetails) {
                      console.log('     %s', detail);
                    }
                  }
                }

                // Handle audio responses (check both formats)
                const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData || message.data;
                if (audio) {
                  ws.send(JSON.stringify({
                    type: 'audio_response',
                    payload: {
                      data: audio.data || audio
                    }
                  }));
                }

                // Handle text responses  
                if (message.serverContent?.text) {
                  ws.send(JSON.stringify({ 
                    type: 'transcript', 
                    payload: { 
                      sender: 'ai', 
                      text: message.serverContent.text 
                    } 
                  }));
                }

                // Handle input transcription (user's speech)
                if (message.serverContent?.inputTranscription) {
                  ws.send(JSON.stringify({
                    type: 'transcript',
                    payload: {
                      sender: 'user',
                      text: message.serverContent.inputTranscription.text
                    }
                  }));
                }

                // Handle output transcription (AI's speech)
                if (message.serverContent?.outputTranscription) {
                  ws.send(JSON.stringify({
                    type: 'transcript',
                    payload: {
                      sender: 'ai',
                      text: message.serverContent.outputTranscription.text
                    }
                  }));
                }
              },
              onerror: (e) => {
                console.error('Gemini error:', e);
                // Keep error in logs but don't show technical errors to users
              },
              onclose: (e) => {
                console.log('Gemini session closed:', e.code, e.reason);
                // Don't send session close messages to frontend - users don't need to see this
              },
            },
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: clientConfig.voiceName } },
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction: clientConfig.systemInstruction ? {
                parts: [{
                  text: clientConfig.systemInstruction
                }]
              } : undefined,
            },
          });
          break; // Success, stop trying other models
        } catch (err) {
          lastError = err;
          continue; // Try next model
        }
      }

      if (!geminiSession) {
        throw lastError || new Error('No models available');
      }

    } catch (err) {
      console.error('Failed to initialize Gemini session:', err);
      // Keep connection errors in logs but don't show to users
    }
  }

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'configure':
          // Update client configuration
          if (msg.payload) {
            clientConfig = { ...clientConfig, ...msg.payload };
            console.log('Client configuration updated:', {
              locale: clientConfig.locale,
              voiceName: clientConfig.voiceName,
              productName: clientConfig.productName,
              hasSystemInstruction: !!clientConfig.systemInstruction,
              hasGreeting: !!clientConfig.greeting,
              responseTimeout: clientConfig.responseTimeout
            });
            
            // Debug: Log first 100 characters of system instruction
            if (clientConfig.systemInstruction) {
              console.log('System instruction preview:', clientConfig.systemInstruction.substring(0, 100) + '...');
            }
            // Don't log full systemInstruction and greeting to keep console clean
          }
          break;

        case 'start':
          isRecording = true;
          await initGeminiSession();
          break;

        case 'stop':
          isRecording = false;
          if (geminiSession) {
            geminiSession.close();
            geminiSession = null;
          }
          // Don't send "Stopped" message - users don't need to see this
          break;

        case 'interrupt':
          // User wants to interrupt AI - close current session
          if (geminiSession) {
            geminiSession.close();
            geminiSession = null;
          }
          isRecording = false;
          console.log('AI interrupted by user');
          break;

        case 'request_greeting':
          // User has enabled audio, send greeting now
          try {
            await initGeminiSession();
            if (geminiSession) {
              // Use the greeting from client config (which should come from localization)
              const greeting = clientConfig.greeting || "Hello! I'm your online shop assistant. How can I help you today?";
              geminiSession.sendRealtimeInput({
                text: greeting
              });
            }
          } catch (err) {
            console.error('Failed to send greeting:', err);
          }
          break;

        case 'audio_blob':
          if (geminiSession && isRecording && msg.payload) {
            // Clear any existing response timer
            if (responseTimer) {
              clearTimeout(responseTimer);
            }
            
            try {
              // Use exact format from new reference implementation
              geminiSession.sendRealtimeInput({ 
                audio: {
                  data: msg.payload.data,
                  mimeType: msg.payload.mimeType
                }
              });
              
              // Set a timer to trigger response after silence
              responseTimer = setTimeout(() => {
                // Check if session is still active before sending
                if (geminiSession) {
                  try {
                    geminiSession.sendRealtimeInput({
                      text: { data: "Please respond to what I just said." }
                    });
                  } catch (err) {
                    console.error('Error requesting response:', err);
                  }
                }
              }, clientConfig.responseTimeout); // Use client-configured timeout
              
            } catch (err) {
              console.error('Error sending audio to Gemini:', err);
            }
          }
          break;
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });

  ws.on('close', () => {
    const sessionDuration = Math.round((Date.now() - sessionStartTime) / 1000);
    console.log('Client disconnected');
    console.log('📊 Session Summary:');
    console.log('   🔢 Total tokens consumed: %s', sessionTokenCount);
    console.log('   ⏱️  Session duration: %s seconds', sessionDuration);
    console.log('   🗣️  Voice: %s | Locale: %s', clientConfig.voiceName, clientConfig.locale);
    if (sessionTokenCount > 0 && sessionDuration > 0) {
      console.log('   📈 Average tokens per second: %s', (sessionTokenCount / sessionDuration).toFixed(2));
    }
    
    if (responseTimer) {
      clearTimeout(responseTimer);
      responseTimer = null;
    }
    if (geminiSession) {
      geminiSession.close();
      geminiSession = null;
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});
