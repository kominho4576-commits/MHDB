const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

const publicDir = path.join(__dirname, 'public');
const rootDir = __dirname;

if (fs.existsSync(publicDir)) app.use(express.static(publicDir));
app.use(express.static(rootDir));

app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/', (req, res) => {
  const publicIndex = path.join(publicDir, 'index.html');
  const rootIndex = path.join(rootDir, 'index.html');
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  return res.send('MHDB Server Online');
});

const rooms = {};

function cleanRoom(code) {
  const room = rooms[code];
  if (!room) return;
  room.members = room.members.filter(Boolean);
  if (!room.members.length) delete rooms[code];
}

function getRoomMember(code, socketId) {
  const room = rooms[code];
  if (!room) return null;
  return room.members.find(m => m.id === socketId) || null;
}

function serializeRoom(room) {
  return room.members.map(m => ({
    id: m.id,
    name: m.name,
    avatarId: m.avatarId,
    title: m.title || '',
    damage: m.damage || 0,
    active: m.active !== false
  }));
}

function emitRoomState(code, extra = {}) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('battleState', {
    roomCode: code,
    members: serializeRoom(room),
    battle: room.battle ? {
      active: !!room.battle.active,
      currentHp: room.battle.currentHp,
      maxHp: room.battle.maxHp,
      timeLeft: room.battle.timeLeft,
      win: room.battle.win,
      ended: !!room.battle.ended
    } : null,
    ...extra
  });
}

function endBattle(code, win, reason = '') {
  const room = rooms[code];
  if (!room || !room.battle || room.battle.ended) return;
  room.battle.active = false;
  room.battle.ended = true;
  room.battle.win = !!win;
  if (room.battle.tick) {
    clearInterval(room.battle.tick);
    room.battle.tick = null;
  }
  const members = serializeRoom(room).sort((a, b) => (b.damage || 0) - (a.damage || 0));
  io.to(code).emit('battleEnded', {
    roomCode: code,
    win: !!win,
    reason,
    members,
    battle: {
      currentHp: room.battle.currentHp,
      maxHp: room.battle.maxHp,
      timeLeft: room.battle.timeLeft,
      ended: true,
      win: !!win
    }
  });
}

function createBattle(room, battleInfo) {
  const hpBase = battleInfo && battleInfo.isDragon ? 52000 : 18000;
  const timeLeft = battleInfo && battleInfo.isDragon ? 60 : 30;
  room.battle = {
    active: true,
    ended: false,
    currentHp: hpBase,
    maxHp: hpBase,
    timeLeft,
    isDragon: !!(battleInfo && battleInfo.isDragon),
    monsterId: battleInfo ? battleInfo.monsterId : null,
    dragonId: battleInfo ? battleInfo.dragonId : null,
    tick: null
  };
  room.members.forEach(m => { m.damage = 0; m.active = true; });
  room.battle.tick = setInterval(() => {
    if (!room.battle || !room.battle.active) return;
    room.battle.timeLeft -= 1;
    if (room.battle.timeLeft <= 0) {
      room.battle.timeLeft = 0;
      endBattle(room.code, false, 'timeout');
      return;
    }
    emitRoomState(room.code);
  }, 1000);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ code, playerName, avatarId, title }) => {
    rooms[code] = { code, members: [{ id: socket.id, name: playerName, avatarId, title: title || '', damage: 0, active: true }], battle: null };
    socket.join(code);
    socket.emit('roomCreated', { code, members: serializeRoom(rooms[code]) });
    console.log(`Room created: ${code} by ${playerName}`);
  });

  socket.on('joinRoom', ({ code, playerName, avatarId, title }) => {
    const room = rooms[code];
    if (!room) return socket.emit('roomError', 'Room not found');
    if (room.members.length >= 4) return socket.emit('roomError', 'Room is full');
    room.members.push({ id: socket.id, name: playerName, avatarId, title: title || '', damage: 0, active: true });
    socket.join(code);
    io.to(code).emit('memberJoined', { members: serializeRoom(room) });
    console.log(`${playerName} joined room ${code}`);
  });

  socket.on('startBattle', ({ roomCode, battle }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.battle && room.battle.active) return;
    createBattle(room, battle || {});
    io.to(roomCode).emit('battleStarted', {
      roomCode,
      members: serializeRoom(room),
      battle: {
        currentHp: room.battle.currentHp,
        maxHp: room.battle.maxHp,
        timeLeft: room.battle.timeLeft
      }
    });
  });

  socket.on('dealDamage', ({ roomCode, damage, title, playerName }) => {
    const room = rooms[roomCode];
    if (!room || !room.battle || !room.battle.active) return;
    const member = getRoomMember(roomCode, socket.id);
    if (!member || member.active === false) return;
    if (title) member.title = title;
    if (playerName) member.name = playerName;
    const dmg = Math.max(0, Number(damage) || 0);
    if (!dmg) return;
    member.damage = (member.damage || 0) + dmg;
    room.battle.currentHp = Math.max(0, room.battle.currentHp - dmg);
    emitRoomState(roomCode);
    if (room.battle.currentHp <= 0) endBattle(roomCode, true, 'kill');
  });

  socket.on('leaveBattle', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const member = getRoomMember(roomCode, socket.id);
    if (member) {
      member.active = false;
      room.members = room.members.filter(m => m.id !== socket.id);
    }
    socket.leave(roomCode);
    if (!room.members.length) {
      if (room.battle && room.battle.active) endBattle(roomCode, false, 'all_left');
      delete rooms[roomCode];
      return;
    }
    io.to(roomCode).emit('memberLeftBattle', { playerName: playerName || (member && member.name) || 'Player', members: serializeRoom(room), battle: room.battle });
  });

  socket.on('leaveRoom', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.members = room.members.filter(m => m.id !== socket.id);
    socket.leave(roomCode);
    if (!room.members.length) {
      if (room.battle && room.battle.tick) clearInterval(room.battle.tick);
      delete rooms[roomCode];
    } else {
      io.to(roomCode).emit('memberLeft', { playerName: playerName || 'Player', members: serializeRoom(room) });
    }
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(code => {
      const room = rooms[code];
      const member = room.members.find(m => m.id === socket.id);
      if (!member) return;
      room.members = room.members.filter(m => m.id !== socket.id);
      if (!room.members.length) {
        if (room.battle && room.battle.tick) clearInterval(room.battle.tick);
        delete rooms[code];
      } else {
        io.to(code).emit(room.battle && room.battle.active ? 'memberLeftBattle' : 'memberLeft', {
          playerName: member.name,
          members: serializeRoom(room),
          battle: room.battle
        });
      }
    });
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MHDB Server running on port ${PORT}`));
