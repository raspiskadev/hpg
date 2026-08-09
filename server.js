const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO Connection Logic
io.on('connection', (socket) => {
  console.log(`Device connected: ${socket.id}`);

  socket.on('REGISTER_DEVICE', (data) => {
    socket.join(`room_${data.unit_id}`);
    socket.join('room_hpg_squad');
    console.log(`${data.unit_id} joined private and group channels`);
  });

  socket.on('SIGNAL_EXCHANGE', (payload) => {
    io.to(`room_${payload.target_id}`).emit('SIGNAL_EXCHANGE', {
      sender_id: payload.sender_id,
      signalData: payload.signalData
    });
  });

  socket.on('TACTICAL_MESSAGE', (messageData) => {
    if (messageData.recipient === 'ALL') {
      io.to('room_hpg_squad').emit('TACTICAL_MESSAGE', messageData);
    } else {
      io.to(`room_${messageData.recipient}`).emit('TACTICAL_MESSAGE', messageData);
    }
  });

  socket.on('PTT_AUDIO_CHUNK', (data) => {
    if (data.target_unit === 'ALL') {
      io.to('room_hpg_squad').emit('PTT_AUDIO_CHUNK', data);
    } else {
      io.to(`room_${data.target_unit}`).emit('PTT_AUDIO_CHUNK', data);
    }
  });

  socket.on('DISPATCH_OVERRIDE_COMMAND', (commandPayload) => {
    io.to(`room_${commandPayload.target_unit}`).emit('EXECUTE_OVERRIDE', commandPayload);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Render server listening on port ${PORT}`);
});