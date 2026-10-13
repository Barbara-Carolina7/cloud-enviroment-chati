# Guía paso a paso: arquitectura de informes y entorno local

Cómo replicar a mano todo lo que se construyó: la arquitectura en AWS, los cambios de código en cada repo y el entorno local para programar sin depender de la nube. Los identificadores van como marcadores (`<ACCOUNT_ID>`, `<EC2_IP>`…): sustitúyelos por los tuyos.

Convenciones: región `us-east-2`; comandos en bash (en Windows, usa Git Bash o WSL para la parte 2, o los equivalentes de PowerShell). La parte 5 (entorno local) tiene una vía automática con `npm run …` que funciona igual en Mac, Linux y Windows.

---

## 0. Qué se construyó

```
Front (React, login Cognito, rol Admin)
   │  POST /api/reports  (JWT)
   ▼
API Gateway (HTTP API) ──► BFF (Spring Boot en EC2)
                             ├─ CRUD de productos ──► Supabase Postgres (tabla products)
                             └─ publica {type:"report.requested", body:{…}}
                                          ▼
                                   SNS report-events   (filtro por type, sobre el cuerpo)
                          ┌───────────────┴────────────────┐
                          ▼                                ▼
                SQS report-requests (+DLQ)       SQS report-generation (+DLQ)
                          ▼                                ▼
            Lambda report-request-recorder       Lambda report-generator
            guarda en report_requests            lee los 10 productos más caros
                          ▼                      y publica un aviso en la API de avisos
                  Supabase Postgres  ◄───────────────────┘ (lee products)
```

Decisiones de diseño:
- **Dos colas independientes** desde un SNS maestro: guardar la solicitud y generar el informe no dependen entre sí.
- **La API cuelga de `/api`:** el endpoint es `POST /api/saas/notices`. `API_NOTIFICATION` es la URL del sitio (`https://TU-APP/`) y el código agrega `/api`; si ya termina en `/api`, no lo duplica. Sin ese prefijo, el nginx del sitio responde `405 Not Allowed` con una página HTML (así falló la primera vez). La Lambda detecta esas respuestas y falla con un mensaje claro; `npm run notify:test` también las diagnostica.
- **El informe es un aviso:** `report-generator` consulta los 10 productos más caros en Supabase y los publica con `POST {API_NOTIFICATION}/saas/notices` (`Authorization: ApiKey <token>`, cuerpo `{"text": "…"}`, de 1 a 2000 caracteres).
- **Filtro sobre el cuerpo del mensaje** (`FilterPolicyScope=MessageBody`), no sobre atributos: el `type` va dentro del JSON.
- **DLQ con 3 reintentos** en cada cola.
- **Un rol por Lambda** con permisos mínimos (logs + su cola).
- **El BFF no usa claves de AWS**: usa el rol de la instancia EC2.

### Contrato del mensaje (BFF → SNS)
```json
{
  "type": "report.requested",
  "body": {
    "requestId": "uuid generado por el BFF",
    "requester": "email del JWT (o cognito:username, o sub)",
    "requesterId": "sub del JWT",
    "reportType": "INVENTORY",
    "params": {},
    "requestedAt": "2026-10-13T06:00:00Z"
  }
}
```
Por SNS sin *raw delivery*, SQS recibe además un sobre: `{"Type":"Notification","Message":"<el JSON de arriba como string>",…}`. Las Lambdas lo desenvuelven.

### Tabla de destino
```sql
CREATE TABLE IF NOT EXISTS report_requests (
  id           varchar(255) PRIMARY KEY,
  requester    varchar(255),
  requester_id varchar(255),
  type         varchar(255),
  params       jsonb,
  requested_at timestamptz
);
```
En AWS la crea el BFF al arrancar (`ddl-auto=update`, entidad `ReportRequest`). Ese SQL es para crearla a mano.

---

## 1. Requisitos
- AWS CLI v2 con credenciales (`aws sts get-caller-identity` debe responder). Recomendado: un usuario IAM, no root.
- Node ≥ 20.12, Java 21, Docker (Docker Desktop en Mac/Windows).
- Un Postgres (Supabase en la nube; uno local para pruebas).
- Opcional: `gh` (GitHub CLI).

---

## 2. Infraestructura en AWS (a mano)

### 2.1 Variables
```bash
export AWS_REGION=us-east-2
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```
> En zsh, escribe siempre `${ACCOUNT_ID}` con llaves: `$ACCOUNT_ID:role` se interpreta como un modificador de variable y rompe el ARN.

