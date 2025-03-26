import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server } from 'socket.io';
import http from 'http';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Track team ownership: { leagueId: { teamIndex: socket.id } }
let teamOwners = {};
let activeClients = {}; // Track active clients per league: { leagueId: Set<socket.id> }

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

const getEasternTime = () => {
  const now = new Date();
  const estOffset = -5;
  return new Date(now.getTime() + estOffset * 60 * 60 * 1000).toISOString();
};

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
    console.log(`${filePath} updated successfully`);
  } catch (err) {
    console.error(`Error writing to ${filePath}:`, err.message);
  }
};

const syncLeaguesToGitHub = async () => {
  const leagues = readJsonFile(FILES.leagues, { leagues: {} });
  try {
    const current = await fetch(GITHUB_API_URL, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
    }).then((res) => res.json());

    const res = await fetch(GITHUB_API_URL, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Sync leagues.json from Render',
        content: Buffer.from(JSON.stringify(leagues, null, 2)).toString('base64'),
        sha: current.sha,
      }),
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
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
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

// Data update functions
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

// API routes
app.get('/live-stats', (req, res) => res.json(readJsonFile(FILES.liveStats, [])));
app.get('/field', (req, res) => res.json(readJsonFile(FILES.fieldList, [])));
app.get('/rankings', (req, res) => res.json(readJsonFile(FILES.rankings, [])));
app.get('/holes', (req, res) => res.json(readJsonFile(FILES.holeByHole, [])));

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
io.on('connection', (socket) => {
  console.log('🟢 New user connected:', socket.id);

  socket.on('join-draft', ({ leagueId }) => {
    // Initialize active clients for this league if not already set
    if (!activeClients[leagueId]) {
      activeClients[leagueId] = new Set();
    }

    // Add the client to the active clients set
    activeClients[leagueId].add(socket.id);
    console.log(`Client ${socket.id} joined league ${leagueId}. Active clients: ${activeClients[leagueId].size}`);

    // Read league data to check draft status
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const draftComplete = data.leagues[leagueId]?.teams?.every((t) => t.length === 6) || false;

    // If this is the first client and the draft isn't complete, reset team assignments
    if (activeClients[leagueId].size === 1 && !draftComplete) {
      console.log(`First client joined league ${leagueId}. Resetting team assignments.`);
      if (teamOwners[leagueId]) {
        delete teamOwners[leagueId];
      }
      if (data.leagues[leagueId]) {
        data.leagues[leagueId].teams = data.leagues[leagueId].teams.map(() => []);
        writeJsonFile(FILES.leagues, data);
        syncLeaguesToGitHub();
      }
      io.emit('draft-reset', { leagueId });
    }

    // Inform the client of the draft status
    socket.emit('draft-status', {
      isFirstClient: activeClients[leagueId].size === 1,
      draftComplete,
    });
  });

  socket.on('start-draft', ({ leagueId }) => {
    console.log(`Starting new draft for league ${leagueId}`);
    // Clear team ownership
    if (teamOwners[leagueId]) {
      delete teamOwners[leagueId];
    }
    // Reset teams in the league
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    if (data.leagues[leagueId]) {
      data.leagues[leagueId].teams = data.leagues[leagueId].teams.map(() => []);
      writeJsonFile(FILES.leagues, data);
      syncLeaguesToGitHub();
    }
    // Notify all clients in the league to reset
    io.emit('draft-reset', { leagueId });
  });

  socket.on('assign-team', ({ leagueId, teamIndex }) => {
    // Check if the draft is complete
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const draftComplete = data.leagues[leagueId]?.teams?.every((t) => t.length === 6) || false;

    if (draftComplete) {
      socket.emit('team-assigned', { success: false, message: 'Draft is already complete. You cannot change teams.' });
      return;
    }

    if (!teamOwners[leagueId]) teamOwners[leagueId] = {};
    if (!teamOwners[leagueId][teamIndex] || teamOwners[leagueId][teamIndex] === socket.id) {
      teamOwners[leagueId][teamIndex] = socket.id;
      console.log(`Assigned team ${teamIndex} in league ${leagueId} to socket ${socket.id}`);
      socket.emit('team-assigned', { success: true, teamIndex });
    } else {
      console.log(`Team ${teamIndex} in league ${leagueId} already taken`);
      socket.emit('team-assigned', { success: false, message: 'Team already taken by another user.' });
    }
  });

  socket.on('draft-pick', ({ leagueId, teamIndex, player }) => {
    console.log(`Received draft-pick: leagueId=${leagueId}, teamIndex=${teamIndex}, player=${player.name}`);
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    if (!data.leagues[leagueId]) return;

    if (!teamOwners[leagueId] || teamOwners[leagueId][teamIndex] !== socket.id) {
      console.log(`Rejected pick: Socket ${socket.id} does not own team ${teamIndex}`);
      return;
    }

    data.leagues[leagueId].teams[teamIndex].push(player);
    writeJsonFile(FILES.leagues, data);
    syncLeaguesToGitHub();

    console.log(`Broadcasting draft-update: leagueId=${leagueId}, teamIndex=${teamIndex}, player=${player.name}`);
    io.emit('draft-update', { leagueId, teamIndex, player });
  });

  socket.on('disconnect', () => {
    console.log('🔴 User disconnected:', socket.id);
    // Remove the client from active clients
    for (const leagueId in activeClients) {
      if (activeClients[leagueId].has(socket.id)) {
        activeClients[leagueId].delete(socket.id);
        console.log(`Client ${socket.id} left league ${leagueId}. Active clients: ${activeClients[leagueId].size}`);
        // If no clients remain, clean up
        if (activeClients[leagueId].size === 0) {
          delete activeClients[leagueId];
          // Clear teamOwners if draft is not complete
          const data = readJsonFile(FILES.leagues, { leagues: {} });
          const draftComplete = data.leagues[leagueId]?.teams?.every((t) => t.length === 6) || false;
          if (!draftComplete) {
            delete teamOwners[leagueId];
          }
        }
      }
    }
    // Remove the client from teamOwners
    for (const leagueId in teamOwners) {
      for (const teamIndex in teamOwners[leagueId]) {
        if (teamOwners[leagueId][teamIndex] === socket.id) {
          delete teamOwners[leagueId][teamIndex];
        }
      }
    }
  });
});

// Restore leagues and start
restoreLeaguesFromGitHub();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});