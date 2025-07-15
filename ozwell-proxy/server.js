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

// Function to parse structured response
function parseStructuredResponse(content, responseFormat) {
  if (!responseFormat || responseFormat.type !== 'json_schema') {
    return content;
  }

  const schema = responseFormat.json_schema?.schema;
  if (!schema || !schema.properties) {
    return content;
  }

  try {
    // Try to parse as JSON first
    const parsed = JSON.parse(content);
    return parsed;
  } catch (e) {
    // If not JSON, try to extract structured data from text
    const result = {};
    
    // Handle language and title extraction for LibreChat's title generation
    if (schema.properties.language && schema.properties.title) {
      // Extract language
      const languageMatch = content.match(/language.*?is\s+(\w+)/i) || 
                           content.match(/detected language.*?(\w+)/i) ||
                           content.match(/1\.\s*.*?(\w+)/i);
      
      if (languageMatch) {
        result.language = languageMatch[1];
      }
      
      // Extract title - look for quoted text or after "title:"
      const titleMatch = content.match(/title:\s*"([^"]+)"/i) || 
                        content.match(/title:\s*([^\n]+)/i) ||
                        content.match(/2\.\s*.*?:\s*"([^"]+)"/i) ||
                        content.match(/2\.\s*.*?:\s*([^\n]+)/i);
      
      if (titleMatch) {
        result.title = titleMatch[1].replace(/"/g, '').trim();
      }
    }
    
    // If we couldn't extract the expected fields, return the original content
    if (Object.keys(result).length === 0) {
      return content;
    }
    
    return result;
  }
}

// Helper function to create OpenAI compatible error response
function createErrorResponse(statusCode, message, type = 'api_error') {
  return {
    error: {
      message,
      type,
      code: statusCode
    }
  };
}

// Helper function to create OpenAI compatible streaming chunk
function createStreamingChunk(id, model, content, isLast = false) {
  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'Ozwell',
    choices: [{
      index: 0,
      delta: isLast ? {} : { content },
      finish_reason: isLast ? 'stop' : null
    }]
  };
}

