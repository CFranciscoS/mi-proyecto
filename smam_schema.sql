CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION
    WHEN undefined_file OR feature_not_supported OR insufficient_privilege THEN
        RAISE NOTICE 'TimescaleDB no disponible; se continuará sin hypertables.';
END
$$;

CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(50) NOT NULL UNIQUE,
    descripcion TEXT,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permisos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) NOT NULL UNIQUE,
    descripcion TEXT,
    recurso VARCHAR(100) NOT NULL,
    accion VARCHAR(50) NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS roles_permisos (
    rol_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permiso_id UUID NOT NULL REFERENCES permisos(id) ON DELETE CASCADE,
    asignado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (rol_id, permiso_id)
);

CREATE TABLE IF NOT EXISTS usuarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rol_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    username VARCHAR(80) NOT NULL UNIQUE,
    email VARCHAR(255) UNIQUE,
    nombre_completo VARCHAR(180) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    ultimo_acceso TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS municipios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo VARCHAR(10) NOT NULL UNIQUE,
    nombre VARCHAR(150) NOT NULL,
    departamento VARCHAR(100) NOT NULL,
    poblacion INTEGER CHECK (poblacion IS NULL OR poblacion >= 0),
    geom geometry(MultiPolygon, 4326) NOT NULL,
    centroide geometry(Point, 4326) GENERATED ALWAYS AS (ST_Centroid(geom)) STORED,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT municipios_geom_valida CHECK (ST_IsValid(geom))
);

CREATE TABLE IF NOT EXISTS estaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo_externo VARCHAR(100) NOT NULL UNIQUE,
    nombre VARCHAR(180) NOT NULL,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('aire', 'agua', 'mixta')),
    fuente VARCHAR(30) NOT NULL CHECK (fuente IN ('CAMS', 'PurpleAir', 'Sentinel-2', 'MARN')),
    latitud NUMERIC(10,7) NOT NULL CHECK (latitud BETWEEN -90 AND 90),
    longitud NUMERIC(10,7) NOT NULL CHECK (longitud BETWEEN -180 AND 180),
    geom geometry(Point, 4326) GENERATED ALWAYS AS
        (ST_SetSRID(ST_MakePoint(longitud, latitud), 4326)) STORED,
    metadatos JSONB NOT NULL DEFAULT '{}'::JSONB,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mediciones_aire (
    timestamp TIMESTAMPTZ NOT NULL,
    estacion_id UUID NOT NULL REFERENCES estaciones(id) ON DELETE CASCADE,
    pm2_5 NUMERIC(12,4),
    pm10 NUMERIC(12,4),
    aqi NUMERIC(12,4),
    co NUMERIC(12,4),
    no2 NUMERIC(12,4),
    so2 NUMERIC(12,4),
    o3 NUMERIC(12,4),
    temperatura NUMERIC(8,3),
    humedad NUMERIC(8,3),
    calidad_nivel VARCHAR(30),
    fuente_raw JSONB NOT NULL DEFAULT '{}'::JSONB,
    PRIMARY KEY (timestamp, estacion_id)
);

CREATE TABLE IF NOT EXISTS mediciones_agua (
    timestamp TIMESTAMPTZ NOT NULL,
    estacion_id UUID NOT NULL REFERENCES estaciones(id) ON DELETE CASCADE,
    ph NUMERIC(8,4),
    oxigeno_disuelto NUMERIC(12,4),
    turbidez NUMERIC(12,4),
    conductividad NUMERIC(12,4),
    temperatura_agua NUMERIC(8,3),
    dbo NUMERIC(12,4),
    coliformes_fecales NUMERIC(16,4),
    ica_wqi NUMERIC(12,4),
    ndci_clorofila NUMERIC(12,6),
    ndti_turbidez NUMERIC(12,6),
    calidad_nivel VARCHAR(30),
    fuente_raw JSONB NOT NULL DEFAULT '{}'::JSONB,
    PRIMARY KEY (timestamp, estacion_id)
);

CREATE TABLE IF NOT EXISTS alertas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo VARCHAR(80) NOT NULL UNIQUE,
    estacion_id UUID REFERENCES estaciones(id) ON DELETE SET NULL,
    municipio_id UUID REFERENCES municipios(id) ON DELETE SET NULL,
    tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('aire', 'agua', 'meteorologica', 'operativa')),
    parametro VARCHAR(80) NOT NULL,
    valor_registrado NUMERIC(18,6) NOT NULL,
    valor_limite NUMERIC(18,6) NOT NULL,
    severidad VARCHAR(15) NOT NULL CHECK (severidad IN ('baja', 'media', 'alta', 'critica')),
    estado VARCHAR(20) NOT NULL DEFAULT 'activa'
        CHECK (estado IN ('activa', 'en_revision', 'atendida', 'cerrada')),
    atendido_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
    geom geometry(Point, 4326),
    descripcion TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atendida_en TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auditoria (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
    accion VARCHAR(50) NOT NULL,
    entidad VARCHAR(100) NOT NULL,
    entidad_id UUID,
    ip INET,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    datos_anteriores JSONB,
    datos_nuevos JSONB
);

