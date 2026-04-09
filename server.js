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
app.get('/health', (_req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/', (_req, res) => {
  const pi = path.join(publicDir, 'index.html');
  const ri = path.join(rootDir, 'index.html');
  if (fs.existsSync(pi)) return res.sendFile(pi);
  if (fs.existsSync(ri)) return res.sendFile(ri);
  return res.send('MHDB Server Online');
});

const partyRooms = {};
const raidRooms = {};

function computePartyMonsterHp(baseHp, memberCount) {
  const base = Math.max(1, Number(baseHp) || 1);
  const count = Math.max(1, Number(memberCount) || 1);
  return Math.floor(base * (1 + 0.6 * (count - 1)));
}

function serializeMember(m) {
  return {
    id: m.id,
    name: m.name || 'Player',
    avatarId: m.avatarId || 'weapon',
    title: m.title || '',
    damage: Number(m.damage) || 0,
    active: m.active !== false,
    connected: m.connected !== false,
    alive: m.alive !== false,
    leftBattle: m.leftBattle === true,
    timeLeft: Math.max(0, Number(m.timeLeft) || 0),
  };
}

function livingMembers(room) {
  return room.members.filter((m) => m.leftBattle !== true && m.alive !== false && (Number(m.timeLeft) || 0) > 0);
}

