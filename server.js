const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

const publicDir = path.join(__dirname, 'public');
const rootDir = __dirname;
const MAX_ROOM_MEMBERS = 4;

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

function serializeMember(member) {
  return {
    id: member.id,
    name: member.name,
    avatarId: member.avatarId,
    title: member.title || '',
    damage: member.damage || 0,
    active: member.active !== false
  };
}

function serializeRoom(room) {
  return {
    code: room.code,
    roomCode: room.code,
    hostId: room.hostId,
    ownerId: room.hostId,
    hostName: room.hostName || '',
    monsterId: room.monsterId || null,
    isDragon: !!room.isDragon,
    started: !!room.started,
    memberCount: room.members.length,
    members: room.members.map(serializeMember),
    battle: room.battle
      ? {
          active: !!room.battle.active,
          ended: !!room.battle.ended,
          win: !!room.battle.win,
          currentHp: room.battle.currentHp,
          maxHp: room.battle.maxHp,
          timeLeft: room.battle.timeLeft,
          monsterId: room.battle.monsterId || room.monsterId || null,
          dragonId: room.battle.dragonId || null,
          isDragon: !!room.battle.isDragon
        }
      : null
  };
}

function listOpenRooms() {
  return Object.values(rooms)
    .filter((room) => !room.started)
    .map(serializeRoom);
}

function emitRoomList(targetSocket = null) {
  const payload = { rooms: listOpenRooms() };
  if (targetSocket) {
    targetSocket.emit('roomList', payload);
    targetSocket.emit('roomsList', payload);
    return;
  }
  io.emit('roomList', payload);
  io.emit('roomsList', payload);
}

function emitRoomUpdated(room) {
  const payload = { room: serializeRoom(room) };
  io.emit('roomUpdated', payload);
  io.to(room.code).emit('roomUpdated', payload);
}

function emitRoomClosed(code) {
  const payload = { code, roomCode: code };
  io.emit('roomClosed', payload);
  io.to(code).emit('roomClosed', payload);
}

function getRoom(code) {
  return rooms[code] || null;
}

function getRoomMember(room, socketId) {
  return room.members.find((m) => m.id === socketId) || null;
}

function promoteHostIfNeeded(room) {
  if (!room.members.length) return;
  const currentHost = room.members.find((m) => m.id === room.hostId);
  if (currentHost) {
    room.hostName = currentHost.name || room.hostName || '';
    return;
  }
  const nextHost = room.members[0];
  room.hostId = nextHost.id;
  room.hostName = nextHost.name || '';
}

function clearBattleTick(room) {
  if (room && room.battle && room.battle.tick) {
    clearInterval(room.battle.tick);
    room.battle.tick = null;
  }
}

function destroyRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearBattleTick(room);
  delete rooms[code];
  emitRoomClosed(code);
  emitRoomList();
}

function emitBattleState(code, extra = {}) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('battleState', {
    roomCode: code,
    members: room.members.map(serializeMember),
    battle: room.battle
      ? {
          active: !!room.battle.active,
          currentHp: room.battle.currentHp,
          maxHp: room.battle.maxHp,
          timeLeft: room.battle.timeLeft,
          win: !!room.battle.win,
          ended: !!room.battle.ended,
          monsterId: room.battle.monsterId || room.monsterId || null,
          dragonId: room.battle.dragonId || null,
          isDragon: !!room.battle.isDragon
        }
      : null,
    ...extra
  });
}

function endBattle(code, win, reason = '') {
  const room = rooms[code];
  if (!room || !room.battle || room.battle.ended) return;
  room.battle.active = false;
  room.battle.ended = true;
  room.battle.win = !!win;
  clearBattleTick(room);
  const members = room.members.map(serializeMember).sort((a, b) => (b.damage || 0) - (a.damage || 0));
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
      win: !!win,
      monsterId: room.battle.monsterId || room.monsterId || null,
      dragonId: room.battle.dragonId || null,
      isDragon: !!room.battle.isDragon
    }
  });
}

