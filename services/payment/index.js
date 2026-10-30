// PAYMENT-SERVICE: pagos académicos. Dueño de `payments`. Pasarela de pago SIMULADA.
const { createApp, start, openDb, auth, h, HttpError, bus } = require('../../common/lib');
const NAME = 'payment-service';
const TTL_SECONDS = Number(process.env.PAYMENT_TTL_SECONDS || 900); // plazo para pagar (15 min por defecto)
const MAX_ATTEMPTS = 3;
const db = openDb(NAME);
db.exec(`CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, enrollment_id INTEGER UNIQUE NOT NULL, student_id INTEGER NOT NULL, concept TEXT NOT NULL,
  amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDIENTE', attempts INTEGER NOT NULL DEFAULT 0, method TEXT,
  due_at TEXT NOT NULL, paid_at TEXT, created_at TEXT NOT NULL)`);
const get = (id) => db.prepare('SELECT * FROM payments WHERE id=?').get(id);
const app = createApp(NAME);

app.get('/payments/me', auth('estudiante'), h(async (req, res) => {
  const st = req.query.status;
  res.json(db.prepare(`SELECT * FROM payments WHERE student_id=? ${st ? 'AND status=?' : ''} ORDER BY id DESC`).all(...(st ? [req.user.ref, st] : [req.user.ref])));
}));

app.get('/payments/summary', auth('admin'), h(async (_req, res) =>
  res.json(db.prepare('SELECT status, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM payments GROUP BY status').all())));

app.get('/payments', auth('admin'), h(async (req, res) => {
  const st = req.query.status;
  res.json(db.prepare(`SELECT * FROM payments ${st ? 'WHERE status=?' : ''} ORDER BY id DESC`).all(...(st ? [st] : [])));
}));

// Simulación de pasarela: tarjetas que terminan en 0000 son rechazadas. A los 3 rechazos el pago pasa a FALLIDO (dispara la compensación).
app.post('/payments/:id/pay', auth('estudiante', 'admin'), h(async (req, res) => {
  const p = get(req.params.id);
  if (!p) throw new HttpError(404, 'Pago no encontrado');
  if (req.user.role === 'estudiante' && p.student_id !== req.user.ref) throw new HttpError(403, 'No puedes pagar una obligación de otra persona.');
  if (p.status !== 'PENDIENTE') throw new HttpError(409, `Este pago ya está ${p.status}.`);
  const { method = 'TARJETA', card = '' } = req.body || {};
  if (!['TARJETA', 'PSE'].includes(method)) throw new HttpError(400, 'Método de pago inválido.');
  const rejected = method === 'TARJETA' && String(card).replace(/\s/g, '').endsWith('0000');
  if (rejected) {
    const attempts = p.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE payments SET attempts=?,status='FALLIDO' WHERE id=?`).run(attempts, p.id);
      await bus.publish('payment.failed', { paymentId: p.id, enrollmentId: p.enrollment_id, studentId: p.student_id, amount: p.amount });
      throw new HttpError(402, 'Pago rechazado por tercera vez: la matrícula fue cancelada.');
    }
    db.prepare('UPDATE payments SET attempts=? WHERE id=?').run(attempts, p.id);
    throw new HttpError(402, `Tarjeta rechazada. Intento ${attempts} de ${MAX_ATTEMPTS}.`);
  }
  db.prepare(`UPDATE payments SET status='PAGADO',method=?,paid_at=? WHERE id=?`).run(method, new Date().toISOString(), p.id);
  await bus.publish('payment.completed', { paymentId: p.id, enrollmentId: p.enrollment_id, studentId: p.student_id, amount: p.amount, method });
  res.json(get(p.id));
}));

// Se crea la obligación de pago cuando nace una matrícula (idempotente por enrollment_id).
bus.subscribe('payment-service', ['enrollment.created', 'enrollment.cancelled'], async (e, key) => {
  if (key === 'enrollment.created') {
    if (db.prepare('SELECT 1 FROM payments WHERE enrollment_id=?').get(e.enrollmentId)) return;
    const due = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
    const r = db.prepare('INSERT INTO payments(enrollment_id,student_id,concept,amount,due_at,created_at) VALUES(?,?,?,?,?,?)')
      .run(e.enrollmentId, e.studentId, `Matrícula ${e.courseName} (${e.period})`, e.amount, due, new Date().toISOString());
    await bus.publish('payment.created', { paymentId: r.lastInsertRowid, enrollmentId: e.enrollmentId, studentId: e.studentId, amount: e.amount, concept: `Matrícula ${e.courseName}`, dueAt: due });
  } else {
    db.prepare(`UPDATE payments SET status='ANULADO' WHERE enrollment_id=? AND status='PENDIENTE'`).run(e.enrollmentId);
  }
});

// Vencimiento de pagos: revisa cada 10 s y publica payment.expired
setInterval(async () => {
  const due = db.prepare(`SELECT * FROM payments WHERE status='PENDIENTE' AND due_at<?`).all(new Date().toISOString());
  for (const p of due) {
    db.prepare(`UPDATE payments SET status='EXPIRADO' WHERE id=?`).run(p.id);
    await bus.publish('payment.expired', { paymentId: p.id, enrollmentId: p.enrollment_id, studentId: p.student_id, amount: p.amount });
  }
}, 10000);
bus.init(NAME);
start(app, NAME);
