import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';

let fsp, path, fileURLToPath;
let MEM_FILE, DATA_DIR, __filename, __dirname;
let fsAvailable = true;

try {
  fsp = await import('fs/promises');
  path = await import('path');
  ({ fileURLToPath } = await import('url'));

  __filename = fileURLToPath(import.meta.url);
  __dirname = path.dirname(__filename);

  DATA_DIR = path.join(__dirname, 'data');
  MEM_FILE = path.join(DATA_DIR, 'memoria.json');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEM_FILE)) fs.writeFileSync(MEM_FILE, JSON.stringify([]));
} catch {
  fsAvailable = false;
  console.log('⚠️ Modo sem fs: Memória será gerenciada apenas pelo cliente');
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

if (!GROQ_API_KEY) {
  console.error("❌ ERRO: GROQ_API_KEY não definida");
  process.exit(1);
}
if (!SERPER_API_KEY) {
  console.error("❌ ERRO: SERPER_API_KEY não definida");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------------------- Funções de memória ----------------------
async function loadMemory() {
  if (!fsAvailable) return [];
  try {
    const buf = await fsp.readFile(MEM_FILE, 'utf-8');
    return JSON.parse(buf);
  } catch {
    return [];
  }
}

async function saveMemory(memory) {
  if (!fsAvailable) return;
  const compact = memory.slice(-100);
  await fsp.writeFile(MEM_FILE, JSON.stringify(compact, null, 2), 'utf-8');
}

// ---------------------- Datas em pt-BR ----------------------
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

// ---------------------- System Message ----------------------
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
      'Nunca diga que não tem acesso em tempo real. ' +
      'IMPORTANTE: quando usar informações da web, NÃO cite "Fonte 1", "Fonte 2"... na resposta. ' +
      'Traga apenas a informação consolidada em texto corrido. As referências já serão mostradas separadamente na interface.'
  };
}


function buildMessages(memory) {
  return [buildSystemMsg(), ...memory.slice(-8)];
}

// ---------------------- Busca na Web (Serper.dev) ----------------------
async function serperSearch(query, max = 5) {
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
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
  const results = await serperSearch(query, maxDocs);
  const ctxParts = results.map(r =>
    `${r.title}\n${r.snippet}\n(${r.url})`
  );
  const contexto = ctxParts.join('\n\n');

  return { contexto, fontes: results };
}

// ---------------------- Endpoint principal ----------------------
app.post('/perguntar', async (req, res) => {
  const { mensagem, messages, usarWeb = false, maxDocs = 3 } = req.body;

  let memory;
  if (messages && Array.isArray(messages)) {
    memory = messages;
  } else {
    memory = await loadMemory();
    memory.push({ role: 'user', content: mensagem });
    await saveMemory(memory);
  }

  let webContextMsg = null;
  let fontesUsadas = [];
  if (usarWeb && mensagem && mensagem.trim().length > 0) {
    try {
      const { contexto, fontes } = await webSearchAndContext(mensagem, Math.min(Math.max(1, maxDocs), 5));
      fontesUsadas = fontes;
      if (contexto) {
        webContextMsg = {
          role: 'user',
          content:
            "📡 INFORMAÇÃO ATUALIZADA DA WEB:\n\n" + contexto + "\n\n" +
            "Responda somente sobre o tema da pergunta atual, ignorando completamente o histórico da conversa. " +
            "Não faça referência a respostas anteriores."
        };

      }
    } catch (e) {
      console.warn('⚠️ Falha ao buscar na web:', e.message);
    }
  }

  const llmMessages = buildMessages(memory);
  if (webContextMsg) llmMessages.push(webContextMsg);

  try {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Se houver fontes, envia logo no começo
    if (fontesUsadas.length > 0) {
      res.write(JSON.stringify({ fontes: fontesUsadas }) + "\n");
    }

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: llmMessages,
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

    let full = '';
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.replace('data: ', '').trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) {
              full += delta;
              res.write(JSON.stringify({ delta }) + '\n');
            }
          } catch { }
        }
      }
    }

    if (fsAvailable) {
      memory.push({ role: 'assistant', content: full || '(Sem resposta)' });
      await saveMemory(memory);
    }

    res.end();
  } catch (err) {
    res.write(JSON.stringify({ error: err.message }) + '\n');
    res.end();
  }
});

// ---------------------- Endpoints auxiliares ----------------------
app.get('/memory', async (_, res) => {
  res.json(await loadMemory());
});

app.delete('/memory', async (_, res) => {
  await saveMemory([]);
  res.json({ ok: true });
});

app.listen(3000, () => console.log('🚀 Servidor rodando em http://localhost:3000'));
