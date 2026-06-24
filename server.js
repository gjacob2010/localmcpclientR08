import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── State ────────────────────────────────────────────────────────────────

// serverId → { client, transportType, url }
const mcpClients = new Map();

const CF_ACCOUNT_ID    = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN     = process.env.CLOUDFLARE_API_TOKEN;
const OB_URL           = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-search/instances/obgyn4`;
const GYN_URL          = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-search/instances/gyne1`;

let aiSearchReady   = false;
let activeSearchUrl = OB_URL;

// ── Cloudflare AI Search ─────────────────────────────────────────────────

async function pingAISearch(url) {
  const res = await fetch(`${url}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CF_API_TOKEN}` },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'test' }],
      ai_search_options: { retrieval: { max_num_results: 1 } }
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`AI Search ping failed: ${JSON.stringify(err.errors)}`);
  }
}

async function initAISearch() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in .env');
  await pingAISearch(OB_URL);
  aiSearchReady   = true;
  activeSearchUrl = OB_URL;
  console.log('✅ Cloudflare AI Search (OB) ready');
}

async function initAISearchGyn() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in .env');
  await pingAISearch(GYN_URL);
  aiSearchReady   = true;
  activeSearchUrl = GYN_URL;
  console.log('✅ Cloudflare AI Search (Gyne) ready');
}

async function queryAISearch(question) {
  if (!aiSearchReady) throw new Error('AI Search not initialised');
  const res = await fetch(`${activeSearchUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CF_API_TOKEN}` },
    body: JSON.stringify({
      messages: [{ role: 'user', content: question }],
      ai_search_options: { retrieval: { max_num_results: 10, match_threshold: 0.4 } }
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`AI Search query failed: ${JSON.stringify(err.errors)}`);
  }
  const data = await res.json();
  return {
    textResponse: data.choices?.[0]?.message?.content || null,
    sources: data.chunks?.map(c => c.item?.key) || []
  };
}

// ── MCP Connection ───────────────────────────────────────────────────────

function buildHeaders() {
  return process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
}

async function connectWithFallback(serverId, baseUrl) {
  // Close existing connection if any
  if (mcpClients.has(serverId)) {
    try { await mcpClients.get(serverId).client.close(); } catch {}
    mcpClients.delete(serverId);
  }

  const headers       = buildHeaders();
  const normalizedUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  // Attempt 1 — streamable-HTTP
  try {
    console.log(`[${serverId}] Trying streamable-HTTP → ${normalizedUrl}`);
    const client    = new Client({ name: 'mcp-client', version: '1.0.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
    const transport = new StreamableHTTPClientTransport(new URL(normalizedUrl), { requestInit: { headers } });
    await client.connect(transport);
    console.log(`[${serverId}] ✅ streamable-HTTP connected`);
    mcpClients.set(serverId, { client, transportType: 'streamable-http', url: normalizedUrl });
    return { client, transportType: 'streamable-http' };
  } catch (err) {
    console.warn(`[${serverId}] streamable-HTTP failed: ${err.message}`);
  }

  // Attempt 2 — SSE fallback
  const sseUrl = normalizedUrl.replace(/\/$/, '').endsWith('/sse')
    ? normalizedUrl
    : `${normalizedUrl.replace(/\/$/, '')}/sse`;

  try {
    console.log(`[${serverId}] Trying SSE → ${sseUrl}`);
    const client    = new Client({ name: 'mcp-client', version: '1.0.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
    const transport = new SSEClientTransport(new URL(sseUrl), { requestInit: { headers } });
    await client.connect(transport);
    console.log(`[${serverId}] ✅ SSE connected`);
    mcpClients.set(serverId, { client, transportType: 'sse', url: sseUrl });
    return { client, transportType: 'sse' };
  } catch (err) {
    console.error(`[${serverId}] SSE failed: ${err.message}`);
    throw new Error(`Both transports failed for ${serverId}. SSE error: ${err.message}`);
  }
}

function mcpToolsToOpenRouter(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {}, required: [] }
    }
  }));
}

