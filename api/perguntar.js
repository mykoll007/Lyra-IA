// pages/api/perguntar.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const {
    mensagem,
    messages,
    usarWeb = false,
    maxDocs = 3
  } = req.body || {};

  if ((!mensagem || !mensagem.trim()) && (!messages || !messages.length)) {
    return res.status(400).json({ erro: 'mensagem vazia' });
  }

  // ------- helpers: datas em pt-BR -------
  function agoraBR() {
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
    return { dataHoje, horaAgora };
  }

  // ------- helpers: system + mensagens -------
  function buildSystemMsg() {
    const { dataHoje, horaAgora } = agoraBR();
    return {
      role: 'system',
      content:
        `Você é Lyra, uma assistente de IA cordial, paciente e clara, criada pelo Mykoll, um desenvolvedor. ` +
        `Hoje é ${dataHoje} e agora são ${horaAgora} no horário de Brasília. ` +
        'Só informe a data ou a hora atual se o usuário perguntar explicitamente sobre isso.' +
        'Responda sempre em português correto, com ortografia e gramática perfeitas. ' +
        'Se precisar repetir uma informação já dada, faça isso de forma gentil e acolhedora. ' +
        'Evite soar ríspida, impaciente ou dar respostas muito curtas. ' +
        'Quando não souber a resposta, explique educadamente. ' +
        '⚠️ Sempre que houver mensagens com "📡 INFORMAÇÃO ATUALIZADA DA WEB", você DEVE usá-las como fonte principal. ' +
        'Nunca diga que não tem acesso em tempo real. ' +
        'IMPORTANTE: quando usar informações da web, NÃO cite "Fonte 1", "Fonte 2"... na resposta. ' +
        'Traga apenas a informação consolidada em texto corrido. As referências já serão mostradas separadamente na interface.'
    };
  }

  function buildMessages(memory) {
    return [buildSystemMsg(), ...memory.slice(-8)];
  }

  // ------- helpers: busca na web (Serper) -------
  async function serperSearch(query, max = 5) {
    try {
      const r = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY || "",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, num: max })
      });
      if (!r.ok) throw new Error(`Erro na busca: ${r.status}`);
      const data = await r.json();
      return (data.organic || []).slice(0, max).map(item => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet
      }));
    } catch (e) {
      console.error("❌ Erro na busca Serper.dev:", e.message);
      return [];
    }
  }

  async function webSearchAndContext(query, maxDocs = 3) {
    const results = await serperSearch(query, Math.min(Math.max(1, maxDocs), 5));
    const ctxParts = results.map(r => `${r.title}\n${r.snippet}\n(${r.url})`);
    const contexto = ctxParts.join('\n\n');
    return { contexto, fontes: results };
  }

  try {
    // valida envs essenciais
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ erro: 'GROQ_API_KEY não definida no servidor' });
    }
    if (usarWeb && !process.env.SERPER_API_KEY) {
      return res.status(500).json({ erro: 'SERPER_API_KEY não definida no servidor (usarWeb=true)' });
    }

    // headers p/ stream NDJSON
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    // monta memória a partir do cliente, ou cria com a mensagem atual
    const memory = (messages && Array.isArray(messages))
      ? messages
      : [{ role: 'user', content: mensagem }];

    // optionally injeta contexto da web
    let webContextMsg = null;
    let fontesUsadas = [];
    if (usarWeb && ((mensagem && mensagem.trim()) || (messages && messages.length))) {
      try {
        const { contexto, fontes } = await webSearchAndContext(mensagem || '', maxDocs);
        fontesUsadas = fontes || [];
        if (contexto) {
          webContextMsg = {
            role: 'user',
            content:
              "📡 INFORMAÇÃO ATUALIZADA DA WEB:\n\n" + contexto + "\n\n" +
              "Com base SOMENTE nestas informações, responda de forma objetiva: quem é o técnico atual da Seleção Brasileira. " +
              "Se houver dados conflitantes, considere apenas o mais recente. Responda uma única vez, sem repetições."
          };

        }
      } catch (e) {
        console.warn('⚠️ Falha ao buscar na web:', e.message);
      }
    }

    // junta system + memória recente + (opcional) contexto web
    const messagesToSend = buildMessages(memory);
    if (webContextMsg) messagesToSend.push(webContextMsg);

    // envia fontes logo no começo do stream (compatível com seu front)
    if (fontesUsadas.length > 0) {
      res.write(JSON.stringify({ fontes: fontesUsadas }) + "\n");
    }

    // chamada Groq com stream
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
      try { errorDetail = await r.text(); } catch { errorDetail = '(sem detalhes do corpo)'; }
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
      buffer = lines.pop(); // pedaço incompleto fica para próxima iteração

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            res.write(JSON.stringify({ delta }) + '\n');
          }
        } catch (err) {
          // chunk parcial do SSE, segue o baile
          // console.error('Erro ao parsear JSON parcial:', err);
        }
      }
    }

    // processa resto do buffer (se veio um último chunk completo)
    if (buffer.trim().startsWith('data: ')) {
      try {
        const data = buffer.slice(6).trim();
        if (data !== '[DONE]') {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            res.write(JSON.stringify({ delta }) + '\n');
          }
        }
      } catch (err) {
        // console.error('Erro ao processar buffer final:', err);
      }
    }

    res.end();
  } catch (err) {
    res.write(JSON.stringify({ error: err.message }) + '\n');
    res.end();
  }
}
