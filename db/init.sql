CREATE SCHEMA IF NOT EXISTS sio;

SET search_path TO sio;

CREATE EXTENSION pgcrypto;


-- 2. Creazione Tipi Enumerati (ENUM)
-- Questo garantisce che nel DB entrino solo questi valori precisi
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('DOC', 'INF', 'AMM');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'admission_status') THEN
        CREATE TYPE admission_status AS ENUM ('ATT', 'VIS', 'OBI', 'RIC', 'DIM');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'triage_color') THEN
        CREATE TYPE triage_color AS ENUM ('ROSSO', 'ARANCIONE', 'AZZURRO', 'VERDE', 'BIANCO');
    END IF;
END$$;

-- 3. Creazione Tabella Utenti
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role user_role NOT NULL, -- Uso del tipo custom
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Creazione Tabella Pazienti (Anagrafica)
CREATE TABLE IF NOT EXISTS patients (
    id SERIAL PRIMARY KEY,
    codice_fiscale VARCHAR(16) UNIQUE NOT NULL,
    nome VARCHAR(100) NOT NULL,
    cognome VARCHAR(100) NOT NULL,
    data_nascita DATE NOT NULL,
    indirizzo_via VARCHAR(255),
    indirizzo_civico VARCHAR(20),
    comune VARCHAR(100),
    provincia VARCHAR(5),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indice per ricerca veloce su CF
CREATE INDEX IF NOT EXISTS idx_patients_cf ON patients(codice_fiscale);

-- 5. Creazione Tabella Accessi (Admissions)
CREATE TABLE IF NOT EXISTS admissions (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE RESTRICT,
    braccialetto VARCHAR(20) UNIQUE NOT NULL,
    data_ora_ingresso TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    stato admission_status NOT NULL DEFAULT 'ATT',
    patologia_codice VARCHAR(10),
    codice_colore triage_color,
    modalita_arrivo VARCHAR(50), -- Es. Ambulanza, Autonomo
    note_triage TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indice per ricerca veloce su Braccialetto
CREATE INDEX IF NOT EXISTS idx_admissions_braccialetto ON admissions(braccialetto);


-- --- POPOLAMENTO DATI (SEEDING) ---

-- A. Utenti (Password: "1234")
INSERT INTO users (username, password, role) VALUES
    ('medico', crypt('1234', gen_salt('bf', 10)), 'DOC'),
    ('infermiere', crypt('1234', gen_salt('bf', 10)), 'INF'),
    ('amministrativo', crypt('1234', gen_salt('bf', 10)), 'AMM')
ON CONFLICT (username) DO NOTHING;

-- B. Pazienti
INSERT INTO patients (nome, cognome, data_nascita, codice_fiscale, indirizzo_via, indirizzo_civico, comune, provincia) VALUES
    ('Mario', 'Rossi', '1980-05-20', 'RSSMRA80E20H501U', 'Via Roma', '10', 'Milano', 'MI'),
    ('Laura', 'Bianchi', '1992-11-15', 'BNCLRA92S55H501K', 'Corso Italia', '22', 'Monza', 'MB'),
    ('Giuseppe', 'Verdi', '1955-03-10', 'VRDGPP55C10H501W', 'Piazza Duomo', '1', 'Milano', 'MI')
ON CONFLICT (codice_fiscale) DO NOTHING;

-- C. Accessi
INSERT INTO admissions (patient_id, braccialetto, stato, patologia_codice, codice_colore, modalita_arrivo)
SELECT id, TO_CHAR(CURRENT_DATE, 'YYYY') || '-0001', 'ATT', 'C1', 'ROSSO', 'AMBULANZA'
FROM patients WHERE codice_fiscale = 'RSSMRA80E20H501U'
ON CONFLICT (braccialetto) DO NOTHING;

INSERT INTO admissions (patient_id, braccialetto, stato, patologia_codice, codice_colore, modalita_arrivo)
SELECT id, TO_CHAR(CURRENT_DATE, 'YYYY') || '-0002', 'VIS', 'C4', 'ARANCIONE', 'AUTONOMO'
FROM patients WHERE codice_fiscale = 'BNCLRA92S55H501K'
ON CONFLICT (braccialetto) DO NOTHING;


SELECT * FROM sio.users;