function emitPartyRoomState(code) {
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

function emitRaidRoomState(code) {
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

function buildRewards(room, winnerId) {
  const count = Math.max(1, room.members.length);
  const bonusMultiplier = 1 + 0.12 * (count - 1);
  const baseZenny = Math.max(10, Number(room.rewardZenny) || 50);
  const materialName = room.rewardMaterialName || room.monsterBone || 'Monster Bone';
  const materialCount = count >= 4 ? 2 : 1;
  const rewards = {};
  room.members.forEach((m) => {
    if (m.claimed === false || m.leftBattle === true) return;
    let zenny = Math.floor(baseZenny * bonusMultiplier);
    let mats = materialCount;
    const firstBonus = winnerId && m.id === winnerId;
    if (firstBonus) {
      zenny += Math.max(15, Math.floor(baseZenny * 0.15));
      mats += 1;
    }
    rewards[m.id] = {
      zenny,
      materials: mats,
      materialName,
      firstBonus,
    };
  });
  return rewards;
}

function cleanupRoomLater(map, code) {
  setTimeout(() => {
    delete map[code];
  }, 15000);
}

function endPartyBattle(code, win, reason) {
  const r = partyRooms[code];
  if (!r || !r.battle || r.battle.ended) return;
  r.battle.active = false;
  r.battle.ended = true;
  r.battle.win = !!win;
  if (r.battle.tick) clearInterval(r.battle.tick);
  r.battle.tick = null;
  const ranked = r.members.map(serializeMember).sort((a, b) => (b.damage || 0) - (a.damage || 0));
  const winnerId = ranked[0] ? ranked[0].id : null;
  const rewards = win ? buildRewards(r, winnerId) : {};
  io.to(code).emit('partyBattleEnded', {
    roomCode: code,
    win: !!win,
    reason,
    members: ranked,
    rewards,
    monsterName: r.monsterName || '',
    battle: {
      currentHp: r.battle.currentHp,
      maxHp: r.battle.maxHp,
    },
  });
  cleanupRoomLater(partyRooms, code);
}

function endRaidBattle(code, win, reason) {
  const r = raidRooms[code];
  if (!r || !r.battle || r.battle.ended) return;
  r.battle.active = false;
  r.battle.ended = true;
  r.battle.win = !!win;
  if (r.battle.tick) clearInterval(r.battle.tick);
  r.battle.tick = null;
  const ranked = r.members.map(serializeMember).sort((a, b) => (b.damage || 0) - (a.damage || 0));
  const winnerId = ranked[0] ? ranked[0].id : null;
  const rewards = win ? buildRewards(r, winnerId) : {};
  io.to(code).emit('battleEnded', {
    roomCode: code,
    win: !!win,
    reason,
    members: ranked,
    rewards,
    battle: {
      currentHp: r.battle.currentHp,
      maxHp: r.battle.maxHp,
    },
  });
  cleanupRoomLater(raidRooms, code);
}

function getRoomList() {
  return Object.values(partyRooms)
    .filter((r) => !r.battle || !r.battle.active)
    .map((r) => ({
      code: r.code,
      monsterId: r.monsterId || '',
      monsterName: r.monsterName || '',
      hostName: r.members[0]?.name || '',
      memberCount: r.members.length,
      monsterHp: computePartyMonsterHp(r.monsterBaseHp || 1, r.members.length),
      monsterBaseHp: r.monsterBaseHp || 1,
    }));
}

function rebindMember(room, oldMember, socket, playerName, avatarId, title) {
  oldMember.id = socket.id;
  oldMember.connected = true;
  oldMember.active = true;
  if (playerName) oldMember.name = playerName;
  if (avatarId) oldMember.avatarId = avatarId;
  if (title) oldMember.title = title;
}

function setupPersonalTimer(room, roomCode, emitFn, endFn) {
  if (room.battle.tick) clearInterval(room.battle.tick);
  room.battle.tick = setInterval(() => {
    if (!room.battle || !room.battle.active || room.battle.ended) return;
    room.members.forEach((m) => {
      if (m.leftBattle === true) return;
      if (m.alive === false) return;
      m.timeLeft = Math.max(0, (Number(m.timeLeft) || 0) - 1);
      if (m.timeLeft <= 0) {
        m.timeLeft = 0;
        m.alive = false;
        m.active = false;
      }
    });
    emitFn(roomCode);
    if (livingMembers(room).length === 0) endFn(roomCode, false, 'timeout');
  }, 1000);
}

io.on('connection', (socket) => {
  socket.on('getRooms', () => {
    socket.emit('roomList', getRoomList());
  });

  socket.on('createPartyRoom', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    if (!code) return socket.emit('roomError', 'Invalid room code');
    if (partyRooms[code]) return socket.emit('roomError', 'Room code conflict, retry');
    const monsterBaseHp = Number(payload.monsterBaseHp || payload.monsterHp || 1) || 1;
    partyRooms[code] = {
      code,
      hostId: socket.id,
      monsterId: payload.monsterId || '',
      monsterName: payload.monsterName || '',
      monsterBaseHp,
      monsterTime: Number(payload.monsterTime || 30) || 30,
      monsterTier: Number(payload.monsterTier || 1) || 1,
      rewardZenny: Number(payload.monsterZenny || 50) || 50,
      rewardMaterialName: payload.monsterBone || 'Monster Bone',
      members: [
        {
          id: socket.id,
          name: payload.playerName || 'Player',
          avatarId: payload.avatarId || 'weapon',
          title: payload.title || '',
          damage: 0,
          active: true,
          connected: true,
          alive: true,
          leftBattle: false,
          timeLeft: Number(payload.monsterTime || 30) || 30,
          claimed: true,
        },
      ],
      battle: null,
    };
    socket.join(code);
    socket.emit('partyRoomCreated', {
      code,
      monsterId: partyRooms[code].monsterId,
      monsterName: partyRooms[code].monsterName,
      members: partyRooms[code].members.map(serializeMember),
    });
    io.emit('roomListUpdated', getRoomList());
  });

  socket.on('joinPartyRoom', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const r = partyRooms[code];
    if (!r) return socket.emit('roomError', 'Room not found');
    if (r.battle && r.battle.active) return socket.emit('roomError', 'Battle already started');
    if (r.members.length >= 4) return socket.emit('roomError', 'Room is full (max 4)');
    r.members.push({
      id: socket.id,
      name: payload.playerName || 'Player',
      avatarId: payload.avatarId || 'weapon',
      title: payload.title || '',
      damage: 0,
      active: true,
      connected: true,
      alive: true,
      leftBattle: false,
      timeLeft: Number(r.monsterTime || 30) || 30,
      claimed: true,
    });
    socket.join(code);
    io.to(code).emit('partyMemberJoined', {
      members: r.members.map(serializeMember),
      newMember: payload.playerName || 'Player',
    });
    io.emit('roomListUpdated', getRoomList());
  });

  socket.on('rejoinPartyRoom', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const r = partyRooms[code];
    if (!r) return;
    const oldMember = r.members.find((m) => m.name === payload.playerName && m.leftBattle !== true);
    if (!oldMember) return;
    rebindMember(r, oldMember, socket, payload.playerName, payload.avatarId, payload.title);
    socket.join(code);
    if (r.battle && r.battle.active) {
      io.to(code).emit('partyBattleState', {
        roomCode: code,
        members: r.members.map(serializeMember),
        battle: {
          active: true,
          currentHp: r.battle.currentHp,
          maxHp: r.battle.maxHp,
        },
      });
    } else {
      io.to(code).emit('partyMemberJoined', {
        members: r.members.map(serializeMember),
        newMember: payload.playerName || 'Player',
      });
    }
  });

  socket.on('kickMember', ({ roomCode, targetId } = {}) => {
    const r = partyRooms[String(roomCode || '').trim().toUpperCase()];
    if (!r || r.hostId !== socket.id) return;
    const target = r.members.find((m) => m.id === targetId);
    if (!target) return;
    target.leftBattle = true;
    target.claimed = false;
    r.members = r.members.filter((m) => m.id !== targetId);
    io.to(targetId).emit('kicked', { roomCode, playerName: target.name });
    io.to(roomCode).emit('memberKicked', {
      playerName: target.name,
      members: r.members.map(serializeMember),
    });
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.leave(roomCode);
    io.emit('roomListUpdated', getRoomList());
  });

  socket.on('startPartyBattle', (payload = {}) => {
    const roomCode = String(payload.roomCode || '').trim().toUpperCase();
    const r = partyRooms[roomCode];
    if (!r || r.hostId !== socket.id || (r.battle && r.battle.active)) return;
    const baseHp = Number(payload.monsterBaseHp || r.monsterBaseHp || 1) || 1;
    const hp = computePartyMonsterHp(baseHp, r.members.length);
    const time = Number(payload.monsterTime || r.monsterTime || 30) || 30;
    r.monsterId = payload.monsterId || r.monsterId;
    r.monsterName = payload.monsterName || r.monsterName;
    r.monsterBaseHp = baseHp;
    r.rewardZenny = Number(payload.monsterZenny || r.rewardZenny || 50) || 50;
    r.rewardMaterialName = payload.monsterBone || r.rewardMaterialName || 'Monster Bone';
    r.members.forEach((m) => {
      m.damage = 0;
      m.active = true;
      m.connected = true;
      m.alive = true;
      m.leftBattle = false;
      m.timeLeft = time;
      m.claimed = true;
    });
    r.battle = { active: true, ended: false, currentHp: hp, maxHp: hp, tick: null };
    setupPersonalTimer(r, roomCode, emitPartyRoomState, endPartyBattle);
    io.to(roomCode).emit('partyBattleStarted', {
      roomCode,
      monsterId: r.monsterId,
      monsterName: r.monsterName,
      monsterHp: hp,
      monsterTime: time,
      monsterTier: payload.monsterTier || r.monsterTier || 1,
      serverHp: hp,
      members: r.members.map(serializeMember),
    });
    io.emit('roomListUpdated', getRoomList());
  });

  socket.on('partyCounterDmg', ({ roomCode, seconds } = {}) => {
    const r = partyRooms[String(roomCode || '').trim().toUpperCase()];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = r.members.find((m) => m.id === socket.id);
    if (!member || member.leftBattle === true || member.alive === false) return;
    member.timeLeft = Math.max(0, (Number(member.timeLeft) || 0) - Math.max(0, Number(seconds) || 0));
    if (member.timeLeft <= 0) {
      member.timeLeft = 0;
      member.alive = false;
      member.active = false;
    }
    emitPartyRoomState(String(roomCode || '').trim().toUpperCase());
    if (livingMembers(r).length === 0) endPartyBattle(String(roomCode || '').trim().toUpperCase(), false, 'timeout');
  });

  socket.on('partyDamage', ({ roomCode, damage, playerName, title } = {}) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const r = partyRooms[code];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = r.members.find((m) => m.id === socket.id);
    if (!member || member.leftBattle === true || member.alive === false) return;
    if (playerName) member.name = playerName;
    if (title) member.title = title;
    const dmg = Math.max(0, Number(damage) || 0);
    if (!dmg) return;
    member.damage += dmg;
    r.battle.currentHp = Math.max(0, r.battle.currentHp - dmg);
    emitPartyRoomState(code);
    if (r.battle.currentHp <= 0) endPartyBattle(code, true, 'kill');
  });

  socket.on('leavePartyRoom', ({ code, playerName } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const r = partyRooms[roomCode];
    if (!r) return;
    const member = r.members.find((m) => m.id === socket.id);
    if (!member) return;
    const wasHost = r.hostId === socket.id;
    socket.leave(roomCode);
    if (r.battle && r.battle.active) {
      member.leftBattle = true;
      member.claimed = false;
      member.alive = false;
      member.active = false;
      member.connected = false;
      io.to(roomCode).emit('partyMemberLeft', {
        playerName: playerName || member.name || 'Player',
        members: r.members.map(serializeMember),
      });
      emitPartyRoomState(roomCode);
      if (livingMembers(r).length === 0) endPartyBattle(roomCode, false, 'all_left');
    } else {
      r.members = r.members.filter((m) => m.id !== socket.id);
      if (!r.members.length) {
        if (r.battle && r.battle.tick) clearInterval(r.battle.tick);
        delete partyRooms[roomCode];
      } else {
        if (wasHost) r.hostId = r.members[0].id;
        io.to(roomCode).emit('partyMemberLeft', {
          playerName: playerName || member.name || 'Player',
          members: r.members.map(serializeMember),
        });
      }
      io.emit('roomListUpdated', getRoomList());
    }
  });

  socket.on('createRoom', ({ code, playerName, avatarId, title } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    if (!roomCode) return socket.emit('roomError', 'Invalid raid room code');
    raidRooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      rewardZenny: 200,
      rewardMaterialName: 'Dragon Blood',
      members: [{
        id: socket.id,
        name: playerName || 'Player',
        avatarId: avatarId || 'weapon',
        title: title || '',
        damage: 0,
        active: true,
        connected: true,
        alive: true,
        leftBattle: false,
        timeLeft: 60,
        claimed: true,
      }],
      battle: null,
    };
    socket.join(roomCode);
    socket.emit('roomCreated', { code: roomCode, members: raidRooms[roomCode].members.map(serializeMember) });
  });

  socket.on('joinRoom', ({ code, playerName, avatarId, title } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const r = raidRooms[roomCode];
    if (!r) return socket.emit('roomError', 'Raid room not found');
    if (r.battle && r.battle.active) return socket.emit('roomError', 'Battle already started');
    if (r.members.length >= 4) return socket.emit('roomError', 'Room full');
    r.members.push({
      id: socket.id,
      name: playerName || 'Player',
      avatarId: avatarId || 'weapon',
      title: title || '',
      damage: 0,
      active: true,
      connected: true,
      alive: true,
      leftBattle: false,
      timeLeft: 60,
      claimed: true,
    });
    socket.join(roomCode);
    io.to(roomCode).emit('memberJoined', { members: r.members.map(serializeMember) });
  });

  socket.on('rejoinRoom', ({ code, playerName, avatarId, title } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const r = raidRooms[roomCode];
    if (!r) return;
    const oldMember = r.members.find((m) => m.name === playerName && m.leftBattle !== true);
    if (!oldMember) return;
    rebindMember(r, oldMember, socket, playerName, avatarId, title);
    socket.join(roomCode);
    emitRaidRoomState(roomCode);
  });

  socket.on('startBattle', ({ roomCode, battle } = {}) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const r = raidRooms[code];
    if (!r || r.hostId !== socket.id || (r.battle && r.battle.active)) return;
    const hp = battle && battle.isDragon ? 36000 : 12000;
    const time = battle && battle.isDragon ? 60 : 35;
    r.rewardZenny = battle && battle.isDragon ? 420 : 180;
    r.rewardMaterialName = battle && battle.isDragon ? 'Dragon Blood' : 'Monster Bone';
    r.members.forEach((m) => {
      m.damage = 0;
      m.active = true;
      m.connected = true;
      m.alive = true;
      m.leftBattle = false;
      m.timeLeft = time;
      m.claimed = true;
    });
    r.battle = { active: true, ended: false, currentHp: hp, maxHp: hp, tick: null };
    setupPersonalTimer(r, code, emitRaidRoomState, endRaidBattle);
    io.to(code).emit('battleStarted', {
      roomCode: code,
      members: r.members.map(serializeMember),
      battle: { currentHp: hp, maxHp: hp },
    });
  });

  socket.on('dealDamage', ({ roomCode, damage, playerName, title } = {}) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const r = raidRooms[code];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = r.members.find((m) => m.id === socket.id);
    if (!member || member.leftBattle === true || member.alive === false) return;
    if (playerName) member.name = playerName;
    if (title) member.title = title;
    const dmg = Math.max(0, Number(damage) || 0);
    if (!dmg) return;
    member.damage += dmg;
    r.battle.currentHp = Math.max(0, r.battle.currentHp - dmg);
    emitRaidRoomState(code);
    if (r.battle.currentHp <= 0) endRaidBattle(code, true, 'kill');
  });

  socket.on('counterDmg', ({ roomCode, seconds } = {}) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const r = raidRooms[code];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = r.members.find((m) => m.id === socket.id);
    if (!member || member.leftBattle === true || member.alive === false) return;
    member.timeLeft = Math.max(0, (Number(member.timeLeft) || 0) - Math.max(0, Number(seconds) || 0));
    if (member.timeLeft <= 0) {
      member.timeLeft = 0;
      member.alive = false;
      member.active = false;
    }
    emitRaidRoomState(code);
    if (livingMembers(r).length === 0) endRaidBattle(code, false, 'timeout');
  });

  socket.on('leaveBattle', ({ roomCode, playerName } = {}) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const r = raidRooms[code];
    if (!r) return;
    const member = r.members.find((m) => m.id === socket.id);
    if (!member) return;
    socket.leave(code);
    member.leftBattle = true;
    member.claimed = false;
    member.alive = false;
    member.active = false;
    member.connected = false;
    io.to(code).emit('memberLeftBattle', { playerName: playerName || member.name || 'Player', members: r.members.map(serializeMember), battle: r.battle });
    emitRaidRoomState(code);
    if (livingMembers(r).length === 0) endRaidBattle(code, false, 'all_left');
  });

  socket.on('leaveRoom', ({ roomCode, playerName } = {}) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const r = raidRooms[code];
    if (!r) return;
    r.members = r.members.filter((m) => m.id !== socket.id);
    socket.leave(code);
    if (!r.members.length) {
      if (r.battle && r.battle.tick) clearInterval(r.battle.tick);
      delete raidRooms[code];
    } else {
      if (r.hostId === socket.id) r.hostId = r.members[0].id;
      io.to(code).emit('memberLeft', { playerName: playerName || 'Player', members: r.members.map(serializeMember) });
    }
  });

  socket.on('disconnect', () => {
    Object.keys(partyRooms).forEach((code) => {
      const r = partyRooms[code];
      const member = r?.members.find((m) => m.id === socket.id);
      if (!member) return;
      member.connected = false;
      member.active = false;
      if (!r.battle || !r.battle.active) {
        r.members = r.members.filter((m) => m.id !== socket.id);
        if (!r.members.length) delete partyRooms[code];
        else {
          if (r.hostId === socket.id) r.hostId = r.members[0].id;
          io.to(code).emit('partyMemberLeft', { playerName: member.name || 'Player', members: r.members.map(serializeMember) });
        }
        io.emit('roomListUpdated', getRoomList());
      } else {
        emitPartyRoomState(code);
      }
    });

    Object.keys(raidRooms).forEach((code) => {
      const r = raidRooms[code];
      const member = r?.members.find((m) => m.id === socket.id);
      if (!member) return;
      member.connected = false;
      member.active = false;
      if (r.battle && r.battle.active) emitRaidRoomState(code);
      else {
        r.members = r.members.filter((m) => m.id !== socket.id);
        if (!r.members.length) delete raidRooms[code];
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MHDB server running on :${PORT}`);
});