// Helper function to sleep (for streaming simulation)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main proxy endpoint for chat completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log('=== RECEIVED REQUEST ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const { messages, model, stream = false, response_format, max_tokens, ...otherParams } = req.body;
    
    // Validate required fields
    if (!messages || !Array.isArray(messages)) {
      console.error('ERROR: Messages array is required');
      return res.status(400).json(createErrorResponse(400, 'Messages array is required', 'invalid_request_error'));
    }
    
    // Get authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      console.error('ERROR: Authorization header is missing');
      return res.status(401).json(createErrorResponse(401, 'Authorization header is required', 'authentication_error'));
    }
    
    // Extract messages - get the conversation context
    let prompt = '';
    let systemMessage = 'You are a helpful assistant.';
    
    // Function to extract text content from message
    const extractTextContent = (content) => {
      if (typeof content === 'string') {
        return content;
      } else if (Array.isArray(content)) {
        // Handle array format: [{ type: 'text', text: 'Hello' }]
        return content
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join(' ');
      }
      return '';
    };

    // Process all messages to build context
    const conversationHistory = [];
    for (const msg of messages) {
      const textContent = extractTextContent(msg.content);
      if (msg.role === 'system') {
        systemMessage = textContent;
      } else if (msg.role === 'user') {
        conversationHistory.push(`User: ${textContent}`);
      } else if (msg.role === 'assistant') {
        conversationHistory.push(`Assistant: ${textContent}`);
      }
    }
    
    // Use the full conversation history for context
    const userMessages = messages.filter(msg => msg.role === 'user');
    if (userMessages.length === 0) {
      console.error('ERROR: No user message found');
      return res.status(400).json(createErrorResponse(400, 'No user message found', 'invalid_request_error'));
    }
    
    // Get the last user message as the main prompt
    prompt = extractTextContent(userMessages[userMessages.length - 1].content);
    
    // If there's conversation history, include it in the system message
    if (conversationHistory.length > 1) {
      systemMessage += '\n\nConversation history:\n' + conversationHistory.slice(0, -1).join('\n');
    }
    
    console.log('=== EXTRACTED DATA ===');
    console.log('Prompt:', prompt);
    console.log('System message:', systemMessage);
    
    // Modify system message if response_format is specified
    if (response_format && response_format.type === 'json_schema') {
      const schema = response_format.json_schema?.schema;
      if (schema) {
        systemMessage += '\n\nIMPORTANT: You must respond with a valid JSON object that matches this schema: ' + JSON.stringify(schema);
        
        // Add specific instructions for common LibreChat patterns
        if (schema.properties?.language && schema.properties?.title) {
          systemMessage += '\n\nFor language detection and title generation, respond with a JSON object like: {"language": "English", "title": "Short Title"}';
        }
      }
    }
    
    // Prepare request payload for Ozwell API
    const ozwellPayload = {
      prompt: prompt,
      systemMessage: systemMessage
    };
    
    // Add max_tokens if specified
    if (max_tokens) {
      ozwellPayload.maxTokens = max_tokens;
    }
    
    console.log('=== CALLING OZWELL API ===');
    console.log('Payload:', JSON.stringify(ozwellPayload, null, 2));
    console.log('URL: https://ai.bluehive.com/api/v1/completion');
    
    // Make request to Ozwell API
    let ozwellResponse;
    try {
      ozwellResponse = await axios.post('https://ai.bluehive.com/api/v1/completion', ozwellPayload, {
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        timeout: 30000, // 30 second timeout
      });
      
      console.log('=== OZWELL API RESPONSE ===');
      console.log('Status:', ozwellResponse.status);
      console.log('Headers:', ozwellResponse.headers);
      console.log('Data:', JSON.stringify(ozwellResponse.data, null, 2));
      
    } catch (apiError) {
      console.error('=== OZWELL API ERROR ===');
      console.error('Error message:', apiError.message);
      console.error('Response status:', apiError.response?.status);
      console.error('Response data:', JSON.stringify(apiError.response?.data, null, 2));
      console.error('Request config:', {
        url: apiError.config?.url,
        method: apiError.config?.method,
        headers: apiError.config?.headers,
        data: apiError.config?.data
      });
      
      const statusCode = apiError.response?.status || 500;
      const errorMessage = apiError.response?.data?.message || apiError.response?.data?.error || apiError.message || 'Internal server error';
      
      return res.status(statusCode).json(createErrorResponse(statusCode, errorMessage, statusCode === 401 ? 'authentication_error' : 'api_error'));
    }
    
    // Validate Ozwell response structure
    if (!ozwellResponse.data) {
      console.error('ERROR: Empty response from Ozwell API');
      return res.status(500).json(createErrorResponse(500, 'Empty response from Ozwell API'));
    }
    
    // Extract content from Ozwell response
    let responseContent = '';
    
    // Handle different possible response structures
    if (ozwellResponse.data.choices && ozwellResponse.data.choices.length > 0) {
      // OpenAI-like structure
      responseContent = ozwellResponse.data.choices[0].message?.content || ozwellResponse.data.choices[0].text || '';
    } else if (ozwellResponse.data.content) {
      // Direct content field
      responseContent = ozwellResponse.data.content;
    } else if (ozwellResponse.data.text) {
      // Text field
      responseContent = ozwellResponse.data.text;
    } else if (ozwellResponse.data.response) {
      // Response field
      responseContent = ozwellResponse.data.response;
    } else if (typeof ozwellResponse.data === 'string') {
      // Direct string response
      responseContent = ozwellResponse.data;
    }
    
    console.log('=== EXTRACTED CONTENT ===');
    console.log('Response content:', responseContent);
    
    if (!responseContent || responseContent.trim() === '') {
      console.error('ERROR: No content in Ozwell response');
      console.error('Full response structure:', JSON.stringify(ozwellResponse.data, null, 2));
      return res.status(500).json(createErrorResponse(500, 'No content in Ozwell API response'));
    }
    
    // Handle structured response if requested
    if (response_format) {
      const parsed = parseStructuredResponse(responseContent, response_format);
      responseContent = typeof parsed === 'object' ? JSON.stringify(parsed) : parsed;
    }
    
    const responseId = ozwellResponse.data.logId || ozwellResponse.data.id || `chatcmpl-${Date.now()}`;
    
    // Handle streaming response
    if (stream) {
      console.log('=== STREAMING RESPONSE ===');
      
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization'
      });

      // Split content into chunks for streaming simulation
      const words = responseContent.split(' ');
      
      try {
        for (let i = 0; i < words.length; i++) {
          const chunk = createStreamingChunk(responseId, model, words[i] + (i < words.length - 1 ? ' ' : ''), false);
          const chunkData = `data: ${JSON.stringify(chunk)}\n\n`;
          
          console.log(`Streaming chunk ${i + 1}/${words.length}:`, chunkData);
          res.write(chunkData);
          
          // Add small delay to simulate streaming
          await sleep(50);
        }
        
        // Send final chunk
        const finalChunk = createStreamingChunk(responseId, model, '', true);
        const finalData = `data: ${JSON.stringify(finalChunk)}\n\n`;
        
        console.log('Final chunk:', finalData);
        res.write(finalData);
        res.write('data: [DONE]\n\n');
        res.end();
        
        console.log('=== STREAMING COMPLETE ===');
        
      } catch (streamError) {
        console.error('ERROR: Streaming failed:', streamError);
        res.end();
      }
      
      return;
    }
    
    // Handle non-streaming response
    console.log('=== NON-STREAMING RESPONSE ===');
    
    // Transform Ozwell response to OpenAI format
    const openAIResponse = {
      id: responseId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'Ozwell',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: responseContent,
          refusal: null
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4), // Rough estimate
        completion_tokens: Math.ceil(responseContent.length / 4),
        total_tokens: Math.ceil((prompt.length + responseContent.length) / 4)
      }
    };
    
    console.log('=== SENDING OPENAI RESPONSE ===');
    console.log('OpenAI formatted response:', JSON.stringify(openAIResponse, null, 2));
    
    res.json(openAIResponse);
    
  } catch (error) {
    console.error('=== UNHANDLED ERROR ===');
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    
    res.status(500).json(createErrorResponse(500, 'Internal server error'));
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.json({ 
    status: 'OK', 
    service: 'Ozwell Proxy',
    timestamp: new Date().toISOString()
  });
});

// Models endpoint (for LibreChat compatibility)
app.get('/v1/models', (req, res) => {
  console.log('Models endpoint requested');
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
  console.error('=== MIDDLEWARE ERROR ===');
  console.error('Unhandled error:', err);
  console.error('Stack:', err.stack);
  
  res.status(500).json(createErrorResponse(500, 'Internal server error'));
});

// 404 handler
app.use('*', (req, res) => {
  console.log('404 - Route not found:', req.method, req.originalUrl);
  res.status(404).json(createErrorResponse(404, 'Not found', 'invalid_request_error'));
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=== OZWELL PROXY STARTED ===`);
  console.log(`Port: ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Models endpoint: http://localhost:${PORT}/v1/models`);
  console.log(`Chat endpoint: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`================================`);
});