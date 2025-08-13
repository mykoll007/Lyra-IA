export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    res.json({ ok: true, memory: [] });
  } else if (req.method === 'GET') {
    res.json([]);
  } else {
    res.status(405).end();
  }
}