function createBattle(room, battleInfo = {}) {
  const hpBase = battleInfo.isDragon ? 52000 : 18000;
  const timeLeft = battleInfo.isDragon ? 60 : 30;
  room.started = true;
  room.monsterId = battleInfo.monsterId || room.monsterId || null;
  room.isDragon = !!battleInfo.isDragon;
  room.battle = {
    active: true,
    ended: false,
    win: false,
    currentHp: hpBase,
    maxHp: hpBase,
    timeLeft,
    isDragon: !!battleInfo.isDragon,
    monsterId: battleInfo.monsterId || null,
    dragonId: battleInfo.dragonId || null,
    tick: null
  };
  room.members.forEach((m) => {
    m.damage = 0;
    m.active = true;
  });
  emitRoomUpdated(room);
  emitRoomList();
  room.battle.tick = setInterval(() => {
    if (!room.battle || !room.battle.active) return;
    room.battle.timeLeft -= 1;
    if (room.battle.timeLeft <= 0) {
      room.battle.timeLeft = 0;
      endBattle(room.code, false, 'timeout');
      return;
    }
    emitBattleState(room.code);
  }, 1000);
}

function makeRoom(code, hostSocketId, payload = {}) {
  return {
    code,
    hostId: hostSocketId,
    hostName: payload.playerName || 'Player',
    monsterId: payload.monsterId || null,
    isDragon: !!payload.isDragon,
    started: false,
    battle: null,
    members: [
      {
        id: hostSocketId,
        name: payload.playerName || 'Player',
        avatarId: payload.avatarId,
        title: payload.title || '',
        damage: 0,
        active: true
      }
    ]
  };
}

