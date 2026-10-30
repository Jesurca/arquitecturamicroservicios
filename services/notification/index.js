// NOTIFICATION-SERVICE: avisos a estudiantes, docentes y administración. Consume TODOS los eventos (`#`).
// El envío de correo/SMS se simula con logs; el canal real (SMTP, SES, FCM…) se conectaría aquí sin tocar a los demás servicios.
const { createApp, start, openDb, auth, h, HttpError, bus, log } = require('../../common/lib');
const NAME = 'notification-service';
const db = openDb(NAME);
db.exec(`CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, ref INTEGER, title TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reads(notification_id INTEGER NOT NULL, user_key TEXT NOT NULL, PRIMARY KEY(notification_id,user_key))`);
const cop = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
const userKey = (u) => `${u.role}:${u.ref ?? u.sub}`;
function notify(role, ref, title, message) {
  db.prepare('INSERT INTO notifications(role,ref,title,message,created_at) VALUES(?,?,?,?,?)').run(role, ref ?? null, title, message, new Date().toISOString());
  log(NAME, `✉  [${role}${ref ? '#' + ref : ''}] ${title}: ${message}`);
}

// Traducción evento → aviso
const rules = {
  'course.created': (e) => notify('estudiante', null, 'Nuevo curso disponible', `${e.code} · ${e.name} ya está abierto para matrícula (${e.period}).`),
  'enrollment.created': (e) => notify('estudiante', e.studentId, 'Matrícula pendiente de pago', `Reservaste cupo en ${e.courseName}. Paga ${cop(e.amount)} para confirmarla.`),
  'payment.completed': (e) => notify('estudiante', e.studentId, 'Pago recibido', `Recibimos tu pago de ${cop(e.amount)}.`),
  'enrollment.confirmed': (e) => {
    notify('estudiante', e.studentId, 'Matrícula confirmada', `Ya estás matriculado en ${e.courseName}.`);
    notify('docente', e.teacherId, 'Nuevo estudiante matriculado', `${e.studentName} se matriculó en ${e.courseName}.`);
  },
  'enrollment.cancelled': (e) => notify('estudiante', e.studentId, 'Matrícula cancelada', `Tu matrícula en ${e.courseName} fue cancelada. Motivo: ${e.reason}.`),
  'payment.failed': (e) => notify('admin', null, 'Pago fallido', `La matrícula #${e.enrollmentId} (estudiante #${e.studentId}) superó los intentos de pago.`),
  'grade.registered': (e) => notify('estudiante', e.studentId, 'Nueva calificación', `Se registró tu nota en ${e.courseName}: ${e.value.toFixed(1)}.`),
};
bus.subscribe('notification-service', ['#'], async (e, key) => { rules[key]?.(e); });

const app = createApp(NAME);
app.get('/notifications/me', auth(), h(async (req, res) => {
  const rows = db.prepare(`SELECT n.id,n.title,n.message,n.created_at, (r.notification_id IS NOT NULL) AS read
    FROM notifications n LEFT JOIN reads r ON r.notification_id=n.id AND r.user_key=?
    WHERE n.role=? AND (n.ref IS NULL OR n.ref=?) ORDER BY n.id DESC LIMIT 50`).all(userKey(req.user), req.user.role, req.user.ref ?? -1);
  res.json(rows.map((r) => ({ ...r, read: !!r.read })));
}));
app.post('/notifications/read-all', auth(), h(async (req, res) => {
  db.prepare(`INSERT OR IGNORE INTO reads(notification_id,user_key) SELECT id,? FROM notifications WHERE role=? AND (ref IS NULL OR ref=?)`)
    .run(userKey(req.user), req.user.role, req.user.ref ?? -1);
  res.json({ ok: true });
}));
app.post('/notifications/broadcast', auth('admin'), h(async (req, res) => {
  const { role, title, message } = req.body || {};
  if (!title || !message) throw new HttpError(400, 'title y message son obligatorios.');
  const roles = role === 'todos' || !role ? ['estudiante', 'docente'] : [role];
  if (!roles.every((r) => ['estudiante', 'docente', 'admin'].includes(r))) throw new HttpError(400, 'Rol destino inválido.');
  roles.forEach((r) => notify(r, null, title, message));
  res.status(201).json({ ok: true, roles });
}));
bus.init(NAME);
start(app, NAME);
