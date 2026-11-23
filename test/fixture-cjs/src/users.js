const db = require('./db');

async function getUser(id) {
  const r = await db.findUser(id);
  return r.rows[0];
}

module.exports = { getUser };
