const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with permissive CORS for mobile Android app and Web Dashboard
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7 // 10MB buffer for audio chunks and video binary data
});

// Serve web console static assets from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory registry for tracking connected patrol units
const activeUnits = {};

// Diagnostics Endpoint
app.get('/api/active-units', (req, res) => {
  res.json({
    status: 'ONLINE',
    agency: 'PNP-HPG Tactical Operations',
    active_count: Object.keys(activeUnits).length,
    units: activeUnits
  });
});

io.on('connection', (socket) => {
  const queryUnitId = socket.handshake.query.unit_id;
  const queryRole = socket.handshake.query.role;

  console.log(`\n========================================`);
  console.log(`[CLIENT CONNECTED] Socket ID: ${socket.id}`);
  if (queryUnitId) console.log(`[REGISTERED UNIT] ID: ${queryUnitId} | Role: ${queryRole}`);
  console.log(`========================================\n`);

  // Auto-join unit room if unit_id passed in handshake
  if (queryUnitId) {
    socket.unit_id = queryUnitId;
    socket.role = queryRole || 'PATROL_UNIT';
    socket.join(queryUnitId);

    activeUnits[queryUnitId] = {
      unit_id: queryUnitId,
      socket_id: socket.id,
      role: socket.role,
      status: 'ONLINE',
      last_seen: new Date()
    };
  }

  // 1. DEVICE REGISTRATION
  socket.on('REGISTER_DEVICE', (data) => {
    const unitId = data.unit_id || socket.unit_id || queryUnitId;
    socket.unit_id = unitId;
    socket.role = data.role || queryRole || 'PATROL_UNIT';

    if (unitId) {
      socket.join(unitId);
      activeUnits[unitId] = {
        unit_id: unitId,
        socket_id: socket.id,
        role: socket.role,
        agency: data.agency || 'PNP-HPG',
        status: 'ONLINE',
        last_seen: new Date()
      };

      console.log(`[REGISTER_DEVICE] HPG Unit "${unitId}" bound to room "${unitId}"`);
      io.emit('DEVICE_REGISTERED', activeUnits[unitId]);
    }
  });

  // 2. TELEMETRY REPORTING (Android Field App -> Server -> Command Console)
  socket.on('TELEMETRY_REPORT', (data) => {
    const unitId = data.unit_id || socket.unit_id || 'UNKNOWN_UNIT';

    const lat = data.lat || data.latitude || (data.telemetry && (data.telemetry.lat || data.telemetry.latitude));
    const lng = data.lng || data.longitude || (data.telemetry && (data.telemetry.lng || data.telemetry.longitude));
    const speed = data.speed || data.current_speed_kmh || (data.telemetry && data.telemetry.current_speed_kmh) || 0;
    const battery = data.battery || data.phone_battery_pct || (data.telemetry && data.telemetry.phone_battery_pct) || 0;
    const status = data.status || (data.telemetry && data.telemetry.status) || 'PATROLLING';

    const normalizedPayload = {
      unit_id: unitId,
      lat: Number(lat),
      lng: Number(lng),
      latitude: Number(lat),
      longitude: Number(lng),
      speed: Number(speed),
      battery: Number(battery),
      status: status,
      is_locked: data.is_locked !== undefined ? data.is_locked : false,
      timestamp: new Date()
    };

    if (unitId !== 'UNKNOWN_UNIT') {
      activeUnits[unitId] = { ...activeUnits[unitId], ...normalizedPayload, status: 'ONLINE', last_seen: new Date() };
    }

    // Broadcast live telemetry out to all listening dashboard consoles
    io.emit('TELEMETRY_UPDATE', normalizedPayload);
  });

  // 3. TACTICAL DISPATCH COMMANDS & ENGINE OVERRIDE (Command Console -> Target Patrol Unit)
  socket.on('DISPATCH_COMMAND', (command) => {
    const target = command.target_unit || 'HPG_GROUP_ALL';
    console.log(`[DISPATCH_COMMAND] Target: ${target} | Action: ${command.action}`);

    if (target === 'HPG_GROUP_ALL' || target === 'ALL') {
      socket.broadcast.emit('EXECUTE_OVERRIDE', command);
    } else {
      io.to(target).emit('EXECUTE_OVERRIDE', command);
    }
  });

  socket.on('DISPATCH_OVERRIDE_COMMAND', (command) => {
    const target = command.target_unit || 'HPG_GROUP_ALL';
    console.log(`[OVERRIDE_COMMAND] Target: ${target} | Action: ${command.action}`);

    if (target === 'HPG_GROUP_ALL' || target === 'ALL') {
      socket.broadcast.emit('EXECUTE_OVERRIDE', command);
    } else {
      io.to(target).emit('EXECUTE_OVERRIDE', command);
    }
  });

  // 4. PUSH-TO-TALK (PTT) AUDIO RELAY ENGINE
  socket.on('PTT_AUDIO_CHUNK', (data) => {
    const target = data.target_unit || 'HPG_GROUP_ALL';

    if (target === 'HPG_GROUP_ALL' || target === 'ALL') {
      socket.broadcast.emit('PTT_AUDIO_CHUNK', data);
    } else {
      io.to(target).emit('PTT_AUDIO_CHUNK', data);
    }
  });

  // 5. CHAT & CAD INCIDENT DISPATCH MESSAGING
  socket.on('CHAT_MESSAGE', (data) => {
    const target = data.target_unit || data.recipient || 'HPG_GROUP_ALL';
    console.log(`[CHAT] ${data.sender} -> ${target}: ${data.text}`);

    if (target === 'HPG_GROUP_ALL' || target === 'ALL') {
      io.emit('CHAT_MESSAGE', data);
    } else {
      io.to(target).emit('CHAT_MESSAGE', data);
      socket.emit('CHAT_MESSAGE', data); // Local echo
    }
  });

  socket.on('TACTICAL_MESSAGE', (data) => {
    const target = data.recipient || data.target_unit || 'HPG_GROUP_ALL';
    console.log(`[TACTICAL CAD MSG] ${data.sender} -> ${target}`);

    if (target === 'HPG_GROUP_ALL' || target === 'ALL') {
      io.emit('TACTICAL_MESSAGE', data);
    } else {
      io.to(target).emit('TACTICAL_MESSAGE', data);
      socket.emit('TACTICAL_MESSAGE', data);
    }
  });

  // 6. WEBRTC UNIFIED SIGNALING RELAY (Video / Duplex Audio Calls)
  socket.on('SIGNAL_EXCHANGE', (data) => {
    const target = data.target_id || data.target_unit;
    console.log(`[WEBRTC SIGNAL] ${data.sender_id || socket.id} -> Target Unit: ${target}`);
    
    if (target) {
      io.to(target).emit('SIGNAL_EXCHANGE', data);
    }
  });

  // Fallbacks for legacy WebRTC individual events
  socket.on('WEBRTC_OFFER', (data) => io.to(data.target_unit).emit('WEBRTC_OFFER', data));
  socket.on('WEBRTC_ANSWER', (data) => io.to(data.target_unit).emit('WEBRTC_ANSWER', data));
  socket.on('ICE_CANDIDATE', (data) => io.to(data.target_unit).emit('ICE_CANDIDATE', data));

  // 7. DISCONNECT HANDLING
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
  console.log(`  PNP-HPG Tactical Dispatch Engine Active          `);
  console.log(`  Listening on Port: ${PORT}                      `);
  console.log(`==================================================`);
});