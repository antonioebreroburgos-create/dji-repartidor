// netlify/functions/odoo-proxy.js
// Proxy entre la PWA y Odoo para evitar CORS

const https = require('https');

const ODOOS = {
  DJI: {
    url:      'https://distribucionesjoaquininfante.es',
    db:       'dji15',
    user:     'aebrero.jinfante@amh.es',
    password: '123456Zx@@',
  },
  SYL: {
    url:      'https://sylonuba.com',
    db:       'devel',
    user:     'antonioebreroburgos@gmail.com',
    password: '123456Zx@@',
    rejectUnauthorized: false,
  },
};

function odooRequest(cfg, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(cfg.url + path);
    const opts = {
      hostname: url.hostname,
      port:     443,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(cfg.cookie ? { 'Cookie': cfg.cookie } : {}),
      },
    };
    if (cfg.rejectUnauthorized === false) opts.rejectUnauthorized = false;

    const req = https.request(opts, (res) => {
      const cookie = res.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ json: JSON.parse(data), cookie }); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function odooLogin(cfg) {
  const { json, cookie } = await odooRequest(cfg, '/web/session/authenticate', {
    jsonrpc: '2.0', method: 'call', id: 1,
    params: { db: cfg.db, login: cfg.user, password: cfg.password },
  });
  if (!json.result?.uid) throw new Error('Login Odoo fallido');
  return cookie;
}

async function odooCallKw(cfg, cookie, model, method, args, kwargs = {}) {
  const { json } = await odooRequest(
    { ...cfg, cookie },
    '/web/dataset/call_kw',
    { jsonrpc: '2.0', method: 'call', id: 1, params: { model, method, args, kwargs } }
  );
  if (json.error) throw new Error(json.error.data?.message || JSON.stringify(json.error));
  return json.result;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const { empresa, action, params } = JSON.parse(event.body || '{}');
    const cfg = ODOOS[empresa];
    if (!cfg) throw new Error('Empresa no válida: ' + empresa);

    const cookie = await odooLogin(cfg);

    let result;

    if (action === 'get_pickings_hoy') {
      const { rutaNombre, fecha } = params;

      // Buscar ruta por nombre
      const rutas = await odooCallKw(cfg, cookie, 'stock.location.route', 'search_read',
        [[['name', 'ilike', rutaNombre]]],
        { fields: ['id', 'name'], limit: 5 }
      );
      if (!rutas.length) throw new Error(`Ruta "${rutaNombre}" no encontrada en Odoo`);
      const rutaId = rutas[0].id;

      // Buscar sale.orders con esa ruta
      const orders = await odooCallKw(cfg, cookie, 'sale.order', 'search_read',
        [[['route_id', '=', rutaId], ['state', 'in', ['sale', 'done']]]],
        { fields: ['id', 'name'], limit: 500 }
      );
      const orderIds = orders.map(o => o.id);

      // Buscar pickings de esas sale orders con estado assigned y fecha hoy
      const domain = [
        ['state', '=', 'assigned'],
        ['picking_type_code', '=', 'outgoing'],
        ['scheduled_date', '>=', fecha + ' 00:00:00'],
        ['scheduled_date', '<=', fecha + ' 23:59:59'],
      ];
      if (orderIds.length > 0) domain.push(['sale_id', 'in', orderIds]);
      else domain.push(['sale_id', '=', false]); // si no hay orders, no hay pickings

      const pickings = await odooCallKw(cfg, cookie, 'stock.picking', 'search_read',
        [domain],
        { fields: ['id', 'name', 'partner_id', 'scheduled_date', 'move_ids_without_package', 'sale_id', 'note'], limit: 100 }
      );
      result = { rutas, orders: orders.length, pickings };

    } else if (action === 'write_picking') {
      const { pickingId, vals } = params;
      result = await odooCallKw(cfg, cookie, 'stock.picking', 'write',
        [[pickingId], vals], {}
      );

    } else if (action === 'search_read') {
      const { model, domain, fields, limit } = params;
      result = await odooCallKw(cfg, cookie, model, 'search_read', [domain], { fields, limit: limit || 100 });

    } else {
      throw new Error('Acción no reconocida: ' + action);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, result }) };

  } catch (e) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
};
