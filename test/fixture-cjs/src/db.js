'use strict';
const { Pool } = require('pg');
const pool = new Pool();

/** Find a user row. */
exports.findUser = async function findUser(id) {
  return pool.query('select * from users where id = $1', [id]);
};