function leaveRoomInternal(socket, roomCode, playerName, mode = 'room') {
  const room = getRoom(roomCode);
  if (!room) return;
  const member = getRoomMember(room, socket.id);
  if (!member) return;

  room.members = room.members.filter((m) => m.id !== socket.id);
  socket.leave(roomCode);

  if (!room.members.length) {
    destroyRoom(roomCode);
    return;
  }

  if (mode === 'battle') member.active = false;
  promoteHostIfNeeded(room);

  const eventName = mode === 'battle' ? 'memberLeftBattle' : 'memberLeft';
  io.to(roomCode).emit(eventName, {
    roomCode,
    playerName: playerName || member.name || 'Player',
    hostId: room.hostId,
    members: room.members.map(serializeMember),
    battle: room.battle
      ? {
          active: !!room.battle.active,
          currentHp: room.battle.currentHp,
          maxHp: room.battle.maxHp,
          timeLeft: room.battle.timeLeft,
          monsterId: room.battle.monsterId || room.monsterId || null,
          dragonId: room.battle.dragonId || null,
          isDragon: !!room.battle.isDragon
        }
      : null
  });

  if (!room.started) {
    emitRoomUpdated(room);
    emitRoomList();
  }

  if (room.battle && room.battle.active && room.members.length === 0) {
    endBattle(roomCode, false, 'all_left');
    destroyRoom(roomCode);
  }
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  const sendRoomList = () => emitRoomList(socket);

  socket.on('listRooms', sendRoomList);
  socket.on('getRooms', sendRoomList);
  socket.on('requestRoomList', sendRoomList);

  socket.on('createRoom', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    if (!code) return socket.emit('roomError', 'Invalid room code');
    if (rooms[code] && !rooms[code].started) return socket.emit('joinRejected', '이미 존재하는 방입니다.');

    const room = makeRoom(code, socket.id, payload);
    rooms[code] = room;
    socket.join(code);

    const serialized = serializeRoom(room);
    socket.emit('roomCreated', serialized);
    emitRoomUpdated(room);
    emitRoomList();
    console.log(`Room created: ${code} by ${room.hostName}`);
  });

  socket.on('joinRoom', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const room = getRoom(code);
    if (!room) return socket.emit('joinRejected', '방을 찾을 수 없습니다.');
    if (room.started || (room.battle && room.battle.active)) return socket.emit('joinRejected', '이미 시작된 방입니다.');
    if (room.members.length >= MAX_ROOM_MEMBERS) return socket.emit('joinRejected', '방이 가득 찼습니다.');
    if (getRoomMember(room, socket.id)) return socket.emit('roomError', '이미 참가 중입니다.');

    room.members.push({
      id: socket.id,
      name: payload.playerName || 'Player',
      avatarId: payload.avatarId,
      title: payload.title || '',
      damage: 0,
      active: true
    });
    socket.join(code);

    const data = {
      roomCode: code,
      hostId: room.hostId,
      members: room.members.map(serializeMember)
    };
    io.to(code).emit('memberJoined', data);
    emitRoomUpdated(room);
    emitRoomList();
    console.log(`${payload.playerName || 'Player'} joined room ${code}`);
  });

  socket.on('kickMember', ({ roomCode, targetId } = {}) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('roomError', '방장만 강퇴할 수 있습니다.');
    if (!targetId || targetId === socket.id) return socket.emit('roomError', '해당 참가자를 강퇴할 수 없습니다.');

    const target = getRoomMember(room, targetId);
    if (!target) return socket.emit('roomError', '대상을 찾을 수 없습니다.');

    room.members = room.members.filter((m) => m.id !== targetId);
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.leave(roomCode);
      targetSocket.emit('memberKicked', {
        roomCode,
        targetId,
        members: room.members.map(serializeMember)
      });
      targetSocket.emit('kickedFromRoom', { roomCode, targetId });
    }

    io.to(roomCode).emit('memberKicked', {
      roomCode,
      targetId,
      playerName: target.name,
      members: room.members.map(serializeMember)
    });

    if (!room.members.length) {
      destroyRoom(roomCode);
      return;
    }

    promoteHostIfNeeded(room);
    emitRoomUpdated(room);
    emitRoomList();
  });

  socket.on('startBattle', ({ roomCode, battle } = {}) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('roomError', '방장만 시작할 수 있습니다.');
    if (room.battle && room.battle.active) return;

    createBattle(room, battle || {});
    io.to(roomCode).emit('battleStarted', {
      roomCode,
      members: room.members.map(serializeMember),
      battle: {
        currentHp: room.battle.currentHp,
        maxHp: room.battle.maxHp,
        timeLeft: room.battle.timeLeft,
        monsterId: room.battle.monsterId || room.monsterId || null,
        dragonId: room.battle.dragonId || null,
        isDragon: !!room.battle.isDragon
      }
    });
  });

  socket.on('dealDamage', ({ roomCode, damage, title, playerName } = {}) => {
    const room = getRoom(roomCode);
    if (!room || !room.battle || !room.battle.active) return;
    const member = getRoomMember(room, socket.id);
    if (!member || member.active === false) return;

    if (title) member.title = title;
    if (playerName) member.name = playerName;
    const dmg = Math.max(0, Number(damage) || 0);
    if (!dmg) return;

    member.damage = (member.damage || 0) + dmg;
    room.battle.currentHp = Math.max(0, room.battle.currentHp - dmg);
    emitBattleState(roomCode);
    if (room.battle.currentHp <= 0) endBattle(roomCode, true, 'kill');
  });

  socket.on('leaveBattle', ({ roomCode, playerName } = {}) => {
    leaveRoomInternal(socket, roomCode, playerName, 'battle');
  });

  socket.on('leaveRoom', ({ roomCode, playerName } = {}) => {
    leaveRoomInternal(socket, roomCode, playerName, 'room');
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach((code) => {
      const room = rooms[code];
      if (!room || !getRoomMember(room, socket.id)) return;
      leaveRoomInternal(socket, code, '', room.battle && room.battle.active ? 'battle' : 'room');
    });
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MHDB Server running on port ${PORT}`));
