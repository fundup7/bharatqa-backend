const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()')
    .then(res => { console.log('✅ DB works', res.rows); pool.end(); })
    .catch(err => { console.error('❌ DB failed', err); pool.end(); });
