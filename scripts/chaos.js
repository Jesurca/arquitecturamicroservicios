#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TEST DEL MONO (Chaos Monkey) para la plataforma académica en Docker.
//
// A cada contenedor (o a uno al azar) le "suelta el mono": le inyecta una falla real y verifica
//   1) ESTADO ESTABLE   → antes de romper nada, todo está sano.
//   2) RADIO DE IMPACTO → durante la falla, SOLO el servicio atacado deja de responder, y lo hace
//                         de forma controlada (503 rápido, no se cuelga); el resto sigue funcionando.
//   3) RECUPERACIÓN     → el contenedor vuelve a estar sano (se mide el MTTR).
//   4) INTEGRIDAD       → después, las APIs y la saga completa (matrícula → pago → confirmación por
//                         eventos RabbitMQ) funcionan, y no se perdieron datos (volúmenes).
//
// Fallas ("modos"):
//   kill     SIGKILL al proceso DENTRO del contenedor (crash real). Prueba la AUTOCURACIÓN: la política
//            restart debe revivirlo sola. (No se usa `docker kill` porque Docker lo trata como parada
//            manual y la política unless-stopped no lo reinicia.)
//   stop     docker stop + espera + docker start. Caída prolongada: prueba degradación y circuit breaker.
//   pause    docker pause (congela el proceso). Servicio colgado: prueba timeouts.
//   network  docker network disconnect. Partición de red: el contenedor vive pero nadie lo alcanza.
//
// Uso:
//   node scripts/chaos.js                          → todos los contenedores × todos los modos
//   node scripts/chaos.js --mode kill              → solo kill, a cada contenedor
//   node scripts/chaos.js --target course-service,rabbitmq --mode stop,pause
//   node scripts/chaos.js --random 5 --seed 42     → 5 ataques al azar (reproducibles con la semilla)
//   Opciones: --hold <s> (duración de la falla, 8)  --recover-timeout <s> (90)  --no-saga
//             --base <url> (http://localhost:8080)   --report-dir <dir> (reports)
// Código de salida: 0 si todas las rondas pasan, 1 si alguna falla (útil para CI).
// ─────────────────────────────────────────────────────────────────────────────────────────────
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- argumentos ----------
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);
if (flag('help') || flag('h')) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 27).join('\n')); process.exit(0); }
const ALL_MODES = ['kill', 'stop', 'pause', 'network'];
const MODES = opt('mode', ALL_MODES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const HOLD = Number(opt('hold', 8)) * 1000;
const RECOVER_TIMEOUT = Number(opt('recover-timeout', 90)) * 1000;
const ORIGIN = opt('base', 'http://localhost:8080').replace(/\/$/, '');
const BASE = `${ORIGIN}/api`;
const REPORT_DIR = opt('report-dir', path.join(__dirname, '..', 'reports'));
const SAGA = !flag('no-saga');
const RANDOM = Number(opt('random', 0));
let seed = Number(opt('seed', Date.now() % 100000));
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; // PRNG reproducible
for (const m of MODES) if (!ALL_MODES.includes(m)) { console.error(`Modo desconocido: ${m}. Usa: ${ALL_MODES.join(', ')}`); process.exit(2); }

// ---------- utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryDocker = (...a) => { try { return docker(...a); } catch (e) { return null; } };
const inspect = (c, fmt) => tryDocker('inspect', '-f', fmt, c);
const health = (c) => inspect(c, '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}');
const restarts = (c) => Number(inspect(c, '{{.RestartCount}}') || 0);

// ---------- objetivos (contenedores del diagrama) ----------
// nets: redes de las que se desconecta en el modo "network" (se reconecta con su alias DNS original).
const TARGETS = [
  { svc: 'rabbitmq', zone: 'domain', nets: ['pa-saga-net', 'pa-domain-net'] },
  { svc: 'auth-service', zone: 'domain', nets: ['pa-domain-net'] },
  { svc: 'payment-service', zone: 'domain', nets: ['pa-domain-net'], dashboard: true },
  { svc: 'notification-service', zone: 'domain', nets: ['pa-domain-net'], dashboard: true },
  { svc: 'enrollment-service', zone: 'saga', nets: ['pa-saga-net'], dashboard: true },
  { svc: 'student-service', zone: 'saga', nets: ['pa-saga-net'], dashboard: true },
  { svc: 'course-service', zone: 'saga', nets: ['pa-saga-net'] },
  { svc: 'teacher-service', zone: 'saga', nets: ['pa-saga-net'] },
  { svc: 'api-gateway', zone: 'edge', nets: ['pa-saga-net', 'pa-domain-net'] },
].map((t) => ({ ...t, container: `pa-${t.svc}` }));
const onlyTargets = opt('target', '').split(',').map((s) => s.trim()).filter(Boolean);
for (const t of onlyTargets) if (!TARGETS.some((x) => x.svc === t)) { console.error(`Objetivo desconocido: ${t}. Usa: ${TARGETS.map((x) => x.svc).join(', ')}`); process.exit(2); }
const targets = onlyTargets.length ? TARGETS.filter((t) => onlyTargets.includes(t.svc)) : TARGETS;

// ---------- cliente HTTP ----------
async function api(method, p, token, body, { timeout = 15000, base = BASE } = {}) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(base + p, {
        method, signal: AbortSignal.timeout(timeout),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 429) { await sleep(3000); continue; } // rate limit del gateway: esperar, no es una falla del mono
      return { status: r.status, data: await r.json().catch(() => ({})), ms: Date.now() - t0 };
    } catch (e) {
      return { status: 0, error: e.name === 'TimeoutError' ? 'timeout' : 'sin conexión', data: {}, ms: Date.now() - t0 };
    }
  }
}
const waitFor = async (fn, ms, every = 1000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } return null; };

