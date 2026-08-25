const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Serve web console static assets from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// Initialize Socket.IO with 10MB buffer for audio clips and video signaling
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7
});

// In-Memory Unit Registry
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

  // 2. TELEMETRY REPORTING (Mobile App -> Server -> Web Dashboard)
  const handleTelemetry = (data) => {
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

    io.emit('TELEMETRY_UPDATE', normalizedPayload);
    io.emit('TELEMETRY_BROADCAST', normalizedPayload);
  };

  socket.on('TELEMETRY_REPORT', handleTelemetry);
  socket.on('TELEMETRY_UPDATE', handleTelemetry);

  // 3. TACTICAL DISPATCH COMMANDS & OVERRIDES
  const handleDispatchCommand = (command) => {
    const target = command.target_unit || command.unit_id || 'HPG_GROUP_ALL';
    console.log(`[DISPATCH_COMMAND] Target: ${target} | Action: ${command.action}`);

    if (target === 'HPG_GROUP_ALL' || target === 'ALL') {
      socket.broadcast.emit('EXECUTE_OVERRIDE', command);
    } else {
      io.to(target).emit('EXECUTE_OVERRIDE', command);
      io.to(target).emit('DISPATCH_COMMAND', command);
    }
  };

  socket.on('DISPATCH_COMMAND', handleDispatchCommand);
  socket.on('DISPATCH_OVERRIDE_COMMAND', handleDispatchCommand);
  socket.on('EXECUTE_OVERRIDE', handleDispatchCommand);

  // 4. PUSH-TO-TALK (PTT) AUDIO RELAY ENGINE
  socket.on('PTT_AUDIO_TRANSMIT', (data) => {
    const target = data.target_unit || 'HPG_GROUP_ALL';
    console.log(`[PTT_TRANSMIT] Audio clip from ${data.sender || socket.unit_id} -> Target: ${target}`);

    if (target === 'HPG_GROUP_ALL' || target === 'ALL') {
      socket.broadcast.emit('PTT_AUDIO_RECEIVE', data);
      socket.broadcast.emit('CHAT_MESSAGE', {
        sender: data.sender || socket.unit_id,
        text: '[PTT_AUDIO]:' + data.audio_base64
      });
    } else {
      io.to(target).emit('PTT_AUDIO_RECEIVE', data);
      io.to(target).emit('CHAT_MESSAGE', {
        sender: data.sender || socket.unit_id,
        text: '[PTT_AUDIO]:' + data.audio_base64
      });
    }
  });

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
    console.log(`[CHAT] ${data.sender} -> ${data.target_unit || 'ALL'}: ${data.text || data.message}`);
    io.emit('CHAT_MESSAGE', data);
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

  // 6. WEBRTC UNIFIED SIGNALING RELAY
  socket.on('WEBRTC_OFFER', (data) => {
    console.log(`[WEBRTC OFFER] From: ${socket.unit_id || 'Console'} -> Target: ${data.target_unit}`);
    io.to(data.target_unit).emit('WEBRTC_OFFER', data);
  });

  socket.on('WEBRTC_ANSWER', (data) => {
    console.log(`[WEBRTC ANSWER] From: ${socket.unit_id || 'Mobile Unit'} -> Target: ${data.target_unit}`);
    io.to(data.target_unit).emit('WEBRTC_ANSWER', data);
  });

  socket.on('WEBRTC_ICE_CANDIDATE', (data) => {
    io.to(data.target_unit).emit('WEBRTC_ICE_CANDIDATE', data);
  });

  socket.on('WEBRTC_HANGUP', (data) => {
    console.log(`[WEBRTC HANGUP] Signal sent to target: ${data.target_unit}`);
    io.to(data.target_unit).emit('WEBRTC_HANGUP', data);
  });

  socket.on('JOIN_AUDIO_ROOM', (data) => {
    const roomId = data.room_id || 'TACTICAL_VOICE_MAIN';
    socket.join(roomId);
    socket.to(roomId).emit('VOICE_SIGNAL', {
      type: 'PEER_JOINED',
      unit_id: data.unit_id,
      socket_id: socket.id
    });
  });

  socket.on('LEAVE_AUDIO_ROOM', (data) => {
    const roomId = data.room_id || 'TACTICAL_VOICE_MAIN';
    socket.leave(roomId);
  });

  socket.on('VOICE_SIGNAL', (signalPayload) => {
    const targetSocketId = signalPayload.target_socket_id;
    if (targetSocketId) {
      io.to(targetSocketId).emit('VOICE_SIGNAL', signalPayload);
    } else {
      socket.broadcast.emit('VOICE_SIGNAL', signalPayload);
    }
  });

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