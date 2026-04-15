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


// ── 입력값 제한 상수 ──────────────────────────────────────────────
const MAX_ROOMS        = 200;      // 동시 방 최대 개수
const MAX_NAME_LEN     = 24;       // playerName, monsterName
const MAX_TITLE_LEN    = 32;       // title
const MAX_CODE_LEN     = 12;       // 방 코드
const MAX_MONSTER_HP   = 500000;   // monsterBaseHp 상한
const MAX_MONSTER_TIME = 300;      // monsterTime 상한 (초)
const MAX_DAMAGE       = 99999;    // 1회 데미지 상한
const MAX_ZENNY        = 100000;   // rewardZenny 상한
const CODE_RE          = /^[A-Z0-9]{1,12}$/;  // 방 코드 형식

function sanitizeStr(val, maxLen) {
  return String(val || '').trim().slice(0, maxLen);
}
function clampNum(val, min, max) {
  const n = Number(val) || 0;
  return Math.min(max, Math.max(min, n));
}
function validCode(code) {
  return CODE_RE.test(code);
}
// ─────────────────────────────────────────────────────────────────
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
    leftReason: m.leftReason || '',
    timeLeft: Math.max(0, Number(m.timeLeft) || 0),
    potionUsed: m.potionUsed === true,
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
    isRaid: r.isRaid === true,
    dragonId: r.isRaid === true ? (r.monsterId || '') : '',
    monsterId: r.monsterId || '',
    monsterName: r.monsterName || '',
    monsterTier: Number(r.monsterTier || 1) || 1,
    monsterTime: Number(r.monsterTime || 30) || 30,
    hostId: r.hostId || null,
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

function formatRewardMaterialName(key) {
  const raw = String(key || '').trim();
  if (!raw) return 'Monster Bone';
  if (/^[A-Z]/.test(raw) && raw.includes(' ')) return raw;
  return raw
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildRewards(room, winnerId) {
  const count = Math.max(1, room.members.length);
  const bonusMultiplier = 1 + 0.12 * (count - 1);
  const baseZenny = Math.max(10, Number(room.rewardZenny) || 50);
  const materialKey = room.rewardMaterialKey || room.rewardMaterialName || room.monsterBone || 'bone_s';
  const materialName = formatRewardMaterialName(room.rewardMaterialDisplayName || room.rewardMaterialName || materialKey);
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
      materialKey,
      materialName,
      firstBonus,
      achievements: [],
    };
  });
  return rewards;
}


function closeRaidLobby(roomCode, reason = 'closed') {
  const code = String(roomCode || '').trim().toUpperCase();
  const r = partyRooms[code];
  if (!r || r.isRaid !== true) return;
  const memberIds = r.members.map((m) => m.id).filter(Boolean);
  const payload = {
    roomCode: code,
    dragonId: r.monsterId || '',
    reason,
    refundTicket: true,
  };
  memberIds.forEach((id) => io.to(id).emit('raidRoomClosed', payload));
  memberIds.forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s) s.leave(code);
  });
  if (r.battle && r.battle.tick) clearInterval(r.battle.tick);
  delete partyRooms[code];
  emitRaidRoomList(r.monsterId || '');
}

function cleanupRoomLater(map, code, delayMs = 1200) {
  setTimeout(() => {
    delete map[code];
  }, Math.max(0, Number(delayMs) || 0));
}

