const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/', (req, res) => res.send('MHDB Server Online'));

const rooms = {};

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ code, playerName, avatarId }) => {
    rooms[code] = [{ id: socket.id, name: playerName, avatarId }];
    socket.join(code);
    socket.emit('roomCreated', { code, members: rooms[code] });
    console.log(`Room created: ${code} by ${playerName}`);
  });

  socket.on('joinRoom', ({ code, playerName, avatarId }) => {
    if (!rooms[code]) {
      socket.emit('roomError', '방을 찾을 수 없습니다');
      return;
    }
    if (rooms[code].length >= 4) {
      socket.emit('roomError', '방이 가득 찼습니다');
      return;
    }
    rooms[code].push({ id: socket.id, name: playerName, avatarId });
    socket.join(code);
    io.to(code).emit('memberJoined', { members: rooms[code] });
    console.log(`${playerName} joined room ${code}`);
  });

  socket.on('startBattle', ({ roomCode }) => {
    io.to(roomCode).emit('battleStarted', { roomCode });
  });

  socket.on('leaveRoom', ({ roomCode, playerName }) => {
    if (rooms[roomCode]) {
      rooms[roomCode] = rooms[roomCode].filter(m => m.id !== socket.id);
      if (rooms[roomCode].length === 0) delete rooms[roomCode];
      else io.to(roomCode).emit('memberLeft', { playerName, members: rooms[roomCode] });
    }
    socket.leave(roomCode);
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(code => {
      const m = rooms[code] && rooms[code].find(m => m.id === socket.id);
      if (m) {
        rooms[code] = rooms[code].filter(x => x.id !== socket.id);
        if (rooms[code].length === 0) delete rooms[code];
        else io.to(code).emit('memberLeft', { playerName: m.name, members: rooms[code] });
      }
    });
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MHDB Server running on port ${PORT}`));
