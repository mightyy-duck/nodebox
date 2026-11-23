const express = require('express');
const { getUser } = require('./users');
const app = express();

async function showUser(req, res) {
  res.json(await getUser(req.params.id));
}

app.get('/users/:id', showUser);
app.listen(3000);
