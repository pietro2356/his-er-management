import express from 'express';
import pg from 'pg';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// Destrutturazione necessaria per 'pg' in ES6
const { Pool } = pg;

const app = express();
const port = 3000;

// Configurazione Middleware
app.use(cors());
app.use(express.json());

// Configurazione Database
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: 5432,
});

pool.on('connect', (client) => {
  client.query('SET search_path TO sio, public');
})

const JWT_SECRET = process.env.JWT_SECRET || 'secret';


// Middleware per verificare il Token JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  // const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  const token = authHeader?.split(' ')[1]; // Bearer TOKEN


  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- HEALTH CHECK ---
app.get('/health', async (req, res) => {
  try {
    // Eseguiamo una query banale per verificare che il DB risponda
    await pool.query('SELECT 1');

    res.json({
      status: 'UP',
      database: 'CONNECTED',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (err) {
    // Se il DB non risponde, restituiamo 503 (Service Unavailable)
    res.status(503).json({
      status: 'DOWN',
      database: 'DISCONNECTED',
      error: err.message
    });
  }
});

// --- API ENDPOINTS ---

// 1. LOGIN
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: "Utente non trovato" });

    const user = result.rows[0];
    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: "Password errata" });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      token,
      user: { username: user.username, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. LISTA PAZIENTI ATTIVI (Stato != DIM e != RIC)
app.get('/admissions', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT a.id, a.braccialetto, a.patologia_codice, a.data_ora_ingresso, a.stato, a.codice_colore,
             p.nome, p.cognome, p.data_nascita, p.codice_fiscale
      FROM admissions a
      JOIN patients p ON a.patient_id = p.id
      WHERE a.stato NOT IN ('DIM', 'RIC')
      ORDER BY a.data_ora_ingresso DESC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. DETTAGLIO PAZIENTE
app.get('/admissions/:id', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT a.*, p.*
      FROM admissions a
      JOIN patients p ON a.patient_id = p.id
      WHERE a.id = $1
    `;
    const result = await pool.query(query, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Paziente non trovato" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. INSERIMENTO PAZIENTE (Nuovo Accesso)
app.post('/admissions', authenticateToken, async (req, res) => {
  // Controllo Ruolo: AMM non può inserire
  if (req.user.role === 'AMM') {
    return res.status(403).json({ error: "Gli amministrativi non possono inserire nuovi accessi sanitari." });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Inizia transazione

    const {
      nome, cognome, dataDiNascita, codiceFiscale, // Anagrafica
      via, civico, comune, provincia,             // Indirizzo
      patologia, codiceColore, modalitaArrivo     // Sanitaria
    } = req.body;

    // A. Gestione Paziente (Check se esiste o crea)
    let patientId;
    const patientCheck = await client.query('SELECT id FROM patients WHERE codice_fiscale = $1', [codiceFiscale]);

    if (patientCheck.rows.length > 0) {
      patientId = patientCheck.rows[0].id;
    } else {
      const insertP = await client.query(
        `INSERT INTO patients (nome, cognome, data_nascita, codice_fiscale, indirizzo_via, indirizzo_civico, comune, provincia)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [nome, cognome, dataDiNascita, codiceFiscale, via, civico, comune, provincia]
      );
      patientId = insertP.rows[0].id;
    }

    // B. Generazione Braccialetto (YYYY-XXXX)
    const year = new Date().getFullYear();
    const countRes = await client.query("SELECT count(*) FROM admissions WHERE braccialetto LIKE $1", [`${year}-%`]);
    const nextNum = Number.parseInt(countRes.rows[0].count) + 1;
    const braccialetto = `${year}-${String(nextNum).padStart(4, '0')}`;

    // C. Creazione Accesso
    const insertAdm = await client.query(
      `INSERT INTO admissions (patient_id, braccialetto, stato, patologia_codice, codice_colore, modalita_arrivo)
       VALUES ($1, $2, 'ATT', $3, $4, $5) RETURNING *`,
      [patientId, braccialetto, patologia, codiceColore, modalitaArrivo]
    );

    await client.query('COMMIT'); // Conferma transazione
    res.status(201).json(insertAdm.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK'); // Annulla tutto se errore
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 5. CAMBIO STATO
app.patch('/admissions/:id/status', authenticateToken, async (req, res) => {
  const { nuovoStato } = req.body;
  const allowed = ['ATT', 'VIS', 'OBI', 'RIC', 'DIM'];

  if (!allowed.includes(nuovoStato)) return res.status(400).json({ error: "Stato non valido" });

  try {
    const result = await pool.query(
      'UPDATE admissions SET stato = $1 WHERE id = $2 RETURNING *',
      [nuovoStato, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Avvio Server
app.listen(port, () => {
  console.log(`SIO Backend (ES6) in ascolto sulla porta ${port}`);
});
