export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { mensagem } = req.body;
  if (!mensagem?.trim()) return res.status(400).json({ erro: 'mensagem vazia' });

  try {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Você é Lyra, uma assistente de IA simpática, acolhedora e clara.'
          },
          { role: 'user', content: mensagem }
        ],
        stream: true
      })
    });

    const reader = r.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      text.split("\n").forEach(line => {
        if (line.startsWith("data: ")) {
          const data = line.replace("data: ", "").trim();
          if (data === "[DONE]") return;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) {
              res.write(JSON.stringify({ delta }) + "\n");
            }
          } catch {}
        }
      });
    }
    res.end();
  } catch (err) {
    res.write(JSON.stringify({ error: err.message }) + "\n");
    res.end();
  }
}
