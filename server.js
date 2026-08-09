const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with permissive CORS for mobile and web apps
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7 // Increase buffer to 10MB to handle binary audio/video chunks
});

// Serve web console static assets from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// In-memory registry for tracking connected units
const activeUnits = {};

io.on('connection', (socket) => {
  const queryUnitId = socket.handshake.query.unit_id;
  const queryRole = socket.handshake.query.role;

  console.log(`\n========================================`);
  console.log(`[CLIENT CONNECTED] ID: ${socket.id}`);
  if (queryUnitId) console.log(`[REGISTERED UNIT] ID: ${queryUnitId} | Role: ${queryRole}`);
  console.log(`========================================\n`);

  // Default join to individual room if unit_id is provided in connection handshake
  if (queryUnitId) {
    socket.unit_id = queryUnitId;
    socket.join(queryUnitId);
  }

  // 1. DEVICE REGISTRATION
  socket.on('REGISTER_DEVICE', (data) => {
    const unitId = data.unit_id || queryUnitId;
    socket.unit_id = unitId;
    socket.role = data.role || queryRole || 'FIELD_RIDER';

    if (unitId) {
      socket.join(unitId);
      activeUnits[unitId] = {
        unit_id: unitId,
        socket_id: socket.id,
        role: socket.role,
        status: 'ONLINE',
        last_seen: new Date()
      };

      console.log(`[REGISTER_DEVICE] Unit "${unitId}" bound to room "${unitId}"`);
      io.emit('DEVICE_REGISTERED', activeUnits[unitId]);
    }
  });

  // 2. TELEMETRY REPORTING (Android -> Server -> Dashboard)
  socket.on('TELEMETRY_REPORT', (data) => {
    const unitId = data.unit_id || socket.unit_id || 'UNKNOWN_UNIT';

    // Normalize coordinates from flat or nested payloads
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
      timestamp: new Date()
    };

    // Update active unit state memory
    if (unitId !== 'UNKNOWN_UNIT') {
      activeUnits[unitId] = { ...activeUnits[unitId], ...normalizedPayload, status: 'ONLINE' };
    }

    // Broadcast live telemetry out to ALL connected web dashboard instances
    io.emit('TELEMETRY_UPDATE', normalizedPayload);
  });

  // 3. DISPATCH OVERRIDE COMMANDS (Dashboard -> Target Android Device)
  socket.on('DISPATCH_COMMAND', (command) => {
    const target = command.target_unit || 'ALL';
    console.log(`[DISPATCH_COMMAND] Target: ${target} | Action: ${command.action}`);

    if (target === 'ALL') {
      socket.broadcast.emit('EXECUTE_OVERRIDE', command);
    } else {
      io.to(target).emit('EXECUTE_OVERRIDE', command);
    }
  });

  // 4. PUSH-TO-TALK (PTT) AUDIO RELAY
  socket.on('AUDIO_STREAM_CHUNK', (data) => {
    const target = data.target_unit || 'ALL';

    if (target === 'ALL') {
      socket.broadcast.emit('RECEIVE_PTT_AUDIO', data);
    } else {
      io.to(target).emit('RECEIVE_PTT_AUDIO', data);
    }
  });

  // 5. CHAT SYSTEM RELAY
  socket.on('CHAT_MESSAGE', (data) => {
    console.log(`[CHAT] ${data.sender} -> ${data.target_unit}: ${data.text}`);
    if (data.target_unit === 'ALL') {
      io.emit('CHAT_MESSAGE', data);
    } else {
      io.to(data.target_unit).emit('CHAT_MESSAGE', data);
      socket.emit('CHAT_MESSAGE', data); // Echo back to sender
    }
  });

  // 6. WEBRTC SIGNALING RELAY (For Video Calling)
  socket.on('WEBRTC_SIGNAL', (data) => {
    console.log(`[WEBRTC SIGNAL] ${socket.id} -> Target: ${data.target_unit}`);
    if (data.target_unit) {
      io.to(data.target_unit).emit('WEBRTC_SIGNAL', {
        sender: socket.unit_id || 'DISPATCH_MAIN',
        signal: data.signal,
        type: data.type
      });
    }
  });

  // 7. DISCONNECT HANDLING
  socket.on('disconnect', (reason) => {
    console.log(`[DISCONNECTED] ID: ${socket.id} | Unit: ${socket.unit_id || 'Unknown'} | Reason: ${reason}`);
    if (socket.unit_id && activeUnits[socket.unit_id]) {
      activeUnits[socket.unit_id].status = 'OFFLINE';
      io.emit('DEVICE_OFFLINE', { unit_id: socket.unit_id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`  HPG Dispatch Engine Running on Port ${PORT}    `);
  console.log(`==================================================`);
});