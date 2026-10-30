// Utilidades compartidas por todos los microservicios (config, DB, JWT, eventos, cliente HTTP resiliente).
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const amqp = require('amqplib');
const { DatabaseSync } = require('node:sqlite');

const PORTS = {
  'api-gateway': 8080, 'auth-service': 3001, 'student-service': 3002, 'teacher-service': 3003,
  'course-service': 3004, 'enrollment-service': 3005, 'payment-service': 3006, 'notification-service': 3007,
};
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const RABBIT_URL = process.env.RABBIT_URL || 'amqp://localhost';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const EXCHANGE = 'academic.events';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (svc, ...a) => console.log(`[${new Date().toISOString()}] [${svc}]`, ...a);
const url = (name) => (process.env.DOCKER ? `http://${name}:${PORTS[name]}` : `http://localhost:${PORTS[name]}`);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- Persistencia: una base SQLite por servicio (patrón Database per Service) ----------
function openDb(name) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, `${name}.db`));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  return db;
}

// ---------- Seguridad: JWT + hash de contraseñas ----------
const hashPw = (pw, salt = crypto.randomBytes(8).toString('hex')) =>
  `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
const checkPw = (pw, stored) => {
  const a = Buffer.from(hashPw(pw, stored.split(':')[0]));
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const signUser = (u) => jwt.sign({ sub: u.id, role: u.role, ref: u.ref_id, name: u.name }, JWT_SECRET, { expiresIn: '8h' });
const serviceToken = () => jwt.sign({ sub: 0, role: 'servicio', name: 'servicio-interno' }, JWT_SECRET, { expiresIn: '5m' });

// Middleware: verifica el JWT y, opcionalmente, restringe por rol (RBAC).
const auth = (...roles) => (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token ausente o inválido. Inicia sesión de nuevo.' });
  }
  if (roles.length && !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'No tienes permiso para esta operación.' });
  }
  next();
};

// ---------- Express ----------
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function createApp(name) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.path !== '/health') log(name, req.method, req.originalUrl); next(); });
  app.get('/health', (_req, res) => res.json({ service: name, status: 'UP' }));
  return app;
}
function start(app, name) {
  app.use((_req, res) => res.status(404).json({ error: 'Recurso no encontrado' }));
  app.use((err, _req, res, _next) => {
    if (!err.status) log(name, 'ERROR', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Error interno del servicio' });
  });
  const port = process.env.PORT || PORTS[name];
  app.listen(port, () => log(name, `escuchando en el puerto ${port}`));
}

// ---------- Cliente HTTP con timeout, reintento y Circuit Breaker ----------
const breakers = {};
async function call(svc, method, p, { body, token, timeout = 3000 } = {}) {
  const b = (breakers[svc] ||= { fails: 0, openUntil: 0 });
  if (Date.now() < b.openUntil) throw new HttpError(503, `El servicio ${svc} no está disponible temporalmente.`);
  const attempts = method === 'GET' ? 2 : 1;
  for (let i = 0; i < attempts; i++) {
    let r;
    try {
      r = await fetch(url(svc) + p, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token || serviceToken()}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      if (i === attempts - 1) {
        if (++b.fails >= 3) b.openUntil = Date.now() + 10000; // abre el circuito 10 s
        throw new HttpError(503, `El servicio ${svc} no responde.`);
      }
      continue;
    }
    b.fails = 0; // el servicio respondió (aunque sea 4xx): el circuito se mantiene cerrado
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(r.status, data.error || `Error en ${svc}`);
    return data;
  }
}

// ---------- Bus de eventos (RabbitMQ, exchange tipo topic) ----------
const bus = (() => {
  let ch = null, svc = 'bus';
  const subs = [];
  const applySub = async ({ queue, keys, handler }) => {
    await ch.assertQueue(queue, { durable: true });
    for (const k of keys) await ch.bindQueue(queue, EXCHANGE, k);
    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      try { await handler(JSON.parse(msg.content.toString()), msg.fields.routingKey); ch.ack(msg); }
      catch (e) { log(svc, `error procesando ${msg.fields.routingKey}:`, e.message); ch.nack(msg, false, false); }
    });
  };
  const connect = async () => {
    for (;;) {
      try {
        const conn = await amqp.connect(RABBIT_URL);
        conn.on('error', () => {});
        conn.on('close', () => { ch = null; log(svc, 'RabbitMQ desconectado; reintentando…'); setTimeout(connect, 3000); });
        ch = await conn.createChannel();
        await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
        for (const s of subs) await applySub(s);
        log(svc, 'conectado a RabbitMQ');
        return;
      } catch { log(svc, 'esperando a RabbitMQ…'); await sleep(2000); }
    }
  };
  return {
    init: (name) => { svc = name; return connect(); },
    subscribe: async (queue, keys, handler) => { const s = { queue, keys, handler }; subs.push(s); if (ch) await applySub(s); },
    publish: async (key, payload) => {
      for (let i = 0; i < 25 && !ch; i++) await sleep(200);
      if (!ch) { log(svc, `No se pudo publicar ${key}: sin conexión al broker`); return; }
      ch.publish(EXCHANGE, key, Buffer.from(JSON.stringify({ ...payload, _at: new Date().toISOString() })), { persistent: true });
      log(svc, `evento publicado → ${key}`);
    },
  };
})();

module.exports = { PORTS, HttpError, openDb, hashPw, checkPw, signUser, serviceToken, auth, h, createApp, start, call, bus, log, sleep, url, JWT_SECRET };
