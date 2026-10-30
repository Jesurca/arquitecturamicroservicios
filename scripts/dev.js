// Arranca todos los microservicios como procesos locales (sin Docker). Requiere RabbitMQ en localhost:5672.
const { spawn } = require('child_process');
const path = require('path');
const services = ['auth', 'student', 'teacher', 'course', 'enrollment', 'payment', 'notification'].map((s) => `services/${s}/index.js`).concat('gateway/index.js');
const procs = services.map((f) => {
  const name = f.split('/')[f.startsWith('gateway') ? 0 : 1];
  const p = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', f)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const pipe = (s) => s.on('data', (d) => d.toString().trimEnd().split('\n').forEach((l) => console.log(l)));
  pipe(p.stdout); pipe(p.stderr);
  p.on('exit', (c) => console.log(`✖ ${name} terminó (código ${c})`));
  return p;
});
console.log('\n▶ Plataforma académica iniciando… abre http://localhost:8080 cuando veas "api-gateway escuchando"\n');
const stop = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
