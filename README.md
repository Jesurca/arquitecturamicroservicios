# Plataforma de Gestión Académica Universitaria: Microservicios

Taller de arquitectura de microservicios (Proyecto 1). 7 microservicios + API Gateway + RabbitMQ, con interfaz web.

## Opción A: Docker (recomendada)
```bash
docker compose up -d --build --wait
```
Abre **http://localhost:8080**. Consola de RabbitMQ: http://localhost:15672 (guest / guest).
Para detener: `Ctrl+C` y `docker compose down` (añade `-v` para borrar las bases de datos).

## Opción B: sin Docker
Requisitos: **Node.js ≥ 22.5** y **RabbitMQ** en `localhost:5672` (`docker run -p 5672:5672 rabbitmq:3-alpine` es la forma más rápida).
```bash
npm install
npm start          # lanza los 8 procesos; abre http://localhost:8080
npm run smoke      # (en otra terminal) prueba end-to-end: 33 verificaciones
```

## Arquitectura de contenedores (`docs/Taller arquitectura.png`)
9 contenedores (`pa-*`) repartidos en las zonas del diagrama:

| Red (driver bridge) | Zona del diagrama | Contenedores |
|---|---|---|
| `pa-edge-net` | Cliente → Proxy | api-gateway (puerto 8080), rabbitmq (solo consola 15672) |
| `pa-saga-net` (internal) | Aggregator y Saga Pattern | enrollment, student, course, teacher, rabbitmq, api-gateway |
| `pa-domain-net` (internal) | Dominio y Mensajería Branch Pattern | auth, payment, notification, rabbitmq, api-gateway |

Las dos zonas no pueden llamarse por HTTP entre sí: solo se comunican por eventos a través de RabbitMQ o pasando por el gateway. Las redes `internal` no tienen salida a internet.

Los 6 bloques de cada contenedor del diagrama:
| Bloque | Implementación en `docker-compose.yml` |
|---|---|
| **NET** | redes de la zona + alias DNS (`course-service`, …) |
| **ISO** | usuario `node` (no root), FS de solo lectura, `cap_drop: ALL`, `no-new-privileges`, límites de 256 MB RAM, 0.5 CPU y 100 PIDs |
| **Config** | `env_file`: `config/common.env` + `config/<servicio>.env` |
| **Bridge** | redes `driver: bridge` con subred propia (172.30.x.0/24) |
| **Data** | volumen con nombre por servicio (`auth-db`, `course-db`, …) montado en `/data` |
| **Disk** | `/tmp` en tmpfs de 16 MB + logs rotados (3 × 10 MB) |

## Test del mono (Chaos Monkey)
Con los contenedores arriba (`docker compose up -d --build --wait`):
```bash
npm run chaos            # los 9 contenedores × 4 fallas (kill, stop, pause, network)
npm run chaos:kill       # solo crash + autocuración, a cada contenedor
npm run chaos:random     # 5 ataques al azar
node scripts/chaos.js --target course-service --mode pause --hold 15
node scripts/chaos.js --help
```
Cada ronda verifica el **estado estable**, el **radio de impacto** (solo cae el servicio atacado y responde 503 rápido), la **recuperación** (MTTR) y la **integridad** (APIs, saga completa por eventos y datos persistidos). Deja un reporte en `reports/chaos-<fecha>.md` y `.json`, y devuelve código de salida 1 si alguna ronda falla. En GitHub corre solo con `.github/workflows/chaos.yml`.

## Cuentas de demostración
| Rol | Correo | Contraseña |
|---|---|---|
| Estudiante | estudiante1@uni.edu (Ana), estudiante2@uni.edu (Luis), estudiante3@uni.edu (Sofía) | estudiante123 |
| Docente | docente1@uni.edu (Dra. Ríos: MAT101, MAT210), docente2@uni.edu (Ing. Pérez: SIS201, SIS305) | docente123 |
| Administración | admin@uni.edu | admin123 |

## Servicios
| Servicio | Puerto | Responsabilidad | Base de datos propia |
|---|---|---|---|
| api-gateway | 8080 | Entrada única, JWT, rate limit, composición, UI | - |
| auth-service | 3001 | Login, JWT, roles, usuarios | `auth-service.db` |
| student-service | 3002 | Datos maestros de estudiantes | `student-service.db` |
| teacher-service | 3003 | Docentes y calificaciones | `teacher-service.db` |
| course-service | 3004 | Oferta académica y cupos | `course-service.db` |
| enrollment-service | 3005 | Matrículas (saga) | `enrollment-service.db` |
| payment-service | 3006 | Cobros y pasarela simulada | `payment-service.db` |
| notification-service | 3007 | Avisos por evento | `notification-service.db` |

## Cómo probar el flujo principal
1. Ingresa como **Ana** → *Cursos disponibles* → **Matricular** en Estructuras de Datos.
2. *Mis pagos* → **Pagar** (tarjeta `4242…` aprueba; una que termine en `0000` rechaza; 3 rechazos cancelan la matrícula y liberan el cupo).
3. La matrícula pasa a **confirmada**; revisa *Notificaciones*.
4. Ingresa como **Carlos (docente)** → *Mis cursos* → *Ver estudiantes* → registra una nota. Ana recibe un aviso.
5. Ingresa como **Administración** → *Estado del sistema* para ver los 8 servicios.
6. Matricula a dos estudiantes en **SIS305** (solo 2 cupos) y a un tercero: será rechazado por cupos agotados.

Variables útiles: `PAYMENT_TTL_SECONDS` (plazo de pago, por defecto 900 s), `JWT_SECRET`, `RABBIT_URL`.

## Ver los eventos fluir
En los logs verás líneas `evento publicado → enrollment.created`, `✉ [estudiante#1] Pago recibido…`, etc.

## Simplificaciones del taller (qué cambiaría en producción)
Monorepo con un `package.json` compartido (en producción, un repositorio/pipeline por servicio); SQLite por servicio (PostgreSQL gestionado); secreto JWT por defecto; pasarela de pago y envío de correo simulados; sin *outbox* transaccional (un fallo entre guardar y publicar puede perder un evento); sin trazas distribuidas.
