require('dotenv').config();
const db = require('./db');

async function check() {
    try {
        console.log('--- Bugs Table Columns ---');
        const bugsAttrs = await db.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'bugs'
        `);
        console.table(bugsAttrs.rows);

        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

check();
