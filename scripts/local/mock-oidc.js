// npm run local:oidc — servidor OIDC falso que reemplaza a Cognito en pruebas locales.
// Inicia sesión automáticamente (sin pantalla de login) y emite tokens con los claims que usa el BFF:
//   email, sub, cognito:username y cognito:groups.
//
// Variables (opcionales, también en local/.env):
//   MOCK_PORT=9000  MOCK_EMAIL=admin@local.test  MOCK_SUB=local-admin-sub  MOCK_GROUPS=Admin   (lista separada por comas)
// Para probar el 403 de un no-admin: MOCK_GROUPS=Colaborador
import { OAuth2Server } from 'oauth2-mock-server'
import { OIDC_PORT } from '../lib/config.js'

const email = process.env.MOCK_EMAIL ?? 'admin@local.test'
const sub = process.env.MOCK_SUB ?? 'local-admin-sub'
const groups = (process.env.MOCK_GROUPS ?? 'Admin')
  .split(',')
  .map((g) => g.trim())
  .filter(Boolean)

const server = new OAuth2Server()
await server.issuer.keys.generate('RS256')

server.service.on('beforeTokenSigning', (token) => {
  Object.assign(token.payload, {
    sub,
    email,
    'cognito:username': email,
    'cognito:groups': groups,
  })
})

// 127.0.0.1 (IPv4, solo loopback): con 'localhost' Node puede enlazar solo a ::1 y un BFF con
// -Djava.net.preferIPv4Stack=true no lo alcanzaría. El issuer sigue siendo http://localhost:PORT.
await server.start(OIDC_PORT, '127.0.0.1')
console.log(`OIDC falso activo
  issuer : ${server.issuer.url}
  usuario: ${email} (sub ${sub})
  grupos : ${groups.join(', ') || '(ninguno)'}`)