### 2.2 SNS
```bash
TOPIC_ARN=$(aws sns create-topic --name report-events --query TopicArn --output text)
```

### 2.3 Colas SQS con DLQ, política para SNS y suscripción (repetir para las dos colas)
Las colas son `report-requests` y `report-generation`.
```bash
for Q in report-requests report-generation; do
  DLQ_URL=$(aws sqs create-queue --queue-name "$Q-dlq" --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)
  DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

  cat > "$Q-attrs.json" <<EOF
{"VisibilityTimeout":"90","MessageRetentionPeriod":"345600","RedrivePolicy":"{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"3\"}"}
EOF
  Q_URL=$(aws sqs create-queue --queue-name "$Q" --attributes "file://$Q-attrs.json" --query QueueUrl --output text)
  Q_ARN=$(aws sqs get-queue-attributes --queue-url "$Q_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

  # Permite que SNS escriba en la cola
  cat > "$Q-policy.json" <<EOF
{"Policy":"{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"sns.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$Q_ARN\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"$TOPIC_ARN\"}}}]}"}
EOF
  aws sqs set-queue-attributes --queue-url "$Q_URL" --attributes "file://$Q-policy.json"

  # Suscripción con filtro sobre el cuerpo
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$Q_ARN" \
    --attributes '{"FilterPolicy":"{\"type\":[\"report.requested\"]}","FilterPolicyScope":"MessageBody","RawMessageDelivery":"false"}'
done
```
El *visibility timeout* (90 s) debe ser mayor que el timeout de la Lambda (15 s).

### 2.4 Roles IAM de las Lambdas (mínimos)
```bash
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

for PAIR in report-request-recorder:report-requests report-generator:report-generation; do
  FN=${PAIR%%:*}; Q=${PAIR##*:}
  aws iam create-role --role-name "$FN-role" --assume-role-policy-document "$TRUST"
  aws iam attach-role-policy --role-name "$FN-role" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  aws iam put-role-policy --role-name "$FN-role" --policy-name "consume-$Q" --policy-document \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"sqs:ReceiveMessage\",\"sqs:DeleteMessage\",\"sqs:GetQueueAttributes\"],\"Resource\":\"arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:$Q\"}]}"
done
sleep 12   # propagación de IAM
```

### 2.5 Lambdas
```bash
# recorder (necesita la dependencia pg)
cd lambdas/pg/report-request-recorder && npm ci --omit=dev && zip -r ../recorder.zip . && cd ../../..
# generator (también necesita pg)
cd lambdas/pg/report-generator && npm ci --omit=dev && zip -r ../generator.zip . && cd ../../..

# La connection string va en un archivo (contiene comas y símbolos que rompen la sintaxis corta)
echo '{"Variables":{"DATABASE_URL":"postgresql://USUARIO:CLAVE@HOST:5432/postgres"}}' > env-recorder.json

aws lambda create-function --function-name report-request-recorder --runtime nodejs22.x \
  --handler index.handler --timeout 15 --memory-size 128 \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/report-request-recorder-role" \
  --zip-file fileb://lambdas/pg/recorder.zip --environment file://env-recorder.json

# generator: ahora también necesita pg y tres variables de entorno
echo '{"Variables":{"API_NOTIFICATION":"https://TU-API/","API_TOKEN_INTEGRATION":"crr_...","DATABASE_URL":"postgresql://USUARIO:CLAVE@HOST:5432/postgres"}}' > env-generator.json
aws lambda create-function --function-name report-generator --runtime nodejs22.x \
  --handler index.handler --timeout 15 --memory-size 128 \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/report-generator-role" \
  --zip-file fileb://lambdas/pg/generator.zip --environment file://env-generator.json

# Triggers SQS → Lambda
aws lambda create-event-source-mapping --function-name report-request-recorder --batch-size 5 \
  --event-source-arn "arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:report-requests"
aws lambda create-event-source-mapping --function-name report-generator --batch-size 5 \
  --event-source-arn "arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:report-generation"
rm env-recorder.json env-generator.json   # no dejes secretos en disco
```

