import express from 'express';
import pg from 'pg';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import client from 'prom-client';
import winston from 'winston';
import responseTime from "response-time";

// --- 1. CONFIGURAZIONE LOGGER (Winston) ---
// I log in JSON sono più facili da analizzare per le macchine
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

// --- 2. CONFIGURAZIONE METRICHE (Prometheus) ---
client.collectDefaultMetrics(); // Raccoglie CPU, Memoria, Event Loop automaticamente

// Definiamo una metrica personalizzata: Istogramma dei tempi di risposta HTTP
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 10] // Fasce di tempo (0.1s, 0.3s...)
});

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

// Impostiamo il search_path su 'sio' per ogni connessione
pool.on('connect', (client) => {
  client.query('SET search_path TO sio, public');
});

// Chiave Segreta per JWT
const JWT_SECRET = process.env.NODE_ENV === 'production'
    ? (process.env.JWT_SECRET || 'super-secret-production-key')
    : crypto.randomBytes(64).toString();

// Middleware per verificare il Token JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1]; // Bearer TOKEN

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- 3. MIDDLEWARE PER TRACCIARE LE METRICHE ---
// Questo middleware intercetta TUTTE le chiamate e registra quanto tempo impiegano
app.use(responseTime((req, res, time) => {
  if (req.path === '/metrics') return; // Ignoriamo la chiamata alle metriche stesse

  // Normalizziamo la rotta (es. /admissions/123 diventa /admissions/:id) per non creare troppi grafici
  // Nota: Express di default non espone la route matchata facilmente in middleware globali,
  // usiamo req.path per semplicità o req.route se spostiamo la logica.
  // Per ora usiamo req.path ma attenzione agli ID.

  httpRequestDurationMicroseconds.labels(
      req.method,
      req.path, // In produzione meglio raggruppare gli ID (es. usare una regex per sostituire numeri con :id)
      res.statusCode
  ).observe(time / 1000); // response-time restituisce ms, Prometheus vuole secondi

  // Loggiamo anche l'evento
  logger.info(`Request handled`, {
    method: req.method,
    url: req.path,
    status: res.statusCode,
    duration_ms: time
  });
}));

// --- 4. ENDPOINT PER LE METRICHE ---
// Prometheus chiamerà questo indirizzo ogni 5-15 secondi
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
});

// --- HEALTH CHECK ---
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'UP',
      database: 'CONNECTED',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (err) {
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

    // Bcrypt confronta la password in chiaro con l'hash nel DB (che ora è standard $2a$...)
    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: "Password errata" });

    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '1h' }
    );

    res.json({
      token,
      user: { username: user.username, role: user.role }
    });
  } catch (err) {
    logger.error("Errore durante il login", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// 2. CONFIGURAZIONE: LISTA COLORI TRIAGE
// Endpoint necessario al FE per ottenere la mappa colori dinamica (Esadecimali, Priorità)
app.get('/resources/triage-colors', authenticateToken, async (req, res) => {
  try {
    // Ordiniamo per priorità (1 = Rosso = In cima)
    const result = await pool.query('SELECT * FROM triage_colors ORDER BY priority');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. LISTA PAZIENTI ATTIVI (Stato != DIM)
// Aggiornata per includere i dettagli del colore dalla tabella triage_colors
app.get('/admissions', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT
        a.id,
        a.braccialetto,
        a.patologia_codice,
        a.data_ora_ingresso,
        a.stato,
        -- Dati Colore (Join)
        a.codice_colore as color_code,
        tc.hex_value as color_hex,
        tc.display_name as color_name,
        tc.priority as color_priority,
        -- Dati Paziente
        p.nome,
        p.cognome,
        p.data_nascita,
        p.codice_fiscale
      FROM admissions a
             JOIN patients p ON a.patient_id = p.id
             LEFT JOIN triage_colors tc ON a.codice_colore = tc.code
      WHERE a.stato NOT IN ('DIM', 'RIC')
      ORDER BY tc.priority, a.data_ora_ingresso DESC
    `;
    const result = await pool.query(query);

    // Mappiamo i risultati per strutturare meglio l'oggetto colore per il FE se necessario,
    // oppure lo lasciamo piatto. Qui restituisco un JSON arricchito.
    const mappedRows = result.rows.map(row => {
    const tmp = {
        ...row,
          codice_colore: row.color_code ? {
            code: row.color_code,
            hex: row.color_hex,
            display: row.color_name,
            priority: row.color_priority
          } : null
      }
      delete tmp.color_code;
      delete tmp.color_hex;
      delete tmp.color_name;
      delete tmp.color_priority;
      return tmp;
    });
    res.json(mappedRows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. DETTAGLIO PAZIENTE
app.get('/admissions/:id', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT a.*, p.*, 
             tc.hex_value, tc.display_name, tc.priority
      FROM admissions a
      JOIN patients p ON a.patient_id = p.id
      LEFT JOIN triage_colors tc ON a.codice_colore = tc.code
      WHERE a.id = $1
    `;
    const result = await pool.query(query, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Paziente non trovato" });

    const row = result.rows[0];
    // Ricostruiamo l'oggetto risposta pulito
    const response = {
      ...row,
      codice_colore: row.codice_colore ? {
        code: row.codice_colore,
        hex: row.hex_value,
        display: row.display_name,
        priority: row.priority
      } : null
    };

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. INSERIMENTO PAZIENTE (Nuovo Accesso)
app.post('/admissions', authenticateToken, async (req, res) => {
  // Controllo Ruolo: AMM non può inserire dati clinici
  if (req.user.role === 'AMM') {
    return res.status(403).json({ error: "Gli amministrativi non possono inserire nuovi accessi sanitari." });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Inizia transazione

    const {
      nome, cognome, dataDiNascita, codiceFiscale, // Anagrafica
      via, civico, comune, provincia,             // Indirizzo
      patologia, codiceColore, modalitaArrivo     // Sanitaria (codiceColore deve essere una stringa es. 'ROSSO')
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
    // Nota: 'codiceColore' qui è la stringa chiave (es. 'ROSSO') che fa riferimento a triage_colors(code)
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

// 6. CAMBIO STATO
app.patch('/admissions/:id/status', authenticateToken, async (req, res) => {
  const { nuovoStato } = req.body;
  // Allineato con l'ENUM 'admission_status' del database
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
  logger.info(`SIO Backend (ES6) in ascolto sulla porta ${port}`);
});
