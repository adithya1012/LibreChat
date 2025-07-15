const express = require('express');
const axios = require('axios');
const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Main proxy endpoint for chat completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log('Received request:', JSON.stringify(req.body, null, 2));
    
    const { messages, model, stream = false, ...otherParams } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          message: 'Messages array is required',
          type: 'invalid_request_error'
        }
      });
    }
    
    // Extract messages - get the conversation context
    let prompt = '';
    let systemMessage = 'You are a helpful assistant.';
    
    // Process all messages to build context
    const conversationHistory = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessage = msg.content;
      } else if (msg.role === 'user') {
        conversationHistory.push(`User: ${msg.content}`);
      } else if (msg.role === 'assistant') {
        conversationHistory.push(`Assistant: ${msg.content}`);
      }
    }
    
    // Use the full conversation or just the last user message
    // For now, let's use just the last user message
    const userMessages = messages.filter(msg => msg.role === 'user');
    prompt = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
    
    if (!prompt) {
      return res.status(400).json({
        error: {
          message: 'No user message found',
          type: 'invalid_request_error'
        }
      });
    }
    
    // Get authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({
        error: {
          message: 'Authorization header is required',
          type: 'authentication_error'
        }
      });
    }
    
    console.log('Calling Ozwell API with:', { prompt, systemMessage });
    
    // Make request to Ozwell API
    const ozwellResponse = await axios.post('https://ai.bluehive.com/api/v1/completion', {
      prompt: prompt,
      systemMessage: systemMessage
    }, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });
    
    console.log('Ozwell API response:', JSON.stringify(ozwellResponse.data, null, 2));
    
    // Transform Ozwell response to OpenAI format
    const openAIResponse = {
      id: ozwellResponse.data.logId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'Ozwell',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: ozwellResponse.data.choices[0].message.content,
          refusal: ozwellResponse.data.choices[0].message.refusal || null
        },
        finish_reason: ozwellResponse.data.choices[0].finish_reason || 'stop'
      }],
      usage: {
        prompt_tokens: prompt.length / 4, // Rough estimate
        completion_tokens: ozwellResponse.data.choices[0].message.content.length / 4,
        total_tokens: (prompt.length + ozwellResponse.data.choices[0].message.content.length) / 4
      }
    };
    
    console.log('Sending OpenAI formatted response:', JSON.stringify(openAIResponse, null, 2));
    res.json(openAIResponse);
    
  } catch (error) {
    console.error('Error calling Ozwell API:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      config: {
        url: error.config?.url,
        method: error.config?.method,
        headers: error.config?.headers
      }
    });
    
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.message || error.message || 'Internal server error';
    
    res.status(statusCode).json({
      error: {
        message: errorMessage,
        type: statusCode === 401 ? 'authentication_error' : 'api_error',
        code: statusCode
      }
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Ozwell Proxy',
    timestamp: new Date().toISOString()
  });
});

// Models endpoint (for LibreChat compatibility)
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'Ozwell',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'ozwell'
      }
    ]
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      type: 'api_error'
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: {
      message: 'Not found',
      type: 'invalid_request_error'
    }
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ozwell proxy service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});