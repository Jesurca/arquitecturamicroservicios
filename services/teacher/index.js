// TEACHER-SERVICE: docentes y registro de calificaciones. Dueño de `teachers` y `grades`.
const { createApp, start, openDb, auth, h, HttpError, bus, call } = require('../../common/lib');
const NAME = 'teacher-service';
const db = openDb(NAME);
db.exec(`CREATE TABLE IF NOT EXISTS teachers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, department TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS grades(
  id INTEGER PRIMARY KEY AUTOINCREMENT, enrollment_id INTEGER UNIQUE NOT NULL, student_id INTEGER NOT NULL, course_id INTEGER NOT NULL,
  course_name TEXT NOT NULL, teacher_id INTEGER NOT NULL, value REAL NOT NULL, comment TEXT, updated_at TEXT NOT NULL)`);
if (!db.prepare('SELECT COUNT(*) n FROM teachers').get().n) {
  const ins = db.prepare('INSERT INTO teachers(document,name,email,department) VALUES(?,?,?,?)');
  ins.run('2001', 'Dra. Marta Ríos', 'docente1@uni.edu', 'Matemáticas');
  ins.run('2002', 'Ing. Carlos Pérez', 'docente2@uni.edu', 'Ingeniería de Sistemas');
}
const app = createApp(NAME);
const tok = (req) => req.headers.authorization.replace('Bearer ', '');

app.get('/teachers', auth('admin', 'servicio'), h(async (_req, res) => res.json(db.prepare('SELECT * FROM teachers ORDER BY id').all())));

app.post('/teachers', auth('admin'), h(async (req, res) => {
  const { document, name, email, department } = req.body || {};
  if (!document || !name || !email || !department) throw new HttpError(400, 'document, name, email y department son obligatorios.');
  try {
    const r = db.prepare('INSERT INTO teachers(document,name,email,department) VALUES(?,?,?,?)').run(String(document), name, String(email).toLowerCase(), department);
    const t = db.prepare('SELECT * FROM teachers WHERE id=?').get(r.lastInsertRowid);
    await bus.publish('teacher.created', { teacherId: t.id, name: t.name, email: t.email, document: t.document });
    res.status(201).json(t);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe un docente con ese documento o correo.');
    throw e;
  }
}));

// Cursos asignados al docente autenticado (consulta a course-service)
app.get('/teachers/me/courses', auth('docente'), h(async (req, res) =>
  res.json(await call('course-service', 'GET', `/courses?teacherId=${req.user.ref}`, { token: tok(req) }))));

// Estudiantes matriculados (matrícula CONFIRMADA) en un curso del docente, con su nota si existe
app.get('/teachers/me/courses/:courseId/students', auth('docente'), h(async (req, res) => {
  const course = await call('course-service', 'GET', `/courses/${Number(req.params.courseId)}`);
  if (course.teacher_id !== req.user.ref) throw new HttpError(403, 'Este curso no está asignado a ti.');
  const enrollments = await call('enrollment-service', 'GET', `/enrollments?courseId=${course.id}&status=CONFIRMADA`);
  const grades = db.prepare('SELECT * FROM grades WHERE course_id=?').all(course.id);
  res.json({
    course,
    students: enrollments.map((e) => {
      const g = grades.find((x) => x.enrollment_id === e.id);
      return { enrollmentId: e.id, studentId: e.student_id, name: e.student_name, email: e.student_email, grade: g?.value ?? null, comment: g?.comment ?? null };
    }),
  });
}));

app.get('/teachers/:id', auth('admin', 'servicio', 'docente'), h(async (req, res) => {
  const t = db.prepare('SELECT * FROM teachers WHERE id=?').get(req.params.id);
  if (!t) throw new HttpError(404, 'Docente no encontrado');
  res.json(t);
}));

// Registro de calificación (upsert por matrícula)
app.post('/grades', auth('docente'), h(async (req, res) => {
  const { enrollmentId, value, comment = '' } = req.body || {};
  const v = Number(value);
  if (!enrollmentId || !Number.isFinite(v) || v < 0 || v > 5) throw new HttpError(400, 'enrollmentId y una nota entre 0.0 y 5.0 son obligatorios.');
  const e = await call('enrollment-service', 'GET', `/enrollments/${Number(enrollmentId)}`);
  if (e.teacher_id !== req.user.ref) throw new HttpError(403, 'Solo puedes calificar estudiantes de tus cursos.');
  if (e.status !== 'CONFIRMADA') throw new HttpError(409, 'La matrícula no está confirmada (pago pendiente o cancelada).');
  db.prepare(`INSERT INTO grades(enrollment_id,student_id,course_id,course_name,teacher_id,value,comment,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(enrollment_id) DO UPDATE SET value=excluded.value, comment=excluded.comment, updated_at=excluded.updated_at`)
    .run(e.id, e.student_id, e.course_id, e.course_name, req.user.ref, v, comment, new Date().toISOString());
  await bus.publish('grade.registered', { enrollmentId: e.id, studentId: e.student_id, courseId: e.course_id, courseName: e.course_name, value: v });
  res.status(201).json({ ok: true, enrollmentId: e.id, value: v });
}));

app.get('/grades/me', auth('estudiante'), h(async (req, res) =>
  res.json(db.prepare('SELECT * FROM grades WHERE student_id=? ORDER BY course_name').all(req.user.ref))));

bus.init(NAME);
start(app, NAME);
