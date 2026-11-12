// Prueba de humo end-to-end contra el gateway (http://localhost:8080). Uso: npm run smoke
const BASE = process.env.BASE || 'http://localhost:8080/api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const api = async (method, p, token, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const check = (name, cond, extra = '') => { console.log(`${cond ? '✔' : '✘'} ${name} ${cond ? '' : extra}`); if (!cond) fails++; };
const login = async (email, password) => (await api('POST', '/auth/login', null, { email, password })).data.token;
const waitFor = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; };

(async () => {
  console.log('— Autenticación');
  check('Sin token → 401', (await api('GET', '/courses')).status === 401);
  check('Credenciales malas → 401', (await api('POST', '/auth/login', null, { email: 'x@uni.edu', password: 'no' })).status === 401);
  const ana = await login('estudiante1@uni.edu', 'estudiante123');
  const luis = await login('estudiante2@uni.edu', 'estudiante123');
  const sofia = await login('estudiante3@uni.edu', 'estudiante123');
  const marta = await login('docente2@uni.edu', 'docente123'); // docente2 = Ing. Carlos Pérez (SIS201, SIS305)
  const admin = await login('admin@uni.edu', 'admin123');
  check('Login de 5 usuarios', [ana, luis, sofia, marta, admin].every(Boolean));
  check('Estudiante no puede crear cursos (403)', (await api('POST', '/courses', ana, {})).status === 403);

  console.log('— Flujo feliz: matrícula → pago → confirmación');
  const courses = (await api('GET', '/courses?status=ABIERTO', ana)).data;
  const sis201 = courses.find((c) => c.code === 'SIS201');
  const enr = await api('POST', '/enrollments', ana, { courseId: sis201.id });
  check('Matrícula creada en PENDIENTE_PAGO', enr.status === 201 && enr.data.status === 'PENDIENTE_PAGO', JSON.stringify(enr.data));
  check('Matrícula duplicada → 409', (await api('POST', '/enrollments', ana, { courseId: sis201.id })).status === 409);
  const pay = await waitFor(async () => (await api('GET', '/payments/me?status=PENDIENTE', ana)).data.find((p) => p.enrollment_id === enr.data.id));
  check('payment-service creó el cobro vía evento', !!pay);
  check('Otro estudiante no puede pagar (403)', (await api('POST', `/payments/${pay.id}/pay`, luis, { method: 'PSE' })).status === 403);
  const paid = await api('POST', `/payments/${pay.id}/pay`, ana, { method: 'TARJETA', card: '4242424242424242' });
  check('Pago aprobado', paid.status === 200 && paid.data.status === 'PAGADO');
  const confirmed = await waitFor(async () => (await api('GET', '/enrollments/me', ana)).data.find((e) => e.id === enr.data.id && e.status === 'CONFIRMADA'));
  check('Saga: matrícula pasó a CONFIRMADA', !!confirmed);
  const notes = await waitFor(async () => { const n = (await api('GET', '/notifications/me', ana)).data; return n.some((x) => x.title === 'Matrícula confirmada') && n; });
  check('Estudiante recibió notificaciones', !!notes);
  const dnotes = await waitFor(async () => (await api('GET', '/notifications/me', marta)).data.some((x) => x.title === 'Nuevo estudiante matriculado'));
  check('Docente fue notificado', !!dnotes);

  console.log('— Docente');
  const myCourses = (await api('GET', '/teachers/me/courses', marta)).data;
  check('Docente ve sus cursos', myCourses.some((c) => c.code === 'SIS201'));
  const roster = (await api('GET', `/teachers/me/courses/${sis201.id}/students`, marta)).data;
  check('Docente ve estudiantes matriculados', roster.students?.some((s) => s.name === 'Ana Torres'));
  const g = await api('POST', '/grades', marta, { enrollmentId: enr.data.id, value: 4.5, comment: 'Excelente' });
  check('Docente registra nota', g.status === 201, JSON.stringify(g.data));
  check('Docente no califica fuera de sus cursos (403)', (await api('POST', '/grades', (await login('docente1@uni.edu', 'docente123')), { enrollmentId: enr.data.id, value: 3 })).status === 403);
  check('Estudiante ve su nota', (await api('GET', '/grades/me', ana)).data.some((x) => x.value === 4.5));

  console.log('— Cupos agotados y compensación');
  const sis305 = courses.find((c) => c.code === 'SIS305');
  const a = await api('POST', '/enrollments', ana, { courseId: sis305.id });
  const b = await api('POST', '/enrollments', luis, { courseId: sis305.id });
  const c = await api('POST', '/enrollments', sofia, { courseId: sis305.id });
  check('Dos primeros toman cupo; el tercero es rechazado (409)', a.status === 201 && b.status === 201 && c.status === 409, `${a.status}/${b.status}/${c.status}: ${c.data.error}`);
  const lp = await waitFor(async () => (await api('GET', '/payments/me?status=PENDIENTE', luis)).data.find((p) => p.enrollment_id === b.data.id));
  let last;
  for (let i = 0; i < 3; i++) last = await api('POST', `/payments/${lp.id}/pay`, luis, { method: 'TARJETA', card: '4000000000000000' });
  check('3 rechazos de tarjeta → 402', last.status === 402);
  const cancelled = await waitFor(async () => (await api('GET', '/enrollments/me', luis)).data.find((e) => e.id === b.data.id && e.status === 'CANCELADA'));
  check('Compensación: matrícula CANCELADA', !!cancelled);
  const freed = await waitFor(async () => (await api('GET', '/courses/' + sis305.id, admin)).data.available === 1);
  check('Compensación: cupo liberado', !!freed);
  const retry = await api('POST', '/enrollments', sofia, { courseId: sis305.id });
  check('Sofía ahora sí puede matricularse', retry.status === 201, JSON.stringify(retry.data));
  const cx = await api('POST', `/enrollments/${retry.data.id}/cancel`, sofia);
  check('Cancelación voluntaria', cx.status === 200 && cx.data.status === 'CANCELADA');

  console.log('— Administración y composición');
  const nc = await api('POST', '/courses', admin, { code: 'FIS101', name: 'Física Mecánica', credits: 4, teacherId: 1, capacity: 20, price: 1150000, period: '2026-2' });
  check('Admin crea curso (valida docente por HTTP)', nc.status === 201, JSON.stringify(nc.data));
  const ns = await api('POST', '/students', admin, { document: '1004' + (Date.now() % 100000), name: 'Pedro Nuevo', email: `pedro${Date.now()}@uni.edu`, program: 'Ingeniería Civil' });
  check('Admin crea estudiante', ns.status === 201, JSON.stringify(ns.data));
  const newLogin = await waitFor(async () => (await api('POST', '/auth/login', null, { email: ns.data.email, password: ns.data.document })).data.token);
  check('Evento student.created provisionó su usuario', !!newLogin);
  const nn = await waitFor(async () => (await api('GET', '/notifications/me', ana)).data.some((x) => x.title === 'Nuevo curso disponible'));
  check('Broadcast "Nuevo curso disponible"', !!nn);
  const summary = (await api('GET', '/payments/summary', admin)).data;
  check('Resumen de pagos', Array.isArray(summary) && summary.length > 0);
  const dash = (await api('GET', '/dashboard', ana)).data;
  check('API Composition /dashboard', dash.student?.name === 'Ana Torres' && Array.isArray(dash.enrollments) && dash.degraded.length === 0, JSON.stringify(dash.degraded));
  const health = (await api('GET', '/health', ana)).data;
  check('Los 8 servicios están UP', health.length === 8 && health.every((s) => s.status === 'UP'));

  console.log(fails ? `\n✘ ${fails} verificación(es) fallaron` : '\n✔ Todo OK');
  process.exit(fails ? 1 : 0);
})();
