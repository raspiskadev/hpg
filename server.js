const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static('public'));

io.on('connection', (socket) => {
  const role = socket.handshake.query.role || 'DASHBOARD';
  console.log(`[+] New Connection (${role}): ${socket.id}`);

  // Forward telemetry updates from Android to Web Dashboards
  socket.on('TELEMETRY_UPDATE', (data) => {
    socket.broadcast.emit('TELEMETRY_PAYLOAD', data);
  });

  // NEW: Forward incoming camera frames from Android to Web Dashboards
  socket.on('CAMERA_STREAM_FRAME', (data) => {
    socket.broadcast.emit('CAMERA_FRAME_PAYLOAD', data);
  });

  // Relay command events from Web Dashboard to Android Gateway
  socket.on('COMMAND_TRIGGER', (cmd) => {
    console.log(`[CMD] Relaying command to unit: ${cmd.action}`);
    io.emit('GATEWAY_EXEC_COMMAND', cmd);
  });

  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[🚀] Command Dashboard Server running on port ${PORT}`));