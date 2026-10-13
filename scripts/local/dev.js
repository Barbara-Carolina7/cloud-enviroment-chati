// npm run local:dev — levanta OIDC falso + BFF + front, con las variables de entorno ya resueltas.
// Ctrl+C detiene los tres. Requiere antes: npm run local:up && npm run local:init
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {
  LOCALSTACK_URL,
  OIDC_ISSUER,
  OIDC_PORT,
  REGION,
  TOPIC_ARN,
  dbConfig,
  paths,
} from '../lib/config.js'
import { gradlew, run, waitForPort } from '../lib/proc.js'

const isWindows = process.platform === 'win32'
const db = dbConfig()
const children = []
let stopping = false

// El front lee estas variables de su archivo .env.development.local (solo aplica a `vite` en desarrollo).
// Se crea si falta, para que el proyecto sea reproducible en otra máquina.
const frontEnv = path.join(paths.front, '.env.development.local')
if (!existsSync(frontEnv)) {
  writeFileSync(
    frontEnv,
    [
      `VITE_OIDC_AUTHORITY=${OIDC_ISSUER}`,
      'VITE_OIDC_CLIENT_ID=local-client',
      'VITE_OIDC_REDIRECT_URI=http://localhost:5173/',
      'VITE_API_BASE=',
      '',
    ].join('\n'),
  )
  console.log(`Creado ${path.relative(process.cwd(), frontEnv)}`)
}

if (!existsSync(path.join(paths.front, 'node_modules'))) {
  console.log('Instalando dependencias del front...')
  await run('npm', ['ci'], { cwd: paths.front })
}

try {
  await fetch(`${LOCALSTACK_URL}/_localstack/health`)
} catch {
  console.warn('AVISO: LocalStack no responde. Sin él el BFF no podrá publicar informes.')
  console.warn('       Ejecuta: npm run local:up && npm run local:init\n')
}

function start(name, color, command, args, options = {}) {
  const child = spawn(command, args, {
    shell: isWindows,
    detached: !isWindows, // grupo propio en Unix: se puede terminar todo el árbol (gradle lanza una JVM)
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  const tag = `\x1b[${color}m[${name}]\x1b[0m`
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => console.log(`${tag} ${line}`))
  }
  child.on('error', (err) => {
    console.error(`${tag} no se pudo iniciar: ${err.message}`)
    shutdown(1)
  })
  child.on('exit', (code) => {
    console.log(`${tag} terminó (código ${code})`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

function killTree(child) {
  if (child.exitCode !== null || !child.pid) return
  if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // ya terminó
    }
  }
}

function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  console.log('\nDeteniendo procesos...')
  children.forEach(killTree)
  setTimeout(() => process.exit(code), 1500)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// 1. OIDC falso (los otros dos dependen de él)
start('oidc', 35, process.execPath, [paths.mockOidc])
await waitForPort(OIDC_PORT).catch((e) => {
  console.error(e.message)
  shutdown(1)
})

// 2. BFF contra LocalStack, la base local y el OIDC falso
const bffEnv = {
  ...process.env,
  SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI: OIDC_ISSUER,
  AWS_ENDPOINT_URL: LOCALSTACK_URL,
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_REGION: REGION,
  SNS_TOPIC_ARN: TOPIC_ARN,
  DB_URL: db.jdbcUrl,
  DB_USER: db.user,
}
// Windows no admite variables de entorno vacías: sin clave, el BFF usa su valor por defecto (vacío).
if (db.password) bffEnv.DB_PASSWORD = db.password
start('bff', 33, gradlew(), ['bootRun'], { cwd: paths.bff, env: bffEnv })

// 3. Front (Vite, con proxy de /api hacia el BFF)
start('front', 36, 'npm', ['run', 'dev'], { cwd: paths.front })

console.log(`
  Front : http://localhost:5173
  BFF   : http://localhost:8080
  OIDC  : ${OIDC_ISSUER}  (entra solo como admin)
  Base  : ${db.label}
  Ctrl+C para detener todo.
`)