### 2.6 Permiso del BFF para publicar
El BFF corre en la EC2 y usa el rol de su instance profile (`<ROL_EC2>`):
```bash
aws iam put-role-policy --role-name <ROL_EC2> --policy-name publish-report-events --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sns:Publish\",\"Resource\":\"$TOPIC_ARN\"}]}"
```
Si el BFF corre en un contenedor Docker, el metadata de la instancia debe aceptar 2 saltos de red o el contenedor no obtendrá credenciales:
```bash
aws ec2 describe-instances --instance-ids <INSTANCE_ID> --query 'Reservations[].Instances[].MetadataOptions.HttpPutResponseHopLimit'
aws ec2 modify-instance-metadata-options --instance-id <INSTANCE_ID> --http-put-response-hop-limit 2   # solo si no es ≥ 2
```

### 2.7 Prueba de humo en la nube
```bash
aws sns publish --topic-arn "$TOPIC_ARN" --message '{"type":"report.requested","body":{"requestId":"smoke-1","requester":"test@example.com","requesterId":"sub-test","reportType":"SMOKE_TEST","params":{},"requestedAt":"2026-01-01T00:00:00Z"}}'
aws logs tail /aws/lambda/report-generator --since 5m
aws logs tail /aws/lambda/report-request-recorder --since 5m
```
Si el recorder falla con `relation "report_requests" does not exist`, la tabla aún no existe (la crea el BFF al arrancar con el código nuevo, o ejecuta el SQL de la parte 0). Los mensajes fallidos terminan en `report-requests-dlq` tras 3 intentos; límpiala con `aws sqs purge-queue`.

### 2.8 Si migras desde la arquitectura anterior (limpieza)
La versión previa usaba SNS `transporte`, SQS `miCola` y las Lambdas `miReceptor`, `productsCatalog` y `eventProcExample`. Para retirarla, después de comprobar que lo nuevo funciona:
1. Quita del API Gateway las rutas `/productos` y `/event/proc/example` y sus integraciones (`aws apigatewayv2 delete-route`, `delete-integration`).
2. Borra los *event source mappings* **antes** que las funciones, luego las funciones y sus log groups.
3. Borra la cola y el topic antiguos, y los roles de servicio de esas Lambdas (con sus políticas).
4. Si ya no usas DynamoDB, elimina la tabla y limpia el rol de la EC2.

---

## 3. Cambios de código por repositorio

### 3.1 BFF (`cloud-chati-bff`, Spring Boot)
1. **`build.gradle`:** agrega `software.amazon.awssdk:sns` (el BOM del SDK ya está importado) y `com.fasterxml.jackson.core:jackson-databind`.
2. **`application.properties`:**
   ```properties
   aws.sns.topic-arn=${SNS_TOPIC_ARN:arn:aws:sns:us-east-2:<ACCOUNT_ID>:report-events}
   aws.region=${AWS_REGION:us-east-2}
   spring.datasource.password=${DB_PASSWORD:}
   ```
   (el valor por defecto vacío de `DB_PASSWORD` permite una base local sin clave y evita variables vacías en Windows).
3. **Archivos nuevos:** `config/SnsConfig` (bean `SnsClient`, sin claves), y el paquete `reports/`: `ReportController`, `ReportService`, `ReportEventPublisher`, `dto/ReportRequestDto`, `dto/ReportResponseDto`, `entity/ReportRequest`.
4. **Comportamiento clave:**
   - `POST /api/reports` con `@PreAuthorize("hasRole('Admin')")` → responde **202** con `requestId`.
   - El solicitante sale del JWT: `email` → `cognito:username` → `sub`.
   - El publisher serializa `{type:"report.requested", body:{…}}` con su propio `ObjectMapper` y publica en SNS **sin atributos de mensaje**.
   - El rol sale del claim `cognito:groups`, que el conversor existente ya convierte en `ROLE_<grupo>`.
5. Compila: `./gradlew compileJava`.

