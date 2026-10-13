// Configuración compartida por todos los scripts. Carga local/.env si existe
// (las variables ya definidas en el entorno tienen prioridad sobre el archivo).
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const envFile = path.join(ROOT, 'local', '.env')
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile)
  } catch (err) {
    console.warn(`AVISO: no se pudo leer local/.env (${err.code ?? err.message}); se usan solo las variables del entorno.`)
  }
}

export const paths = {
  compose: path.join(ROOT, 'local', 'docker-compose.yml'),
  schema: path.join(ROOT, 'local', 'schema.sql'),
  bff: path.join(ROOT, 'bff'),
  front: path.join(ROOT, 'front'),
  recorder: path.join(ROOT, 'lambdas', 'pg', 'report-request-recorder'),
  generator: path.join(ROOT, 'lambdas', 'pg', 'report-generator'),
  mockOidc: path.join(ROOT, 'scripts', 'local', 'mock-oidc.js'),
}

export const REGION = 'us-east-2'
export const LOCALSTACK_URL = 'http://localhost:4566'
export const ACCOUNT_ID = '000000000000'
export const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:report-events`
export const OIDC_PORT = Number(process.env.MOCK_PORT ?? 9000)
export const OIDC_ISSUER = `http://localhost:${OIDC_PORT}`
export const MESSAGE_TYPE = 'report.requested'

export function fail(message) {
  console.error(message)
  process.exit(1)
}

// Interpreta DATABASE_URL (la única variable de base de datos que hay que definir) y deriva el resto.
// Nunca devuelve ni imprime la contraseña salvo en `password`, que solo se pasa a procesos hijos.
export function dbConfig() {
  const url = process.env.DATABASE_URL
  if (!url) {
    fail('Falta DATABASE_URL. Copia local/.env.example a local/.env y ajústalo (o define la variable).')
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail('DATABASE_URL no es una URL válida (postgresql://usuario[:clave]@host:5432/base).')
  }
  const user = decodeURIComponent(parsed.username)
  const password = decodeURIComponent(parsed.password)
  const port = parsed.port || '5432'
  return {
    url,
    ssl: process.env.DATABASE_SSL !== 'false',
    user,
    password,
    jdbcUrl: `jdbc:postgresql://${parsed.hostname}:${port}${parsed.pathname}`,
    // Dentro del contenedor de la Lambda, "localhost" es el propio contenedor: se apunta al host.
    lambdaUrl: url.replace(/(\/\/(?:[^@/]*@)?)(localhost|127\.0\.0\.1)/, '$1host.docker.internal'),
    label: `${user}@${parsed.hostname}:${port}${parsed.pathname}`,
  }
}

export function pgSsl(db) {
  return db.ssl ? { rejectUnauthorized: false } : false
}
