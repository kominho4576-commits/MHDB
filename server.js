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
  pingInterval: 25000,
});

const publicDir = path.join(__dirname, 'public');
const rootDir = __dirname;
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));
app.use(express.static(rootDir));
app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/', (req, res) => {
  const pi = path.join(publicDir, 'index.html');
  const ri = path.join(rootDir, 'index.html');
  if (fs.existsSync(pi)) return res.sendFile(pi);
  if (fs.existsSync(ri)) return res.sendFile(ri);
  return res.send('MHDB Server Online');
});

const partyRooms = {};
const raidRooms = {};
const RECONNECT_GRACE_MS = 30000;

function normalizeName(v) {
  return String(v || 'Player').trim().slice(0, 24);
}
function playerKey({ playerName, avatarId }) {
  return `${normalizeName(playerName).toLowerCase()}__${String(avatarId || 'default')}`;
}
function computePartyMonsterHp(baseHp, memberCount) {
  const base = Math.max(0, Number(baseHp) || 0);
  const count = Math.max(1, Number(memberCount) || 1);
  return Math.floor(base * 5 * (1 + 0.5 * (count - 1)));
}
function makeMember(socket, payload, startTime = 30) {
  return {
    id: socket.id,
    socketId: socket.id,
    playerKey: playerKey(payload),
    name: normalizeName(payload.playerName),
    avatarId: payload.avatarId,
    title: String(payload.title || ''),
    damage: 0,
    active: true,
    alive: true,
    connected: true,
    timeLeft: startTime,
    waitingReward: true,
    leftEarly: false,
    graceTimer: null,
  };
}
function serializeMember(m) {
  return {
    id: m.socketId || m.id,
    name: m.name,
    avatarId: m.avatarId,
    title: m.title || '',
    damage: m.damage || 0,
    active: m.active !== false,
    alive: m.alive !== false,
    connected: m.connected !== false,
    timeLeft: Math.max(0, Number(m.timeLeft) || 0),
    waitingReward: m.waitingReward !== false,
  };
}
function activeAliveMembers(room) {
  return room.members.filter((m) => m.alive !== false && m.leftEarly !== true);
}
function connectedAliveMembers(room) {
  return room.members.filter((m) => m.connected !== false && m.alive !== false && m.leftEarly !== true);
}
function rankedMembers(room) {
  return room.members.map(serializeMember).sort((a, b) => (b.damage || 0) - (a.damage || 0));
}
function emitPartyState(code) {
  const r = partyRooms[code];
  if (!r) return;
  io.to(code).emit('partyBattleState', {
    roomCode: code,
    members: r.members.map(serializeMember),
    battle: r.battle
      ? {
          active: r.battle.active,
          currentHp: r.battle.currentHp,
          maxHp: r.battle.maxHp,
        }
      : null,
  });
}
function emitRaidState(code) {
  const r = raidRooms[code];
  if (!r) return;
  io.to(code).emit('battleState', {
    roomCode: code,
    members: r.members.map(serializeMember),
    battle: r.battle
      ? {
          active: r.battle.active,
          currentHp: r.battle.currentHp,
          maxHp: r.battle.maxHp,
        }
      : null,
  });
}
function clearGrace(member) {
  if (member && member.graceTimer) {
    clearTimeout(member.graceTimer);
    member.graceTimer = null;
  }
}
function schedulePartyDisconnect(code, member) {
  clearGrace(member);
  member.graceTimer = setTimeout(() => {
    const r = partyRooms[code];
    if (!r || !r.battle || !r.battle.active) return;
    if (member.connected === false) {
      member.alive = false;
      member.timeLeft = 0;
      emitPartyState(code);
      if (!connectedAliveMembers(r).length && !activeAliveMembers(r).length) endPartyBattle(code, false, 'all_down');
    }
  }, RECONNECT_GRACE_MS);
}
function scheduleRaidDisconnect(code, member) {
  clearGrace(member);
  member.graceTimer = setTimeout(() => {
    const r = raidRooms[code];
    if (!r || !r.battle || !r.battle.active) return;
    if (member.connected === false) {
      member.alive = false;
      member.timeLeft = 0;
      emitRaidState(code);
      if (!connectedAliveMembers(r).length && !activeAliveMembers(r).length) endRaidBattle(code, false, 'all_down');
    }
  }, RECONNECT_GRACE_MS);
}
function endPartyBattle(code, win, reason) {
  const r = partyRooms[code];
  if (!r || !r.battle || r.battle.ended) return;
  r.battle.active = false;
  r.battle.ended = true;
  r.battle.win = !!win;
  if (r.battle.tick) {
    clearInterval(r.battle.tick);
    r.battle.tick = null;
  }
  r.members.forEach(clearGrace);
  io.to(code).emit('partyBattleEnded', {
    roomCode: code,
    win: !!win,
    reason,
    members: rankedMembers(r),
    monsterId: r.monsterId || '',
    monsterName: r.monsterName || '',
    battle: { currentHp: r.battle.currentHp, maxHp: r.battle.maxHp },
  });
  setTimeout(() => {
    delete partyRooms[code];
    io.emit('roomListUpdated', getRoomList());
  }, 15000);
}
function endRaidBattle(code, win, reason) {
  const r = raidRooms[code];
  if (!r || !r.battle || r.battle.ended) return;
  r.battle.active = false;
  r.battle.ended = true;
  r.battle.win = !!win;
  if (r.battle.tick) {
    clearInterval(r.battle.tick);
    r.battle.tick = null;
  }
  r.members.forEach(clearGrace);
  io.to(code).emit('battleEnded', {
    roomCode: code,
    win: !!win,
    reason,
    members: rankedMembers(r),
    battle: { currentHp: r.battle.currentHp, maxHp: r.battle.maxHp },
  });
  setTimeout(() => {
    delete raidRooms[code];
  }, 15000);
}
function getRoomList() {
  return Object.values(partyRooms)
    .filter((r) => !r.battle || !r.battle.active)
    .map((r) => ({
      code: r.code,
      monsterId: r.monsterId || '',
      monsterName: r.monsterName || '',
      hostName: r.members[0]?.name || '',
      memberCount: r.members.filter((m) => m.leftEarly !== true).length,
      monsterHp: computePartyMonsterHp(r.monsterBaseHp || r.monsterHp || 0, r.members.filter((m) => m.leftEarly !== true).length || 1),
    }));
}
function findMemberBySocket(room, socketId) {
  return room.members.find((m) => m.socketId === socketId || m.id === socketId);
}
function findMemberByKey(room, payload) {
  const key = playerKey(payload);
  return room.members.find((m) => m.playerKey === key);
}
function syncRejoinMember(member, socket, payload) {
  clearGrace(member);
  member.id = socket.id;
  member.socketId = socket.id;
  member.connected = true;
  member.leftEarly = false;
  member.name = normalizeName(payload.playerName);
  member.avatarId = payload.avatarId;
  if (payload.title != null) member.title = String(payload.title || '');
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('getRooms', () => socket.emit('roomList', getRoomList()));

  socket.on('createPartyRoom', (payload) => {
    const { code, playerName, avatarId, title, monsterId, monsterName, monsterBaseHp, monsterHp, monsterTime, monsterTier } = payload || {};
    if (partyRooms[code]) return socket.emit('roomError', 'Room code conflict, retry');
    const member = makeMember(socket, { playerName, avatarId, title }, Number(monsterTime) || 30);
    partyRooms[code] = {
      code,
      monsterId,
      monsterName,
      monsterBaseHp: Number(monsterBaseHp || monsterHp || 0),
      monsterHp: Number(monsterHp || 0),
      monsterTime: Number(monsterTime || 30),
      monsterTier: monsterTier || 1,
      hostId: socket.id,
      members: [member],
      battle: null,
    };
    socket.join(code);
    socket.emit('partyRoomCreated', { code, monsterId, monsterName, members: partyRooms[code].members.map(serializeMember) });
    io.emit('roomListUpdated', getRoomList());
  });

  socket.on('joinPartyRoom', (payload) => {
    const { code, playerName, avatarId, title } = payload || {};
    const r = partyRooms[code];
    if (!r) return socket.emit('roomError', 'Room not found');
    if (r.battle && r.battle.active) return socket.emit('roomError', 'Battle already started');
    if (r.members.filter((m) => m.leftEarly !== true).length >= 4) return socket.emit('roomError', 'Room is full (max 4)');
    const existing = findMemberByKey(r, { playerName, avatarId });
    if (existing) {
      syncRejoinMember(existing, socket, { playerName, avatarId, title });
      socket.join(code);
      socket.emit('partyRejoined', { roomCode: code, monsterId: r.monsterId, monsterName: r.monsterName, members: r.members.map(serializeMember), battle: r.battle ? { active:r.battle.active, currentHp:r.battle.currentHp, maxHp:r.battle.maxHp } : null, monsterHp: r.battle ? r.battle.maxHp : computePartyMonsterHp(r.monsterBaseHp || r.monsterHp || 0, r.members.length), monsterTime: existing.timeLeft });
      io.to(code).emit('partyMemberJoined', { members: r.members.map(serializeMember), newMember: existing.name, reconnected: true });
      return;
    }
    const member = makeMember(socket, { playerName, avatarId, title }, r.monsterTime || 30);
    r.members.push(member);
    socket.join(code);
    io.to(code).emit('partyMemberJoined', { members: r.members.map(serializeMember), newMember: member.name });
    io.emit('roomListUpdated', getRoomList());
  });

  socket.on('rejoinPartyRoom', (payload) => {
    const { roomCode, playerName, avatarId, title } = payload || {};
    const r = partyRooms[roomCode];
    if (!r) return;
    const member = findMemberByKey(r, { playerName, avatarId });
    if (!member) return;
    syncRejoinMember(member, socket, { playerName, avatarId, title });
    socket.join(roomCode);
    socket.emit('partyRejoined', {
      roomCode,
      monsterId: r.monsterId,
      monsterName: r.monsterName,
      members: r.members.map(serializeMember),
      battle: r.battle ? { active:r.battle.active, currentHp:r.battle.currentHp, maxHp:r.battle.maxHp } : null,
      monsterHp: r.battle ? r.battle.maxHp : computePartyMonsterHp(r.monsterBaseHp || r.monsterHp || 0, r.members.length),
      monsterTime: member.timeLeft,
    });
    emitPartyState(roomCode);
  });

  socket.on('kickMember', ({ roomCode, targetId }) => {
    const r = partyRooms[roomCode];
    if (!r || r.hostId !== socket.id) return;
    const target = r.members.find((m) => m.socketId === targetId || m.id === targetId);
    if (!target) return;
    target.leftEarly = true;
    target.waitingReward = false;
    target.connected = false;
    target.alive = false;
    target.timeLeft = 0;
    io.to(target.socketId).emit('kicked', { roomCode, playerName: target.name });
    if (r.battle && r.battle.active) {
      emitPartyState(roomCode);
    } else {
      r.members = r.members.filter((m) => m !== target);
      io.to(roomCode).emit('memberKicked', { playerName: target.name, members: r.members.map(serializeMember) });
      io.emit('roomListUpdated', getRoomList());
    }
  });

  socket.on('startPartyBattle', (payload) => {
    const { roomCode, monsterId, monsterName, monsterBaseHp, monsterHp, monsterTime, monsterTier } = payload || {};
    const r = partyRooms[roomCode];
    if (!r || r.hostId !== socket.id || (r.battle && r.battle.active)) return;
    const baseHp = Number(monsterBaseHp || r.monsterBaseHp || monsterHp || r.monsterHp || 10000);
    const hp = computePartyMonsterHp(baseHp, r.members.filter((m) => m.leftEarly !== true).length || 1);
    const time = Number(monsterTime || r.monsterTime || 30);
    r.monsterId = monsterId || r.monsterId;
    r.monsterName = monsterName || r.monsterName;
    r.monsterBaseHp = baseHp;
    r.members.forEach((m) => {
      m.damage = 0;
      m.active = true;
      m.alive = true;
      m.connected = true;
      m.leftEarly = false;
      m.waitingReward = true;
      m.timeLeft = time;
      clearGrace(m);
    });
    r.battle = { active: true, ended: false, win: false, currentHp: hp, maxHp: hp, tick: null };
    r.battle.tick = setInterval(() => {
      if (!r.battle || !r.battle.active) return;
      r.members.forEach((m) => {
        if (m.leftEarly || m.alive === false || m.connected === false) return;
        m.timeLeft = Math.max(0, (Number(m.timeLeft) || 0) - 1);
        if (m.timeLeft <= 0) m.alive = false;
      });
      emitPartyState(roomCode);
      if (!connectedAliveMembers(r).length) endPartyBattle(roomCode, false, 'all_down');
    }, 1000);
    io.to(roomCode).emit('partyBattleStarted', { roomCode, monsterId: r.monsterId, monsterName: r.monsterName, monsterHp: hp, monsterTime: time, monsterTier: monsterTier || r.monsterTier || 1, serverHp: hp, members: r.members.map(serializeMember) });
    io.emit('roomListUpdated', getRoomList());
  });

  socket.on('partyCounterDmg', ({ roomCode, seconds }) => {
    const r = partyRooms[roomCode];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = findMemberBySocket(r, socket.id);
    if (!member || member.alive === false || member.leftEarly) return;
    member.timeLeft = Math.max(0, (Number(member.timeLeft) || 0) - Math.max(0, Number(seconds) || 0));
    if (member.timeLeft <= 0) member.alive = false;
    emitPartyState(roomCode);
    if (!connectedAliveMembers(r).length) endPartyBattle(roomCode, false, 'all_down');
  });

  socket.on('partyDamage', ({ roomCode, damage, playerName, title }) => {
    const r = partyRooms[roomCode];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = findMemberBySocket(r, socket.id);
    if (!member || member.alive === false || member.connected === false || member.leftEarly) return;
    if (playerName) member.name = normalizeName(playerName);
    if (title != null) member.title = String(title || '');
    const dmg = Math.max(0, Number(damage) || 0);
    if (!dmg) return;
    member.damage = (member.damage || 0) + dmg;
    r.battle.currentHp = Math.max(0, r.battle.currentHp - dmg);
    emitPartyState(roomCode);
    if (r.battle.currentHp <= 0) endPartyBattle(roomCode, true, 'kill');
  });

  socket.on('leavePartyRoom', ({ code, playerName }) => {
    const r = partyRooms[code];
    if (!r) return;
    const member = findMemberBySocket(r, socket.id);
    if (!member) return;
    socket.leave(code);
    if (r.battle && r.battle.active) {
      member.leftEarly = true;
      member.waitingReward = false;
      member.connected = false;
      member.alive = false;
      member.timeLeft = 0;
      emitPartyState(code);
      if (!connectedAliveMembers(r).length) endPartyBattle(code, false, 'all_down');
    } else {
      const wasHost = r.hostId === socket.id;
      r.members = r.members.filter((m) => m !== member);
      if (!r.members.length) {
        delete partyRooms[code];
      } else {
        if (wasHost) r.hostId = r.members[0].socketId;
        io.to(code).emit('partyMemberLeft', { playerName: playerName || member.name, members: r.members.map(serializeMember) });
      }
      io.emit('roomListUpdated', getRoomList());
    }
  });

  // Raid / event rooms
  socket.on('createRoom', ({ code, playerName, avatarId, title }) => {
    const member = makeMember(socket, { playerName, avatarId, title }, 60);
    raidRooms[code] = { code, hostId: socket.id, members: [member], battle: null };
    socket.join(code);
    socket.emit('roomCreated', { code, members: raidRooms[code].members.map(serializeMember) });
  });

  socket.on('joinRoom', ({ code, playerName, avatarId, title }) => {
    const r = raidRooms[code];
    if (!r) return socket.emit('roomError', 'Raid room not found');
    if (r.members.filter((m) => m.leftEarly !== true).length >= 4) return socket.emit('roomError', 'Room full');
    const existing = findMemberByKey(r, { playerName, avatarId });
    if (existing) {
      syncRejoinMember(existing, socket, { playerName, avatarId, title });
      socket.join(code);
      socket.emit('roomRejoined', { roomCode: code, members: r.members.map(serializeMember), battle: r.battle ? { active:r.battle.active, currentHp:r.battle.currentHp, maxHp:r.battle.maxHp } : null });
      io.to(code).emit('memberJoined', { members: r.members.map(serializeMember) });
      return;
    }
    const member = makeMember(socket, { playerName, avatarId, title }, 60);
    r.members.push(member);
    socket.join(code);
    io.to(code).emit('memberJoined', { members: r.members.map(serializeMember) });
  });

  socket.on('rejoinRoom', ({ roomCode, playerName, avatarId, title }) => {
    const r = raidRooms[roomCode];
    if (!r) return;
    const member = findMemberByKey(r, { playerName, avatarId });
    if (!member) return;
    syncRejoinMember(member, socket, { playerName, avatarId, title });
    socket.join(roomCode);
    socket.emit('roomRejoined', { roomCode, members: r.members.map(serializeMember), battle: r.battle ? { active:r.battle.active, currentHp:r.battle.currentHp, maxHp:r.battle.maxHp } : null });
    emitRaidState(roomCode);
  });

  socket.on('startBattle', ({ roomCode, battle }) => {
    const r = raidRooms[roomCode];
    if (!r || (r.battle && r.battle.active)) return;
    const hp = battle && battle.isDragon ? 52000 : 18000;
    const time = battle && battle.isDragon ? 60 : 30;
    r.members.forEach((m) => {
      m.damage = 0;
      m.active = true;
      m.alive = true;
      m.connected = true;
      m.leftEarly = false;
      m.waitingReward = true;
      m.timeLeft = time;
      clearGrace(m);
    });
    r.battle = { active: true, ended: false, win: false, currentHp: hp, maxHp: hp, tick: null };
    r.battle.tick = setInterval(() => {
      if (!r.battle || !r.battle.active) return;
      r.members.forEach((m) => {
        if (m.leftEarly || m.alive === false || m.connected === false) return;
        m.timeLeft = Math.max(0, (Number(m.timeLeft) || 0) - 1);
        if (m.timeLeft <= 0) m.alive = false;
      });
      emitRaidState(roomCode);
      if (!connectedAliveMembers(r).length) endRaidBattle(roomCode, false, 'all_down');
    }, 1000);
    io.to(roomCode).emit('battleStarted', { roomCode, members: r.members.map(serializeMember), battle: { currentHp: hp, maxHp: hp } });
  });

  socket.on('counterDmg', ({ roomCode, seconds }) => {
    const r = raidRooms[roomCode];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = findMemberBySocket(r, socket.id);
    if (!member || member.alive === false || member.leftEarly) return;
    member.timeLeft = Math.max(0, (Number(member.timeLeft) || 0) - Math.max(0, Number(seconds) || 0));
    if (member.timeLeft <= 0) member.alive = false;
    emitRaidState(roomCode);
    if (!connectedAliveMembers(r).length) endRaidBattle(roomCode, false, 'all_down');
  });

  socket.on('dealDamage', ({ roomCode, damage, playerName, title }) => {
    const r = raidRooms[roomCode];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = findMemberBySocket(r, socket.id);
    if (!member || member.alive === false || member.connected === false || member.leftEarly) return;
    if (playerName) member.name = normalizeName(playerName);
    if (title != null) member.title = String(title || '');
    const dmg = Math.max(0, Number(damage) || 0);
    if (!dmg) return;
    member.damage = (member.damage || 0) + dmg;
    r.battle.currentHp = Math.max(0, r.battle.currentHp - dmg);
    emitRaidState(roomCode);
    if (r.battle.currentHp <= 0) endRaidBattle(roomCode, true, 'kill');
  });

  socket.on('leaveBattle', ({ roomCode, playerName }) => {
    const r = raidRooms[roomCode];
    if (!r) return;
    const member = findMemberBySocket(r, socket.id);
    if (!member) return;
    socket.leave(roomCode);
    if (r.battle && r.battle.active) {
      member.leftEarly = true;
      member.waitingReward = false;
      member.connected = false;
      member.alive = false;
      member.timeLeft = 0;
      emitRaidState(roomCode);
      if (!connectedAliveMembers(r).length) endRaidBattle(roomCode, false, 'all_down');
    } else {
      r.members = r.members.filter((m) => m !== member);
      if (!r.members.length) delete raidRooms[roomCode];
      else io.to(roomCode).emit('memberLeftBattle', { playerName: playerName || member.name, members: r.members.map(serializeMember), battle: r.battle });
    }
  });

  socket.on('leaveRoom', ({ roomCode, playerName }) => {
    const r = raidRooms[roomCode];
    if (!r) return;
    const member = findMemberBySocket(r, socket.id);
    if (!member) return;
    socket.leave(roomCode);
    r.members = r.members.filter((m) => m !== member);
    if (!r.members.length) delete raidRooms[roomCode];
    else io.to(roomCode).emit('memberLeft', { playerName: playerName || member.name, members: r.members.map(serializeMember) });
  });

  socket.on('disconnect', () => {
    Object.keys(partyRooms).forEach((code) => {
      const r = partyRooms[code];
      const member = r && findMemberBySocket(r, socket.id);
      if (!member) return;
      if (r.battle && r.battle.active) {
        member.connected = false;
        emitPartyState(code);
        io.to(code).emit('partyMemberLeft', { playerName: member.name, members: r.members.map(serializeMember) });
        schedulePartyDisconnect(code, member);
      } else {
        const wasHost = r.hostId === socket.id;
        r.members = r.members.filter((m) => m !== member);
        if (!r.members.length) delete partyRooms[code];
        else {
          if (wasHost) r.hostId = r.members[0].socketId;
          io.to(code).emit('partyMemberLeft', { playerName: member.name, members: r.members.map(serializeMember) });
        }
        io.emit('roomListUpdated', getRoomList());
      }
    });

    Object.keys(raidRooms).forEach((code) => {
      const r = raidRooms[code];
      const member = r && findMemberBySocket(r, socket.id);
      if (!member) return;
      if (r.battle && r.battle.active) {
        member.connected = false;
        emitRaidState(code);
        io.to(code).emit('memberLeftBattle', { playerName: member.name, members: r.members.map(serializeMember), battle: r.battle });
        scheduleRaidDisconnect(code, member);
      } else {
        r.members = r.members.filter((m) => m !== member);
        if (!r.members.length) delete raidRooms[code];
        else io.to(code).emit('memberLeft', { playerName: member.name, members: r.members.map(serializeMember) });
      }
    });
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MHDB Server running on port ${PORT}`));
