import 'dotenv/config';
import express from 'express';
import cors from 'cors';

let fs, fsp, path, fileURLToPath;
let MEM_FILE, DATA_DIR, __filename, __dirname;
let fsAvailable = true;

// tenta carregar fs e path (caso esteja no ambiente local)
try {
  fs = await import('fs');
  fsp = await import('fs/promises');
  path = await import('path');
  ({ fileURLToPath } = await import('url'));

  __filename = fileURLToPath(import.meta.url);
  __dirname = path.dirname(__filename);

  DATA_DIR = path.join(__dirname, 'data');
  MEM_FILE = path.join(DATA_DIR, 'memoria.json');

  if (!fs.default.existsSync(DATA_DIR)) fs.default.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.default.existsSync(MEM_FILE)) fs.default.writeFileSync(MEM_FILE, JSON.stringify([]));
} catch {
  fsAvailable = false;
  console.log('⚠️ Modo sem fs: Memória será gerenciada apenas pelo cliente');
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

if (!GROQ_API_KEY) {
  console.error("❌ ERRO: GROQ_API_KEY não definida");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

const hoje = new Date().toLocaleDateString('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

const SYSTEM_MSG = {
  role: 'system',
  content:
    `Você é Lyra, uma assistente de IA cordial, paciente e clara, criada pelo Mykoll, um desenvolvedor. ` +
    `Hoje é ${hoje}. ` +
    'Responda sempre em português correto, com ortografia e gramática perfeitas. ' +
    'Se precisar repetir uma informação já dada, faça isso de forma gentil e acolhedora, ' +
    'mostrando disposição para ajudar em outros assuntos relacionados. ' +
    'Evite soar ríspida, impaciente ou dar respostas muito curtas. ' +
    'Quando não souber a resposta, explique educadamente e sugira formas de encontrar a informação. ' +
    'Não invente informações e não use gírias, mantendo sempre um tom amigável e prestativo.'
};

function buildMessages(memory) {
  return [SYSTEM_MSG, ...memory.slice(-8)];
}

app.post('/perguntar', async (req, res) => {
  const { mensagem, messages } = req.body;

  let memory;
  if (messages && Array.isArray(messages)) {
    memory = messages;
  } else {
    memory = await loadMemory();
    memory.push({ role: 'user', content: mensagem });
    await saveMemory(memory);
  }

  try {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: buildMessages(memory),
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

    let full = '';
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
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
              full += delta;
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
            full += delta;
            res.write(JSON.stringify({ delta }) + '\n');
          }
        }
      } catch (err) {
        console.error('Erro ao processar buffer final:', err);
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

app.get('/memory', async (_, res) => {
  res.json(await loadMemory());
});

app.delete('/memory', async (_, res) => {
  await saveMemory([]);
  res.json({ ok: true });
});

app.listen(3000, () => console.log('🚀 Servidor rodando em http://localhost:3000'));
