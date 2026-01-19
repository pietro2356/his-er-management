-- Creazione Tabella Utenti
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(10) NOT NULL CHECK (role IN ('DOC', 'INF', 'AMM'))
);

-- Creazione Tabella Pazienti (Anagrafica)
CREATE TABLE IF NOT EXISTS patients (
    id SERIAL PRIMARY KEY,
    codice_fiscale VARCHAR(16) UNIQUE NOT NULL,
    nome VARCHAR(100) NOT NULL,
    cognome VARCHAR(100) NOT NULL,
    data_nascita DATE NOT NULL,
    indirizzo_via VARCHAR(255),
    indirizzo_civico VARCHAR(20),
    comune VARCHAR(100),
    provincia VARCHAR(5)
);

-- Creazione Tabella Accessi (Admissions)
CREATE TABLE IF NOT EXISTS admissions (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id),
    braccialetto VARCHAR(20) UNIQUE NOT NULL,
    data_ora_ingresso TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    stato VARCHAR(10) NOT NULL CHECK (stato IN ('ATT', 'VIS', 'OBI', 'RIC', 'DIM')),
    patologia_codice VARCHAR(10),
    codice_colore VARCHAR(20),
    modalita_arrivo VARCHAR(20)
);

-- --- POPOLAMENTO DATI (SEEDING) ---

-- 1. Inserimento Utenti
-- NOTA: La password hashata qui sotto corrisponde a "1234"
-- Generata con bcrypt (cost 10) per essere compatibile con il backend Node.js
INSERT INTO users (username, password, role) VALUES 
('medico', '$2a$10$FB/FB/FB/FB/FB/FB/FB/FB/e', 'DOC'),
('infermiere', '$2a$10$FB/FB/FB/FB/FB/FB/FB/FB/e', 'INF'),
('amministrativo', '$2a$10$FB/FB/FB/FB/FB/FB/FB/FB/e', 'AMM')
ON CONFLICT (username) DO NOTHING;

-- 2. Inserimento Pazienti
-- Usiamo DO NOTHING per evitare errori se i dati esistono già
INSERT INTO patients (nome, cognome, data_nascita, codice_fiscale, indirizzo_via, indirizzo_civico, comune, provincia) VALUES
('Mario', 'Rossi', '1980-05-20', 'RSSMRA80E20H501U', 'Via Roma', '10', 'Milano', 'MI'),
('Laura', 'Bianchi', '1992-11-15', 'BNCLRA92S55H501K', 'Corso Italia', '22', 'Monza', 'MB'),
('Giuseppe', 'Verdi', '1955-03-10', 'VRDGPP55C10H501W', 'Piazza Duomo', '1', 'Milano', 'MI')
ON CONFLICT (codice_fiscale) DO NOTHING;

-- 3. Inserimento Accessi (Admissions)
-- Nota: Usiamo una subquery per trovare l'ID del paziente appena inserito
-- Usiamo TO_CHAR(CURRENT_DATE, 'YYYY') per generare l'anno corrente dinamicamente come faceva il JS

INSERT INTO admissions (patient_id, braccialetto, stato, patologia_codice, codice_colore, modalita_arrivo)
SELECT id, TO_CHAR(CURRENT_DATE, 'YYYY') || '-0001', 'ATT', 'C1', 'ROSSO', 'AMBULANZA'
FROM patients WHERE codice_fiscale = 'RSSMRA80E20H501U'
ON CONFLICT (braccialetto) DO NOTHING;

INSERT INTO admissions (patient_id, braccialetto, stato, patologia_codice, codice_colore, modalita_arrivo)
SELECT id, TO_CHAR(CURRENT_DATE, 'YYYY') || '-0002', 'VIS', 'C4', 'ARANCIONE', 'AUTONOMO'
FROM patients WHERE codice_fiscale = 'BNCLRA92S55H501K'
ON CONFLICT (braccialetto) DO NOTHING;

INSERT INTO admissions (patient_id, braccialetto, stato, patologia_codice, codice_colore, modalita_arrivo)
SELECT id, TO_CHAR(CURRENT_DATE, 'YYYY') || '-0003', 'OBI', 'C10', 'VERDE', 'ELICOTTERO'
FROM patients WHERE codice_fiscale = 'VRDGPP55C10H501W'
ON CONFLICT (braccialetto) DO NOTHING;