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

  // Forward telemetry from Android gateway to all connected web dashboards
  socket.on('TELEMETRY_UPDATE', (data) => {
    socket.broadcast.emit('TELEMETRY_PAYLOAD', data);
  });

  // Relay command events from web dashboard to Android gateway
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