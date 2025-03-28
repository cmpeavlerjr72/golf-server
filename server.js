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
  preds: `${DATA_PATH}/preds.json`,
};

const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH;
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

let lastUpdateTime = null;
let lastFieldUpdate = null;
let lastSyncTime = null;
const SYNC_INTERVAL = 60000; // Sync every 60 seconds at most

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
    throw err;
  }
};

const syncLeaguesToGitHub = async () => {
  const now = new Date();
  if (lastSyncTime && (now - lastSyncTime) < SYNC_INTERVAL) {
    console.log('Skipping GitHub sync due to rate limiting');
    return;
  }

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
    lastSyncTime = now;
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

// Fetch players from the server's /field and /rankings endpoints
const getPlayersFromServer = async () => {
  try {
    let fieldData = readJsonFile(FILES.fieldList, { field: [] });
    let rankingsData = readJsonFile(FILES.rankings, { rankings: [] });

    // If data is missing or empty, trigger an update
    if (!fieldData.field || fieldData.field.length === 0 || !rankingsData.rankings || rankingsData.rankings.length === 0) {
      console.log('Field or rankings data is missing, updating...');
      await updateFieldList();
      await updateRankings();
      fieldData = readJsonFile(FILES.fieldList, { field: [] });
      rankingsData = readJsonFile(FILES.rankings, { rankings: [] });
    }

    const normalizeName = (name) => (name ? name.toLowerCase().trim() : '');
    const players = fieldData.field.map(p => {
      const match = rankingsData.rankings.find(r => normalizeName(r.player_name) === normalizeName(p.player_name));
      return {
        id: p.dg_id,
        name: p.player_name,
        owgr_rank: match?.owgr_rank || 1000,
        dg_rank: match?.datagolf_rank || 1000,
      };
    });
    console.log('Players from server:', players.map(p => ({ id: p.id, name: p.name })));
    return players;
  } catch (err) {
    console.error('Error fetching players from server:', err.message);
    return [
      { id: 18417, name: 'Scheffler, Scottie', owgr_rank: 1, dg_rank: 1 },
      { id: 67890, name: 'McIlroy, Rory', owgr_rank: 2, dg_rank: 2 },
      { id: 54321, name: 'Rahm, Jon', owgr_rank: 3, dg_rank: 3 },
      { id: 98765, name: 'Thomas, Justin', owgr_rank: 4, dg_rank: 4 },
      { id: 45678, name: 'Spieth, Jordan', owgr_rank: 5, dg_rank: 5 },
    ];
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

const updatePreds = async () => {
  const url = `https://feeds.datagolf.com/preds/in-play?tour=pga&dead_heat=no&odds_format=percent&key=${process.env.DATAGOLF_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    writeJsonFile(FILES.preds, data);
    console.log(`[${getEasternTime()}] Updated preds.json`);
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

const updateRankings = async () => {
  const url = `https://feeds.datagolf.com/preds/dg-rankings?file_format=json&key=${process.env.DATAGOLF_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    writeJsonFile(FILES.rankings, data);
    console.log(`[${getEasternTime()}] Updated rankings.json`);
  } catch (err) {
    console.error('Error updating rankings:', err.message);
  }
};

// API routes
app.get('/live-stats', (req, res) => res.json(readJsonFile(FILES.liveStats, [])));
app.get('/field', (req, res) => res.json(readJsonFile(FILES.fieldList, [])));
app.get('/rankings', (req, res) => res.json(readJsonFile(FILES.rankings, [])));
app.get('/holes', (req, res) => res.json(readJsonFile(FILES.holeByHole, [])));
app.get('/preds', (req, res) => res.json(readJsonFile(FILES.preds, [])));

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

app.post('/leagues', async (req, res) => {
  try {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const { teams, teamNames } = req.body;
    const nextId = Math.max(0, ...Object.keys(data.leagues).map(Number)) + 1;

    const newLeague = {
      teams: teams || Array(teamNames.length).fill().map(() => []),
      teamNames: teamNames || [],
      availablePlayers: [],
      currentTeamIndex: 0,
      snakeDirection: 1,
      isDrafting: false,
      draftComplete: false,
      teamOwners: {},
    };
    data.leagues[nextId] = newLeague;

    try {
      writeJsonFile(FILES.leagues, data);
      syncLeaguesToGitHub();
    } catch (err) {
      console.error('Failed to write league data in POST /leagues:', err.message);
      return res.status(500).json({ error: 'Failed to save league data.' });
    }

    res.status(201).json({ leagueId: nextId });
  } catch (err) {
    console.error('Error creating league:', err.message);
    res.status(500).json({ error: 'Failed to create league' });
  }
});

app.put('/leagues/:id', (req, res) => {
  try {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const league = data.leagues[req.params.id];
    if (!league) return res.status(404).json({ error: 'League not found' });
    data.leagues[req.params.id] = { ...league, ...req.body };
    try {
      writeJsonFile(FILES.leagues, data);
      syncLeaguesToGitHub();
    } catch (err) {
      console.error('Failed to write league data in PUT /leagues:', err.message);
      return res.status(500).json({ error: 'Failed to update league data.' });
    }
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
    await updatePreds();
    const today = new Date().toISOString().split('T')[0];
    if (lastFieldUpdate !== today) {
      await updateFieldList();
      await updateRankings();
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

  socket.on('join-draft', async ({ leagueId }) => {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const league = data.leagues[leagueId];
    if (!league) {
      socket.emit('draft-status', { error: 'League not found' });
      return;
    }

    console.log(`Initial availablePlayers for league ${leagueId}:`, league.availablePlayers ? league.availablePlayers.map(p => ({ id: p.id, name: p.name })) : 'empty');

    if (!league.teams || league.teams.length === 0) {
      league.teams = Array(league.teamNames.length).fill().map(() => []);
      data.leagues[leagueId] = league;
      try {
        writeJsonFile(FILES.leagues, data);
        syncLeaguesToGitHub();
      } catch (err) {
        console.error('Failed to write teams data in join-draft:', err.message);
        socket.emit('draft-status', { error: 'Failed to initialize teams on the server. Please try again.' });
        return;
      }
    }

    socket.emit('draft-status', {
      teams: league.teams,
      teamNames: league.teamNames,
      availablePlayers: league.availablePlayers || [],
      currentTeamIndex: league.currentTeamIndex || 0,
      snakeDirection: league.snakeDirection || 1,
      isDrafting: league.isDrafting || false,
      draftComplete: league.draftComplete || false,
    });
  });

  socket.on('assign-team', ({ leagueId, teamIndex }) => {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const league = data.leagues[leagueId];
    if (!league) {
      socket.emit('team-assigned', { success: false, message: 'League not found.' });
      return;
    }

    if (league.draftComplete) {
      socket.emit('team-assigned', { success: false, message: 'Draft is already complete. You cannot change teams.' });
      return;
    }

    if (!league.teamOwners) league.teamOwners = {};
    if (!league.teamOwners[teamIndex] || league.teamOwners[teamIndex] === socket.id) {
      league.teamOwners[teamIndex] = socket.id;
      data.leagues[leagueId] = league;
      try {
        writeJsonFile(FILES.leagues, data);
        syncLeaguesToGitHub();
      } catch (err) {
        console.error('Failed to write league data in assign-team:', err.message);
        socket.emit('team-assigned', { success: false, message: 'Failed to assign team on the server.' });
        return;
      }
      console.log(`Assigned team ${teamIndex} in league ${leagueId} to socket ${socket.id}`);
      socket.emit('team-assigned', { success: true, teamIndex });
    } else {
      console.log(`Team ${teamIndex} in league ${leagueId} already taken`);
      socket.emit('team-assigned', { success: false, message: 'Team already taken by another user.' });
    }
  });

  socket.on('start-draft', async ({ leagueId }) => {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const league = data.leagues[leagueId];
    if (!league || league.isDrafting) return;

    console.log(`Starting draft for league ${leagueId}`);
    console.log('Before starting draft, availablePlayers:', league.availablePlayers ? league.availablePlayers.map(p => ({ id: p.id, name: p.name })) : 'empty');

    // Check if data is stale (e.g., older than 1 hour)
    const currentTime = new Date();
    if (!lastUpdateTime || (currentTime - new Date(lastUpdateTime)) / 1000 / 60 > 60) {
      console.log('Data is stale, updating field and rankings...');
      await updateFieldList();
      await updateRankings();
      lastUpdateTime = currentTime;
    }

    // Initialize availablePlayers if not already set
    if (!league.availablePlayers || league.availablePlayers.length === 0) {
      const players = await getPlayersFromServer();
      if (players.length === 0) {
        console.error('Failed to fetch players from server in start-draft');
        io.emit('draft-update', { leagueId, error: 'Failed to fetch player data. Please try again.' });
        return;
      }
      league.availablePlayers = players;
      console.log('Initialized availablePlayers:', league.availablePlayers.map(p => ({ id: p.id, name: p.name })));
    }

    league.isDrafting = true;
    league.currentTeamIndex = 0;
    league.snakeDirection = 1;
    league.draftComplete = false;
    league.teams = Array(league.teamNames.length).fill().map(() => []);

    console.log('After setting draft state, availablePlayers:', league.availablePlayers.map(p => ({ id: p.id, name: p.name })));
    data.leagues[leagueId] = league;

    try {
      writeJsonFile(FILES.leagues, data);
      syncLeaguesToGitHub();
    } catch (err) {
      console.error('Failed to write updated league data in start-draft:', err.message);
    }

    io.emit('draft-update', {
      leagueId,
      teams: league.teams,
      availablePlayers: league.availablePlayers,
      currentTeamIndex: league.currentTeamIndex,
      snakeDirection: league.snakeDirection,
      isDrafting: league.isDrafting,
      draftComplete: league.draftComplete,
    });
  });

  socket.on('draft-pick', ({ leagueId, teamIndex, player }) => {
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    const league = data.leagues[leagueId];

    if (!league || !league.isDrafting || league.draftComplete) return;

    if (!league.teamOwners || league.teamOwners[teamIndex] !== socket.id) {
      console.log(`Rejected pick: Socket ${socket.id} does not own team ${teamIndex}`);
      return;
    }

    console.log('Player being drafted:', player);
    console.log('Player ID being drafted:', player.id, 'Type:', typeof player.id);
    console.log('Available players in draft-pick:', league.availablePlayers.map(p => ({ id: p.id, name: p.name, idType: typeof p.id })));
    if (!league.availablePlayers.some(p => String(p.id) === String(player.id))) {
      console.log(`Rejected pick: Player ${player.name} is not available`);
      console.log('Available player IDs:', league.availablePlayers.map(p => p.id));
      return;
    }

    console.log(`Received draft-pick: leagueId=${leagueId}, teamIndex=${teamIndex}, player=${player.name}`);
    league.teams[teamIndex].push(player);
    league.availablePlayers = league.availablePlayers.filter(p => String(p.id) !== String(player.id));

    let nextTeamIndex = league.currentTeamIndex + league.snakeDirection;
    if (nextTeamIndex >= league.teamNames.length) {
      nextTeamIndex = league.teamNames.length - 1;
      league.snakeDirection = -1;
    } else if (nextTeamIndex < 0) {
      nextTeamIndex = 0;
      league.snakeDirection = 1;
    }
    league.currentTeamIndex = nextTeamIndex;
    league.draftComplete = league.teams.every(t => t.length === 6);

    data.leagues[leagueId] = league;
    try {
      writeJsonFile(FILES.leagues, data);
      syncLeaguesToGitHub();
    } catch (err) {
      console.error('Failed to write updated league data in draft-pick:', err.message);
    }

    console.log(`Broadcasting draft-update: leagueId=${leagueId}, teamIndex=${teamIndex}, player=${player.name}`);
    io.emit('draft-update', {
      leagueId,
      teams: league.teams,
      availablePlayers: league.availablePlayers,
      currentTeamIndex: league.currentTeamIndex,
      snakeDirection: league.snakeDirection,
      isDrafting: league.isDrafting,
      draftComplete: league.draftComplete,
    });
  });

  socket.on('disconnect', () => {
    console.log('🔴 User disconnected:', socket.id);
    const data = readJsonFile(FILES.leagues, { leagues: {} });
    for (const leagueId in data.leagues) {
      const league = data.leagues[leagueId];
      if (league.teamOwners) {
        for (const teamIndex in league.teamOwners) {
          if (league.teamOwners[teamIndex] === socket.id) {
            delete league.teamOwners[teamIndex];
          }
        }
        data.leagues[leagueId] = league;
      }
    }
    try {
      writeJsonFile(FILES.leagues, data);
      syncLeaguesToGitHub();
    } catch (err) {
      console.error('Failed to write league data in disconnect:', err.message);
    }
  });
});

// Restore leagues and start
restoreLeaguesFromGitHub();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});