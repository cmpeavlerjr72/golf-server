import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import cors from 'cors';
import bodyParser from 'body-parser';

const app = express();
const PORT = process.env.PORT || 5000;


// Middleware
app.use(cors());
app.use(bodyParser.json());

// Path to data files
const DATA_PATH = './data';
const FILES = {
  holeByHole: `${DATA_PATH}/holes.json`,
  liveStats: `${DATA_PATH}/live_tournament_stats.json`,
  fieldList: `${DATA_PATH}/field.json`,
  rankings: `${DATA_PATH}/rankings.json`,
  leagues: `${DATA_PATH}/leagues.json`,
};

// Keep track of the last update time
let lastUpdateTime = null;
let lastFieldUpdate = null;

// Helper function to get the current Eastern Time
const getEasternTime = () => {
  const now = new Date();
  const estOffset = -5; // EST is UTC-5
  const estTime = new Date(now.getTime() + estOffset * 60 * 60 * 1000);
  return estTime.toISOString();
};

// Helper function to read JSON files
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

// Helper function to write JSON files
const writeJsonFile = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`${filePath} updated successfully.`);
  } catch (error) {
    console.error(`Error writing to ${filePath}:`, error.message);
  }
};

// Function to update the hole-by-hole data
const updateHoleByHole = async () => {
  const apiEndpoint = `https://feeds.datagolf.com/preds/live-hole-scores?file_format=json&key=${process.env.DATAGOLF_API_KEY}`;
  try {
    const response = await fetch(apiEndpoint);
    if (response.ok) {
      const data = await response.json();
      writeJsonFile(FILES.holeByHole, data);
      console.log(`[${getEasternTime()}] Updated holes.json`);
    } else {
      console.error(`Failed to fetch hole-by-hole data: ${response.status}`);
    }
  } catch (error) {
    console.error('Error updating hole-by-hole data:', error.message);
  }
};

// Function to update live tournament stats
const updateLiveStats = async () => {
  const apiEndpoint = `https://feeds.datagolf.com/preds/live-tournament-stats?stats=sg_ott,distance,accuracy,sg_app,gir,prox_fw,sg_putt,scrambling&round=event_avg&display=value&key=${process.env.DATAGOLF_API_KEY}`;
  try {
    const response = await fetch(apiEndpoint);
    if (response.ok) {
      const data = await response.json();
      writeJsonFile(FILES.liveStats, data);
      console.log(`[${getEasternTime()}] Updated live_tournament_stats.json`);
    } else {
      console.error(`Failed to fetch live stats: ${response.status}`);
    }
  } catch (error) {
    console.error('Error updating live stats:', error.message);
  }
};

// Function to update the field list (once per day)
const updateFieldList = async () => {
  const apiEndpoint = `https://feeds.datagolf.com/field-updates?tour=pga&file_format=json&key=${process.env.DATAGOLF_API_KEY}`;
  try {
    const response = await fetch(apiEndpoint);
    if (response.ok) {
      const data = await response.json();
      writeJsonFile(FILES.fieldList, data);
      console.log(`[${getEasternTime()}] Updated field.json`);
    } else {
      console.error(`Failed to fetch field list: ${response.status}`);
    }
  } catch (error) {
    console.error('Error updating field list:', error.message);
  }
};

// Routes to serve JSON data
app.get('/live-stats', (req, res) => {
  const data = readJsonFile(FILES.liveStats, []);
  res.json(data);
});

app.get('/field', (req, res) => {
  const data = readJsonFile(FILES.fieldList, []);
  res.json(data);
});

app.get('/rankings', (req, res) => {
  const data = readJsonFile(FILES.rankings, []);
  res.json(data);
});

app.get('/holes', (req, res) => {
  const data = readJsonFile(FILES.holeByHole, []);
  res.json(data);
});

// Route: Get all leagues
app.get('/leagues', (req, res) => {
  const data = readJsonFile(FILES.leagues, { leagues: {} });
  res.json(data.leagues);
});

// Route: Get a specific league by ID
app.get('/leagues/:id', (req, res) => {
  const data = readJsonFile(FILES.leagues, { leagues: {} });
  const league = data.leagues[req.params.id];
  if (!league) {
    console.error(`League with ID ${req.params.id} not found.`);
    return res.status(404).json({ error: 'League not found' });
  }
  res.json(league);
});

// Route: Create a new league
app.post('/leagues', (req, res) => {
  try {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const { teams, teamNames } = req.body;

    // Determine the next league ID
    const existingIds = Object.keys(data.leagues).map(Number);
    const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

    // Save the new league
    data.leagues[nextId] = { teams: teams || [], teamNames: teamNames || [] };
    writeJsonFile(FILES.leagues, data);

    console.log(`New league created with ID: ${nextId}`);
    res.status(201).json({ leagueId: nextId });
  } catch (error) {
    console.error('Error creating league:', error.message);
    res.status(500).json({ error: 'Failed to create league' });
  }
});

// Route: Update an existing league
app.put('/leagues/:id', (req, res) => {
  try {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const league = data.leagues[req.params.id];
    if (!league) {
      console.error(`League with ID ${req.params.id} not found.`);
      return res.status(404).json({ error: 'League not found' });
    }

    // Update league data
    data.leagues[req.params.id] = { ...league, ...req.body };
    writeJsonFile(FILES.leagues, data);

    console.log(`League with ID ${req.params.id} updated.`);
    res.json(data.leagues[req.params.id]);
  } catch (error) {
    console.error('Error updating league:', error.message);
    res.status(500).json({ error: 'Failed to update league' });
  }
});

// Route: Update data for hole-by-hole, live stats, and field list
app.post('/update-data', async (req, res) => {
  try {
    const currentTime = new Date();
    const easternTime = getEasternTime();

    // Enforce a 5-minute rule for updates
    if (lastUpdateTime) {
      const timeDifference = (currentTime - new Date(lastUpdateTime)) / 1000 / 60; // In minutes
      if (timeDifference < 5) {
        return res
          .status(429)
          .send(
            `Updates are only allowed every 5 minutes. Please wait ${Math.ceil(
              5 - timeDifference
            )} minute(s) before trying again.`
          );
      }
    }

    // Update hole-by-hole data and live stats
    await updateHoleByHole();
    await updateLiveStats();

    // Update the field list if it's the first update of the day
    const today = new Date().toISOString().split('T')[0]; // Current date (UTC)
    if (lastFieldUpdate !== today) {
      await updateFieldList();
      lastFieldUpdate = today;
    }

    // Record the last update time
    lastUpdateTime = currentTime;
    console.log(`[${easternTime}] Data updated successfully`);

    res.status(200).json({ message: 'Data updated successfully', lastUpdateTime: easternTime });
  } catch (error) {
    console.error(`[${getEasternTime()}] Error updating data:`, error.message);
    res.status(500).send('Failed to update data');
  }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
