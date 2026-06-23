import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
//import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Store MCP client instances
const mcpClients = new Map();

// Cloudflare AI Search configuration
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_AI_SEARCH_NAME = process.env.CLOUDFLARE_AI_SEARCH_NAME;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_AI_SEARCH_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-search/instances/obgyn4`;

let aiSearchReady = false;
let activeSearchUrl = CF_AI_SEARCH_URL;

async function initAISearch() {
  // Validate credentials are present
  if (!CF_ACCOUNT_ID || !CF_AI_SEARCH_NAME || !CF_API_TOKEN) {
    throw new Error('Missing Cloudflare AI Search credentials in .env file');
  }

  // Test connection by doing a lightweight search
  try {
    const response = await fetch(`${CF_AI_SEARCH_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CF_API_TOKEN}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        ai_search_options: { retrieval: { max_num_results: 1 } }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`AI Search connection failed: ${JSON.stringify(err.errors)}`);
    }

    aiSearchReady = true;
    activeSearchUrl = CF_AI_SEARCH_URL; 
    console.log('Cloudflare AI Search initialized successfully');
    return true;
  } catch (error) {
    console.error('AI Search init error:', error);
    throw error;
  }
}

async function initAISearchGyn() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw new Error('Missing Cloudflare AI Search credentials in .env file');
  }

  const GYN_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-search/instances/gyne1`;

  try {
    const response = await fetch(`${GYN_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CF_API_TOKEN}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        ai_search_options: { retrieval: { max_num_results: 1 } }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`AI Search connection failed: ${JSON.stringify(err.errors)}`);
    }

    aiSearchReady = true;
    activeSearchUrl = GYN_URL;
    console.log('Cloudflare AI Search Gyne initialized successfully');
    return true;
  } catch (error) {
    console.error('AI Search init error:', error);
    throw error;
  }
}


async function queryAISearch(question) {
  if (!aiSearchReady) {
    throw new Error('Cloudflare AI Search not initialized');
  }

  const response = await fetch(`${activeSearchUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CF_API_TOKEN}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: question }],
      ai_search_options: {
        retrieval: {
          max_num_results: 10,
          match_threshold: 0.4
        }
      }
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`AI Search query failed: ${JSON.stringify(err.errors)}`);
  }

  const data = await response.json();

  // Return in a format compatible with the rest of the app
  return {
    textResponse: data.choices?.[0]?.message?.content || null,
    sources: data.chunks?.map(c => c.item?.key) || []
  };
}

// Connect to an MCP server (SSE)
/*async function connectToSSEServer(serverId, url) {
  const client = new Client({
    name: 'mcp-openrouter-client',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  });

  const transport = new SSEClientTransport(new URL(url));
  await client.connect(transport);
  mcpClients.set(serverId, client);
  
  return client;
}
*/
async function connectToSSEServer(serverId, url) {
  // Clean up any existing broken connection first
  if (mcpClients.has(serverId)) {
    try { await mcpClients.get(serverId).close(); } catch {}
    mcpClients.delete(serverId);
  }

  const client = new Client({
    name: 'mcp-openrouter-client',
    version: '1.0.0'
  }, {
    capabilities: { tools: {}, resources: {}, prompts: {} }
  });

  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  mcpClients.set(serverId, client);
  return client;
}

// Connect to an MCP server (stdio)
/*async function connectToStdioServer(serverId, config) {
  const client = new Client({
    name: 'mcp-openrouter-client',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  });

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env
  });

  await client.connect(transport);
  mcpClients.set(serverId, client);
  
  return client;
}
*/
// Convert MCP tools to OpenRouter format
function convertMCPToolsToOpenRouter(mcpTools) {
  return mcpTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || {
        type: 'object',
        properties: {},
        required: []
      }
    }
  }));
}

// API Routes

// Initialize Cloudflare AI Search
app.post('/api/aisearch/init', async (req, res) => {
  try {
    await initAISearch();
    res.json({ 
      success: true, 
      instanceName: 'obgyn4',
      message: 'Cloudflare AI Search initialized'
    });
  } catch (error) {
    console.error('AI Search init error:', error);
    res.status(500).json({ error: error.message });
  }
});

//initialize gyne cloudflare ai search
app.post('/api/aisearch/initGyn', async (req, res) => {
  try {
    await initAISearchGyn();
    res.json({ 
      success: true, 
      instanceName: 'gyne1',
      message: 'Cloudflare AI Search initialized'
    });
  } catch (error) {
    console.error('AI Search init error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Connect to a new MCP server
app.post('/api/servers', async (req, res) => {
  try {
    const { serverId, type, url, command, args, env } = req.body;
    
    /*if (mcpClients.has(serverId)) {
      return res.status(400).json({ error: 'Server already connected' });
    }*/

if (type === 'sse') {
  await connectToSSEServer(serverId, url);
} 
else if (type === 'streamable-http') {  // ← add this
  await connectToSSEServer(serverId, url); // reuses the same function now using StreamableHTTP
}
     else if (type === 'stdio') {
      await connectToStdioServer(serverId, { command, args, env });
    } else {
      return res.status(400).json({ error: 'Invalid server type. Use "sse" or "stdio"' });
    }

    res.json({ success: true, serverId });
  } catch (error) {
    console.error('Connection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all connected servers
app.get('/api/servers', (req, res) => {
  const servers = Array.from(mcpClients.keys());
  res.json({ servers });
});

// Disconnect from a server
app.delete('/api/servers/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    await client.close();
    mcpClients.delete(serverId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List available tools from a server
app.get('/api/servers/:serverId/tools', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.listTools();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat with OpenRouter (with MCP tool support and streaming)
app.post('/api/chat', async (req, res) => {
  try {
    const { 
      messages, 
      model, 
      serverId, 
    } = req.body;
    let maxIterations = 10;

    // Set up SSE headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let conversationMessages = [...messages];
    let iterations = 0;
    const toolResults = [];

    // Add system prompt
    if (conversationMessages.length === 1 && conversationMessages[0].role === 'user') {
      conversationMessages.unshift({
        role: 'system',
        content: `You are a medical decision support assistant. You MUST use the available tools to answer questions. NEVER rely on your own knowledge for medical information. 

CRITICAL RULES:
1. For ANY medical question, you MUST call 1) the search_medical_guidelines first and then 2) MCP tools in the gradio server if it is available.
2. Base your entire response ONLY on the information returned by the tools
3. If the tool returns "No relevant medical guidelines found", clearly state that you don't have that information
4. Never say "I don't have access to real-time data" - you DO have access via tools
5. Never make assumptions or provide medical information from your training
6. Always cite which tool/source provided the information