// Sonda independiente por servicio: cada una toca SOLO ese microservicio (a través del gateway).
const tokens = {};
const PROBES = {
  'auth-service': () => api('POST', '/auth/login', null, { email: 'admin@uni.edu', password: 'admin123' }),
  'student-service': () => api('GET', '/students/me', tokens.ana),
  'teacher-service': () => api('GET', '/grades/me', tokens.ana),
  'course-service': () => api('GET', '/courses', tokens.ana),
  'enrollment-service': () => api('GET', '/enrollments/me', tokens.ana),
  'payment-service': () => api('GET', '/payments/me', tokens.ana),
  'notification-service': () => api('GET', '/notifications/me', tokens.ana),
};
const ok = (r) => r.status >= 200 && r.status < 300;
const fmt = (r) => (r.status ? `HTTP ${r.status}` : r.error) + ` en ${r.ms} ms`;

// ---------- pasos ----------
async function waitAllHealthy(ms = RECOVER_TIMEOUT) {
  return waitFor(async () => TARGETS.every((t) => health(t.container) === 'healthy'), ms);
}

async function login() {
  const l = async (email, password) => (await api('POST', '/auth/login', null, { email, password })).data.token;
  tokens.ana = await l('estudiante1@uni.edu', 'estudiante123');
  tokens.admin = await l('admin@uni.edu', 'admin123');
  return tokens.ana && tokens.admin;
}

