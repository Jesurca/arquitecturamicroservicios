// STUDENT-SERVICE: datos maestros del estudiante. Dueño de la tabla `students`.
const { createApp, start, openDb, auth, h, HttpError, bus } = require('../../common/lib');
const NAME = 'student-service';
const db = openDb(NAME);
db.exec(`CREATE TABLE IF NOT EXISTS students(
  id INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  program TEXT NOT NULL, semester INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'ACTIVO')`);
if (!db.prepare('SELECT COUNT(*) n FROM students').get().n) {
  const ins = db.prepare('INSERT INTO students(document,name,email,program,semester) VALUES(?,?,?,?,?)');
  ins.run('1001', 'Ana Torres', 'estudiante1@uni.edu', 'Ingeniería de Sistemas', 5);
  ins.run('1002', 'Luis Gómez', 'estudiante2@uni.edu', 'Ingeniería de Sistemas', 3);
  ins.run('1003', 'Sofía Ramírez', 'estudiante3@uni.edu', 'Administración de Empresas', 7);
}
const app = createApp(NAME);

app.get('/students', auth('admin', 'docente', 'servicio'), h(async (_req, res) =>
  res.json(db.prepare('SELECT * FROM students ORDER BY id').all())));

app.get('/students/me', auth('estudiante'), h(async (req, res) => {
  const s = db.prepare('SELECT * FROM students WHERE id=?').get(req.user.ref);
  if (!s) throw new HttpError(404, 'No existe perfil de estudiante para este usuario.');
  res.json(s);
}));

app.get('/students/:id', auth('admin', 'docente', 'servicio', 'estudiante'), h(async (req, res) => {
  if (req.user.role === 'estudiante' && req.user.ref !== Number(req.params.id)) throw new HttpError(403, 'Solo puedes consultar tu propio perfil.');
  const s = db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
  if (!s) throw new HttpError(404, 'Estudiante no encontrado');
  res.json(s);
}));

app.post('/students', auth('admin'), h(async (req, res) => {
  const { document, name, email, program, semester = 1 } = req.body || {};
  if (!document || !name || !email || !program) throw new HttpError(400, 'document, name, email y program son obligatorios.');
  try {
    const r = db.prepare('INSERT INTO students(document,name,email,program,semester) VALUES(?,?,?,?,?)').run(String(document), name, String(email).toLowerCase(), program, Number(semester));
    const s = db.prepare('SELECT * FROM students WHERE id=?').get(r.lastInsertRowid);
    await bus.publish('student.created', { studentId: s.id, name: s.name, email: s.email, document: s.document });
    res.status(201).json(s);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe un estudiante con ese documento o correo.');
    throw e;
  }
}));

app.put('/students/:id', auth('admin'), h(async (req, res) => {
  const s = db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
  if (!s) throw new HttpError(404, 'Estudiante no encontrado');
  const { name = s.name, program = s.program, semester = s.semester, status = s.status } = req.body || {};
  if (!['ACTIVO', 'INACTIVO', 'SUSPENDIDO'].includes(status)) throw new HttpError(400, 'Estado inválido.');
  db.prepare('UPDATE students SET name=?,program=?,semester=?,status=? WHERE id=?').run(name, program, Number(semester), status, s.id);
  res.json(db.prepare('SELECT * FROM students WHERE id=?').get(s.id));
}));

bus.init(NAME);
start(app, NAME);
