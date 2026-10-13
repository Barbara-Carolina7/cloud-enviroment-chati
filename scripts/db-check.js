// npm run db:check — valida que la credencial de Postgres/Supabase funcione (solo SELECT, no modifica nada).
//
// Uso:
//   npm run db:check                                   usa DATABASE_URL (variable o local/.env)
//   npm run db:check -- "postgresql://user:pass@host:5432/postgres"
// Para un Postgres sin SSL (local): DATABASE_SSL=false en local/.env.
// Exit code: 0 = credencial válida, 1 = falló, 2 = falta configuración.
import pg from 'pg'
import { dbConfig } from './lib/config.js'

const EXPECTED_TABLES = ['products', 'report_requests']
const TIMEOUT_MS = 8000

if (process.argv[2]) process.env.DATABASE_URL = process.argv[2]
if (!process.env.DATABASE_URL) {
  console.error('Falta la connection string. Define DATABASE_URL (o local/.env) o pásala como argumento.')
  process.exit(2)
}
const db = dbConfig()

const client = new pg.Client({
  connectionString: db.url,
  ssl: db.ssl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: TIMEOUT_MS,
})

console.log(`Destino: ${db.label}`) // nunca se imprime la contraseña
const started = Date.now()

try {
  await client.connect()
  const who = await client.query('SELECT current_user AS usr, current_database() AS db, version() AS ver')
  const { usr, db: dbName, ver } = who.rows[0]
  console.log(`OK  credencial válida (${Date.now() - started} ms)`)
  console.log(`    usuario: ${usr} | base: ${dbName}`)
  console.log(`    ${ver.split(',')[0]}`)

  const found = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
    [EXPECTED_TABLES],
  )
  const present = new Set(found.rows.map((r) => r.table_name))
  for (const t of EXPECTED_TABLES) {
    console.log(`    tabla ${t}: ${present.has(t) ? 'existe' : 'NO existe (la crea el BFF al arrancar, o npm run db:schema)'}`)
  }
} catch (err) {
  const text = `${err.code ?? ''} ${err.message}`
  console.error(`FALLÓ  ${err.code ? `[${err.code}] ` : ''}${err.message}`)
  if (/password authentication failed|28P01/.test(text)) {
    console.error('    La contraseña o el usuario no son correctos (¿se rotó la contraseña?).')
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(text)) {
    console.error('    No se pudo alcanzar el host: revisa red, host y puerto (pooler 5432 / 6543).')
  }
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
