export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { mensagem, messages } = req.body;

  if ((!mensagem || !mensagem.trim()) && (!messages || !messages.length)) {
    return res.status(400).json({ erro: 'mensagem vazia' });
  }

  try {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

const agora = new Date();
const dataHoje = agora.toLocaleDateString('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'America/Sao_Paulo'
});
const horaAgora = agora.toLocaleTimeString('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'America/Sao_Paulo'
});

const SYSTEM_MSG = {
  role: 'system',
  content:
    `Você é Lyra, uma assistente de IA cordial, paciente e clara, criada pelo Mykoll, um desenvolvedor. ` +
    `Hoje é ${dataHoje} e agora são ${horaAgora} no horário de Brasília e só diga essa frase quando perguntarem.` +
    'Sempre use exatamente essa data e esse horário quando perguntarem. ' +
    'Responda sempre em português correto, com ortografia e gramática perfeitas. ' +
    'Se precisar repetir uma informação já dada, faça isso de forma gentil e acolhedora, ' +
    'mostrando disposição para ajudar em outros assuntos relacionados. ' +
    'Evite soar ríspida, impaciente ou dar respostas muito curtas. ' +
    'Quando não souber a resposta, explique educadamente e sugira formas de encontrar a informação. ' +
    'Não invente informações e não use gírias, mantendo sempre um tom amigável e prestativo.'
};

    // Se vier histórico (localStorage), usa ele; senão cria um novo
    const conversation = messages && messages.length
      ? messages
      : [{ role: 'user', content: mensagem }];

    // Junta prompt + histórico
    const messagesToSend = [SYSTEM_MSG, ...conversation];

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: messagesToSend,
        stream: true,
        temperature: 0.3,
        max_tokens: 2048
      })
    });

    if (!r.ok || !r.body) {
      let errorDetail = '';
      try {
        errorDetail = await r.text();
      } catch {
        errorDetail = '(sem detalhes do corpo)';
      }
      throw new Error(`Falha ao gerar resposta: ${r.status} — Detalhes: ${errorDetail}`);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let lines = buffer.split('\n');
      buffer = lines.pop(); // guarda pedaço incompleto

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.replace('data: ', '').trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) {
              res.write(JSON.stringify({ delta }) + '\n');
            }
          } catch (err) {
            console.error('Erro ao parsear JSON parcial:', err);
          }
        }
      }
    }

    // processa o que restou no buffer
    if (buffer.trim().startsWith('data: ')) {
      try {
        const data = buffer.replace('data: ', '').trim();
        if (data !== '[DONE]') {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            res.write(JSON.stringify({ delta }) + '\n');
          }
        }
      } catch (err) {
        console.error('Erro ao processar buffer final:', err);
      }
    }

    res.end();
  } catch (err) {
    res.write(JSON.stringify({ error: err.message }) + '\n');
    res.end();
  }
}
