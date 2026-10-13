-- Tabla de solicitudes de informe para un Postgres local.
-- En AWS la crea el BFF al arrancar (ddl-auto=update, entidad ReportRequest); con el BFF local
-- apuntando a la misma base no hace falta ejecutar esto.
CREATE TABLE IF NOT EXISTS report_requests (
  id           varchar(255) PRIMARY KEY,
  requester    varchar(255),
  requester_id varchar(255),
  type         varchar(255),
  params       jsonb,
  requested_at timestamptz
);
