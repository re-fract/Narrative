interface NIMResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateNimSummary(prompt: string, retries = 3): Promise<string | null> {
  const apiKey = process.env.NIM_API_KEY;
  const model = process.env.NIM_MODEL || 'meta/llama-3.2-3b-instruct';

  if (!apiKey) {
    console.error('NIM_API_KEY not set');
    return null;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          top_p: 0.7,
          max_tokens: 1024,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        // Rate limit or server error — retry if we have attempts left
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const delay = 1000 * Math.pow(2, attempt);
          console.log(`NIM rate limited (${res.status}), retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        console.error('NIM API error:', res.status, body);
        return null;
      }

      const data = (await res.json()) as NIMResponse;
      return data.choices[0]?.message?.content ?? null;
    } catch (err) {
      console.error('NIM API error:', err);
      // Network / timeout error — retry if we have attempts left
      if (attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt);
        console.log(`NIM error, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      return null;
    }
  }

  return null;
}
