/**
 * Cloudflare Worker — proxy para la API de Anthropic
 *
 * La API key vive como secreto en Cloudflare (variable ANTHROPIC_KEY).
 * El navegador llama a este worker; el worker llama a Anthropic.
 * La key nunca aparece en el código fuente público.
 *
 * Despliegue:
 *   1. Crear worker en dash.cloudflare.com
 *   2. Pegar este código
 *   3. Agregar secreto: Settings → Variables → Add variable → ANTHROPIC_KEY = sk-ant-...
 *   4. Copiar la URL del worker (ej. https://incendios-ai.TU_USUARIO.workers.dev)
 *   5. Pegar esa URL en planeta.js como WORKER_URL
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await upstream.json();
    return json(data, upstream.status);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
