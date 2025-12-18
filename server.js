// Updated server.js - RTD N Line API + Calendar/Commute Planner + Smart Pantry
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Database connection
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

// Token generation for PLAN (Calendar/Commute)
function generatePlanToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = 'PLAN-';
  for (let i = 0; i < 6; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// Token generation for KITCH (Smart Pantry)
function generateKitchToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = 'KITCH-';
  for (let i = 0; i < 6; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// Initialize database with all tables
async function initDatabase() {
  if (!pool) {
    console.log('⚠️  Database not configured - planner sync disabled');
    return;
  }

  try {
    // ===== CALENDAR/COMMUTE PLANNER TABLES =====
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_tokens (
        id VARCHAR(100) PRIMARY KEY,
        user_token VARCHAR(20) REFERENCES planner_users(token) ON DELETE CASCADE,
        data JSONB,
        expires_at TIMESTAMP NOT NULL
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_user_token ON planner_tasks(user_token);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_updated ON planner_tasks(updated_at);
    `);

    // ===== SMART PANTRY TABLES =====
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pantry_users (
        id SERIAL PRIMARY KEY,
        token VARCHAR(20) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pantry_ingredients (
        user_token VARCHAR(20) PRIMARY KEY REFERENCES pantry_users(token) ON DELETE CASCADE,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pantry_recipes (
        user_token VARCHAR(20) PRIMARY KEY REFERENCES pantry_users(token) ON DELETE CASCADE,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pantry_shopping (
        user_token VARCHAR(20) PRIMARY KEY REFERENCES pantry_users(token) ON DELETE CASCADE,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pantry_mealplan (
        user_token VARCHAR(20) PRIMARY KEY REFERENCES pantry_users(token) ON DELETE CASCADE,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ingredients_updated ON pantry_ingredients(updated_at);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_recipes_updated ON pantry_recipes(updated_at);
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// ==================== RTD N LINE TRANSIT ENDPOINTS ====================

app.get('/api/rtd/arrivals', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');

  try {
    const response = await fetch('https://www.rtd-denver.com/files/gtfs-rt/VehiclePosition.pb');
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const nLineVehicles = feed.entity
      .filter(entity => entity.vehicle && entity.vehicle.trip && entity.vehicle.trip.routeId === 'N')
      .map(entity => ({
        id: entity.id,
        position: entity.vehicle.position,
        trip: entity.vehicle.trip,
        timestamp: entity.vehicle.timestamp
      }));

    res.json({
      success: true,
      vehicles: nLineVehicles,
      count: nLineVehicles.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching RTD data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch RTD data',
      message: error.message
    });
  }
});

// ==================== CALENDAR/COMMUTE PLANNER ENDPOINTS ====================

app.post('/api/planner/register', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');

  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    let token;
    let attempts = 0;

    while (attempts < 10) {
      token = generatePlanToken();
      try {
        await pool.query('INSERT INTO planner_users (token) VALUES ($1)', [token]);
        break;
      } catch (error) {
        if (error.code === '23505') {
          attempts++;
          continue;
        }
        throw error;
      }
    }

    if (attempts === 10) {
      return res.status(500).json({ success: false, error: 'Could not generate unique token' });
    }

    console.log(`✅ Planner user registered: ${token}`);
    res.json({ success: true, token, message: 'Save this token!' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/planner/login', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');

  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token required' });
    }

    const result = await pool.query(
      'SELECT token, created_at FROM planner_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    res.json({
      success: true,
      token: result.rows[0].token,
      createdAt: result.rows[0].created_at
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/planner/tasks/:token', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');

  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;

    const userCheck = await pool.query(
      'SELECT token FROM planner_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const result = await pool.query(
      'SELECT data FROM planner_tasks WHERE user_token = $1 ORDER BY id',
      [token.toUpperCase()]
    );

    const tasks = result.rows.map(row => row.data);
    res.json({ success: true, tasks });
  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/planner/tasks/:token', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');

  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;
    const { tasks } = req.body;

    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: 'Tasks must be an array' });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query('DELETE FROM planner_tasks WHERE user_token = $1', [token.toUpperCase()]);

      for (const task of tasks) {
        await client.query(
          'INSERT INTO planner_tasks (id, user_token, data) VALUES ($1, $2, $3)',
          [task.id, token.toUpperCase(), task]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Sync tasks error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/planner/tasks/:token/:taskId', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');

  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token, taskId } = req.params;

    await pool.query(
      'DELETE FROM planner_tasks WHERE user_token = $1 AND id = $2',
      [token.toUpperCase(), taskId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/planner/settings/:token', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');

  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;

    const result = await pool.query(
      'SELECT data FROM planner_settings WHERE user_token = $1',
      [token.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, settings: {} });
    }

    res.json({ success: true, settings: result.rows[0].data });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/planner/settings/:token', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');

  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;
    const { settings } = req.body;

    await pool.query(
      `INSERT INTO planner_settings (user_token, data)
       VALUES ($1, $2)
       ON CONFLICT (user_token)
       DO UPDATE SET data = $2, updated_at = NOW()`,
      [token.toUpperCase(), settings]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SMART PANTRY ENDPOINTS ====================

app.post('/api/pantry/register', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    let token;
    let attempts = 0;

    while (attempts < 10) {
      token = generateKitchToken();
      try {
        await pool.query('INSERT INTO pantry_users (token) VALUES ($1)', [token]);
        break;
      } catch (error) {
        if (error.code === '23505') {
          attempts++;
          continue;
        }
        throw error;
      }
    }

    if (attempts === 10) {
      return res.status(500).json({ success: false, error: 'Could not generate unique token' });
    }

    console.log(`✅ Pantry user registered: ${token}`);
    res.json({ success: true, token });
  } catch (error) {
    console.error('Pantry registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pantry/login', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token required' });
    }

    const result = await pool.query(
      'SELECT token, created_at FROM pantry_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    res.json({
      success: true,
      token: result.rows[0].token,
      createdAt: result.rows[0].created_at
    });
  } catch (error) {
    console.error('Pantry login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pantry/ingredients/:token', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;

    const userCheck = await pool.query(
      'SELECT token FROM pantry_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    const result = await pool.query(
      'SELECT data FROM pantry_ingredients WHERE user_token = $1',
      [token.toUpperCase()]
    );

    const data = result.rows.length > 0 ? result.rows[0].data : { pantry: [], fridge: [], freezer: [] };
    res.json({ success: true, data });
  } catch (error) {
    console.error('Get ingredients error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pantry/ingredients/:token', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ success: false, error: 'Data required' });
    }

    await pool.query(
      `INSERT INTO pantry_ingredients (user_token, data)
       VALUES ($1, $2)
       ON CONFLICT (user_token)
       DO UPDATE SET data = $2, updated_at = NOW()`,
      [token.toUpperCase(), data]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update ingredients error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pantry/recipes/:token', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;

    const userCheck = await pool.query(
      'SELECT token FROM pantry_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    const result = await pool.query(
      'SELECT data FROM pantry_recipes WHERE user_token = $1',
      [token.toUpperCase()]
    );

    const data = result.rows.length > 0 ? result.rows[0].data : [];
    res.json({ success: true, data });
  } catch (error) {
    console.error('Get recipes error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pantry/recipes/:token', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ success: false, error: 'Data required' });
    }

    await pool.query(
      `INSERT INTO pantry_recipes (user_token, data)
       VALUES ($1, $2)
       ON CONFLICT (user_token)
       DO UPDATE SET data = $2, updated_at = NOW()`,
      [token.toUpperCase(), data]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update recipes error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pantry/shopping/:token', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;

    const userCheck = await pool.query(
      'SELECT token FROM pantry_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    const result = await pool.query(
      'SELECT data FROM pantry_shopping WHERE user_token = $1',
      [token.toUpperCase()]
    );

    const data = result.rows.length > 0 ? result.rows[0].data : [];
    res.json({ success: true, data });
  } catch (error) {
    console.error('Get shopping error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pantry/shopping/:token', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ success: false, error: 'Data required' });
    }

    await pool.query(
      `INSERT INTO pantry_shopping (user_token, data)
       VALUES ($1, $2)
       ON CONFLICT (user_token)
       DO UPDATE SET data = $2, updated_at = NOW()`,
      [token.toUpperCase(), data]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update shopping error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pantry/mealplan/:token', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;

    const userCheck = await pool.query(
      'SELECT token FROM pantry_users WHERE token = $1',
      [token.toUpperCase()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    const result = await pool.query(
      'SELECT data FROM pantry_mealplan WHERE user_token = $1',
      [token.toUpperCase()]
    );

    const data = result.rows.length > 0 ? result.rows[0].data : {
      monday: { breakfast: null, lunch: null, dinner: null },
      tuesday: { breakfast: null, lunch: null, dinner: null },
      wednesday: { breakfast: null, lunch: null, dinner: null },
      thursday: { breakfast: null, lunch: null, dinner: null },
      friday: { breakfast: null, lunch: null, dinner: null },
      saturday: { breakfast: null, lunch: null, dinner: null },
      sunday: { breakfast: null, lunch: null, dinner: null }
    };
    res.json({ success: true, data });
  } catch (error) {
    console.error('Get meal plan error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pantry/mealplan/:token', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database not configured' });
    }

    const { token } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ success: false, error: 'Data required' });
    }

    await pool.query(
      `INSERT INTO pantry_mealplan (user_token, data)
       VALUES ($1, $2)
       ON CONFLICT (user_token)
       DO UPDATE SET data = $2, updated_at = NOW()`,
      [token.toUpperCase(), data]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update meal plan error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      rtd: 'available',
      planner: pool ? 'available' : 'disabled',
      pantry: pool ? 'available' : 'disabled'
    },
    timestamp: new Date().toISOString()
  });
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
  console.log(`🚀 RTD N Line API + Planner + Pantry running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🗄️  Database: ${pool ? 'Connected' : 'Not configured'}`);
  initDatabase();
});