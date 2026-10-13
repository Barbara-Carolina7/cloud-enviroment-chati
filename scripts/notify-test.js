// npm run notify:test — envía un aviso de prueba a la API de notificaciones (POST /saas/notices).
// Sirve para validar la URL base y la API key SIN pasar por AWS, y para encontrar la URL correcta.
//
// Lee del .env de la raíz (o del entorno):
//   API_NOTIFICATION       URL del sitio de la app (con o sin "/" final); se le agrega /api/saas/notices
//   API_TOKEN_INTEGRATION  API key (crr_...). Nunca se imprime.
//
// Uso:
//   npm run notify:test
//   npm run notify:test -- "Texto del aviso"
//   npm run notify:test -- --base https://api.ejemplo.com          # prueba otra URL base sin editar el .env
//   npm run notify:test -- --base https://api.ejemplo.com "Texto"
//   npm run notify:test -- --dry-run                               # muestra qué enviaría, sin enviarlo
// Exit code: 0 = aviso aceptado (2xx), 1 = la API lo rechazó o no respondió, 2 = falta configuración.
import './lib/config.js' // carga local/.env y .env

const TIMEOUT_MS = 10000
const MAX_TEXT = 2000

const args = process.argv.slice(2)
let base = process.env.API_NOTIFICATION
let dryRun = false
const words = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base') base = args[++i]
  else if (args[i] === '--dry-run') dryRun = true
  else words.push(args[i])
}

const token = process.env.API_TOKEN_INTEGRATION
const missing = [!base && 'API_NOTIFICATION', !token && 'API_TOKEN_INTEGRATION'].filter(Boolean)
if (missing.length) {
  console.error(`Falta configuración: ${missing.join(', ')}. Defínelas en el .env de la raíz (o en el entorno).`)
  process.exit(2)
}

let url
try {
  // La API publica en /api/saas/notices; la base puede ser el sitio o ya incluir /api (no se duplica).
  const root = base.trim().replace(/\/+$/, '')
  url = new URL(`${/\/api$/i.test(root) ? root : `${root}/api`}/saas/notices`)
} catch {
  console.error('API_NOTIFICATION no es una URL válida (ej. https://api.ejemplo.com).')
  process.exit(2)
}

const text = (words.join(' ') || `Prueba de notificación desde notify-test (${new Date().toISOString()})`).trim()
if (text.length < 1 || text.length > MAX_TEXT) {
  console.error(`El texto debe tener entre 1 y ${MAX_TEXT} caracteres (tiene ${text.length}).`)
  process.exit(2)
}

console.log(`POST ${url.origin}${url.pathname}`)
console.log(`Authorization: ApiKey ${'*'.repeat(8)} (token de ${token.length} caracteres, no se muestra)`)
console.log(`Texto (${text.length} caracteres): ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`)
if (dryRun) {
  console.log('\n--dry-run: no se envió nada.')
  process.exit(0)
}

let res
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    redirect: 'manual', // un redirect convertiría el POST en GET y ocultaría el problema
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
} catch (err) {
  const reason = err.cause?.code ?? err.name
  console.error(`\nFALLÓ  no se pudo conectar: ${reason} ${err.cause?.message ?? err.message}`)
  if (reason === 'ENOTFOUND') console.error('       El dominio no existe: revisa la URL base.')
  if (reason === 'TimeoutError') console.error(`       Sin respuesta en ${TIMEOUT_MS / 1000} s.`)
  process.exit(1)
}

const contentType = res.headers.get('content-type') ?? ''
const raw = await res.text().catch(() => '')
const preview = raw.replace(/\s+/g, ' ').slice(0, 300)
console.log(`\nHTTP ${res.status} ${res.statusText} | content-type: ${contentType || '(ninguno)'}`)
if (preview) console.log(`Respuesta: ${preview}`)

if (res.ok && !/json/i.test(contentType)) {
  console.error('\nFALLÓ  respondió 2xx pero no es JSON: el aviso probablemente no se creó (¿es el sitio web y no la API?).')
  process.exit(1)
}

if (res.ok) {
  let item
  try {
    item = JSON.parse(raw)?.item
  } catch {
    // la respuesta no era JSON
  }
  console.log(`\nOK  aviso aceptado${item?.id ? ` (id ${item.id})` : ''}. Revísalo en tu app.`)
  process.exit(0)
}

console.error('\nFALLÓ  la API no aceptó el aviso.')
const looksLikeHtml = /text\/html/i.test(contentType) || /^\s*</.test(raw)
if (res.status >= 300 && res.status < 400) {
  console.error(`       Redirección a ${res.headers.get('location') ?? '(sin Location)'}: usa ese destino, sin el /api/saas/notices final, como base (un redirect convierte el POST en GET y rompe el envío).`)
} else if (looksLikeHtml) {
  console.error('       Respondió una página HTML, no la API: revisa la URL base (debe ser el sitio de la app, p. ej. https://TU-APP/).')
} else if (res.status === 401 || res.status === 403) {
  console.error('       La API key no es válida o no tiene permiso (header "Authorization: ApiKey …").')
} else if (res.status === 404) {
  console.error('       La ruta /api/saas/notices no existe en esa base: la URL base es otra.')
} else if (res.status === 400 || res.status === 422) {
  console.error('       La API entendió la petición pero rechazó el cuerpo: el texto debe ser {"text": "..."} de 1 a 2000 caracteres.')
}
process.exit(1)
