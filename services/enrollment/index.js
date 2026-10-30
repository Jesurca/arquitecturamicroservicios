// ENROLLMENT-SERVICE: procesos de matrícula. Dueño de `enrollments`. Participa en la SAGA coreografiada de matrícula.
//   POST /enrollments → [reserva cupo (sync)] → enrollment.created → (payment-service) payment.completed → CONFIRMADA
//                                                                  ↘ payment.failed|expired → CANCELADA → enrollment.cancelled (libera cupo)
const { createApp, start, openDb, auth, h, HttpError, bus, call } = require('../../common/lib');
const NAME = 'enrollment-service';
const db = openDb(NAME);
db.exec(`CREATE TABLE IF NOT EXISTS enrollments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, student_name TEXT NOT NULL, student_email TEXT NOT NULL,
  course_id INTEGER NOT NULL, course_name TEXT, teacher_id INTEGER, amount INTEGER, period TEXT,
  status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
const now = () => new Date().toISOString();
const get = (id) => db.prepare('SELECT * FROM enrollments WHERE id=?').get(id);
const setStatus = (id, status, reason = null) => db.prepare('UPDATE enrollments SET status=?,reason=?,updated_at=? WHERE id=?').run(status, reason, now(), id);
const app = createApp(NAME);

app.post('/enrollments', auth('estudiante', 'admin'), h(async (req, res) => {
  const studentId = req.user.role === 'estudiante' ? req.user.ref : Number(req.body?.studentId);
  const courseId = Number(req.body?.courseId);
  if (!studentId || !courseId) throw new HttpError(400, 'courseId es obligatorio (y studentId si eres administrador).');
  const student = await call('student-service', 'GET', `/students/${studentId}`);
  if (student.status !== 'ACTIVO') throw new HttpError(409, 'El estudiante no está activo y no puede matricularse.');
  if (db.prepare(`SELECT 1 FROM enrollments WHERE student_id=? AND course_id=? AND status IN ('CREADA','PENDIENTE_PAGO','CONFIRMADA')`).get(studentId, courseId))
    throw new HttpError(409, 'Ya tienes una matrícula activa o pendiente de pago en este curso.');

  const t = now();
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO enrollments(student_id,student_name,student_email,course_id,status,created_at,updated_at) VALUES(?,?,?,?,'CREADA',?,?)`)
    .run(studentId, student.name, student.email, courseId, t, t);
  let course;
  try {
    course = await call('course-service', 'POST', `/courses/${courseId}/reserve`, { body: { enrollmentId: id } });
  } catch (e) {
    setStatus(id, 'RECHAZADA', e.message); // paso fallido: no hay nada que compensar todavía
    throw e;
  }
  db.prepare(`UPDATE enrollments SET course_name=?,teacher_id=?,amount=?,period=?,status='PENDIENTE_PAGO',updated_at=? WHERE id=?`)
    .run(course.name, course.teacher_id, course.price, course.period, now(), id);
  await bus.publish('enrollment.created', { enrollmentId: id, studentId, studentName: student.name, courseId, courseName: course.name, teacherId: course.teacher_id, amount: course.price, period: course.period });
  res.status(201).json(get(id));
}));

app.get('/enrollments/me', auth('estudiante'), h(async (req, res) =>
  res.json(db.prepare('SELECT * FROM enrollments WHERE student_id=? ORDER BY id DESC').all(req.user.ref))));

app.get('/enrollments', auth('admin', 'docente', 'servicio'), h(async (req, res) => {
  const where = [], args = [];
  if (req.user.role === 'docente') { where.push('teacher_id=?'); args.push(req.user.ref); }
  for (const [q, col] of [['courseId', 'course_id'], ['studentId', 'student_id'], ['status', 'status']])
    if (req.query[q]) { where.push(`${col}=?`); args.push(req.query[q]); }
  res.json(db.prepare(`SELECT * FROM enrollments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`).all(...args));
}));

app.get('/enrollments/:id', auth(), h(async (req, res) => {
  const e = get(req.params.id);
  if (!e) throw new HttpError(404, 'Matrícula no encontrada');
  const { role, ref } = req.user;
  if ((role === 'estudiante' && e.student_id !== ref) || (role === 'docente' && e.teacher_id !== ref)) throw new HttpError(403, 'No tienes acceso a esta matrícula.');
  res.json(e);
}));

app.post('/enrollments/:id/cancel', auth('estudiante', 'admin'), h(async (req, res) => {
  const e = get(req.params.id);
  if (!e) throw new HttpError(404, 'Matrícula no encontrada');
  if (req.user.role === 'estudiante' && e.student_id !== req.user.ref) throw new HttpError(403, 'No puedes cancelar la matrícula de otra persona.');
  if (e.status !== 'PENDIENTE_PAGO') throw new HttpError(409, 'Solo se pueden cancelar matrículas con pago pendiente.');
  setStatus(e.id, 'CANCELADA', 'Cancelada por el usuario');
  await bus.publish('enrollment.cancelled', { enrollmentId: e.id, studentId: e.student_id, courseId: e.course_id, courseName: e.course_name, reason: 'Cancelada por el usuario' });
  res.json(get(e.id));
}));

// Pasos de la saga disparados por eventos de pago (idempotentes: solo actúan si la matrícula sigue PENDIENTE_PAGO)
bus.subscribe('enrollment-service', ['payment.completed', 'payment.failed', 'payment.expired'], async (ev, key) => {
  const e = get(ev.enrollmentId);
  if (!e || e.status !== 'PENDIENTE_PAGO') return;
  if (key === 'payment.completed') {
    setStatus(e.id, 'CONFIRMADA');
    await bus.publish('enrollment.confirmed', { enrollmentId: e.id, studentId: e.student_id, studentName: e.student_name, courseId: e.course_id, courseName: e.course_name, teacherId: e.teacher_id });
  } else {
    const reason = key === 'payment.expired' ? 'El plazo de pago venció' : 'El pago fue rechazado repetidamente';
    setStatus(e.id, 'CANCELADA', reason);
    await bus.publish('enrollment.cancelled', { enrollmentId: e.id, studentId: e.student_id, courseId: e.course_id, courseName: e.course_name, reason });
  }
});
bus.init(NAME);
start(app, NAME);