// ── Routes ───────────────────────────────────────────────────────────────

// Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedServers: Array.from(mcpClients.keys()),
    aiSearchReady,
    activeInstance: activeSearchUrl.includes('gyne1') ? 'Gynecology (gyne1)' : 'OB (obgyn4)'
  });
});

// RAG init
app.post('/api/aisearch/init', async (req, res) => {
  try {
    await initAISearch();
    res.json({ success: true, instanceName: 'obgyn4' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/aisearch/initGyn', async (req, res) => {
  try {
    await initAISearchGyn();
    res.json({ success: true, instanceName: 'gyne1' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MCP servers
app.post('/api/servers', async (req, res) => {
  const { serverId, url } = req.body;
  if (!serverId || !url) return res.status(400).json({ error: 'serverId and url are required' });
  try {
    const { transportType } = await connectWithFallback(serverId, url);
    res.json({ success: true, serverId, transportType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/servers', (req, res) => {
  res.json({ servers: Array.from(mcpClients.keys()) });
});

app.delete('/api/servers/:serverId', async (req, res) => {
  const entry = mcpClients.get(req.params.serverId);
  if (!entry) return res.status(404).json({ error: 'Server not found' });
  try {
    await entry.client.close();
    mcpClients.delete(req.params.serverId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/servers/:serverId/tools', async (req, res) => {
  const entry = mcpClients.get(req.params.serverId);
  if (!entry) return res.status(404).json({ error: 'Server not found' });
  try {
    res.json(await entry.client.listTools());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/servers/:serverId/tools/:toolName/call', async (req, res) => {
  const entry = mcpClients.get(req.params.serverId);
  if (!entry) return res.status(404).json({ error: 'Server not found' });
  try {
    res.json(await entry.client.callTool({ name: req.params.toolName, arguments: req.body.arguments || {} }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/servers/:serverId/resources', async (req, res) => {
  const entry = mcpClients.get(req.params.serverId);
  if (!entry) return res.status(404).json({ error: 'Server not found' });
  try { res.json(await entry.client.listResources()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/servers/:serverId/resources/read', async (req, res) => {
  const entry = mcpClients.get(req.params.serverId);
  if (!entry) return res.status(404).json({ error: 'Server not found' });
  try { res.json(await entry.client.readResource({ uri: req.body.uri })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/servers/:serverId/prompts', async (req, res) => {
  const entry = mcpClients.get(req.params.serverId);
  if (!entry) return res.status(404).json({ error: 'Server not found' });
  try { res.json(await entry.client.listPrompts()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/servers/:serverId/prompts/:promptName', async (req, res) => {
  const entry = mcpClients.get(req.params.serverId);
  if (!entry) return res.status(404).json({ error: 'Server not found' });
  try { res.json(await entry.client.getPrompt({ name: req.params.promptName, arguments: req.body.arguments || {} })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Chat (streaming) ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a medical decision support assistant. You MUST use the available tools to answer questions. NEVER rely on your own knowledge for medical information.

CRITICAL RULES:
1. For ANY medical question, call search_medical_guidelines first, then MCP tools if available.
2. Base your entire response ONLY on information returned by the tools.
3. If the tool returns "No relevant medical guidelines found", clearly state you don't have that information.
4. Never say "I don't have access to real-time data" — you DO have access via tools.
5. Never make assumptions or provide medical information from your training.
6. Always cite which tool/source provided the information.

Available tools:
- search_medical_guidelines: Searches medical guidelines via Cloudflare AI Search RAG
- Clinical decision support tools (MCP tools on connected gradio server)`;

app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const { messages, model, serverId } = req.body;
    let conversationMessages = [...messages];
    let maxIterations = 10;
    let iterations    = 0;
    const toolResults = [];

    // Inject system prompt on first user turn
    if (conversationMessages.length === 1 && conversationMessages[0].role === 'user') {
      conversationMessages.unshift({ role: 'system', content: SYSTEM_PROMPT });
    }

    while (iterations < maxIterations) {
      iterations++;

      // Build tool list
      let tools = [];
      if (serverId) {
        const entry = mcpClients.get(serverId);
        if (entry) {
          const { tools: mcpTools } = await entry.client.listTools();
          tools = mcpToolsToOpenRouter(mcpTools || []);
        }
      }
      if (aiSearchReady) {
        tools.push({
          type: 'function',
          function: {
            name: 'search_medical_guidelines',
            description: 'Search comprehensive obstetric and gynecological medical guidelines via Cloudflare AI Search RAG.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: 'Medical question or clinical scenario to search.' } },
              required: ['query']
            }
          }
        });
      }

      // Call OpenRouter
      const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'Medical Decision Support'
        },
        body: JSON.stringify({
          model: model || 'openai/gpt-4o-mini',
          messages: conversationMessages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true
        })
      });

      if (!orRes.ok) {
        send('error', { message: `OpenRouter error: ${await orRes.text()}` });
        res.end();
        return;
      }

      // Stream response
      let fullContent = '';
      let toolCalls   = [];
      const reader    = orRes.body.getReader();
      const decoder   = new TextDecoder();
      let buf         = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') continue;
          try {
            const parsed = JSON.parse(raw);
            const delta  = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              fullContent += delta.content;
              send('content', { content: delta.content });
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                }
                if (tc.id)                  toolCalls[tc.index].id                   = tc.id;
                if (tc.function?.name)      toolCalls[tc.index].function.name        = tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].function.arguments  += tc.function.arguments;
              }
            }
          } catch {}
        }
      }

      // Record assistant turn
      const assistantMsg = { role: 'assistant', content: fullContent || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      conversationMessages.push(assistantMsg);

      // No tool calls → we're done
      if (toolCalls.length === 0) {
        send('done', { conversationMessages, toolResults });
        res.end();
        return;
      }

      // Execute tool calls
      send('tool_calls_start', { count: toolCalls.length });

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        let toolArgs;

        try {
          toolArgs = JSON.parse(tc.function.arguments);
        } catch (e) {
          conversationMessages.push({
            role: 'tool', tool_call_id: tc.id,
            content: JSON.stringify({ error: `Bad JSON args: ${e.message}` })
          });
          continue;
        }

        send('tool_call', { tool: toolName, arguments: toolArgs });

        let result;

        if (toolName === 'search_medical_guidelines') {
          try {
            const rag = await queryAISearch(toolArgs.query);
            const text = rag.textResponse
              ? rag.textResponse + (rag.sources.length ? `\n\nSources: ${rag.sources.join(', ')}` : '')
              : 'No relevant medical guidelines found.';
            result = { content: [{ type: 'text', text }] };
          } catch (e) {
            result = { content: [{ type: 'text', text: `Error: ${e.message}` }] };
          }
          maxIterations = iterations + 1; // one more pass to synthesise answer
        } else {
          const entry = mcpClients.get(serverId);
          if (!entry) {
            send('error', { message: 'MCP server not connected' });
            res.end();
            return;
          }
          result = await entry.client.callTool({ name: toolName, arguments: toolArgs });
        }

        const displayResult = result.content?.[0]?.text || JSON.stringify(result);
        toolResults.push({ tool: toolName, arguments: toolArgs, rawResult: result, displayResult });
        send('tool_result', { tool: toolName, arguments: toolArgs, rawResult: result, displayResult });
        conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }

      send('tool_calls_end', {});
    }

    send('done', { message: 'Max iterations reached', conversationMessages, toolResults });
    res.end();

  } catch (err) {
    console.error('Chat error:', err);
    try { res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`); res.end(); } catch {}
  }
});

// ── Startup ──────────────────────────────────────────────────────────────

initAISearch()
  .then(() => console.log('AI Search ready on startup'))
  .catch(err => console.error('AI Search startup failed:', err.message));

process.on('SIGTERM', async () => {
  for (const [id, entry] of mcpClients) {
    try { await entry.client.close(); console.log(`Closed ${id}`); }
    catch (e) { console.error(`Error closing ${id}:`, e.message); }
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏥 Medical Decision Support → http://localhost:${PORT}`));
