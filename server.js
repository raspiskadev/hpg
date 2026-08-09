const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Enable Socket.IO with global CORS for web clients and Android
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve web frontend files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Store active unit states in memory
const activeUnits = {};

io.on('connection', (socket) => {
  const queryUnitId = socket.handshake.query.unit_id;
  const queryRole = socket.handshake.query.role;

  console.log(`\n----------------------------------------`);
  console.log(`[CONNECTED] Socket ID: ${socket.id}`);
  if (queryUnitId) console.log(`[UNIT INFO] ID: ${queryUnitId} | Role: ${queryRole}`);
  console.log(`----------------------------------------\n`);

  // Handle unit registration
  socket.on('REGISTER_DEVICE', (data) => {
    console.log(`[REGISTER_DEVICE]`, data);
    socket.unit_id = data.unit_id || queryUnitId;
    socket.role = data.role || queryRole;

    if (socket.unit_id) {
      socket.join(socket.unit_id);
      activeUnits[socket.unit_id] = {
        unit_id: socket.unit_id,
        socket_id: socket.id,
        status: 'ONLINE',
        last_seen: new Date()
      };
      
      // Notify all connected web dashboards
      io.emit('DEVICE_REGISTERED', activeUnits[socket.unit_id]);
    }
  });

  // Handle live telemetry incoming from Android
  socket.on('TELEMETRY_REPORT', (data) => {
    const unitId = data.unit_id || socket.unit_id;
    
    // Normalize coordinates for Leaflet map compatibility
    const lat = data.lat || data.latitude || (data.telemetry && data.telemetry.lat);
    const lng = data.lng || data.longitude || (data.telemetry && data.telemetry.lng);

    console.log(`[TELEMETRY_REPORT] Unit: ${unitId} | Lat: ${lat}, Lng: ${lng}`);

    const broadcastPayload = {
      unit_id: unitId,
      lat: lat,
      lng: lng,
      latitude: lat,
      longitude: lng,
      speed: data.current_speed_kmh || (data.telemetry && data.telemetry.current_speed_kmh) || 0,
      battery: data.phone_battery_pct || (data.telemetry && data.telemetry.phone_battery_pct) || 0,
      telemetry: data.telemetry || data,
      timestamp: new Date()
    };

    // Store latest state
    if (unitId) {
      activeUnits[unitId] = { ...activeUnits[unitId], ...broadcastPayload, status: 'ONLINE' };
    }

    // CRITICAL FIX: Broadcast payload out to ALL connected web browser dashboards
    io.emit('TELEMETRY_UPDATE', broadcastPayload);
  });

  // Relay Dispatcher Commands (Dashboard -> Android Device)
  socket.on('DISPATCH_COMMAND', (command) => {
    console.log(`[DISPATCH_COMMAND] Targeting ${command.target_unit}:`, command);
    if (command.target_unit) {
      // Send command directly to the target Android unit room
      io.to(command.target_unit).emit('EXECUTE_OVERRIDE', command);
    } else {
      // Broadcast to all units if no specific target is set
      io.emit('EXECUTE_OVERRIDE', command);
    }
  });

  // Disconnect handling
  socket.on('disconnect', (reason) => {
    console.log(`[DISCONNECTED] Socket ID: ${socket.id} | Unit: ${socket.unit_id || 'Unknown'} | Reason: ${reason}`);
    if (socket.unit_id && activeUnits[socket.unit_id]) {
      activeUnits[socket.unit_id].status = 'OFFLINE';
      io.emit('DEVICE_OFFLINE', { unit_id: socket.unit_id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`HPG Dispatch System Server listening on port ${PORT}`);
  console.log(`==================================================`);
});