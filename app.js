// app.js
import dotenv from 'dotenv';
dotenv.config();

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const AI_SEARCH_NAME = process.env.CLOUDFLARE_AI_SEARCH_NAME;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-search/instances/${AI_SEARCH_NAME}`;

async function ask(question) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_TOKEN}`
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

  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(`API error: ${JSON.stringify(data)}`);
  }

  return {
    answer: data.choices[0].message.content,
    sources: data.chunks.map(c => c.item.key) // which files were used
  };
}

// Test it
ask('What is the management of UTI sepsis?')
  .then(result => {
    console.log('Answer:', result.answer);
    console.log('Sources:', result.sources);
  })
  .catch(console.error);