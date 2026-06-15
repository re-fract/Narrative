interface NIMResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export async function generateNimSummary(prompt: string): Promise<string | null> {
  const apiKey = process.env.NIM_API_KEY;
  const model = process.env.NIM_MODEL || 'meta/llama-3.2-3b-instruct';

  if (!apiKey) {
    console.error('NIM_API_KEY not set');
    return null;
  }

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
      console.error('NIM API error:', res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as NIMResponse;
    return data.choices[0]?.message?.content ?? null;
  } catch (err) {
    console.error('NIM API error:', err);
    return null;
  }
}