### 3.2 Lambdas (`cloud-lambda-pg`)
Estructura final:
```
lambdas/pg/
├── report-request-recorder/   index.js, package.json (pg)
├── report-generator/          index.js, src/{handler,report.service,notifier}.js
└── .github/workflows/         deploy-report-request-recorder.yml, deploy-report-generator.yml
```
- **recorder:** por cada registro SQS, desenvuelve el sobre SNS, exige `type === "report.requested"` y ejecuta `INSERT … ON CONFLICT (id) DO NOTHING` con `$5::jsonb` (idempotente: SQS entrega "al menos una vez"). Conexión con `ssl: {rejectUnauthorized:false}` salvo `DATABASE_SSL=false`.
- **generator:** capas `handler → report.service → product.repository / notifier`.
  - `product.repository.js`: `SELECT id, name, price, stock FROM products WHERE price IS NOT NULL ORDER BY price DESC LIMIT 10` (dependencia `pg`).
  - `report.service.js`: valida la solicitud y arma el texto: un encabezado con el tipo y el solicitante, y una línea por producto (`1. Nombre - $precio (stock N)`), recortado a 2000 caracteres.
  - `notifier.js`: `POST {API_NOTIFICATION}/api/saas/notices` con `Authorization: ApiKey {API_TOKEN_INTEGRATION}`, con `redirect: "manual"` (un redirect convertiría el POST en GET). Solo un **2xx con JSON** cuenta como entregado; una redirección, una página HTML, un código distinto de 2xx o variables faltantes **lanzan error**: el mensaje se reintenta y, tras 3 intentos, queda en la DLQ en vez de perderse. Con `NOTIFY_MODE=log` (solo desarrollo local) imprime el aviso sin publicarlo. El token nunca se escribe en los logs.
  - Variables de entorno de la Lambda: `API_NOTIFICATION`, `API_TOKEN_INTEGRATION`, `DATABASE_URL`.
- Ambas lanzan error ante cualquier fallo: SQS reintenta y, tras 3 intentos, manda a la DLQ.

### 3.3 Front (`cloud-s3-chati`, React + Vite + `react-oidc-context`)
1. **`src/config.ts`:** `API_BASE = import.meta.env.VITE_API_BASE ?? '<URL del API Gateway>'`.
2. **`src/main.tsx`:** `authority`, `client_id` y `redirect_uri` desde `VITE_OIDC_*`, con los valores de Cognito como respaldo (producción no cambia).
3. **`src/components/ReportRequestPanel.tsx`:** selector de tipo + botón "Solicitar informe" → `POST {API_BASE}/api/reports` con `Authorization: Bearer <id_token>`; muestra el `requestId` o el error (403 si no es Admin).
4. **`src/pages/DashboardPage.tsx`:** muestra el panel solo si `cognito:groups` incluye `Admin`.
5. **`vite.config.ts`:** proxy de `/api` → `http://localhost:8080` agregando el header `X-Secret-Gateway` (solo en `npm run dev`).
6. **Solo local:** `front/.env.development.local` con `VITE_OIDC_AUTHORITY=http://localhost:9000`, `VITE_OIDC_CLIENT_ID=local-client`, `VITE_OIDC_REDIRECT_URI=http://localhost:5173/`, `VITE_API_BASE=`. Está ignorado por git y nunca entra al build de producción.
7. Verifica: `npm run build`.

---

## 4. Secrets y orden de despliegue