async function sagaProbe() {
  // Flujo completo que cruza las dos zonas: HTTP síncrono (gateway → enrollment → student/course)
  // + eventos asíncronos (enrollment.created → payment → payment.completed → enrollment CONFIRMADA → notification)
  const code = `CH${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const c = await api('POST', '/courses', tokens.admin, { code, name: `Curso chaos ${code}`, credits: 1, teacherId: 1, capacity: 5, price: 1000, period: 'CHAOS' });
  if (c.status !== 201) return `crear curso → ${fmt(c)} ${c.data.error || ''}`;
  const e = await api('POST', '/enrollments', tokens.ana, { courseId: c.data.id });
  if (e.status !== 201) return `matricular → ${fmt(e)} ${e.data.error || ''}`;
  const pay = await waitFor(async () => (await api('GET', '/payments/me?status=PENDIENTE', tokens.ana)).data.find?.((p) => p.enrollment_id === e.data.id), 30000);
  if (!pay) return 'el evento enrollment.created no generó el cobro (payment-service)';
  const p = await api('POST', `/payments/${pay.id}/pay`, tokens.ana, { method: 'PSE' });
  if (p.status !== 200) return `pagar → ${fmt(p)} ${p.data.error || ''}`;
  const conf = await waitFor(async () => (await api('GET', '/enrollments/me', tokens.ana)).data.find?.((x) => x.id === e.data.id && x.status === 'CONFIRMADA'), 30000);
  if (!conf) return 'el evento payment.completed no confirmó la matrícula (saga incompleta)';
  const notif = await waitFor(async () => (await api('GET', '/notifications/me', tokens.ana)).data.some?.((n) => n.message.includes(code)), 20000);
  if (!notif) return 'notification-service no registró el aviso de la matrícula';
  return null;
}

// Inyección y liberación de cada tipo de falla
const FAULTS = {
  // kill -9 -1 = SIGKILL a todos los procesos del contenedor salvo el PID 1 (tini), que sale con el código del hijo
  // (en los microservicios se ejecuta como el usuario `node`: root no puede, porque el contenedor no tiene CAP_KILL [ISO])
  kill: { inject: (t) => { tryDocker('exec', ...(t.svc === 'rabbitmq' ? ['-u', 'root'] : []), t.container, 'kill', '-9', '-1'); }, release: async () => {} },
  stop: { inject: (t) => docker('stop', '-t', '2', t.container), release: (t) => docker('start', t.container) },
  pause: { inject: (t) => docker('pause', t.container), release: (t) => docker('unpause', t.container) },
  network: {
    inject: (t) => t.nets.forEach((n) => docker('network', 'disconnect', n, t.container)),
    release: (t) => t.nets.forEach((n) => tryDocker('network', 'connect', '--alias', t.svc, n, t.container)),
  },
};
let active = null; // falla en curso, para limpiarla si el script se interrumpe
async function cleanup() {
  if (!active) return;
  const { t, mode } = active; active = null;
  console.log(C.y(`\n⚠ Restaurando ${t.container} (${mode})…`));
  try { await FAULTS[mode].release(t); } catch {}
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

async function round(t, mode, n, total) {
  const res = { target: t.svc, zone: t.zone, mode, checks: [], mttr: null, pass: true };
  const check = (phase, name, cond, detail = '', { soft = false } = {}) => {
    const status = cond ? 'ok' : soft ? 'info' : 'fail';
    res.checks.push({ phase, name, status, detail });
    if (status === 'fail') res.pass = false;
    console.log(`   ${cond ? C.g('✔') : soft ? C.y('•') : C.r('✘')} ${C.d(`[${phase}]`)} ${name} ${C.d(detail)}`);
  };
  console.log(C.b(`\n🐒 [${n}/${total}] ${mode.toUpperCase()} → ${t.container}  (zona ${t.zone})`));

  // 1) Estado estable
  const stable = await waitAllHealthy();
  check('antes', 'todos los contenedores healthy', !!stable);
  if (!stable) return res;
  if (!(await waitFor(login, 30000))) { check('antes', 'login de cuentas de prueba', false); return res; }
  const before = (await api('GET', '/enrollments/me', tokens.ana)).data;
  const beforeCount = Array.isArray(before) ? before.length : null;
  const rc0 = restarts(t.container);

  // 2) Soltar el mono
  const t0 = Date.now();
  active = { t, mode };
  try { FAULTS[mode].inject(t); } catch (e) { check('falla', `inyectar ${mode}`, false, e.message); active = null; return res; }
  console.log(C.y(`   💥 falla inyectada (${mode})`));

  // 3) Radio de impacto mientras dura la falla
  const isGateway = t.svc === 'api-gateway';
  const strict = mode !== 'kill'; // con kill el contenedor revive en ~1 s: lo observado durante la falla es informativo
  await sleep(mode === 'kill' ? 300 : 1500);
  if (isGateway) {
    const r = await api('GET', '/courses', tokens.ana, null, { timeout: 12000 });
    check('durante', 'sin gateway no hay entrada al sistema (esperado)', !ok(r), fmt(r), { soft: !strict });
  } else {
    const results = await Promise.all(Object.entries(PROBES).map(async ([svc, probe]) => [svc, await probe()]));
    for (const [svc, r] of results) {
      if (svc === t.svc) {
        check('durante', `${svc} (atacado) falla de forma controlada: 5xx en < 12 s, sin colgarse`,
          r.status >= 500 && r.ms < 12000, fmt(r), { soft: !strict });
      } else {
        check('durante', `${svc} sigue respondiendo`, ok(r), fmt(r));
      }
    }
    if (t.dashboard) {
      const d = await api('GET', '/dashboard', tokens.ana);
      check('durante', 'API Composition /dashboard degrada en vez de caerse', ok(d) && d.data.degraded?.includes(t.svc),
        `${fmt(d)} degraded=${JSON.stringify(d.data.degraded)}`, { soft: !strict });
    }
  }
  if (mode !== 'kill') await sleep(Math.max(0, HOLD - (Date.now() - t0)));

  // 4) Recuperación
  const tr = Date.now();
  try { await FAULTS[mode].release(t); } catch (e) { check('recuperación', `liberar ${mode}`, false, e.message); }
  active = null;
  const healed = await waitFor(async () => health(t.container) === 'healthy' && (mode !== 'kill' || restarts(t.container) > rc0), RECOVER_TIMEOUT, 500);
  res.mttr = healed ? (Date.now() - (mode === 'kill' ? t0 : tr)) / 1000 : null;
  if (mode === 'kill') check('recuperación', 'Docker lo reinició solo (restart: unless-stopped)', restarts(t.container) > rc0, `reinicios ${rc0} → ${restarts(t.container)}`);
  check('recuperación', `${t.container} vuelve a healthy`, !!healed, healed ? `MTTR ${res.mttr.toFixed(1)} s` : `no se recuperó en ${RECOVER_TIMEOUT / 1000} s`);
  if (!healed && mode === 'kill') tryDocker('start', t.container);

  // 5) Integridad posterior
  check('después', 'todos los contenedores healthy', !!(await waitAllHealthy()));
  if (t.svc === 'rabbitmq' || isGateway) await sleep(5000); // tiempo para reconectar consumidores / abrir puerto
  if (isGateway) {
    const g = await waitFor(async () => ok(await api('GET', '/health', null, null, { base: ORIGIN })), 30000);
    check('después', 'gateway acepta tráfico de nuevo', !!g);
  }
  for (const [svc, probe] of Object.entries(PROBES)) {
    // hasta 30 s: el circuit breaker interno puede seguir abierto 10 s tras la caída
    let last;
    const good = await waitFor(async () => ok((last = await probe())), 30000);
    check('después', `${svc} responde`, !!good, good ? '' : fmt(last));
  }
  const after = (await api('GET', '/enrollments/me', tokens.ana)).data;
  if (beforeCount !== null) check('después', 'datos persistidos (volumen): no se perdieron matrículas', Array.isArray(after) && after.length >= beforeCount, `${beforeCount} → ${after?.length}`);
  if (SAGA) {
    const err = await sagaProbe();
    check('después', 'saga end-to-end por eventos (matrícula → pago → confirmación → aviso)', !err, err || '');
  }
  console.log(res.pass ? C.g('   ✔ RONDA OK') : C.r('   ✘ RONDA FALLIDA'));
  return res;
}

function writeReport(results, started) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.join(REPORT_DIR, `chaos-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ started, seed: opt('seed') ?? null, results }, null, 2));
  const rows = results.map((r) => `| ${r.target} | ${r.zone} | ${r.mode} | ${r.mttr != null ? r.mttr.toFixed(1) + ' s' : '-'} | ${r.checks.filter((c) => c.status === 'ok').length}/${r.checks.length} | ${r.pass ? '✅ OK' : '❌ FALLA'} |`);
  const fails = results.flatMap((r) => r.checks.filter((c) => c.status === 'fail').map((c) => `- **${r.target} / ${r.mode}** [${c.phase}] ${c.name}: ${c.detail}`));
  const md = [`# Test del mono: ${started.toLocaleString()}`, '',
    `Rondas: ${results.length} · OK: ${results.filter((r) => r.pass).length} · Fallidas: ${results.filter((r) => !r.pass).length}`, '',
    '| Contenedor | Zona | Falla | MTTR | Verificaciones | Resultado |', '|---|---|---|---|---|---|', ...rows, '',
    ...(fails.length ? ['## Fallas', ...fails] : ['Sin fallas.'])].join('\n');
  fs.writeFileSync(`${base}.md`, md);
  return `${base}.md`;
}

