// RTD N Line API Proxy Server + Ultimate Planner Sync
// This bypasses CORS restrictions for TransitLand API calls
// NOW INCLUDES: 
// - 16th Street Mall FreeRide Bus Support
// - Ultimate Planner Cross-Platform Sync with PostgreSQL
// 
// Setup Instructions:
// 1. Save this file as 'server.js'
// 2. Run: npm install
// 3. Add PostgreSQL database on Render
// 4. Set DATABASE_URL environment variable
// 5. Run: node server.js
// 6. Server will run on PORT from environment or 3001

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// CRITICAL: CORS must be configured BEFORE any routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for task data

// Explicit OPTIONS handler for all routes
app.options('*', cors());

// ==================== DATABASE SETUP ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS planner_users (
        id SERIAL PRIMARY KEY,
        token VARCHAR(20) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS planner_tasks (
        id BIGINT PRIMARY KEY,
        user_token VARCHAR(20) REFERENCES planner_users(token) ON DELETE CASCADE,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS planner_settings (
        user_token VARCHAR(20) PRIMARY KEY REFERENCES planner_users(token) ON DELETE CASCADE,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS planner_stats (
        user_token VARCHAR(20) PRIMARY KEY REFERENCES planner_users(token) ON DELETE CASCADE,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create indexes for performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_user_token ON planner_tasks(user_token);
      CREATE INDEX IF NOT EXISTS idx_tasks_updated ON planner_tasks(updated_at DESC);
    `);

    // Create sync tokens table for cross-browser sync
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_tokens (
        token_id VARCHAR(10) PRIMARY KEY,
        data JSONB NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create index for cleanup of expired tokens
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sync_tokens_expires ON sync_tokens(expires_at);
    `);

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// Generate simple memorable token
function generateToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  let token = 'PLAN-';
  for (let i = 0; i < 6; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// ==================== PLANNER API ENDPOINTS ====================

// Register new user - get a token
app.post('/api/planner/register', async (req, res) => {
  // Set CORS headers explicitly
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');
  
  try {
    // Check if database is connected
    if (!pool) {
      return res.status(503).json({ 
        success: false, 
        error: 'Database not configured. Please add DATABASE_URL environment variable.' 
      });
    }

    // Test database connection
    try {
      await pool.query('SELECT 1');
    } catch (dbError) {
      console.error('Database connection error:', dbError);
      return res.status(503).json({ 
        success: false, 
        error: 'Database connection failed: ' + dbError.message 
      });
    }

    let token;
    let attempts = 0;
    
    // Generate unique token
    while (attempts < 10) {
      token = generateToken();
      try {
        await pool.query(
          'INSERT INTO planner_users (token) VALUES ($1)',
          [token]
        );
        break;
      } catch (error) {
        if (error.code === '23505') { // Duplicate key
          attempts++;
          continue;
        }
        throw error;
      }
    }

    if (attempts === 10) {
      return res.status(500).json({ success: false, error: 'Failed to generate unique token' });
    }

    console.log(`✅ New user registered: ${token}`);
    res.json({
      success: true,
      token: token,
      message: 'Save this token! You\'ll need it to access your data on any device.'
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Verify token exists
app.post('/api/planner/login', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const result = await pool.query(
      'SELECT token, created_at FROM planner_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    res.json({
      success: true,
      token: result.rows[0].token,
      createdAt: result.rows[0].created_at
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all tasks for user
app.get('/api/planner/tasks/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Verify token
    const userCheck = await pool.query(
      'SELECT token FROM planner_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get all tasks
    const result = await pool.query(
      'SELECT id, data, updated_at FROM planner_tasks WHERE user_token = $1 ORDER BY updated_at DESC',
      [token.toUpperCase()]
    );

    const tasks = result.rows.map(row => ({
      ...row.data,
      id: parseInt(row.id),
      _syncedAt: row.updated_at
    }));

    res.json({
      success: true,
      tasks: tasks,
      count: tasks.length
    });

  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save/update tasks (bulk operation)
app.post('/api/planner/tasks/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { tasks } = req.body;

    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: 'Tasks must be an array' });
    }

    // Verify token
    const userCheck = await pool.query(
      'SELECT token FROM planner_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Use transaction for atomicity
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete all existing tasks for this user
      await client.query(
        'DELETE FROM planner_tasks WHERE user_token = $1',
        [token.toUpperCase()]
      );

      // Insert all tasks
      for (const task of tasks) {
        await client.query(
          'INSERT INTO planner_tasks (id, user_token, data, updated_at) VALUES ($1, $2, $3, NOW())',
          [task.id, token.toUpperCase(), task]
        );
      }

      await client.query('COMMIT');

      console.log(`✅ Synced ${tasks.length} tasks for ${token}`);
      res.json({
        success: true,
        count: tasks.length,
        message: 'Tasks synced successfully'
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Save tasks error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete single task
app.delete('/api/planner/tasks/:token/:taskId', async (req, res) => {
  try {
    const { token, taskId } = req.params;

    // Verify token
    const userCheck = await pool.query(
      'SELECT token FROM planner_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    await pool.query(
      'DELETE FROM planner_tasks WHERE user_token = $1 AND id = $2',
      [token.toUpperCase(), taskId]
    );

    res.json({ success: true, message: 'Task deleted' });

  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get settings
app.get('/api/planner/settings/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const result = await pool.query(
      'SELECT data FROM planner_settings WHERE user_token = $1',
      [token.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, settings: null });
    }

    res.json({
      success: true,
      settings: result.rows[0].data
    });

  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save settings
app.post('/api/planner/settings/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { settings } = req.body;

    await pool.query(
      `INSERT INTO planner_settings (user_token, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_token)
       DO UPDATE SET data = $2, updated_at = NOW()`,
      [token.toUpperCase(), settings]
    );

    res.json({ success: true, message: 'Settings saved' });

  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get stats
app.get('/api/planner/stats/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const result = await pool.query(
      'SELECT data FROM planner_stats WHERE user_token = $1',
      [token.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, stats: null });
    }

    res.json({
      success: true,
      stats: result.rows[0].data
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SHORT TOKEN SYNC (PLAN-XXXXX) ====================

// POST: Generate sync token and store data
app.post('/sync/:id', async (req, res) => {
    try {
        const tokenId = req.params.id.toUpperCase();
        const syncData = req.body;
        const expiresAt = new Date(Date.now() + (24 * 60 * 60 * 1000)); // 24 hours from now

        // Store in PostgreSQL for persistence across server restarts
        await pool.query(
            `INSERT INTO sync_tokens (token_id, data, expires_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (token_id)
             DO UPDATE SET data = $2, expires_at = $3, created_at = NOW()`,
            [tokenId, syncData, expiresAt]
        );

        console.log(`✅ Sync token generated: PLAN-${tokenId}`);
        res.json({
            success: true,
            token: `PLAN-${tokenId}`,
            expiresIn: '24 hours'
        });
    } catch (error) {
        console.error('Sync token generation error:', error);
        res.status(500).json({ error: 'Failed to generate sync token' });
    }
});

// GET: Retrieve data by sync token
app.get('/sync/:id', async (req, res) => {
    try {
        const tokenId = req.params.id.toUpperCase();

        // Clean up expired tokens first
        await pool.query('DELETE FROM sync_tokens WHERE expires_at < NOW()');

        // Fetch the token data
        const result = await pool.query(
            'SELECT data, expires_at FROM sync_tokens WHERE token_id = $1',
            [tokenId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Token not found or expired' });
        }

        console.log(`✅ Sync token retrieved: PLAN-${tokenId}`);
        res.json(result.rows[0].data);
    } catch (error) {
        console.error('Sync token retrieval error:', error);
        res.status(500).json({ error: 'Failed to retrieve sync data' });
    }
});

// Save stats
app.post('/api/planner/stats/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { stats } = req.body;

    await pool.query(
      `INSERT INTO planner_stats (user_token, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_token)
       DO UPDATE SET data = $2, updated_at = NOW()`,
      [token.toUpperCase(), stats]
    );

    res.json({ success: true, message: 'Stats saved' });

  } catch (error) {
    console.error('Save stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check sync status
app.get('/api/planner/sync/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const result = await pool.query(
      'SELECT COUNT(*) as task_count, MAX(updated_at) as last_sync FROM planner_tasks WHERE user_token = $1',
      [token.toUpperCase()]
    );

    res.json({
      success: true,
      taskCount: parseInt(result.rows[0].task_count),
      lastSync: result.rows[0].last_sync
    });

  } catch (error) {
    console.error('Sync check error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete account (for testing/cleanup)
app.delete('/api/planner/account/:token', async (req, res) => {
  try {
    const { token } = req.params;

    await pool.query(
      'DELETE FROM planner_users WHERE token = $1',
      [token.toUpperCase()]
    );

    res.json({ success: true, message: 'Account deleted' });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== RTD TRANSIT API (ORIGINAL CODE) ====================

// Your TransitLand API key
const TRANSITLAND_API_KEY = 'TXTmQ3It74ub7L4huB6mgBxUJ824DRLG';

// RTD GTFS-RT feed URLs
const RTD_TRIP_UPDATES = 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/TripUpdate.pb';
const RTD_VEHICLE_POSITIONS = 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb';

// N Line stop IDs (from RTD GTFS data - numeric IDs)
const N_LINE_STOPS = {
  '34668': { name: 'Union Station', direction: 'both' },
  '35247': { name: '38th & Blake', direction: 'northbound' },
  '35249': { name: '40th & Colorado', direction: 'northbound' },
  '35251': { name: '61st & Pena', direction: 'northbound' },
  '35253': { name: 'Commerce City/72nd', direction: 'northbound' },
  '35255': { name: 'Thornton Crossroads/104th', direction: 'northbound' },
  '35257': { name: 'Eastlake/124th', direction: 'northbound' },
  '35365': { name: 'Northglenn/112th', direction: 'southbound' },
  '35254': { name: 'Thornton Crossroads/104th', direction: 'southbound' },
  '35252': { name: 'Commerce City/72nd', direction: 'southbound' },
  '35250': { name: '61st & Pena', direction: 'southbound' },
  '35248': { name: '40th & Colorado', direction: 'southbound' },
  '35246': { name: '38th & Blake', direction: 'southbound' },
  'ustn': { name: 'Union Station', actualId: '34668' },
};

// 16th Street Mall FreeRide bus stops
const FREERIDE_STOPS = {
  '34668': { name: 'Union Station', direction: 'both' },
  '35367': { name: 'Union Station Bus Gates', direction: 'both' },
  '22358': { name: '16th St Mall & Wynkoop', direction: 'both' },
  '22359': { name: '16th St Mall & Wazee', direction: 'both' },
  '22360': { name: '16th St Mall & Blake', direction: 'both' },
  '22361': { name: '16th St Mall & Market', direction: 'both' },
  '22362': { name: '16th St Mall & Larimer', direction: 'both' },
  '22363': { name: '16th St Mall & Lawrence', direction: 'both' },
  '22364': { name: '16th St Mall & Arapahoe', direction: 'both' },
  '22365': { name: '16th St Mall & Curtis', direction: 'both' },
  '22366': { name: '16th St Mall & Champa', direction: 'both' },
  '22367': { name: '16th St Mall & Stout', direction: 'both' },
  '22368': { name: '16th St Mall & California', direction: 'both' },
  '22369': { name: '16th St Mall & Welton', direction: 'both' },
  '22370': { name: '16th St Mall & Glenarm', direction: 'both' },
  '22371': { name: '16th St Mall & Tremont', direction: 'both' },
  '22372': { name: '16th St Mall & Court', direction: 'both' },
  '22373': { name: '16th St Mall & Cleveland', direction: 'both' },
  '35368': { name: 'Civic Center Station', direction: 'both' },
};

// Free MetroRide bus stops
const METRORIDE_STOPS = {
  '34299': { name: '19th St & Stout (Outbound)', direction: 'outbound' },
  '34304': { name: '18th St & California (Inbound)', direction: 'inbound' },
  '34300': { name: '19th St & Welton', direction: 'outbound' },
  '34301': { name: '19th St & California', direction: 'outbound' },
  '34302': { name: '19th St & Stout', direction: 'outbound' },
  '34303': { name: '18th St & Stout', direction: 'inbound' },
  '34305': { name: '18th St & Champa', direction: 'inbound' },
  '34306': { name: '18th St & Arapahoe', direction: 'inbound' },
};

// TransitLand proxy endpoint
app.get('/api/transitland/routes', async (req, res) => {
  try {
    const url = `https://transit.land/api/v2/rest/routes?feed_onestop_id=f-9xj-rtd&route_short_name=N&apikey=${TRANSITLAND_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('TransitLand routes error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/transitland/stops', async (req, res) => {
  try {
    const { route_id } = req.query;
    const url = `https://transit.land/api/v2/rest/stops?served_by_route_id=${route_id}&apikey=${TRANSITLAND_API_KEY}&limit=100`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('TransitLand stops error:', error);
    res.status(500).json({ error: error.message });
  }
});

// RTD real-time trip updates endpoint
app.get('/api/rtd/arrivals', async (req, res) => {
  try {
    console.log('Fetching RTD trip updates...');
    
    const response = await fetch(`${RTD_TRIP_UPDATES}?t=${Date.now()}`, {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    
    const buffer = await response.arrayBuffer();
    
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    const nLineArrivals = [];
    
    feed.entity.forEach(entity => {
      if (entity.tripUpdate && entity.tripUpdate.trip.routeId === '117N') {
        const trip = entity.tripUpdate;
        const stopTimeUpdates = trip.stopTimeUpdate || [];
        
        stopTimeUpdates.forEach(update => {
          const stopId = update.stopId.toString().trim();
          
          if (N_LINE_STOPS[stopId]) {
            const arrivalTime = update.arrival?.time?.low || update.departure?.time?.low;
            
            if (arrivalTime) {
              nLineArrivals.push({
                stopId: stopId,
                stopName: N_LINE_STOPS[stopId].name,
                tripId: trip.trip.tripId,
                directionId: trip.trip.directionId,
                arrivalTime: arrivalTime,
                arrivalTimeFormatted: new Date(arrivalTime * 1000).toLocaleTimeString(),
                minutesUntil: Math.round((arrivalTime - Date.now() / 1000) / 60),
                vehicleId: trip.vehicle?.id || 'Unknown'
              });
            }
          }
        });
      }
    });

    nLineArrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);

    console.log(`Found ${nLineArrivals.length} N Line arrivals`);
    res.json({
      timestamp: Date.now(),
      arrivals: nLineArrivals
    });

  } catch (error) {
    console.error('RTD arrivals error:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Get arrivals for a specific stop (supports BOTH trains and buses)
app.get('/api/rtd/arrivals/:stopId', async (req, res) => {
  try {
    const { stopId } = req.params;
    console.log(`Fetching arrivals for stop: ${stopId}`);
    
    const response = await fetch(`${RTD_TRIP_UPDATES}?t=${Date.now()}`, {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    
    const buffer = await response.arrayBuffer();
    
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    const arrivals = [];
    
    feed.entity.forEach(entity => {
      if (entity.tripUpdate) {
        const trip = entity.tripUpdate;
        const routeId = trip.trip.routeId;
        const stopTimeUpdates = trip.stopTimeUpdate || [];
        
        const isNLine = routeId === '117N';
        const isFreeRide = routeId === 'MALL' || routeId === 'FREE' || routeId === 'MALLRIDE' || routeId.includes('MALL');
        const isMetroRide = routeId === 'METRO' || routeId === 'METRORIDE' || routeId.includes('METRO');
        
        if (isNLine || isFreeRide || isMetroRide) {
          stopTimeUpdates.forEach(update => {
            if (update.stopId.toString().trim() === stopId.toString().trim()) {
              const arrivalTime = update.arrival?.time?.low || update.departure?.time?.low;
              
              if (arrivalTime) {
                const minutesUntil = Math.round((arrivalTime - Date.now() / 1000) / 60);
                
                if (minutesUntil >= -5 && minutesUntil <= 120) {
                  arrivals.push({
                    tripId: trip.trip.tripId,
                    routeId: routeId,
                    route: isNLine ? 'N Line' : isMetroRide ? 'MetroRide' : '16th St Mall',
                    directionId: trip.trip.directionId,
                    direction: trip.trip.directionId === 0 ? 'Southbound' : 'Northbound',
                    arrivalTime: arrivalTime,
                    arrivalTimeFormatted: new Date(arrivalTime * 1000).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit'
                    }),
                    minutesUntil: minutesUntil,
                    status: minutesUntil <= 1 ? 'Arriving' : minutesUntil <= 5 ? 'Due' : 'On Time',
                    vehicleId: trip.vehicle?.id || 'Unknown'
                  });
                }
              }
            }
          });
        }
      }
    });

    arrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);

    const feedTimestamp = feed.header?.timestamp?.low || Math.floor(Date.now() / 1000);
    const feedAge = Math.floor((Date.now() / 1000 - feedTimestamp) / 60);

    const stopName = N_LINE_STOPS[stopId.toLowerCase()]?.name || 
                     FREERIDE_STOPS[stopId]?.name || 
                     METRORIDE_STOPS[stopId]?.name ||
                     stopId;

    res.json({
      stopId,
      stopName: stopName,
      timestamp: Date.now(),
      feedTimestamp: feedTimestamp,
      feedAgeMinutes: feedAge,
      arrivals: arrivals.slice(0, 10)
    });

  } catch (error) {
    console.error('Stop arrivals error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dedicated bus endpoint for 16th Street Mall FreeRide
app.get('/api/rtd/bus/:stopId', async (req, res) => {
  try {
    const { stopId } = req.params;
    console.log(`Fetching bus arrivals for stop: ${stopId}`);
    
    const response = await fetch(`${RTD_TRIP_UPDATES}?t=${Date.now()}`, {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    const busArrivals = [];
    
    feed.entity.forEach(entity => {
      if (entity.tripUpdate) {
        const trip = entity.tripUpdate;
        const routeId = trip.trip.routeId;
        
        if (routeId === 'MALL' || routeId === 'FREE' || routeId === 'MALLRIDE' || routeId.includes('MALL') ||
            routeId === 'METRO' || routeId === 'METRORIDE' || routeId.includes('METRO')) {
          const stopTimeUpdates = trip.stopTimeUpdate || [];
          
          stopTimeUpdates.forEach(update => {
            if (update.stopId.toString().trim() === stopId.toString().trim()) {
              const arrivalTime = update.arrival?.time?.low || update.departure?.time?.low;
              
              if (arrivalTime) {
                const minutesUntil = Math.round((arrivalTime - Date.now() / 1000) / 60);
                
                if (minutesUntil >= -2 && minutesUntil <= 60) {
                  busArrivals.push({
                    tripId: trip.trip.tripId,
                    routeId: routeId,
                    route: routeId.includes('METRO') ? 'MetroRide' : '16th St Mall',
                    arrivalTime: arrivalTime,
                    arrivalTimeFormatted: new Date(arrivalTime * 1000).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit'
                    }),
                    minutesUntil: minutesUntil,
                    status: minutesUntil <= 1 ? 'Arriving' : 'On Time',
                    vehicleId: trip.vehicle?.id || 'Unknown'
                  });
                }
              }
            }
          });
        }
      }
    });

    busArrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);

    res.json({
      stopId,
      stopName: FREERIDE_STOPS[stopId]?.name || METRORIDE_STOPS[stopId]?.name || '16th Street Mall',
      route: '16th St Mall FreeRide / MetroRide',
      timestamp: Date.now(),
      arrivals: busArrivals.slice(0, 5)
    });

  } catch (error) {
    console.error('Bus arrivals error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint
app.get('/api/rtd/debug', async (req, res) => {
  try {
    console.log('Fetching ALL RTD trip updates for debugging...');
    const response = await fetch(RTD_TRIP_UPDATES);
    const buffer = await response.arrayBuffer();
    
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    const debugData = {
      timestamp: Date.now(),
      totalEntities: feed.entity.length,
      nLineTrips: [],
      busTrips: [],
      allRoutes: new Set(),
      allStopIds: new Set()
    };
    
    feed.entity.forEach(entity => {
      if (entity.tripUpdate) {
        const routeId = entity.tripUpdate.trip.routeId;
        debugData.allRoutes.add(routeId);
        
        const trip = entity.tripUpdate;
        const tripData = {
          tripId: trip.trip.tripId,
          routeId: trip.trip.routeId,
          directionId: trip.trip.directionId,
          stops: []
        };
        
        (trip.stopTimeUpdate || []).forEach(update => {
          debugData.allStopIds.add(update.stopId);
          tripData.stops.push({
            stopId: update.stopId,
            arrivalTime: update.arrival?.time?.low,
            departureTime: update.departure?.time?.low
          });
        });
        
        if (routeId === '117N') {
          debugData.nLineTrips.push(tripData);
        } else if (routeId === 'FREE' || routeId === 'MALL') {
          debugData.busTrips.push(tripData);
        }
      }
    });

    debugData.allRoutes = Array.from(debugData.allRoutes).sort();
    debugData.allStopIds = Array.from(debugData.allStopIds).sort();

    res.json(debugData);

  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', async (req, res) => {
  let dbStatus = 'not configured';
  
  if (process.env.DATABASE_URL && pool) {
    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (error) {
      dbStatus = 'error: ' + error.message;
    }
  }
  
  res.json({ 
    status: 'ok', 
    message: 'RTD API Proxy (Trains + Buses) + Ultimate Planner Sync is running',
    database: dbStatus
  });
});

// Planner API health check
app.get('/api/planner/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Ultimate Planner API is ready',
    endpoints: {
      register: 'POST /api/planner/register',
      login: 'POST /api/planner/login',
      tasks: 'GET/POST /api/planner/tasks/:token',
      settings: 'GET/POST /api/planner/settings/:token',
      stats: 'GET/POST /api/planner/stats/:token',
      sync: 'GET /api/planner/sync/:token'
    }
  });
});

// Start server and initialize database
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 RTD API Proxy + Ultimate Planner Sync Server`);
  console.log(`📍 Running on port ${PORT}\n`);
  console.log(`Health checks:`);
  console.log(`  🏥 General: http://0.0.0.0:${PORT}/health`);
  console.log(`  📱 Planner: http://0.0.0.0:${PORT}/api/planner/health\n`);
  console.log(`RTD Examples:`);
  console.log(`  🚉 Train: http://0.0.0.0:${PORT}/api/rtd/arrivals/34668`);
  console.log(`  🚌 Bus: http://0.0.0.0:${PORT}/api/rtd/bus/22367\n`);
  console.log(`Planner Examples:`);
  console.log(`  📝 Register: POST http://0.0.0.0:${PORT}/api/planner/register`);
  console.log(`  🔐 Login: POST http://0.0.0.0:${PORT}/api/planner/login`);
  console.log(`  📋 Tasks: GET http://0.0.0.0:${PORT}/api/planner/tasks/PLAN-ABC123\n`);
  
  // Initialize database
  if (process.env.DATABASE_URL) {
    await initDatabase();
  } else {
    console.log('⚠️  No DATABASE_URL found - planner sync disabled');
    console.log('   Add PostgreSQL database in Render dashboard\n');
  }
});
