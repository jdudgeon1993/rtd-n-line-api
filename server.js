// RTD N Line API Proxy Server
// This bypasses CORS restrictions for TransitLand API calls
// 
// Setup Instructions:
// 1. Save this file as 'server.js'
// 2. Run: npm init -y
// 3. Run: npm install express cors node-fetch gtfs-realtime-bindings
// 4. Run: node server.js
// 5. Server will run on http://localhost:3001

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app = express();
const PORT = process.env.PORT || 3001;

// CRITICAL: CORS must be configured BEFORE any routes
// This allows requests from ANY origin including Claude artifacts
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors());
app.use(express.json());

// Your TransitLand API key (Kept for completeness, though not used below)
const TRANSITLAND_API_KEY = 'TXTmQ3It74ub7L4huB6mgBxUJ824DRLG';

// RTD GTFS-RT feed URLs
const RTD_TRIP_UPDATES = 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/TripUpdate.pb';
// const RTD_VEHICLE_POSITIONS = 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb'; // Not used

// N Line stop IDs (These must match the IDs used in the client HTML)
const N_LINE_STOPS = {
  // Union Station (RTD GTFS ID for Commuter Rail Track)
  '25287': { name: 'Union Station', direction: 'both' },
  // N Line stop IDs used in the client HTML
  '35248': { name: '38th & Blake', direction: 'southbound' },
  '35250': { name: '40th & Colorado', direction: 'southbound' },
  '35252': { name: '61st & Pena', direction: 'southbound' },
  '35254': { name: 'Commerce City/72nd', direction: 'southbound' },
  '35255': { name: 'Thornton Crossroads/104th', direction: 'northbound' }, // Northglenn ID used in client
  '35257': { name: 'Eastlake/124th', direction: 'northbound' },
  
  // Include common alternate IDs used in the feed just in case
  '34668': { name: 'Union Station Alt', direction: 'both' },
  '35247': { name: '38th & Blake North', direction: 'northbound' },
};

// TransitLand proxy endpoints (left untouched)
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


// Get arrivals for a specific stop
app.get('/api/rtd/arrivals/:stopId', async (req, res) => {
  try {
    const { stopId } = req.params;
    console.log(`Fetching arrivals for stop: ${stopId}`);
    
    // Add cache-busting
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
    const targetStopId = stopId.toLowerCase(); // Ensure case-insensitivity

    feed.entity.forEach(entity => {
      if (entity.tripUpdate) {
        const routeId = entity.tripUpdate.trip.routeId;
        
        // 🔑 FIX 3: Robust N Line Route ID filtering
        if (routeId === '117N' || routeId === 'N' || routeId === '900') {
          const trip = entity.tripUpdate;
          const stopTimeUpdates = trip.stopTimeUpdate || [];
          
          stopTimeUpdates.forEach(update => {
            // Check against the requested stopId
            if (update.stopId.toLowerCase() === targetStopId) {
              
              // Use arrival time if available, otherwise fall back to departure time
              const arrivalTimeSec = update.arrival?.time?.low || update.departure?.time?.low;
              
              if (arrivalTimeSec) {
                // 🔑 FIX 1: Convert seconds to milliseconds for accurate Date object creation
                const arrivalTimeMs = arrivalTimeSec * 1000;
                
                // 🔑 FIX 2: Correctly calculate minutesUntil (using seconds vs seconds)
                const nowSec = Date.now() / 1000; 
                const minutesUntil = Math.round((arrivalTimeSec - nowSec) / 60);
                
                // Only show upcoming trains (within next 2 hours)
                if (minutesUntil >= -5 && minutesUntil <= 120) {
                  arrivals.push({
                    tripId: trip.trip.tripId,
                    directionId: trip.trip.directionId,
                    direction: trip.trip.directionId === 0 ? 'Southbound' : 'Northbound',
                    arrivalTime: arrivalTimeSec, // Keep in seconds for sorting
                    
                    // Use the corrected MS variable for formatting
                    arrivalTimeFormatted: new Date(arrivalTimeMs).toLocaleTimeString('en-US', {
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

    res.json({
      stopId,
      stopName: N_LINE_STOPS[targetStopId]?.name || stopId,
      timestamp: Date.now(),
      feedTimestamp: feedTimestamp,
      feedAgeMinutes: feedAge,
      arrivals: arrivals.slice(0, 10) // Return next 10 arrivals
    });

  } catch (error) {
    console.error('Stop arrivals error:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});


// Debug endpoint - see all N Line data from RTD
// (Left untouched as it's purely for debugging)
app.get('/api/rtd/debug', async (req, res) => {
  try {
    console.log('Fetching ALL RTD trip updates for debugging...');
    const response = await fetch(RTD_TRIP_UPDATES);
    const buffer = await response.arrayBuffer();
    
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    const nLineData = {
      timestamp: Date.now(),
      totalEntities: feed.entity.length,
      nLineTrips: [],
      allRoutes: new Set(),
      allStopIds: new Set()
    };
    
    feed.entity.forEach(entity => {
      if (entity.tripUpdate) {
        const routeId = entity.tripUpdate.trip.routeId;
        nLineData.allRoutes.add(routeId);
        
        if (routeId === 'N' || routeId === 'n' || routeId === '117N' || routeId.toLowerCase().includes('n-line') || routeId === '900') {
          const trip = entity.tripUpdate;
          const tripData = {
            tripId: trip.trip.tripId,
            routeId: trip.trip.routeId,
            directionId: trip.trip.directionId,
            stops: []
          };
          
          (trip.stopTimeUpdate || []).forEach(update => {
            nLineData.allStopIds.add(update.stopId);
            tripData.stops.push({
              stopId: update.stopId,
              arrivalTime: update.arrival?.time?.low,
              departureTime: update.departure?.time?.low
            });
          });
          
          nLineData.nLineTrips.push(tripData);
        }
      }
    });

    nLineData.allRoutes = Array.from(nLineData.allRoutes);
    nLineData.allStopIds = Array.from(nLineData.allStopIds);

    res.json(nLineData);

  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});


// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'RTD N Line API Proxy is running' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚆 RTD N Line API Proxy running on port ${PORT}`);
  console.log(`📍 Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`🚉 Example: http://0.0.0.0:${PORT}/api/rtd/arrivals/25287`);
});
