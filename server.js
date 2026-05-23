import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const mcpClients = new Map();

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_AI_SEARCH_NAME = process.env.CLOUDFLARE_AI_SEARCH_NAME;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_AI_SEARCH_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-search/instances/${CF_AI_SEARCH_NAME}`;

let aiSearchReady = false;

async function initAISearch() {
  if (!CF_ACCOUNT_ID || !CF_AI_SEARCH_NAME || !CF_API_TOKEN) {
    throw new Error('Missing Cloudflare AI Search credentials in .env file');
  }

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
    console.log('Cloudflare AI Search initialized successfully');
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

  const response = await fetch(`${CF_AI_SEARCH_URL}/chat/completions`, {
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
});