CREATE INDEX IF NOT EXISTS idx_municipios_geom ON municipios USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_estaciones_geom ON estaciones USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_estaciones_tipo_fuente ON estaciones (tipo, fuente);
CREATE INDEX IF NOT EXISTS idx_mediciones_aire_estacion_timestamp
    ON mediciones_aire (estacion_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mediciones_agua_estacion_timestamp
    ON mediciones_agua (estacion_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alertas_estado_severidad ON alertas (estado, severidad);
CREATE INDEX IF NOT EXISTS idx_alertas_geom ON alertas USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_auditoria_entidad_timestamp
    ON auditoria (entidad, entidad_id, timestamp DESC);

INSERT INTO roles (nombre, descripcion) VALUES
    ('Administrador', 'Acceso completo al sistema'),
    ('Operador', 'Monitoreo y gestión operativa'),
    ('Consulta', 'Acceso de solo lectura')
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO permisos (nombre, descripcion, recurso, accion) VALUES
    ('usuarios.leer', 'Consultar usuarios', 'usuarios', 'leer'),
    ('usuarios.gestionar', 'Gestionar usuarios', 'usuarios', 'gestionar'),
    ('estaciones.leer', 'Consultar estaciones', 'estaciones', 'leer'),
    ('estaciones.gestionar', 'Gestionar estaciones', 'estaciones', 'gestionar'),
    ('mediciones.leer', 'Consultar mediciones ambientales', 'mediciones', 'leer'),
    ('alertas.leer', 'Consultar alertas', 'alertas', 'leer'),
    ('alertas.gestionar', 'Gestionar alertas', 'alertas', 'gestionar'),
    ('auditoria.leer', 'Consultar auditoría', 'auditoria', 'leer')
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permisos p
WHERE r.nombre = 'Administrador'
ON CONFLICT DO NOTHING;

INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r JOIN permisos p ON p.nombre IN
    ('estaciones.leer', 'estaciones.gestionar', 'mediciones.leer',
     'alertas.leer', 'alertas.gestionar')
WHERE r.nombre = 'Operador'
ON CONFLICT DO NOTHING;

INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id FROM roles r JOIN permisos p ON p.nombre IN
    ('estaciones.leer', 'mediciones.leer', 'alertas.leer')
WHERE r.nombre = 'Consulta'
ON CONFLICT DO NOTHING;

INSERT INTO usuarios (rol_id, username, email, nombre_completo, password_hash)
SELECT id, 'admin', 'admin@smam.gob.gt', 'Administrador SMAM',
       crypt('Admin123!', gen_salt('bf', 12))
FROM roles WHERE nombre = 'Administrador'
ON CONFLICT (username) DO NOTHING;

INSERT INTO municipios (codigo, nombre, departamento, poblacion, geom) VALUES
('0101', 'Ciudad de Guatemala', 'Guatemala', 923392, ST_Multi(ST_GeomFromText('POLYGON((-90.60 14.50,-90.45 14.50,-90.45 14.70,-90.60 14.70,-90.60 14.50))', 4326))),
('0108', 'Mixco', 'Guatemala', 503080, ST_Multi(ST_GeomFromText('POLYGON((-90.72 14.58,-90.52 14.58,-90.52 14.72,-90.72 14.72,-90.72 14.58))', 4326))),
('0115', 'Villa Nueva', 'Guatemala', 618397, ST_Multi(ST_GeomFromText('POLYGON((-90.67 14.45,-90.52 14.45,-90.52 14.58,-90.67 14.58,-90.67 14.45))', 4326))),
('0117', 'Amatitlán', 'Guatemala', 116711, ST_Multi(ST_GeomFromText('POLYGON((-90.72 14.38,-90.52 14.38,-90.52 14.52,-90.72 14.52,-90.72 14.38))', 4326))),
('0901', 'Quetzaltenango', 'Quetzaltenango', 180706, ST_Multi(ST_GeomFromText('POLYGON((-91.65 14.75,-91.40 14.75,-91.40 14.95,-91.65 14.95,-91.65 14.75))', 4326))),
('0501', 'Escuintla', 'Escuintla', 156313, ST_Multi(ST_GeomFromText('POLYGON((-91.00 14.20,-90.65 14.20,-90.65 14.45,-91.00 14.45,-91.00 14.20))', 4326)))
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO estaciones (codigo_externo, nombre, tipo, fuente, latitud, longitud, metadatos) VALUES
('AMSA-AMATITLAN', 'Amatitlán AMSA', 'agua', 'MARN', 14.4877, -90.6150, '{"organizacion":"AMSA","cuerpo_agua":"Lago de Amatitlán"}'),
('MARN-RIO-VILLALOBOS', 'Río Villalobos', 'agua', 'MARN', 14.5350, -90.5900, '{"cuenca":"Río Villalobos"}'),
('MARN-RIO-LAS-VACAS', 'Río Las Vacas', 'agua', 'MARN', 14.6900, -90.5100, '{"cuenca":"Río Las Vacas"}'),
('CAMS-PLAZA-CONSTITUCION', 'Plaza de la Constitución', 'aire', 'CAMS', 14.6419, -90.5133, '{"zona":"Centro Histórico"}'),
('PURPLEAIR-Z10-OBELISCO', 'Zona 10 Obelisco', 'aire', 'PurpleAir', 14.5950, -90.5130, '{"zona":"Zona 10"}'),
('CAMS-XELA', 'Xela', 'mixta', 'CAMS', 14.8347, -91.5180, '{"ciudad":"Quetzaltenango"}')
ON CONFLICT (codigo_externo) DO NOTHING;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        PERFORM create_hypertable('public.mediciones_aire', 'timestamp', if_not_exists => TRUE);
        PERFORM create_hypertable('public.mediciones_agua', 'timestamp', if_not_exists => TRUE);
    END IF;
EXCEPTION
    WHEN undefined_function OR feature_not_supported THEN
        RAISE NOTICE 'No fue posible crear hypertables; se mantienen tablas PostgreSQL convencionales.';
END
$$;
