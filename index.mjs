import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';


if (!GROQ_API_KEY) {
  console.error("❌ ERRO: GROQ_API_KEY não definida no .env");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const MEM_FILE = path.join(DATA_DIR, 'memoria.json');
if (!fs.existsSync(MEM_FILE)) fs.writeFileSync(MEM_FILE, JSON.stringify([]));

async function loadMemory() {
  try {
    const buf = await fsp.readFile(MEM_FILE, 'utf-8');
    return JSON.parse(buf);
  } catch {
    return [];
  }
}

async function saveMemory(memory) {
  const compact = memory.slice(-100);
  await fsp.writeFile(MEM_FILE, JSON.stringify(compact, null, 2), 'utf-8');
}
const SYSTEM_MSG = {
  role: 'system',
  content:
    'Você é Lyra, uma assistente de IA simpática, acolhedora e clara. ' +
    'Responda sempre em português correto, revisando ortografia (não errar letras em português), gramática, pontuação e coerência antes de enviar a resposta. ' +
    'Suas respostas devem ser bem estruturadas, sem atropelar palavras ou frases, e organizadas de forma lógica. ' +
    'Explique de forma breve, mas completa e fácil de entender. ' +
    'Mantenha um tom amigável e prestativo. ' +
    'Se não tiver certeza, diga "Não tenho certeza" de forma natural e educada. ' +
    'Quem te criou foi o Mykoll.'
};



function buildMessages(memory, userMsg) {
  return [SYSTEM_MSG, ...memory.slice(-8), { role: 'user', content: userMsg }];
}

app.post('/perguntar', async (req, res) => {
  const { mensagem } = req.body;
  if (!mensagem?.trim()) {
    return res.status(400).json({ erro: 'mensagem vazia' });
  }

  try {
    const memory = await loadMemory();
    memory.push({ role: 'user', content: mensagem });
    await saveMemory(memory);

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Chamada da API
    const r = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: buildMessages(memory, mensagem),
        stream: true,
        temperature: 0.7,
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

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });

      text.split('\n').forEach(line => {
        if (line.startsWith('data: ')) {
          const data = line.replace('data: ', '').trim();
          if (data === '[DONE]') return;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) {
              full += delta;
              res.write(JSON.stringify({ delta }) + '\n');
            }
          } catch { }
        }
      });
    }

    memory.push({ role: 'assistant', content: full || '(Sem resposta)' });
    await saveMemory(memory);
    res.end();

  } catch (err) {
    res.write(JSON.stringify({ error: err.message }) + '\n');
    res.end();
  }
});

app.get('/memory', async (_, res) => res.json(await loadMemory()));

app.delete('/memory', async (_, res) => {
  await saveMemory([]);
  res.json({ ok: true });
});

app.listen(3000, () => console.log('🚀 Servidor rodando com Groq em http://localhost:3000'));
