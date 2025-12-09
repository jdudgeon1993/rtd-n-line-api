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

// Enable CORS for all origins
app.use(cors());
app.use(express.json());

// Your TransitLand API key
const TRANSITLAND_API_KEY = 'TXTmQ3It74ub7L4huB6mgBxUJ824DRLG';

// RTD GTFS-RT feed URLs
const RTD_TRIP_UPDATES = 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/TripUpdate.pb';
const RTD_VEHICLE_POSITIONS = 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb';

// N Line stop IDs (from RTD GTFS data)
// Note: RTD uses various formats, so we check multiple possibilities
const N_LINE_STOPS = {
  'ustn': { name: 'Union Station', id: 'ustn' },
  'union': { name: 'Union Station', id: 'union' },
  'unionstation': { name: 'Union Station', id: 'unionstation' },
  '48th': { name: '48th & Brighton/National Western Center', id: '48th' },
  '48thbrighton': { name: '48th & Brighton/National Western Center', id: '48thbrighton' },
  '72nd': { name: 'Commerce City/72nd', id: '72nd' },
  '72ndcommercecity': { name: 'Commerce City/72nd', id: '72ndcommercecity' },
  '88th': { name: 'Original Thornton/88th', id: '88th' },
  '88ththornton': { name: 'Original Thornton/88th', id: '88ththornton' },
  '104th': { name: 'Thornton Crossroads/104th', id: '104th' },
  '104ththornton': { name: 'Thornton Crossroads/104th', id: '104ththornton' },
  '112th': { name: 'Northglenn/112th', id: '112th' },
  '112thnorthglenn': { name: 'Northglenn/112th', id: '112thnorthglenn' },
  '124th': { name: 'Eastlake/124th', id: '124th' },
  '124theastlake': { name: 'Eastlake/124th', id: '124theastlake' }
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
    const response = await fetch(RTD_TRIP_UPDATES);
    const buffer = await response.arrayBuffer();
    
    // Parse the protocol buffer
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    // Filter for N Line trips only
    const nLineArrivals = [];
    
    feed.entity.forEach(entity => {
      if (entity.tripUpdate && entity.tripUpdate.trip.routeId === 'N') {
        const trip = entity.tripUpdate;
        const stopTimeUpdates = trip.stopTimeUpdate || [];
        
        stopTimeUpdates.forEach(update => {
          const stopId = update.stopId.toLowerCase();
          
          // Check if this is an N Line stop
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

    // Sort by arrival time
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

// Get arrivals for a specific stop
app.get('/api/rtd/arrivals/:stopId', async (req, res) => {
  try {
    const { stopId } = req.params;
    console.log(`Fetching arrivals for stop: ${stopId}`);
    
    const response = await fetch(RTD_TRIP_UPDATES);
    const buffer = await response.arrayBuffer();
    
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    const arrivals = [];
    
    feed.entity.forEach(entity => {
      if (entity.tripUpdate && entity.tripUpdate.trip.routeId === 'N') {
        const trip = entity.tripUpdate;
        const stopTimeUpdates = trip.stopTimeUpdate || [];
        
        stopTimeUpdates.forEach(update => {
          if (update.stopId.toLowerCase() === stopId.toLowerCase()) {
            const arrivalTime = update.arrival?.time?.low || update.departure?.time?.low;
            
            if (arrivalTime) {
              const minutesUntil = Math.round((arrivalTime - Date.now() / 1000) / 60);
              
              // Only show upcoming trains (within next 2 hours)
              if (minutesUntil >= -2 && minutesUntil <= 120) {
                arrivals.push({
                  tripId: trip.trip.tripId,
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
    });

    arrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);

    res.json({
      stopId,
      stopName: N_LINE_STOPS[stopId.toLowerCase()]?.name || stopId,
      timestamp: Date.now(),
      arrivals: arrivals.slice(0, 10) // Return next 10 arrivals
    });

  } catch (error) {
    console.error('Stop arrivals error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint - see all N Line data from RTD
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
        
        if (routeId === 'N' || routeId === 'n' || routeId.toLowerCase().includes('n-line')) {
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
  console.log(`🚉 Example: http://0.0.0.0:${PORT}/api/rtd/arrivals/ustn`);
});