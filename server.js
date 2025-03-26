import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server } from 'socket.io';
import http from 'http';

const app = express();
const server = http.createServer(app); // Create HTTP server
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Paths and GitHub config
const DATA_PATH = './data';
const FILES = {
  holeByHole: `${DATA_PATH}/holes.json`,
  liveStats: `${DATA_PATH}/live_tournament_stats.json`,
  fieldList: `${DATA_PATH}/field.json`,
  rankings: `${DATA_PATH}/rankings.json`,
  leagues: `${DATA_PATH}/leagues.json`,
};

const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH;
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

let lastUpdateTime = null;
let lastFieldUpdate = null;

// Time helper
const getEasternTime = () => {
  const now = new Date();
  const estOffset = -5;
  return new Date(now.getTime() + estOffset * 60 * 60 * 1000).toISOString();
};

// JSON File Helpers
const readJsonFile = (filePath, defaultValue = {}) => {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
    return defaultValue;
  }
};

const writeJsonFile = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`${filePath} updated successfully.`);
  } catch (err) {
    console.error(`Error writing to ${filePath}:`, err.message);
  }
};

// GitHub Sync Helpers
const syncLeaguesToGitHub = async () => {
  const leagues = readJsonFile(FILES.leagues, { leagues: {} });
  try {
    const current = await fetch(GITHUB_API_URL, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
    }).then(res => res.json());

    const res = await fetch(GITHUB_API_URL, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Sync leagues.json from Render',
        content: Buffer.from(JSON.stringify(leagues, null, 2)).toString('base64'),
        sha: current.sha
      })
    });

    if (!res.ok) throw new Error(`GitHub sync failed: ${res.status}`);
    console.log('✅ Synced leagues.json to GitHub');
  } catch (err) {
    console.error('❌ GitHub sync error:', err.message);
  }
};

const restoreLeaguesFromGitHub = async () => {
  try {
    const res = await fetch(GITHUB_API_URL, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
    });

    if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status}`);
    const data = await res.json();
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
    writeJsonFile(FILES.leagues, JSON.parse(decoded));
    console.log('✅ Restored leagues.json from GitHub');
  } catch (err) {
    console.error('❌ Failed to restore leagues.json:', err.message);
  }
};

// Data Update Functions
const updateHoleByHole = async () => {
  const url = `https://feeds.datagolf.com/preds/live-hole-scores?file_format=json&key=${process.env.DATAGOLF_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    writeJsonFile(FILES.holeByHole, data);
    console.log(`[${getEasternTime()}] Updated holes.json`);
  } catch (err) {
    console.error('Error updating hole data:', err.message);
  }
};

const updateLiveStats = async () => {
  const url = `https://feeds.datagolf.com/preds/live-tournament-stats?stats=sg_ott,distance,accuracy,sg_app,gir,prox_fw,sg_putt,scrambling&round=event_avg&display=value&key=${process.env.DATAGOLF_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    writeJsonFile(FILES.liveStats, data);
    console.log(`[${getEasternTime()}] Updated live_tournament_stats.json`);
  } catch (err) {
    console.error('Error updating live stats:', err.message);
  }
};

const updateFieldList = async () => {
  const url = `https://feeds.datagolf.com/field-updates?tour=pga&file_format=json&key=${process.env.DATAGOLF_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    writeJsonFile(FILES.fieldList, data);
    console.log(`[${getEasternTime()}] Updated field.json`);
  } catch (err) {
    console.error('Error updating field list:', err.message);
  }
};

// Static API Routes
app.get('/live-stats', (req, res) => res.json(readJsonFile(FILES.liveStats, [])));
app.get('/field', (req, res) => res.json(readJsonFile(FILES.fieldList, [])));
app.get('/rankings', (req, res) => res.json(readJsonFile(FILES.rankings, [])));
app.get('/holes', (req, res) => res.json(readJsonFile(FILES.holeByHole, [])));

