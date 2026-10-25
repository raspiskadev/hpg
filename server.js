const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Live unit cache
const telemetryState = {
  unit_id: 'VOGE-500AC-01',
  lat: 14.5995,
  lng: 120.9842,
  speed: 0,
  heading: 0,
  telemetry: { lean_angle_deg: 0, pitch_deg: 0 }
};

app.post('/api/telemetry', (req, res) => {
  const data = req.body || {};
  const unitId = data.unit_id || 'VOGE-525-01';

  telemetryState.unit_id = unitId;

  // Merge GPS data if provided by Android App
  if (data.lat !== undefined) telemetryState.lat = Number(data.lat);
  if (data.lng !== undefined) telemetryState.lng = Number(data.lng);
  if (data.speed !== undefined) telemetryState.speed = Number(data.speed);
  if (data.heading !== undefined) telemetryState.heading = Number(data.heading);

  // Merge Tilt data if provided by ESP32
  if (data.telemetry) {
    if (data.telemetry.lean_angle_deg !== undefined) telemetryState.telemetry.lean_angle_deg = Number(data.telemetry.lean_angle_deg);
    if (data.telemetry.pitch_deg !== undefined) telemetryState.telemetry.pitch_deg = Number(data.telemetry.pitch_deg);
  }

  // Instant zero-delay broadcast to web dashboard
  io.emit('TELEMETRY_UPDATE', telemetryState);
  res.status(200).json({ status: 'OK' });
});

io.on('connection', (socket) => {
  socket.emit('TELEMETRY_UPDATE', telemetryState);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));