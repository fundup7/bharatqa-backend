const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()')
    .then(() => console.log('✅ Database connected'))
    .catch(err => console.error('❌ Database failed:', err));

module.exports = pool;