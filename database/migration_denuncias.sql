CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS denuncias_ciudadanas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo VARCHAR(30) UNIQUE NOT NULL,
    categoria VARCHAR(50) NOT NULL,
    titulo VARCHAR(150) NOT NULL,
    descripcion TEXT NOT NULL,
    foto_url TEXT,
    latitud NUMERIC(10,6) NOT NULL,
    longitud NUMERIC(10,6) NOT NULL,
    geom GEOMETRY(Point, 4326)
        GENERATED ALWAYS AS (
            ST_SetSRID(ST_MakePoint(longitud, latitud), 4326)
        ) STORED,
    nombre_denunciante VARCHAR(100) NOT NULL DEFAULT 'Anónimo',
    contacto_denunciante VARCHAR(100),
    estado VARCHAR(30) NOT NULL DEFAULT 'pendiente',
    municipio_id UUID REFERENCES municipios(id) ON DELETE SET NULL,
    notas_municipales TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT denuncias_categoria_chk CHECK (
        categoria IN (
            'basurero_clandestino',
            'descarga_drenaje_rio',
            'quema_humo',
            'tala_arboles'
        )
    ),
    CONSTRAINT denuncias_estado_chk CHECK (
        estado IN ('pendiente', 'verificado', 'en_inspeccion', 'resuelto')
    ),
    CONSTRAINT denuncias_latitud_chk CHECK (latitud BETWEEN -90 AND 90),
    CONSTRAINT denuncias_longitud_chk CHECK (longitud BETWEEN -180 AND 180),
    CONSTRAINT denuncias_codigo_chk CHECK (codigo ~ '^DEN-[A-Z0-9-]{4,26}$')
);

CREATE INDEX IF NOT EXISTS idx_denuncias_geom
    ON denuncias_ciudadanas USING GIST (geom);

CREATE INDEX IF NOT EXISTS idx_denuncias_estado_created_at
    ON denuncias_ciudadanas (estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_denuncias_municipio
    ON denuncias_ciudadanas (municipio_id);

CREATE OR REPLACE FUNCTION actualizar_denuncia_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_denuncias_updated_at ON denuncias_ciudadanas;

CREATE TRIGGER trg_denuncias_updated_at
BEFORE UPDATE ON denuncias_ciudadanas
FOR EACH ROW
EXECUTE FUNCTION actualizar_denuncia_updated_at();