// League API Routes
app.get('/leagues', (req, res) => {
  const data = readJsonFile(FILES.leagues, { leagues: {} });
  res.json(data.leagues);
});

app.get('/leagues/:id', (req, res) => {
  const data = readJsonFile(FILES.leagues, { leagues: {} });
  const league = data.leagues[req.params.id];
  if (!league) return res.status(404).json({ error: 'League not found' });
  res.json(league);
});

app.post('/leagues', (req, res) => {
  try {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const { teams, teamNames } = req.body;
    const nextId = Math.max(0, ...Object.keys(data.leagues).map(Number)) + 1;
    data.leagues[nextId] = { teams: teams || [], teamNames: teamNames || [] };
    writeJsonFile(FILES.leagues, data);
    syncLeaguesToGitHub();
    res.status(201).json({ leagueId: nextId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create league' });
  }
});

app.put('/leagues/:id', (req, res) => {
  try {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const league = data.leagues[req.params.id];
    if (!league) return res.status(404).json({ error: 'League not found' });
    data.leagues[req.params.id] = { ...league, ...req.body };
    writeJsonFile(FILES.leagues, data);
    syncLeaguesToGitHub();
    res.json(data.leagues[req.params.id]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update league' });
  }
});

app.post('/update-data', async (req, res) => {
  try {
    const currentTime = new Date();
    const easternTime = getEasternTime();
    if (lastUpdateTime && (currentTime - new Date(lastUpdateTime)) / 1000 / 60 < 5) {
      return res.status(429).send('Please wait before updating again.');
    }
    await updateHoleByHole();
    await updateLiveStats();
    const today = new Date().toISOString().split('T')[0];
    if (lastFieldUpdate !== today) {
      await updateFieldList();
      lastFieldUpdate = today;
    }
    lastUpdateTime = currentTime;
    res.json({ message: 'Data updated', lastUpdateTime: easternTime });
  } catch (err) {
    res.status(500).send('Failed to update data');
  }
});

// Real-time Draft Events
io.on('connection', socket => {
  console.log('🟢 New user connected');

  // Send full league state on connection (optional)
  socket.on('join-league', (leagueId) => {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    if (data.leagues[leagueId]) {
      socket.join(leagueId); // Join the Socket.IO room
      socket.emit('league-state', {
        leagueId,
        state: data.leagues[leagueId]
      });
    }
  });

  // Handle a draft pick
  socket.on('draftPlayer', ({ leagueId, player, currentTeam, sortedPlayers, teams, teamNames, snakeDirection }) => {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const league = data.leagues[leagueId];
    if (!league) return;
  
    const updatedTeams = [...teams];
    const updatedSortedPlayers = sortedPlayers.filter(p => p.id !== player.id);
    updatedTeams[currentTeam] = [...updatedTeams[currentTeam], player];
  
    // Check if all teams are full (6 players each)
    const draftComplete = updatedTeams.every(team => team.length === 6);
  
    let nextTeam = currentTeam;
    let nextSnake = snakeDirection;
    if (!draftComplete) {
      const tentativeNext = currentTeam + snakeDirection;
      if (tentativeNext >= updatedTeams.length) {
        nextTeam = updatedTeams.length - 1;
        nextSnake = -1;
      } else if (tentativeNext < 0) {
        nextTeam = 0;
        nextSnake = 1;
      } else {
        nextTeam = tentativeNext;
      }
    }
  
    // Save changes to file
    data.leagues[leagueId] = {
      ...league,
      teams: updatedTeams,
      teamNames: teamNames,
    };
    writeJsonFile(FILES.leagues, data);
    syncLeaguesToGitHub();
  
    io.emit('updateDraft', {
      leagueId,
      teams: updatedTeams,
      sortedPlayers: updatedSortedPlayers,
      currentTeam: draftComplete ? null : nextTeam,
      snakeDirection: nextSnake,
      draftComplete,
    });
  });
  
});


// Restore on startup and start server
restoreLeaguesFromGitHub();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});