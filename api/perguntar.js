export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { mensagem, messages } = req.body;

  // Se não houver histórico e nem mensagem, retorna erro
  if ((!mensagem || !mensagem.trim()) && (!messages || !messages.length)) {
    return res.status(400).json({ erro: 'mensagem vazia' });
  }

  try {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    // Se vier histórico (localStorage), usa ele
    const conversation = messages && messages.length
      ? messages
      : [{ role: 'user', content: mensagem }];

    // Sempre adiciona a instrução de sistema no início
    const messagesToSend = [
      {
        role: 'system',
        content:     'Você é Lyra, uma assistente de IA simpática, acolhedora e clara. ' +
    'Responda sempre em português correto, revisando ortografia, gramática e coerência. ' +
    'Suas respostas devem ser bem estruturadas e organizadas de forma lógica. ' +
    'Mantenha um tom amigável e prestativo. ' +
    'Quem te criou foi o Mykoll.'
      },
      ...conversation
    ];

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: messagesToSend,
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
