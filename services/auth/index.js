// AUTH-SERVICE: identidad, login (JWT) y roles. Dueño de la tabla `users`.
const { createApp, start, openDb, hashPw, checkPw, signUser, auth, h, HttpError, bus } = require('../../common/lib');
const NAME = 'auth-service';
const db = openDb(NAME);
db.exec(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('estudiante','docente','admin')), ref_id INTEGER, name TEXT NOT NULL)`);

function addUser(email, pw, role, ref, name) {
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return false;
  db.prepare('INSERT INTO users(email,password_hash,role,ref_id,name) VALUES(?,?,?,?,?)').run(email, hashPw(pw), role, ref, name);
  return true;
}
// Usuarios de demostración (los ref_id coinciden con los datos semilla de student/teacher-service)
addUser('admin@uni.edu', 'admin123', 'admin', null, 'Administración Académica');
addUser('docente1@uni.edu', 'docente123', 'docente', 1, 'Dra. Marta Ríos');
addUser('docente2@uni.edu', 'docente123', 'docente', 2, 'Ing. Carlos Pérez');
addUser('estudiante1@uni.edu', 'estudiante123', 'estudiante', 1, 'Ana Torres');
addUser('estudiante2@uni.edu', 'estudiante123', 'estudiante', 2, 'Luis Gómez');
addUser('estudiante3@uni.edu', 'estudiante123', 'estudiante', 3, 'Sofía Ramírez');

const app = createApp(NAME);

app.post('/auth/login', h(async (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
  if (!u || !checkPw(String(password || ''), u.password_hash)) throw new HttpError(401, 'Correo o contraseña incorrectos.');
  res.json({ token: signUser(u), user: { id: u.id, name: u.name, email: u.email, role: u.role, ref: u.ref_id } });
}));

app.get('/auth/me', auth(), h(async (req, res) => {
  const u = db.prepare('SELECT id,email,role,ref_id AS ref,name FROM users WHERE id=?').get(req.user.sub);
  if (!u) throw new HttpError(404, 'Usuario no encontrado');
  res.json(u);
}));

app.post('/auth/change-password', auth(), h(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.sub);
  if (!u || !checkPw(String(currentPassword || ''), u.password_hash)) throw new HttpError(401, 'La contraseña actual no es correcta.');
  if (!newPassword || String(newPassword).length < 6) throw new HttpError(400, 'La nueva contraseña debe tener al menos 6 caracteres.');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPw(String(newPassword)), u.id);
  res.json({ ok: true });
}));

app.post('/auth/users', auth('admin'), h(async (req, res) => {
  const { email, password, role, ref, name } = req.body || {};
  if (!email || !password || !role || !name) throw new HttpError(400, 'email, password, role y name son obligatorios.');
  if (!addUser(String(email).toLowerCase(), password, role, ref ?? null, name)) throw new HttpError(409, 'Ya existe un usuario con ese correo.');
  res.status(201).json({ ok: true });
}));

// Eventos: cuando otro servicio crea un estudiante/docente, se le provisiona un usuario (contraseña inicial = documento).
bus.subscribe('auth-service', ['student.created', 'teacher.created'], async (e, key) => {
  const role = key === 'student.created' ? 'estudiante' : 'docente';
  const ref = e.studentId ?? e.teacherId;
  addUser(String(e.email).toLowerCase(), String(e.document), role, ref, e.name); // idempotente
});
bus.init(NAME);
start(app, NAME);
