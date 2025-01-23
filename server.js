const express = require('express');
const fs = require('fs');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Paths to JSON files
const DB_FILE = './data/leagues.json';
const TOURNAMENT_STATS_FILE = './data/live_tournament_stats.json';
const FIELD_FILE = './data/field.json';
const RANKINGS_FILE = './data/rankings.json';
const HOLES_FILE = './data/holes.json';

// Utility to read a JSON file
const readJsonFile = (filePath, defaultValue = {}) => {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error.message);
    return defaultValue;
  }
};

// Utility to write to a JSON file
const writeJsonFile = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`${filePath} updated successfully.`);
  } catch (error) {
    console.error(`Error writing to ${filePath}:`, error.message);
  }
};

// API: Get all leagues
app.get('/leagues', (req, res) => {
  const data = readJsonFile(DB_FILE, { leagues: {} });
  res.json(data.leagues);
});

// API: Get a specific league by ID
app.get('/leagues/:id', (req, res) => {
  const data = readJsonFile(DB_FILE, { leagues: {} });
  const league = data.leagues[req.params.id];
  if (!league) {
    console.error(`League with ID ${req.params.id} not found.`);
    return res.status(404).json({ error: 'League not found' });
  }
  res.json(league);
});

// API: Create a new league
app.post('/leagues', (req, res) => {
  try {
    const data = readJsonFile(DB_FILE, { leagues: {} });
    const { teams, teamNames } = req.body;

    // Determine the next league ID
    const existingIds = Object.keys(data.leagues).map(Number);
    const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

    // Save the new league
    data.leagues[nextId] = { teams, teamNames };
    writeJsonFile(DB_FILE, data);

    console.log(`New league created with ID: ${nextId}`);
    res.status(201).json({ leagueId: nextId });
  } catch (error) {
    console.error('Error creating league:', error.message);
    res.status(500).json({ error: 'Failed to create league' });
  }
});

// API: Update an existing league
app.put('/leagues/:id', (req, res) => {
  try {
    const data = readJsonFile(DB_FILE, { leagues: {} });
    const league = data.leagues[req.params.id];
    if (!league) {
      console.error(`League with ID ${req.params.id} not found.`);
      return res.status(404).json({ error: 'League not found' });
    }

    // Update league data
    data.leagues[req.params.id] = { ...league, ...req.body };
    writeJsonFile(DB_FILE, data);

    console.log(`League with ID ${req.params.id} updated.`);
    res.json(data.leagues[req.params.id]);
  } catch (error) {
    console.error('Error updating league:', error.message);
    res.status(500).json({ error: 'Failed to update league' });
  }
});

// API: Get live tournament stats
app.get('/tournament-stats', (req, res) => {
  try {
    const data = readJsonFile(TOURNAMENT_STATS_FILE);
    res.json(data);
  } catch (error) {
    console.error('Error reading tournament stats:', error.message);
    res.status(500).json({ error: 'Failed to retrieve tournament stats' });
  }
});

// API: Get field data
app.get('/field', (req, res) => {
  try {
    const data = readJsonFile(FIELD_FILE);
    res.json(data);
  } catch (error) {
    console.error('Error reading field data:', error.message);
    res.status(500).json({ error: 'Failed to retrieve field data' });
  }
});

// API: Get rankings data
app.get('/rankings', (req, res) => {
  try {
    const data = readJsonFile(RANKINGS_FILE);
    res.json(data);
  } catch (error) {
    console.error('Error reading rankings data:', error.message);
    res.status(500).json({ error: 'Failed to retrieve rankings data' });
  }
});

// API: Get rankings data
app.get('/holes', (req, res) => {
  try {
    const data = readJsonFile(HOLES_FILE);
    res.json(data);
  } catch (error) {
    console.error('Error reading rankings data:', error.message);
    res.status(500).json({ error: 'Failed to retrieve rankings data' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});


