const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve web frontend files if needed
app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log(`\n========================================`);
  console.log(`[SOCKET CONNECTED] ID: ${socket.id}`);
  console.log(`Query Params:`, socket.handshake.query);
  console.log(`========================================\n`);

  // 1. Device Registration Event Listener
  socket.on('REGISTER_DEVICE', (data) => {
    console.log(`[EVENT: REGISTER_DEVICE] Received from ${socket.id}:`, data);
    
    // Store unit context on the socket instance
    socket.unit_id = data.unit_id;
    socket.role = data.role;

    // Join room for targeting specific units
    if (data.unit_id) {
      socket.join(data.unit_id);
    }

    // Broadcast registration to all connected web dashboards
    io.emit('DEVICE_REGISTERED', data);
  });

  // 2. Telemetry Report Listener (Android -> Server -> Dashboard)
  socket.on('TELEMETRY_REPORT', (data) => {
    console.log(`[EVENT: TELEMETRY_REPORT] Payload received:`, JSON.stringify(data, null, 2));

    // Re-broadcast to web clients (Leaflet map relies on this)
    io.emit('TELEMETRY_UPDATE', data);
  });

  // 3. Fallback Location Update Listener
  socket.on('LOCATION_UPDATE', (data) => {
    console.log(`[EVENT: LOCATION_UPDATE] Payload received:`, JSON.stringify(data, null, 2));
    io.emit('TELEMETRY_UPDATE', data);
  });

  // 4. Catch-all Debugger (Logs ANY event emitted by Android)
  socket.onAny((eventName, ...args) => {
    if (!['TELEMETRY_REPORT', 'LOCATION_UPDATE', 'REGISTER_DEVICE'].includes(eventName)) {
      console.log(`[UNKNOWN EVENT RECEIVED] Name: "${eventName}" | Data:`, args);
    }
  });

  // 5. Disconnect handling
  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET DISCONNECTED] ID: ${socket.id} | Unit: ${socket.unit_id || 'Unknown'} | Reason: ${reason}`);
    io.emit('DEVICE_OFFLINE', { unit_id: socket.unit_id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`HPG Dispatch Engine running on port ${PORT}`);
});