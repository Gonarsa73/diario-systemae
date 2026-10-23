// Diario de Calorías · Systémae — estimador de calorías por foto (Cloudflare Workers AI, plan gratis).
// No guarda fotos ni datos: recibe la imagen, pide la estimación y devuelve el resultado.
const ORIGENES = ['https://gonarsa73.github.io'];
const MODELOS = ['@cf/google/gemma-4-26b-a4b-it', '@cf/meta/llama-4-scout-17b-16e-instruct'];
const MAX_IMAGEN = 1_500_000; // ~1,5 MB en base64

const INSTRUCCION = `Eres un asistente de nutrición de una clínica en Chile. Mira la foto de comida y estima cada alimento visible.
Usa nombres de comida chilena cuando corresponda (marraqueta, porotos, cazuela, pastel de choclo, palta, etc.).
Estima la porción en gramos o medidas caseras y considera aceite o salsas probables.
Responde SOLO con JSON válido, sin texto extra, con este formato:
{"items":[{"name":"Arroz blanco","qty":"1 taza (150 g)","kcal":195,"p":4,"c":42,"f":0.5}],"note":"frase corta sobre lo que no se puede ver"}
Si la foto no muestra comida, responde {"items":[],"note":"No veo comida en la foto."}`;

function cors(origen) {
  return {
    'Access-Control-Allow-Origin': origen,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function json(data, status, origen) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origen) } });
}

function extraerJSON(texto) {
  if (typeof texto !== 'string') return texto;
  const i = texto.indexOf('{'), j = texto.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try { return JSON.parse(texto.slice(i, j + 1)); } catch (e) { return null; }
}

function limpiar(r) {
  const n = (v, max) => { const x = Number(v); return isFinite(x) && x >= 0 ? Math.min(Math.round(x * 10) / 10, max) : 0; };
  const items = (Array.isArray(r && r.items) ? r.items : []).slice(0, 12).map(i => ({
    name: String(i.name || '').slice(0, 60),
    qty: String(i.qty || '').slice(0, 60),
    kcal: Math.round(n(i.kcal, 3000)),
    p: n(i.p, 300), c: n(i.c, 500), f: n(i.f, 300)
  })).filter(i => i.name && i.kcal > 0);
  return { items, note: String((r && r.note) || '').slice(0, 200) };
}

export default {
  async fetch(request, env) {
    const origen = request.headers.get('Origin') || '';
    if (!ORIGENES.includes(origen)) return new Response('No autorizado', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origen) });
    if (request.method !== 'POST') return json({ error: 'metodo' }, 405, origen);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'formato' }, 400, origen); }
    const img = body && body.image;
    if (typeof img !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > MAX_IMAGEN) {
      return json({ error: 'imagen' }, 400, origen);
    }

    const messages = [
      { role: 'system', content: INSTRUCCION },
      { role: 'user', content: [
        { type: 'text', text: 'Estima las calorías de esta comida.' },
        { type: 'image_url', image_url: { url: img } }
      ] }
    ];

    for (const modelo of MODELOS) {
      try {
        const out = await env.AI.run(modelo, { messages, max_tokens: 700, temperature: 0.2 });
        const texto = out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content));
        const r = extraerJSON(texto);
        if (r) return json(limpiar(r), 200, origen);
      } catch (e) {
        if (String(e && e.message).includes('4006')) return json({ error: 'limite' }, 429, origen); // cuota diaria gratis agotada
      }
    }
    return json({ error: 'ia' }, 502, origen);
  }
};
