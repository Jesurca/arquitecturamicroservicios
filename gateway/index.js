// API-GATEWAY: punto de entrada único. Enruta /api/<recurso> → microservicio, valida JWT, limita tasa,
// agrega datos (API Composition) y sirve la interfaz web.
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createApp, start, call, url, PORTS, JWT_SECRET, h, HttpError, log } = require('../common/lib');
const NAME = 'api-gateway';

const ROUTES = {
  auth: 'auth-service', students: 'student-service', teachers: 'teacher-service', grades: 'teacher-service',
  courses: 'course-service', enrollments: 'enrollment-service', payments: 'payment-service', notifications: 'notification-service',
};
const PUBLIC = [['POST', '/auth/login']];

const app = createApp(NAME);

// Rate limiting simple por IP (120 peticiones/minuto)
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
app.use('/api', (req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > 120) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' });
  next();
});

// Estado de todos los servicios
app.get('/api/health', h(async (_req, res) => {
  const out = await Promise.all(Object.keys(PORTS).filter((s) => s !== NAME).map(async (s) => {
    try { const r = await fetch(`${url(s)}/health`, { signal: AbortSignal.timeout(1500) }); return { service: s, status: r.ok ? 'UP' : 'DOWN' }; }
    catch { return { service: s, status: 'DOWN' }; }
  }));
  res.json([{ service: NAME, status: 'UP' }, ...out]);
}));

// Autenticación en el borde: todo excepto el login exige un JWT válido
app.use('/api', (req, res, next) => {
  if (PUBLIC.some(([m, p]) => m === req.method && p === req.path)) return next();
  try { req.user = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token ausente o inválido. Inicia sesión de nuevo.' }); }
});

// API Composition: el panel del estudiante reúne 4 servicios en una sola respuesta tolerante a fallos parciales
app.get('/api/dashboard', h(async (req, res) => {
  if (req.user.role !== 'estudiante') throw new HttpError(403, 'El resumen está disponible solo para estudiantes.');
  const token = req.headers.authorization.replace('Bearer ', '');
  const parts = { student: ['student-service', '/students/me'], enrollments: ['enrollment-service', '/enrollments/me'],
    pendingPayments: ['payment-service', '/payments/me?status=PENDIENTE'], notifications: ['notification-service', '/notifications/me'] };
  const keys = Object.keys(parts);
  const results = await Promise.allSettled(keys.map((k) => call(parts[k][0], 'GET', parts[k][1], { token })));
  const body = { degraded: [] };
  results.forEach((r, i) => { if (r.status === 'fulfilled') body[keys[i]] = r.value; else { body[keys[i]] = null; body.degraded.push(parts[keys[i]][0]); } });
  res.json(body);
}));

// Proxy hacia los microservicios
app.use('/api/:resource', async (req, res) => {
  const svc = ROUTES[req.params.resource];
  if (!svc) return res.status(404).json({ error: 'Recurso no encontrado' });
  const target = `${url(svc)}/${req.params.resource}${req.url === '/' ? '' : req.url}`;
  try {
    const r = await fetch(target, {
      method: req.method,
      headers: { 'content-type': 'application/json', authorization: req.headers.authorization || '' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(10000),
    });
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(await r.text());
  } catch (e) {
    log(NAME, `fallo al contactar ${svc}: ${e.message}`);
    res.status(503).json({ error: `El servicio ${svc} no está disponible en este momento.` });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
start(app, NAME);
