// npm run db:schema — crea la tabla report_requests en tu Postgres local (no hace falta psql).
// Si el BFF local apunta a la misma base, él la crea solo al arrancar y esto no es necesario.
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { dbConfig, paths, pgSsl } from '../lib/config.js'

const db = dbConfig()
const client = new pg.Client({ connectionString: db.url, ssl: pgSsl(db), connectionTimeoutMillis: 8000 })
try {
  await client.connect()
  await client.query(readFileSync(paths.schema, 'utf8'))
  console.log(`OK  report_requests lista en ${db.label}`)
} catch (err) {
  console.error(`FALLÓ  ${err.code ? `[${err.code}] ` : ''}${err.message}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