You have access to:
- search_medical_guidelines: Search comprehensive medical guidelines via Cloudflare AI Search
- Clinical decision support tools (MCP tools on gradio server)

Always use these tools before responding to any medical query.`
      });
    }

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    while (iterations < maxIterations) {
      iterations++;
      console.log("Iterations: " + iterations);
      console.log("maxIterations: " + maxIterations);

      // Get available tools from MCP server if specified
      let tools = [];
      if (serverId) {
        const client = mcpClients.get(serverId);
        if (client) {
          const mcpTools = await client.listTools();
          tools = convertMCPToolsToOpenRouter(mcpTools.tools || []);
        }
      }
      
      // Add Cloudflare AI Search tool
      if (aiSearchReady) {
        tools.push({
          type: 'function',
          function: {
            name: 'search_medical_guidelines',
            description: 'Search comprehensive obstetric and gynecological medical guidelines and clinical protocols using Cloudflare AI Search RAG pipeline.',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The medical question or clinical scenario to search for in the guidelines.'
                }
              },
              required: ['query']
            }
          }
        });
      }

      // Call OpenRouter API with streaming
      const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'MCP OpenRouter Client'
        },
        body: JSON.stringify({
          model: model || 'openai/gpt-3.5-turbo',
          messages: conversationMessages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true
        })
      });

      if (!openRouterResponse.ok) {
        const error = await openRouterResponse.text();
        sendEvent('error', { message: `OpenRouter API error: ${error}` });
        res.end();
        return;
      }

      let fullContent = '';
      let toolCalls = [];
      const reader = openRouterResponse.body.getReader();
      const decoder = new TextDecoder();
      let streamBuffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });
        const lines = streamBuffer.split('\n');
streamBuffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices[0]?.delta;

              if (delta?.content) {
                fullContent += delta.content;
                sendEvent('content', { content: delta.content });
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!toolCalls[tc.index]) {
                    toolCalls[tc.index] = {
                      id: tc.id || '',
                      type: 'function',
                      function: { name: '', arguments: '' }
                    };
                  }
                  if (tc.function?.name) {
                    toolCalls[tc.index].function.name = tc.function.name;
                  }
                  if (tc.function?.arguments) {
                    toolCalls[tc.index].function.arguments += tc.function.arguments;
                  }
                  if (tc.id) {
                    toolCalls[tc.index].id = tc.id;
                  }
                }
              }
            } catch (e) {
              console.error('Error parsing stream:', e);
            }
          }
        }
      }

      const assistantMessage = {
        role: 'assistant',
        content: fullContent || null
      };

      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }

      conversationMessages.push(assistantMessage);

      // Check if the model wants to call tools
      if (toolCalls.length > 0) {
        sendEvent('tool_calls_start', { count: toolCalls.length });

        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          let toolArgs;
          
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch (jsonError) {
            console.error(`JSON parse error for tool ${toolName}:`, jsonError);
            conversationMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({ 
                error: `JSON parsing failed: ${jsonError.message}. Please retry with valid JSON.`,
                invalid_json: toolCall.function.arguments
              })
            });
            continue;
          }

          sendEvent('tool_call', { tool: toolName, arguments: toolArgs });

          let result;
          
          // Handle Cloudflare AI Search
          if (toolName === 'search_medical_guidelines') {
            try {
              if (!aiSearchReady) {
                throw new Error('Cloudflare AI Search not initialized. Please initialize RAG first.');
              }
              
              console.log(`Querying Cloudflare AI Search for: "${toolArgs.query}"`);
              
              const ragResponse = await queryAISearch(toolArgs.query);
              
              console.log('Cloudflare AI Search response received');
              
              if (ragResponse.textResponse) {
                // Include sources in the result if available
                const sourcesText = ragResponse.sources.length > 0
                  ? `\n\nSources: ${ragResponse.sources.join(', ')}`
                  : '';

                result = {
                  content: [{
                    type: 'text',
                    text: ragResponse.textResponse + sourcesText
                  }]
                };
              } else {
                result = {
                  content: [{
                    type: 'text',
                    text: 'No relevant medical guidelines found.'
                  }]
                };
              }
            } catch (error) {
              console.error('AI Search error:', error);
              result = {
                content: [{
                  type: 'text',
                  text: `Error searching medical guidelines: ${error.message}`
                }]
              };
            }
            
            maxIterations = iterations + 1;
            console.log('Search completed - forcing final response on next iteration');
          }

          // Handle Gradio MCP server tools
          else {
            const client = mcpClients.get(serverId);
            if (!client) {
              sendEvent('error', { message: 'MCP server not connected' });
              res.end();
              return;
            }

            result = await client.callTool({
              name: toolName,
              arguments: toolArgs
            });
          }


          // Store tool result
          toolResults.push({
            tool: toolName,
            arguments: toolArgs,
            rawResult: result,
            displayResult: result.content?.[0]?.text || JSON.stringify(result)
          });

          sendEvent('tool_result', { 
            tool: toolName, 
            arguments: toolArgs,
            rawResult: result,
            displayResult: result.content?.[0]?.text || JSON.stringify(result)
          });

          // Add tool result to conversation
          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }

        sendEvent('tool_calls_end', {});
        continue;
      }

      // No more tool calls, send done event
      sendEvent('done', {
        conversationMessages: conversationMessages,
        toolResults: toolResults
      });
      res.end();
      return;
    }

    // Max iterations reached
    sendEvent('done', {
      message: 'Maximum iterations reached',
      conversationMessages: conversationMessages,
      toolResults: toolResults
    });
    res.end();

  } catch (error) {
    console.error('Chat error:', error);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      res.end();
    } catch (e) {
      // Response already ended
    }
  }
});

// Call a tool directly (for testing)
app.post('/api/servers/:serverId/tools/:toolName/call', async (req, res) => {
  try {
    const { serverId, toolName } = req.params;
    const { arguments: toolArgs } = req.body;
    
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.callTool({
      name: toolName,
      arguments: toolArgs || {}
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List available resources
app.get('/api/servers/:serverId/resources', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.listResources();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Read a resource
app.post('/api/servers/:serverId/resources/read', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { uri } = req.body;
    
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.readResource({ uri });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List available prompts
app.get('/api/servers/:serverId/prompts', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.listPrompts();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a prompt
app.post('/api/servers/:serverId/prompts/:promptName', async (req, res) => {
  try {
    const { serverId, promptName } = req.params;
    const { arguments: promptArgs } = req.body;
    
    const client = mcpClients.get(serverId);
    
    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.getPrompt({
      name: promptName,
      arguments: promptArgs || {}
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connectedServers: mcpClients.size,
    aiSearchReady: aiSearchReady,
    activeSearchUrl: activeSearchUrl,
    aiSearchInstance: activeSearchUrl.includes('gyne1') ? 'Gynecology' : 'obgyn4'
  });
});

// Auto-initialize AI Search on startup
initAISearch()
  .then(() => console.log('AI Search ready'))
  .catch(err => console.error('AI Search init failed on startup:', err.message));

// Cleanup on shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  for (const [serverId, client] of mcpClients) {
    try {
      await client.close();
      console.log(`Closed connection to ${serverId}`);
    } catch (error) {
      console.error(`Error closing ${serverId}:`, error);
    }
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP OpenRouter Client running on http://localhost:${PORT}`);
  console.log(`Cloudflare AI Search RAG ready - instance: obgyn4`);
});