(async () => {
  try { docker('info', '--format', '{{.ServerVersion}}'); } catch { console.error(C.r('Docker no está disponible. Abre Docker Desktop.')); process.exit(2); }
  const missing = TARGETS.filter((t) => !inspect(t.container, '{{.Name}}'));
  if (missing.length) { console.error(C.r(`Faltan contenedores: ${missing.map((t) => t.container).join(', ')}. Ejecuta: docker compose up -d --build --wait`)); process.exit(2); }

  let plan = targets.flatMap((t) => MODES.map((m) => [t, m]));
  if (RANDOM > 0) plan = Array.from({ length: RANDOM }, () => [targets[Math.floor(rnd() * targets.length)], MODES[Math.floor(rnd() * MODES.length)]]);
  const started = new Date();
  console.log(C.b(`Test del mono: ${plan.length} ronda(s) · modos ${MODES.join(', ')} · falla de ${HOLD / 1000} s${RANDOM ? ` · semilla ${opt('seed', '(aleatoria)')}` : ''}`));

  const results = [];
  for (let i = 0; i < plan.length; i++) {
    try { results.push(await round(plan[i][0], plan[i][1], i + 1, plan.length)); }
    catch (e) { await cleanup(); results.push({ target: plan[i][0].svc, zone: plan[i][0].zone, mode: plan[i][1], checks: [{ phase: 'error', name: e.message, status: 'fail', detail: '' }], mttr: null, pass: false }); console.log(C.r(`   ✘ error: ${e.message}`)); }
  }

  console.log(C.b('\n════════ RESUMEN ════════'));
  console.table(results.map((r) => ({ contenedor: r.target, falla: r.mode, MTTR: r.mttr != null ? `${r.mttr.toFixed(1)} s` : '-', resultado: r.pass ? 'OK' : 'FALLA' })));
  const file = writeReport(results, started);
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed ? C.r(`✘ ${failed} de ${results.length} rondas fallaron`) : C.g(`✔ Las ${results.length} rondas pasaron: el sistema resiste al mono`));
  console.log(C.d(`Reporte: ${file}`));
  process.exit(failed ? 1 : 0);
})();
