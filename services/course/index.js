// COURSE-SERVICE: oferta académica y control de cupos. Dueño de `courses` y `reservations`.
const { createApp, start, openDb, auth, h, HttpError, bus, call } = require('../../common/lib');
const NAME = 'course-service';
const db = openDb(NAME);
db.exec(`CREATE TABLE IF NOT EXISTS courses(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, credits INTEGER NOT NULL,
  teacher_id INTEGER NOT NULL, teacher_name TEXT NOT NULL, capacity INTEGER NOT NULL, enrolled INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL, period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ABIERTO');
  CREATE TABLE IF NOT EXISTS reservations(enrollment_id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL);`);
if (!db.prepare('SELECT COUNT(*) n FROM courses').get().n) {
  const ins = db.prepare('INSERT INTO courses(code,name,credits,teacher_id,teacher_name,capacity,price,period) VALUES(?,?,?,?,?,?,?,?)');
  ins.run('MAT101', 'Cálculo Diferencial', 4, 1, 'Dra. Marta Ríos', 30, 1200000, '2026-2');
  ins.run('SIS201', 'Estructuras de Datos', 3, 2, 'Ing. Carlos Pérez', 25, 1100000, '2026-2');
  ins.run('SIS305', 'Arquitectura de Software', 3, 2, 'Ing. Carlos Pérez', 2, 1300000, '2026-2'); // 2 cupos: sirve para probar "cupos agotados"
  ins.run('MAT210', 'Álgebra Lineal', 3, 1, 'Dra. Marta Ríos', 30, 1000000, '2026-2');
}
const view = (c) => c && { ...c, available: c.capacity - c.enrolled };
const app = createApp(NAME);

app.get('/courses', auth(), h(async (req, res) => {
  const where = [], args = [];
  if (req.query.teacherId) { where.push('teacher_id=?'); args.push(Number(req.query.teacherId)); }
  if (req.query.status) { where.push('status=?'); args.push(req.query.status); }
  res.json(db.prepare(`SELECT * FROM courses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY code`).all(...args).map(view));
}));

app.get('/courses/:id', auth(), h(async (req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!c) throw new HttpError(404, 'Curso no encontrado');
  res.json(view(c));
}));

app.post('/courses', auth('admin'), h(async (req, res) => {
  const { code, name, credits, teacherId, capacity, price, period } = req.body || {};
  if (!code || !name || !credits || !teacherId || !capacity || !price || !period) throw new HttpError(400, 'Faltan campos obligatorios del curso.');
  const teacher = await call('teacher-service', 'GET', `/teachers/${Number(teacherId)}`); // validación síncrona entre servicios
  try {
    const r = db.prepare('INSERT INTO courses(code,name,credits,teacher_id,teacher_name,capacity,price,period) VALUES(?,?,?,?,?,?,?,?)')
      .run(String(code).toUpperCase(), name, Number(credits), teacher.id, teacher.name, Number(capacity), Number(price), period);
    const c = db.prepare('SELECT * FROM courses WHERE id=?').get(r.lastInsertRowid);
    await bus.publish('course.created', { courseId: c.id, code: c.code, name: c.name, teacherId: c.teacher_id, price: c.price, period: c.period });
    res.status(201).json(view(c));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe un curso con ese código.');
    throw e;
  }
}));

app.put('/courses/:id', auth('admin'), h(async (req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!c) throw new HttpError(404, 'Curso no encontrado');
  const { capacity = c.capacity, price = c.price, status = c.status } = req.body || {};
  if (!['ABIERTO', 'CERRADO'].includes(status)) throw new HttpError(400, 'Estado inválido.');
  if (Number(capacity) < c.enrolled) throw new HttpError(409, 'El cupo no puede ser menor que los estudiantes ya matriculados.');
  db.prepare('UPDATE courses SET capacity=?,price=?,status=? WHERE id=?').run(Number(capacity), Number(price), status, c.id);
  res.json(view(db.prepare('SELECT * FROM courses WHERE id=?').get(c.id)));
}));

// Reserva de cupo (llamada síncrona de enrollment-service). Idempotente por enrollmentId.
app.post('/courses/:id/reserve', auth('servicio'), h(async (req, res) => {
  const enrollmentId = Number(req.body?.enrollmentId);
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!c) throw new HttpError(404, 'Curso no encontrado');
  if (db.prepare('SELECT 1 FROM reservations WHERE enrollment_id=?').get(enrollmentId)) return res.json(view(c));
  if (c.status !== 'ABIERTO') throw new HttpError(409, 'El curso no está abierto para matrícula.');
  const r = db.prepare('UPDATE courses SET enrolled=enrolled+1 WHERE id=? AND enrolled<capacity').run(c.id);
  if (!r.changes) throw new HttpError(409, 'No hay cupos disponibles en este curso.');
  db.prepare('INSERT INTO reservations(enrollment_id,course_id) VALUES(?,?)').run(enrollmentId, c.id);
  res.json(view(db.prepare('SELECT * FROM courses WHERE id=?').get(c.id)));
}));

// Compensación de la saga: si la matrícula se cancela, se libera el cupo (idempotente).
bus.subscribe('course-service', ['enrollment.cancelled'], async (e) => {
  const rsv = db.prepare('SELECT * FROM reservations WHERE enrollment_id=?').get(e.enrollmentId);
  if (!rsv) return;
  db.prepare('DELETE FROM reservations WHERE enrollment_id=?').run(e.enrollmentId);
  db.prepare('UPDATE courses SET enrolled=MAX(enrolled-1,0) WHERE id=?').run(rsv.course_id);
});
bus.init(NAME);
start(app, NAME);