function promotePartyHost(room, leavingId) {
  if (!room || !Array.isArray(room.members) || !room.members.length) return;
  const next = room.members.find((m) => m.id !== leavingId && m.leftBattle !== true && m.connected !== false)
    || room.members.find((m) => m.id !== leavingId && m.leftBattle !== true)
    || room.members.find((m) => m.id !== leavingId);
  if (next) room.hostId = next.id;
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
  if (win && !r.partyPioneerGranted) {
    Object.keys(rewards).forEach((id) => {
      rewards[id].achievements = Array.isArray(rewards[id].achievements) ? rewards[id].achievements : [];
      if (!rewards[id].achievements.includes('Party Pioneer')) rewards[id].achievements.push('Party Pioneer');
    });
    r.partyPioneerGranted = true;
  }
  io.to(code).emit('partyBattleEnded', {
    roomCode: code,
    isRaid: r.isRaid === true,
    dragonId: r.isRaid === true ? (r.monsterId || '') : '',
    win: !!win,
    reason,
    members: ranked,
    rewards,
    monsterId: r.monsterId || '',
    monsterName: r.monsterName || '',
    monsterTier: Number(r.monsterTier || 1) || 1,
    monsterTime: Number(r.monsterTime || 30) || 30,
    hostId: r.hostId || null,
    battle: {
      currentHp: r.battle.currentHp,
      maxHp: r.battle.maxHp,
    },
  });
  emitRelevantRoomList(r);
  cleanupRoomLater(partyRooms, code, 1200);
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
    .filter((r) => !r.isRaid && !r.battle)
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


function emitRelevantRoomList(room) {
  if (!room) return;
  if (room.isRaid === true) emitRaidRoomList(room.monsterId || '');
  else io.emit('roomListUpdated', getRoomList());
}

function emitLegacyRaidDisabled(socket) {
  socket.emit('legacyRaidDisabled', {
    message: 'Legacy raid path disabled. Use createRaidRoom/joinRaidRoom/startRaidBattle.',
  });
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
    if (!code || !validCode(code)) return socket.emit('roomError', 'Invalid room code');
    if (partyRooms[code]) return socket.emit('roomError', 'Room code conflict, retry');
    if (Object.keys(partyRooms).length >= MAX_ROOMS) return socket.emit('roomError', 'Server full, try later');
    const monsterBaseHp = clampNum(payload.monsterBaseHp || payload.monsterHp, 1, MAX_MONSTER_HP);
    partyRooms[code] = {
      code,
      hostId: socket.id,
      monsterId: sanitizeStr(payload.monsterId, 32),
      monsterName: sanitizeStr(payload.monsterName, MAX_NAME_LEN),
      monsterBaseHp,
      monsterTime: clampNum(payload.monsterTime || 30, 10, MAX_MONSTER_TIME),
      monsterTier: clampNum(payload.monsterTier || 1, 1, 5),
      rewardZenny: clampNum(payload.monsterZenny || 50, 0, MAX_ZENNY),
      rewardMaterialName: sanitizeStr(payload.monsterBone || 'Monster Bone', 32),
      members: [
        {
          id: socket.id,
          name: sanitizeStr(payload.playerName || 'Player', MAX_NAME_LEN),
          avatarId: sanitizeStr(payload.avatarId || 'weapon', 32),
          title: sanitizeStr(payload.title, MAX_TITLE_LEN),
          damage: 0,
          active: true,
          connected: true,
          alive: true,
          leftBattle: false,
          timeLeft: clampNum(payload.monsterTime || 30, 10, MAX_MONSTER_TIME),
          claimed: true,
          potionUsed: false,
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
      hostId: partyRooms[code].hostId,
      monsterTier: Number(partyRooms[code].monsterTier || 1) || 1,
      monsterTime: Number(partyRooms[code].monsterTime || 30) || 30,
    });
    emitRelevantRoomList(partyRooms[code]);
  });

  socket.on('joinPartyRoom', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const r = partyRooms[code];
    if (!r) return socket.emit('roomError', 'Room not found');
    if (r.battle && r.battle.active) return socket.emit('roomError', 'Battle already started');
    if (r.members.length >= 4) return socket.emit('roomError', 'Room is full (max 4)');
    r.members.push({
      id: socket.id,
      name: sanitizeStr(payload.playerName || 'Player', MAX_NAME_LEN),
      avatarId: sanitizeStr(payload.avatarId || 'weapon', 32),
      title: sanitizeStr(payload.title, MAX_TITLE_LEN),
      damage: 0,
      active: true,
      connected: true,
      alive: true,
      leftBattle: false,
      timeLeft: clampNum(r.monsterTime || 30, 10, MAX_MONSTER_TIME),
      claimed: true,
      potionUsed: false,
    });
    socket.join(code);
    io.to(code).emit('partyMemberJoined', {
      members: r.members.map(serializeMember),
      newMember: payload.playerName || 'Player',
      hostId: r.hostId,
    });
    emitRelevantRoomList(r);
  });


  socket.on('rejoinPartyRoom', (payload = {}) => {
    socket.emit('roomError', 'Rejoin disabled. Please create or join a new room.');
  });

  socket.on('kickMember', ({ roomCode, targetId } = {}) => {
    const r = partyRooms[String(roomCode || '').trim().toUpperCase()];
    if (!r || r.hostId !== socket.id) return;
    if (targetId === socket.id) return;  // 자기 자신 kick 불가
    const target = r.members.find((m) => m.id === targetId);
    if (!target) return;
    target.leftBattle = true;
    target.claimed = false;
    r.members = r.members.filter((m) => m.id !== targetId);
    io.to(targetId).emit('kicked', { roomCode, playerName: target.name, refundPaintball: !(r.battle && r.battle.active) });
    io.to(roomCode).emit('memberKicked', {
      playerName: target.name,
      members: r.members.map(serializeMember),
      hostId: r.hostId,
    });
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.leave(roomCode);
    emitRelevantRoomList(r);
  });

  socket.on('startPartyBattle', (payload = {}) => {
    const roomCode = String(payload.roomCode || '').trim().toUpperCase();
    const r = partyRooms[roomCode];
    if (!r || r.hostId !== socket.id || (r.battle && r.battle.active)) return;
    const baseHp = clampNum(r.monsterBaseHp || 1, 1, MAX_MONSTER_HP);  // 서버 저장값 사용, 클라이언트 override 불가
    const hp = computePartyMonsterHp(baseHp, r.members.length);
    const time = Number(payload.monsterTime || r.monsterTime || 30) || 30;
    r.monsterId = payload.monsterId || r.monsterId;
    r.monsterName = payload.monsterName || r.monsterName;
    r.monsterBaseHp = baseHp;
    r.monsterTier = Number(payload.monsterTier || r.monsterTier || 1) || 1;
    r.monsterTime = time;
    r.rewardZenny = Number(payload.monsterZenny || r.rewardZenny || 50) || 50;
    r.rewardMaterialKey = payload.monsterBone || r.rewardMaterialKey || 'bone_s';
    r.rewardMaterialName = formatRewardMaterialName(payload.monsterBone || r.rewardMaterialName || r.rewardMaterialKey || 'bone_s');
    r.rewardMaterialDisplayName = formatRewardMaterialName(payload.monsterBone || r.rewardMaterialDisplayName || r.rewardMaterialKey || 'bone_s');
    r.members.forEach((m) => {
      m.damage = 0;
      m.active = true;
      m.connected = true;
      m.alive = true;
      m.leftBattle = false;
      m.timeLeft = time;
      m.claimed = true;
      m.potionUsed = false;
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
      hostId: r.hostId,
      battle: { currentHp: hp, maxHp: hp },
    });
    io.emit('roomListUpdated', getRoomList());
  });

  socket.on('partyCounterDmg', ({ roomCode, seconds } = {}) => {
    const r = partyRooms[String(roomCode || '').trim().toUpperCase()];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = r.members.find((m) => m.id === socket.id);
    if (!member || member.leftBattle === true || member.alive === false) return;
    member.timeLeft = Math.max(0, (Number(member.timeLeft) || 0) - clampNum(seconds, 0, 60));
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
    if (playerName) member.name = sanitizeStr(playerName, MAX_NAME_LEN);
    if (title) member.title = sanitizeStr(title, MAX_TITLE_LEN);
    const dmg = clampNum(damage, 0, MAX_DAMAGE);
    if (!dmg) return;
    member.damage += dmg;
    r.battle.currentHp = Math.max(0, r.battle.currentHp - dmg);
    emitPartyRoomState(code);
    if (r.battle.currentHp <= 0) endPartyBattle(code, true, 'kill');
  });

  socket.on('partyUsePotion', ({ roomCode } = {}) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const r = partyRooms[code];
    if (!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = r.members.find((m) => m.id === socket.id);
    if (!member || member.leftBattle === true || member.alive === false) return;
    if (member.potionUsed === true) return;
    member.potionUsed = true;
    member.timeLeft = Math.min(999, Math.max(0, Number(member.timeLeft) || 0) + 30);
    io.to(socket.id).emit('partyPotionApplied', {
      roomCode: code,
      timeLeft: member.timeLeft,
      potionUsed: true,
    });
    emitPartyRoomState(code);
  });

  socket.on('leavePartyRoom', ({ code, playerName } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const r = partyRooms[roomCode];
    if (!r) return;
    const member = r.members.find((m) => m.id === socket.id);
    if (!member) return;
    const wasHost = r.hostId === socket.id;
    const isRaidLobby = r.isRaid === true && !(r.battle && r.battle.active);
    socket.leave(roomCode);
    if (isRaidLobby && wasHost) {
      closeRaidLobby(roomCode, 'host_left');
      return;
    }
    if (wasHost) promotePartyHost(r, socket.id);
    if (r.battle && r.battle.active) {
      member.leftBattle = true;
      member.leftReason = 'left';
      member.claimed = false;
      member.alive = false;
      member.active = false;
      member.connected = false;
      io.to(roomCode).emit('partyMemberLeft', {
        playerName: playerName || member.name || 'Player',
        members: r.members.map(serializeMember),
        hostId: r.hostId,
      });
      emitPartyRoomState(roomCode);
      if (livingMembers(r).length === 0) endPartyBattle(roomCode, false, 'all_left');
    } else {
      r.members = r.members.filter((m) => m.id !== socket.id);
      if (r.isRaid === true) {
        io.to(socket.id).emit('raidTicketRefunded', { roomCode, reason: 'left_room' });
      }
      if (!r.members.length) {
        if (r.battle && r.battle.tick) clearInterval(r.battle.tick);
        delete partyRooms[roomCode];
      } else {
        if (wasHost) r.hostId = r.members[0].id;
        io.to(roomCode).emit('partyMemberLeft', {
          playerName: playerName || member.name || 'Player',
          members: r.members.map(serializeMember),
          hostId: r.hostId,
        });
      }
      emitRelevantRoomList(r);
    }
  });

  socket.on('createRoom', () => { emitLegacyRaidDisabled(socket); });

  socket.on('joinRoom', () => { emitLegacyRaidDisabled(socket); });

  socket.on('rejoinRoom', () => { emitLegacyRaidDisabled(socket); });

  socket.on('startBattle', () => { emitLegacyRaidDisabled(socket); });

  socket.on('dealDamage', () => { emitLegacyRaidDisabled(socket); });

  socket.on('counterDmg', () => { emitLegacyRaidDisabled(socket); });

  socket.on('leaveBattle', () => { emitLegacyRaidDisabled(socket); });

  socket.on('leaveRoom', () => { emitLegacyRaidDisabled(socket); });

  socket.on('disconnect', () => {
    Object.keys(partyRooms).forEach((code) => {
      const r = partyRooms[code];
      const member = r?.members.find((m) => m.id === socket.id);
      if (!member) return;
      member.connected = false;
      member.active = false;
      if (!r.battle || !r.battle.active) {
        if (r.isRaid === true && r.hostId === socket.id) {
          closeRaidLobby(code, 'host_disconnected');
          return;
        }
        r.members = r.members.filter((m) => m.id !== socket.id);
        if (!r.members.length) delete partyRooms[code];
        else {
          if (r.hostId === socket.id) r.hostId = r.members[0].id;
          io.to(code).emit('partyMemberLeft', { playerName: member.name || 'Player', members: r.members.map(serializeMember), hostId: r.hostId });
        }
        emitRelevantRoomList(r);
      } else {
        member.leftBattle = true;
        member.leftReason = 'disconnected';
        member.claimed = false;
        member.alive = false;
        member.active = false;
        member.connected = false;
        if (r.hostId === socket.id) promotePartyHost(r, socket.id);
        io.to(code).emit('partyMemberLeft', {
          playerName: member.name || 'Player',
          members: r.members.map(serializeMember),
          hostId: r.hostId,
          disconnected: true,
        });
        emitPartyRoomState(code);
        if (livingMembers(r).length === 0) endPartyBattle(code, false, 'all_left');
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

  socket.on('getRaidRooms', (payload = {}) => {
    const dragonId = String(payload.dragonId || '').trim();
    socket.emit('raidRoomList', {
      dragonId,
      rooms: getRaidRoomList(dragonId),
    });
  });

  socket.on('createRaidRoom', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    if (!code || !validCode(code)) return socket.emit('roomError', 'Invalid raid room code');
    if (partyRooms[code]) return socket.emit('roomError', 'Room code conflict, retry');
    if (Object.keys(partyRooms).length >= MAX_ROOMS) return socket.emit('roomError', 'Server full, try later');
    const dragonId = sanitizeStr(payload.dragonId, 32);
    if (!dragonId) return socket.emit('roomError', 'Invalid raid target');
    const monsterBaseHp = clampNum(payload.monsterBaseHp || payload.monsterHp || 1, 1, MAX_MONSTER_HP);
    const monsterTime = clampNum(payload.monsterTime || 60, 10, MAX_MONSTER_TIME);
    const monsterTier = clampNum(payload.monsterTier || 5, 1, 5);
    const rewardZenny = clampNum(payload.monsterZenny || 420, 0, MAX_ZENNY);
    partyRooms[code] = {
      code,
      isRaid: true,
      hostId: socket.id,
      monsterId: dragonId,
      monsterName: payload.monsterName || dragonId,
      monsterBaseHp,
      monsterTime,
      monsterTier,
      rewardZenny,
      rewardMaterialKey: payload.monsterBone || 'dragon_blood',
      rewardMaterialName: formatRewardMaterialName(payload.monsterBone || 'dragon_blood'),
      rewardMaterialDisplayName: formatRewardMaterialName(payload.monsterBone || 'dragon_blood'),
      members: [
        {
          id: socket.id,
          name: sanitizeStr(payload.playerName || 'Player', MAX_NAME_LEN),
          avatarId: sanitizeStr(payload.avatarId || 'weapon', 32),
          title: sanitizeStr(payload.title, MAX_TITLE_LEN),
          damage: 0,
          active: true,
          connected: true,
          alive: true,
          leftBattle: false,
          timeLeft: monsterTime,
          claimed: true,
          potionUsed: false,
        },
      ],
      battle: null,
    };
    socket.join(code);
    socket.emit('partyRoomCreated', {
      code,
      isRaid: true,
      dragonId,
      monsterId: dragonId,
      monsterName: partyRooms[code].monsterName,
      members: partyRooms[code].members.map(serializeMember),
      hostId: partyRooms[code].hostId,
      monsterTier,
      monsterTime,
    });
    emitRaidRoomList(dragonId);
  });

  socket.on('joinRaidRoom', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const r = partyRooms[code];
    if (!r || r.isRaid !== true) return socket.emit('roomError', 'Raid room not found');
    if (r.battle && r.battle.active) return socket.emit('roomError', 'Battle already started');
    if (r.members.length >= 4) return socket.emit('roomError', 'Room is full (max 4)');
    r.members = r.members.filter((m) => m.id !== socket.id);
    r.members.push({
      id: socket.id,
      name: sanitizeStr(payload.playerName || 'Player', MAX_NAME_LEN),
      avatarId: sanitizeStr(payload.avatarId || 'weapon', 32),
      title: sanitizeStr(payload.title, MAX_TITLE_LEN),
      damage: 0,
      active: true,
      connected: true,
      alive: true,
      leftBattle: false,
      timeLeft: clampNum(r.monsterTime || 60, 10, MAX_MONSTER_TIME),
      claimed: true,
      potionUsed: false,
    });
    socket.join(code);
    socket.emit('partyRoomCreated', {
      code,
      isRaid: true,
      dragonId: r.monsterId || '',
      monsterId: r.monsterId || '',
      monsterName: r.monsterName || '',
      members: r.members.map(serializeMember),
      hostId: r.hostId,
      monsterTier: Number(r.monsterTier || 5) || 5,
      monsterTime: Number(r.monsterTime || 60) || 60,
    });
    io.to(code).emit('partyMemberJoined', {
      isRaid: true,
      dragonId: r.monsterId || '',
      members: r.members.map(serializeMember),
      newMember: payload.playerName || 'Player',
      hostId: r.hostId,
    });
    emitRaidRoomList(r.monsterId);
  });

  socket.on('startRaidBattle', (payload = {}) => {
    const roomCode = String(payload.roomCode || '').trim().toUpperCase();
    const r = partyRooms[roomCode];
    if (!r || r.isRaid !== true || r.hostId !== socket.id || (r.battle && r.battle.active)) return;
    const baseHp = Number(r.monsterBaseHp || 1) || 1;
    const hp = computePartyMonsterHp(baseHp, r.members.length);
    const time = Number(r.monsterTime || 60) || 60;
    r.members.forEach((m) => {
      m.damage = 0;
      m.active = true;
      m.connected = true;
      m.alive = true;
      m.leftBattle = false;
      m.timeLeft = time;
      m.claimed = true;
      m.potionUsed = false;
    });
    r.battle = { active: true, ended: false, currentHp: hp, maxHp: hp, tick: null };
    setupPersonalTimer(r, roomCode, emitPartyRoomState, endPartyBattle);
    io.to(roomCode).emit('partyBattleStarted', {
      roomCode,
      isRaid: true,
      dragonId: r.monsterId,
      monsterId: r.monsterId,
      monsterName: r.monsterName,
      monsterHp: hp,
      monsterTime: time,
      monsterTier: Number(r.monsterTier || 5) || 5,
      serverHp: hp,
      members: r.members.map(serializeMember),
      hostId: r.hostId,
      battle: { currentHp: hp, maxHp: hp },
    });
    emitRaidRoomList(r.monsterId);
  });
});