### 4.1 Secrets de GitHub por repo
| Repo | Secrets / variables |
|---|---|
| BFF | `GH_CR_PAT`, `EC2_SSH_KEY`, `API_GATEWAY_SECRET`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD`; variable `TARGET_HOST_IP` (la IP **vigente** de la EC2) |
| Lambdas | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=us-east-2`, `LAMBDA_RECORDER_FUNCTION_NAME=report-request-recorder`, `LAMBDA_GENERATOR_FUNCTION_NAME=report-generator`, **`API_NOTIFICATION`** (URL base de la API de avisos), **`API_TOKEN_INTEGRATION`** (API key `crr_…`), **`DATABASE_URL`** (la de Supabase) |
| Front | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_NAME`, `CLOUDFRONT_DISTRIBUTION_ID` |

Los secrets de GitHub solo existen dentro del workflow: el de `report-generator` los copia a las variables de entorno de la Lambda con `update-function-configuration`, que **reemplaza todas** las variables, por eso envía las tres juntas. Si falta alguna, ese paso se salta con un aviso y la Lambda conserva su configuración anterior. El workflow de `report-request-recorder` también reemplazaría las suyas si defines `DATABASE_URL`; como ahora sí lo defines para el generator, ese paso se activa y deja solo `DATABASE_URL` (para Supabase basta: el SSL va activo por defecto).

### 4.2 Orden
1. Infraestructura AWS (parte 2).
2. **BFF** (push a `main`: compila, sube la imagen y reinicia el contenedor; crea `report_requests`). Comprueba `GET /health` → 200.
3. **Lambdas** (push a `main`, con los secrets ya creados).
4. **Front** (push a `main`: sube a S3 e invalida CloudFront).
5. Prueba real: entra con un usuario del grupo `Admin` y pulsa "Solicitar informe".

---

## 5. Entorno local (programar sin la nube)

Emula SNS, SQS y Lambda con LocalStack y reemplaza Cognito por un OIDC falso. La base es la que indiques (Postgres local recomendado).

### 5.1 Vía automática (Mac, Linux y Windows)
```bash
npm install
cp local/.env.example local/.env     # PowerShell: Copy-Item local/.env.example local/.env
#   edita DATABASE_URL, p. ej. postgresql://USUARIO@localhost:5432/reports_local  y  DATABASE_SSL=false
createdb reports_local               # o créala con tu cliente de Postgres
npm run db:check                     # valida la conexión
npm run local:up                     # levanta LocalStack
npm run local:init                   # crea topic, colas, DLQs, suscripciones y Lambdas
npm run local:dev                    # OIDC falso + BFF + front; Ctrl+C detiene todo
```
Abre http://localhost:5173 y pulsa "Ingresar con Cognito": entra solo como `admin@local.test` con grupo `Admin`. Otros comandos: `local:send-test` (publica una solicitud y muestra los logs de las Lambdas), `local:oidc`, `db:schema`, `local:down`. Detalle en `local/README.md`.

### 5.2 Vía manual (qué hace cada pieza)
**a) LocalStack** (`local/docker-compose.yml`): imagen `localstack/localstack:3.8.1` (las recientes pueden exigir token), servicios `sns,sqs,lambda,logs,iam,sts`, puerto `127.0.0.1:4566`, montando `/var/run/docker.sock` y con `LAMBDA_DOCKER_FLAGS=--add-host=host.docker.internal:host-gateway`.
```bash
docker compose -f local/docker-compose.yml up -d
```

**b) Recursos:** son los mismos comandos de la parte 2.2–2.5, con estas diferencias:
```bash
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-2
alias awsl='aws --endpoint-url http://localhost:4566'   # usa awsl en lugar de aws
```
- Cuenta `000000000000`; el rol de las Lambdas puede ser ficticio (`arn:aws:iam::000000000000:role/lambda-role`), sin crear IAM ni la política de las colas.
- Runtime `nodejs20.x`.
- `DATABASE_URL` de la Lambda con `localhost` reemplazado por `host.docker.internal`, y `DATABASE_SSL=false` en su entorno.
- Al recrear una Lambda, **borra antes sus event source mappings** (`awsl lambda list-event-source-mappings --event-source-arn <cola>` → `delete-event-source-mapping`); si no, LocalStack responde `ResourceConflictException`.

**c) OIDC falso:** `node scripts/local/mock-oidc.js` (paquete `oauth2-mock-server`). Escucha en `127.0.0.1:9000`, inicia sesión automáticamente y firma tokens con `email`, `sub`, `cognito:username` y `cognito:groups`. Variables: `MOCK_EMAIL`, `MOCK_SUB`, `MOCK_GROUPS` (p. ej. `Colaborador` para probar el 403), `MOCK_PORT`.

**d) BFF** apuntando a todo lo local (variables de entorno):
```bash
cd bff
SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI=http://localhost:9000 \
AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-2 \
SNS_TOPIC_ARN=arn:aws:sns:us-east-2:000000000000:report-events \
DB_URL=jdbc:postgresql://localhost:5432/reports_local DB_USER=USUARIO DB_PASSWORD= \
./gradlew bootRun          # Windows: gradlew.bat bootRun, y las variables con $env:NOMBRE='valor'
```
`AWS_ENDPOINT_URL` lo respeta el SDK de AWS v2 sin cambiar código.

**e) Front:** `cd front && npm install && npm run dev` (lee `.env.development.local` de 3.3.6).

**f) Probar:** abre http://localhost:5173, entra y pulsa el botón; luego
```bash
psql reports_local -P pager=off -c "SELECT id, requester, type, requested_at FROM report_requests ORDER BY requested_at DESC LIMIT 3;"
```

---

## 6. Problemas que aparecieron y su causa

| Síntoma | Causa | Solución |
|---|---|---|
| BFF local responde 401 con `Bearer resource_metadata=…` y sin `error=` | El BFF no alcanza el OIDC falso: Node enlazó `localhost` solo a `::1` y el Java del BFF fuerza IPv4 | Enlazar el OIDC a `127.0.0.1` (ya hecho) |
| 401 `no matching key(s) found` tras reiniciar el OIDC | El OIDC regenera sus claves al arrancar; el navegador conserva un token firmado con las anteriores | Cerrar sesión y volver a entrar |
| `ResourceConflictException` al repetir `init` | LocalStack no borra el *event source mapping* al borrar la función | Borrar los mapeos antes (el script ya lo hace) |
| El recorder falla con `relation "report_requests" does not exist` | El BFF nuevo aún no arrancó contra esa base | Desplegar el BFF, o ejecutar el SQL de la parte 0 |
| 503 del API Gateway tras desplegar el BFF | El contenedor tarda en arrancar | Esperar y repetir `GET /health` |
| Los mensajes de informe no llegan a las colas | El filtro de la suscripción no incluye el `type` publicado | Revisar `FilterPolicy` y que sea `MessageBody` |
| `Unknown options: --region …` en zsh | zsh no divide una variable con varios flags | Usar una función o repetir los flags |
| ARN con `ole/…` roto | `$ACC:role` en zsh es un modificador | Usar `${ACC}` con llaves |
| `git commit` falla firmando | Firma GPG activa y no accesible desde un entorno restringido | Hacer el commit desde tu terminal |
| `gh secret` da 403 | `gh` está autenticado con otra cuenta | `gh auth login --hostname github.com --git-protocol https --web` con la cuenta dueña del repo, o crear los secrets desde la web |
| El aviso no llega y el log del generador dice `HTTP 405 … nginx` con una página HTML | La petición iba a `/saas/notices` en vez de `/api/saas/notices` (el nginx del sitio no acepta el POST) | Era un error de ruta: la API es `/api/saas/notices`. Con el código actual, `API_NOTIFICATION` basta con la URL del sitio. Se prueba con `npm run notify:test` |
| La Lambda no alcanza tu Postgres local | Dentro del contenedor `localhost` es el propio contenedor | Usar `host.docker.internal` |

---

### Probar la API de avisos sin pasar por AWS
Con `API_NOTIFICATION` y `API_TOKEN_INTEGRATION` en el `.env` de la raíz:
```bash
npm run notify:test                                  # envía un aviso de prueba
npm run notify:test -- "Texto del aviso"
npm run notify:test -- --base https://api.ejemplo.com   # prueba otra URL base sin editar el .env
npm run notify:test -- --dry-run                     # muestra qué enviaría, sin enviarlo
```
Imprime el estado HTTP y un diagnóstico: página HTML (la URL es un sitio web), 401/403 (clave inválida), 404 (falta un prefijo como `/api`), redirección (usar el destino como base). Nunca muestra el token.

## 7. Lista de verificación final
- [ ] `aws sns list-subscriptions-by-topic` muestra las dos colas con filtro `report.requested` sobre `MessageBody`.
- [ ] Las dos Lambdas existen y sus mapeos están `Enabled`.
- [ ] El rol de la EC2 tiene `sns:Publish` y el hop limit del metadata es ≥ 2.
- [ ] `GET /health` del API responde 200 y `report_requests` existe en la base.
- [ ] Un usuario `Admin` ve el panel "Informes"; uno que no es Admin no lo ve y un `POST` directo da 403.
- [ ] Tras pulsar el botón: respuesta 202 con `requestId`, fila nueva en `report_requests` y el informe en los logs de `report-generator`.
- [ ] Colas DLQ vacías.

## 8. Pendientes y seguridad
- Rotar la contraseña de Supabase, expuesta en texto plano en variables de entorno durante el trabajo.
- Dejar de usar **root** con access keys: crear un usuario IAM o SSO acotado (y uno de despliegue solo con permisos de Lambda/S3/CloudFront).
- Quitar del BFF el log `DEBUG SECRETO` de `SecretGatewayFilter`, que imprime el secreto de la pasarela, y bajar el log de Spring Security a `INFO` en producción.
- API Gateway → EC2 va por HTTP plano a una IP sin Elastic IP: usar una IP fija o un ALB con HTTPS.
- SSH (22) abierto a Internet: restringir a tu IP o usar SSM Session Manager.
- Verificar que `TARGET_HOST_IP` del BFF apunte a la IP actual de la EC2.
- El aviso se publica una vez por mensaje; como SQS entrega "al menos una vez", un reintento puede publicar un aviso duplicado. Si la API de avisos lo permite, conviene una clave de idempotencia con el `requestId`.
