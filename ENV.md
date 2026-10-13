# Variables de entorno y secrets

Cuenta `258344940817`, región `us-east-2`. Los valores **nunca** se documentan aquí: solo el nombre, dónde vive y quién lo usa.

Para validar la credencial de Supabase (en cualquier sistema): `npm run db:check -- "postgresql://…"` (ver [scripts/db-check.js](scripts/db-check.js)). Stack local: [local/README.md](local/README.md).

## Resumen: qué debe existir en cada repo de GitHub

| Repo | Secrets | Variables |
|---|---|---|
| `cloud-chati-bff` | `GH_CR_PAT`, `EC2_SSH_KEY`, `API_GATEWAY_SECRET`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD` | `TARGET_HOST_IP` |
| `cloud-lambda-pg` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `LAMBDA_RECORDER_FUNCTION_NAME`, `LAMBDA_GENERATOR_FUNCTION_NAME`, `API_NOTIFICATION`, `API_TOKEN_INTEGRATION`, `DATABASE_URL` | — |
| `cloud-s3-chati` (front) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_NAME`, `CLOUDFRONT_DISTRIBUTION_ID` | — |

Valores no secretos que te faltan en `cloud-lambda-pg` (los nombres cambiaron):

| Secret | Valor |
|---|---|
| `AWS_REGION` | `us-east-2` |
| `LAMBDA_RECORDER_FUNCTION_NAME` | `report-request-recorder` |
| `LAMBDA_GENERATOR_FUNCTION_NAME` | `report-generator` |

Secrets antiguos ya sin uso (se pueden borrar): `LAMBDA_FUNCTION_NAME`, `LAMBDA_CATALOG_FUNCTION_NAME`, `SNS_TOPIC_ARN`.

## BFF (contenedor en la EC2)

Las inyecta `deploy.yml` con `docker run -e …`.

| Variable | Origen | Obligatoria | Descripción |
|---|---|---|---|
| `PORT` | `deploy.yml` (`8080`) | no | Puerto interno; la EC2 mapea 80 → 8080. |
| `PUBLIC_HOST_URL` | `vars.TARGET_HOST_IP` | no | Host público, solo informativo. |
| `API_GATEWAY_SECRET` | secret | sí | Secreto compartido que el API Gateway envía al BFF. Por defecto `secreto_local`. |
| `DB_URL` | `deploy.yml` (fijo) | sí | JDBC de Supabase (`jdbc:postgresql://…pooler.supabase.com:5432/postgres`). No es secreto. |
| `DB_USER` | secret `SUPABASE_DB_USER` | sí | Usuario de Supabase. |
| `DB_PASSWORD` | secret `SUPABASE_DB_PASSWORD` | sí | Contraseña de Supabase. |
| `AWS_REGION` | `deploy.yml` (`us-east-2`) | no | Región del cliente SNS. |
| `SNS_TOPIC_ARN` | — (no se inyecta) | no | Por defecto `arn:aws:sns:us-east-2:258344940817:report-events`. |

Credenciales AWS del BFF: no hay keys; usa el rol de la instancia `EC2-DynamoDB-Access-Role`, que tiene la política inline `publish-report-events` (`sns:Publish` solo sobre `report-events`).

## Lambda `report-request-recorder`

| Variable (config de la Lambda) | Descripción |
|---|---|
| `DATABASE_URL` | Connection string de Supabase (pooler 5432). Ya configurada en AWS. |

Consume la cola `report-requests`. Rol `report-request-recorder-role` (logs + recibir/borrar de esa cola).

Secrets del repo: ver tabla arriba. **Cuidado con `DATABASE_URL` como secret de GitHub:** si lo defines, el workflow ejecuta `update-function-configuration` y **reemplaza todas** las variables de la Lambda con esa sola. Si no lo defines, el paso se salta y la Lambda conserva la actual. Recomendación: no lo definas hasta que roteres la contraseña.

## Lambda `report-generator`

Consume la cola `report-generation`, lee los 10 productos más caros de Supabase y publica un aviso en la API de notificaciones. Rol `report-generator-role`.

| Variable (config de la Lambda) | Origen | Descripción |
|---|---|---|
| `API_NOTIFICATION` | secret `API_NOTIFICATION` | URL del sitio de la app (ej. `https://TU-APP/`). El código agrega `/api` y publica en `POST {URL}/api/saas/notices`; si la URL ya termina en `/api`, no lo duplica. Con o sin `/` final. |
| `API_TOKEN_INTEGRATION` | secret `API_TOKEN_INTEGRATION` | API key (`crr_…`) enviada como `Authorization: ApiKey …`. **Secreto**: nunca en código, logs ni chat. |
| `DATABASE_URL` | secret `DATABASE_URL` | Connection string de Supabase (la misma del recorder), para leer `products`. |
| `DATABASE_SSL` | opcional | `false` solo para un Postgres local sin SSL. |
| `NOTIFY_MODE` | solo local | `log` imprime el aviso en el log en vez de publicarlo. **No definir en AWS.** |

El workflow copia los tres secrets a la Lambda tras desplegar el código. `update-function-configuration` **reemplaza todas** las variables, así que las tres se envían juntas; si falta alguna, el paso se salta con un aviso (`::warning::`) y la Lambda conserva su configuración anterior. Sin esas variables, la Lambda falla a propósito y el mensaje termina en la DLQ.

## `.env` de la raíz (solo tu máquina, ignorado por git)

Lo leen los scripts de `scripts/` (`config.js` carga `local/.env` y después `.env`; las variables ya definidas en el entorno tienen prioridad).

| Variable | Descripción |
|---|---|
| `API_NOTIFICATION` | URL del sitio de la app (ej. `https://TU-APP/`). Los scripts publican en `POST {URL}/api/saas/notices`. |
| `API_TOKEN_INTEGRATION` | API key `crr_…`. Secreto. |

Para probarlas sin pasar por AWS: `npm run notify:test` (ver más abajo en `GUIA.md`, sección 6).

## Front (S3 + CloudFront)

Sin variables de build detectadas en la copia local antigua; falta confirmar con el repo actualizado (`git pull origin main` en `front/`). El deploy usa los secrets de la tabla de arriba.

## Pendientes de revisión

- **`TARGET_HOST_IP`:** el comentario de `deploy.yml` menciona `18.216.244.5`, pero la instancia actual tiene `3.138.140.224` (y es la IP que usa el API Gateway). Verifica que la variable apunte a la IP vigente, o el despliegue irá a otro host.
- **Credenciales de CI:** `DEPLOY.md` sugiere usar tus keys actuales. Si son las de root, crea un usuario IAM de despliegue con permisos solo para `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration` y `lambda:GetFunction` sobre las dos funciones, y para S3/CloudFront en el front.
- **Contraseña de Supabase:** quedó expuesta en texto plano en esta sesión. Pendiente de rotar (decisión tuya: más adelante).
