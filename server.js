const http = require('https');
const httpPlain = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Helper: HTTPS POST
function post(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, path: urlPath, method: 'POST', headers }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// Helper: HTTPS GET/ANY
function proxyRequest(method, hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path: urlPath, method, headers };
    const req = http.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise(resolve => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

httpPlain.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(200, CORS); return res.end(); }

  // ── /ml-callback — OAuth callback from ML ──
  if (p === '/ml-callback') {
    const { code, error, state } = parsed.query;
    const APP = 'https://' + (req.headers.host || 'localhost:'+PORT);

    if (error) return res.writeHead(302, { Location: APP+'/?ml_error='+encodeURIComponent(error) }) && res.end();
    if (!code) return res.writeHead(302, { Location: APP+'/?ml_error=sem_codigo' }) && res.end();

    let clientId = '', clientSecret = '';
    try { const s = JSON.parse(Buffer.from(state||'e30=','base64').toString()); clientId = s.id||''; clientSecret = s.sec||''; } catch(e) {}
    if (!clientId || !clientSecret) { res.writeHead(302, { Location: APP+'/?ml_error=sem_credenciais' }); return res.end(); }

    const redirectUri = APP + '/ml-callback';
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }).toString();

    try {
      const r = await post('api.mercadolibre.com', '/oauth/token', {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }, body);

      if (r.status !== 200 || r.body.error) {
        const msg = (r.body.error||'token_error')+': '+(r.body.message||'');
        res.writeHead(302, { Location: APP+'/?ml_error='+encodeURIComponent(msg) }); return res.end();
      }

      const { access_token, refresh_token, user_id } = r.body;

      // Get user info
      let userName = 'Vendedor ML';
      try {
        const uR = await proxyRequest('GET','api.mercadolibre.com','/users/'+user_id,{
          'Authorization':'Bearer '+access_token,'Accept':'application/json'
        });
        const u = JSON.parse(uR.body||'{}');
        userName = u.nickname || u.first_name || 'Vendedor ML';
      } catch(e) {}

      const tokenData = encodeURIComponent(JSON.stringify({ access_token, refresh_token, user_id: String(user_id), user_name: userName }));
      res.writeHead(302, { Location: APP+'/?ml_token='+tokenData }); return res.end();

    } catch(e) {
      res.writeHead(302, { Location: APP+'/?ml_error='+encodeURIComponent(e.message) }); return res.end();
    }
  }

  // ── /ml-proxy/* — Proxy all ML API calls ──
  if (p.startsWith('/ml-proxy/')) {
    const mlPath = p.replace('/ml-proxy','') + (parsed.search||'');
    const reqBody = await readBody(req);

    try {
      const r = await proxyRequest(
        req.method,
        'api.mercadolibre.com',
        mlPath,
        {
          'Authorization': req.headers['authorization']||'',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(reqBody ? {'Content-Length': Buffer.byteLength(reqBody)} : {}),
        },
        reqBody||undefined
      );
      res.writeHead(r.status, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(r.body||'{}');
    } catch(e) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Serve HTML ──
  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(HTML);

}).listen(PORT, () => console.log('✅ SellHub on port '+PORT));
