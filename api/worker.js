export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.searchParams.get('path') || '';

    // CORS for Jotform iframe
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type,authorization'
    };
    if (req.method === 'OPTIONS') return new Response('', { headers: cors });

    try {
      if (path === 'health') return json({ ok: true }, cors);

      if (path === 'oauth/start' && req.method === 'GET') {
        const state = crypto.randomUUID();
        // store a short-lived empty record just to recognize the state on callback (optional)
        await env.KV.put(`state:${state}`, '1', { expirationTtl: 600 });
        const authUrl = `https://dev.wealthbox.com/oauth/authorize?response_type=code` +
          `&client_id=${encodeURIComponent(env.WB_CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent(env.OAUTH_REDIRECT)}` +
          `&state=${encodeURIComponent(state)}` +
          `&scope=login%20data`;
        return redirect(authUrl, cors);
      }

      if (path === 'oauth/callback' && req.method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state) return json({ error: 'Missing code/state' }, cors, 400);
        const seen = await env.KV.get(`state:${state}`);
        if (!seen) return json({ error: 'Invalid state' }, cors, 400);

        const tokenRes = await fetch('https://dev.wealthbox.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: env.WB_CLIENT_ID,
            client_secret: env.WB_CLIENT_SECRET,
            redirect_uri: env.OAUTH_REDIRECT
          })
        });
        const token = await tokenRes.json();
        if (!token.access_token) return json({ error: 'Token exchange failed', raw: token }, cors, 500);

        // Persist token against state
        await env.KV.put(`tok:${state}`, JSON.stringify({
          access_token: token.access_token,
          refresh_token: token.refresh_token || null,
          obtained: Date.now()
        }), { expirationTtl: 60 * 60 * 24 }); // 24h or your preference

        // Pop back to the widget (postMessage)
        const html = `<script>
          window.opener && window.opener.postMessage({wbOAuthState:${JSON.stringify(state)}}, "*");
          window.close();
        </script>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html', ...cors } });
      }

      // Helper to resolve auth header (API key or OAuth state)
      async function authHeaders(body) {
        const headers = { 'Content-Type': 'application/json' };
        if (body.apiKey) {
          headers['ACCESS_TOKEN'] = body.apiKey;
        } else if (body.stateId) {
          const tok = await env.KV.get(`tok:${body.stateId}`, 'json');
          if (!tok?.access_token) throw new Error('Missing/invalid OAuth state');
          headers['Authorization'] = `Bearer ${tok.access_token}`;
        } else {
          throw new Error('No auth provided');
        }
        return headers;
      }

      // Parse JSON body (POST)
      async function parseBody() {
        const ct = req.headers.get('content-type') || '';
        if (ct.includes('application/json')) return await req.json();
        return {};
      }

      if (path === 'contacts' && req.method === 'POST') {
        const body = await parseBody();
        const { page = 1, per_page = 50, q = '', type = 'contacts' } = body;
        const headers = await authHeaders(body);
        const wbUrl = `https://api.crmworkspace.com/v1/${type}?per_page=${per_page}&page=${page}` + (q ? `&query=${encodeURIComponent(q)}` : '');
        const r = await fetch(wbUrl, { headers });
        const data = await r.json();
        return json(data, cors, r.status);
      }

      if (path === 'contact' && req.method === 'POST') {
        const body = await parseBody();
        const { id, type = 'contacts' } = body;
        if (!id) return json({ error: 'Missing id' }, cors, 400);
        const headers = await authHeaders(body);
        const r = await fetch(`https://api.crmworkspace.com/v1/${type}/${encodeURIComponent(id)}`, { headers });
        const data = await r.json();
        return json(data, cors, r.status);
      }

      if (path === 'update-contact' && req.method === 'POST') {
        const body = await parseBody();
        const { secret, id, payload } = body;
        if (secret !== env.SERVER_SHARED_SECRET) return json({ error: 'Forbidden' }, cors, 403);
        if (!id || !payload) return json({ error: 'Missing id/payload' }, cors, 400);

        const headers = await authHeaders(body); // can use apiKey or stateId
        const r = await fetch(`https://api.crmworkspace.com/v1/contacts/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(payload)
        });
        const data = await r.json();
        return json(data, cors, r.status);
      }

      return json({ error: 'Not found' }, cors, 404);
    } catch (err) {
      return json({ error: String(err) }, cors, 500);
    }
  }
};

function json(obj, extraHeaders = {}, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}
function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}
