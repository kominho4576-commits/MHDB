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
  const pi = path.join(publicDir,'index.html'), ri = path.join(rootDir,'index.html');
  if(fs.existsSync(pi)) return res.sendFile(pi);
  if(fs.existsSync(ri)) return res.sendFile(ri);
  return res.send('MHDB Server Online');
});

// ── 파티 방 (사냥용) ──
const partyRooms = {}; // code → room

function serializeMember(m) {
  return { id:m.id, name:m.name, avatarId:m.avatarId, title:m.title||'', damage:m.damage||0, active:m.active!==false };
}
function buildPartyRewards(room) {
  const zennyBase = Math.max(0, Number(room.monsterBaseZenny) || 0);
  const bonusZenny = Math.floor(Math.random() * 35);
  const rewards = [];
  if (zennyBase + bonusZenny > 0) {
    rewards.push({ type:'zenny', name:'Zenny', count: zennyBase + bonusZenny });
  }
  if (room.monsterBone) {
    rewards.push({ type:'material', key: room.monsterBone, name: room.monsterBone, count: 1 });
  }
  return rewards;
}
function emitRoomState(code) {
  const r = partyRooms[code];
  if(!r) return;
  io.to(code).emit('partyBattleState', {
    roomCode: code,
    members: r.members.map(serializeMember),
    battle: r.battle ? {
      active: r.battle.active,
      currentHp: r.battle.currentHp,
      maxHp: r.battle.maxHp,
      timeLeft: r.battle.timeLeft,
    } : null,
  });
}
function endPartyBattle(code, win, reason) {
  const r = partyRooms[code];
  if(!r || !r.battle || r.battle.ended) return;
  r.battle.active = false;
  r.battle.ended = true;
  r.battle.win = win;
  if(r.battle.tick) { clearInterval(r.battle.tick); r.battle.tick=null; }
  const members = r.members.map(serializeMember).sort((a,b)=>(b.damage||0)-(a.damage||0));
  const rewards = win ? buildPartyRewards(r) : [];
  io.to(code).emit('partyBattleEnded', {
    roomCode: code, win, reason,
    members,
    monsterId: r.monsterId || '',
    monsterName: r.monsterName||'',
    rewards,
    battle: { currentHp: r.battle.currentHp, maxHp: r.battle.maxHp, timeLeft: r.battle.timeLeft }
  });
  // 방 3초 후 삭제
  setTimeout(()=>{ delete partyRooms[code]; }, 5000);
}

function getRoomList() {
  return Object.values(partyRooms)
    .filter(r => !r.battle || !r.battle.active)
    .map(r => ({
      code: r.code,
      monsterId: r.monsterId||'',
      monsterName: r.monsterName||'',
      hostName: r.members[0]?.name||'',
      memberCount: r.members.length,
      monsterHp: r.monsterHp || 0,
    }));
}

// ── 레이드 방 (고룡 코드생성 방식) ──
const raidRooms = {};

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // ── 파티 사냥 ──
  socket.on('getRooms', () => {
    socket.emit('roomList', getRoomList());
  });

  socket.on('createPartyRoom', ({ code, playerName, avatarId, title, monsterId, monsterName, monsterHp, monsterTime, monsterTier, monsterBone, monsterBaseZenny }) => {
    if(partyRooms[code]) return socket.emit('roomError', 'Room code conflict, retry');
    partyRooms[code] = {
      code,
      monsterId, monsterName, monsterHp, monsterTime, monsterTier: monsterTier||1,
      monsterBone: monsterBone || '',
      monsterBaseZenny: Number(monsterBaseZenny) || 0,
      hostId: socket.id,
      members: [{ id:socket.id, name:playerName, avatarId, title:title||'', damage:0, active:true }],
      battle: null,
    };
    socket.join(code);
    socket.emit('partyRoomCreated', {
      code, monsterId, monsterName,
      members: partyRooms[code].members.map(serializeMember),
    });
    // 방 목록 갱신
    io.emit('roomListUpdated', getRoomList());
    console.log(`Party room created: ${code} monster:${monsterName} by ${playerName}`);
  });

  socket.on('joinPartyRoom', ({ code, playerName, avatarId, title }) => {
    const r = partyRooms[code];
    if(!r) return socket.emit('roomError', 'Room not found');
    if(r.battle && r.battle.active) return socket.emit('roomError', 'Battle already started');
    if(r.members.length >= 4) return socket.emit('roomError', 'Room is full (max 4)');
    r.members.push({ id:socket.id, name:playerName, avatarId, title:title||'', damage:0, active:true });
    socket.join(code);
    io.to(code).emit('partyMemberJoined', {
      members: r.members.map(serializeMember),
      newMember: playerName,
    });
    io.emit('roomListUpdated', getRoomList());
    console.log(`${playerName} joined party room ${code}`);
  });

  socket.on('kickMember', ({ roomCode, targetId }) => {
    const r = partyRooms[roomCode];
    if(!r) return;
    if(r.hostId !== socket.id) return;
    const target = r.members.find(m => m.id === targetId);
    if(!target) return;
    r.members = r.members.filter(m => m.id !== targetId);
    // 강퇴 대상에게 알림
    io.to(targetId).emit('kicked', { roomCode, playerName: target.name });
    io.to(roomCode).emit('memberKicked', {
      playerName: target.name,
      members: r.members.map(serializeMember),
    });
    // targetId를 방에서 내보내기
    const targetSocket = io.sockets.sockets.get(targetId);
    if(targetSocket) targetSocket.leave(roomCode);
    io.emit('roomListUpdated', getRoomList());
  });

  socket.on('startPartyBattle', ({ roomCode, monsterId, monsterName, monsterHp, monsterTime, monsterTier, monsterBone, monsterBaseZenny }) => {
    const r = partyRooms[roomCode];
    if(!r) return;
    if(r.hostId !== socket.id) return;
    if(r.battle && r.battle.active) return;
    const hp = monsterHp || r.monsterHp || 10000;
    const time = monsterTime || r.monsterTime || 30;
    r.monsterId = monsterId || r.monsterId;
    r.monsterName = monsterName || r.monsterName;
    r.monsterBone = monsterBone || r.monsterBone || '';
    r.monsterBaseZenny = Number(monsterBaseZenny) || r.monsterBaseZenny || 0;
    r.members.forEach(m => { m.damage = 0; m.active = true; });
    r.battle = {
      active: true, ended: false, win: false,
      currentHp: hp, maxHp: hp,
      timeLeft: time,
      tick: null,
    };
    r.battle.tick = setInterval(() => {
      if(!r.battle || !r.battle.active) return;
      r.battle.timeLeft = Math.max(0, r.battle.timeLeft - 1);
      emitRoomState(roomCode);
      if(r.battle.timeLeft <= 0) endPartyBattle(roomCode, false, 'timeout');
    }, 1000);

    io.to(roomCode).emit('partyBattleStarted', {
      roomCode, monsterId: r.monsterId, monsterName: r.monsterName,
      monsterHp: hp, monsterTime: time, monsterTier: monsterTier||r.monsterTier||1,
      serverHp: hp,
      members: r.members.map(serializeMember),
    });
    // 시작된 방은 목록에서 제거
    io.emit('roomListUpdated', getRoomList());
    console.log(`Party battle started in ${roomCode}: ${r.monsterName} HP:${hp}`);
  });

  socket.on('partyCounterDmg', ({ roomCode, seconds }) => {
    const r = partyRooms[roomCode];
    if(!r || !r.battle || !r.battle.active || r.battle.ended) return;
    r.battle.timeLeft = Math.max(0, r.battle.timeLeft - (seconds||0));
    emitRoomState(roomCode);
    if(r.battle.timeLeft <= 0) endPartyBattle(roomCode, false, 'timeout');
  });

  socket.on('partyDamage', ({ roomCode, damage, playerName, title }) => {
    const r = partyRooms[roomCode];
    if(!r || !r.battle || !r.battle.active || r.battle.ended) return;
    const member = r.members.find(m => m.id === socket.id);
    if(!member) return;
    if(playerName) member.name = playerName;
    if(title) member.title = title;
    const dmg = Math.max(0, Number(damage)||0);
    if(!dmg) return;
    member.damage = (member.damage||0) + dmg;
    r.battle.currentHp = Math.max(0, r.battle.currentHp - dmg);
    emitRoomState(roomCode);
    if(r.battle.currentHp <= 0) endPartyBattle(roomCode, true, 'kill');
  });

  socket.on('leavePartyRoom', ({ code, playerName }) => {
    const r = partyRooms[code];
    if(!r) return;
    const wasHost = r.hostId === socket.id;
    r.members = r.members.filter(m => m.id !== socket.id);
    socket.leave(code);
    if(!r.members.length) {
      if(r.battle && r.battle.tick) clearInterval(r.battle.tick);
      delete partyRooms[code];
    } else {
      // 방장이 나가면 다음 멤버가 방장
      if(wasHost) r.hostId = r.members[0].id;
      if(r.battle && r.battle.active) {
        endPartyBattle(code, false, 'host_left');
      } else {
        io.to(code).emit('partyMemberLeft', {
          playerName: playerName||'Player',
          members: r.members.map(serializeMember),
        });
      }
    }
    io.emit('roomListUpdated', getRoomList());
  });

  // ── 레이드 (고룡, 코드생성 방식) ──
  socket.on('createRoom', ({ code, playerName, avatarId, title }) => {
    raidRooms[code] = { code, hostId:socket.id, members:[{id:socket.id,name:playerName,avatarId,title:title||'',damage:0,active:true}], battle:null };
    socket.join(code);
    socket.emit('roomCreated', { code, members: raidRooms[code].members.map(serializeMember) });
  });

  socket.on('joinRoom', ({ code, playerName, avatarId, title }) => {
    const r = raidRooms[code];
    if(!r) return socket.emit('roomError', 'Raid room not found');
    if(r.members.length>=4) return socket.emit('roomError', 'Room full');
    r.members.push({id:socket.id,name:playerName,avatarId,title:title||'',damage:0,active:true});
    socket.join(code);
    io.to(code).emit('memberJoined', { members: r.members.map(serializeMember) });
  });

  socket.on('startBattle', ({ roomCode, battle }) => {
    const r = raidRooms[roomCode];
    if(!r) return;
    const hp = (battle&&battle.isDragon) ? 52000 : 18000;
    const time = (battle&&battle.isDragon) ? 60 : 30;
    r.members.forEach(m=>{m.damage=0;m.active=true;});
    r.battle = { active:true, ended:false, currentHp:hp, maxHp:hp, timeLeft:time, tick:null };
    r.battle.tick = setInterval(()=>{
      if(!r.battle||!r.battle.active) return;
      r.battle.timeLeft=Math.max(0,r.battle.timeLeft-1);
      io.to(roomCode).emit('battleState',{roomCode,members:r.members.map(serializeMember),battle:{active:r.battle.active,currentHp:r.battle.currentHp,maxHp:r.battle.maxHp,timeLeft:r.battle.timeLeft}});
      if(r.battle.timeLeft<=0){
        r.battle.active=false;r.battle.ended=true;r.battle.win=false;
        clearInterval(r.battle.tick);
        const sorted=r.members.map(serializeMember).sort((a,b)=>(b.damage||0)-(a.damage||0));
        io.to(roomCode).emit('battleEnded',{roomCode,win:false,reason:'timeout',members:sorted,battle:r.battle});
      }
    },1000);
    io.to(roomCode).emit('battleStarted',{roomCode,members:r.members.map(serializeMember),battle:{currentHp:hp,maxHp:hp,timeLeft:time}});
  });

  socket.on('dealDamage', ({ roomCode, damage, playerName, title }) => {
    const r = raidRooms[roomCode];
    if(!r||!r.battle||!r.battle.active||r.battle.ended) return;
    const member = r.members.find(m=>m.id===socket.id);
    if(!member) return;
    if(playerName) member.name=playerName;
    if(title) member.title=title;
    const dmg=Math.max(0,Number(damage)||0);
    if(!dmg) return;
    member.damage=(member.damage||0)+dmg;
    r.battle.currentHp=Math.max(0,r.battle.currentHp-dmg);
    io.to(roomCode).emit('battleState',{roomCode,members:r.members.map(serializeMember),battle:{active:r.battle.active,currentHp:r.battle.currentHp,maxHp:r.battle.maxHp,timeLeft:r.battle.timeLeft}});
    if(r.battle.currentHp<=0){
      r.battle.active=false;r.battle.ended=true;r.battle.win=true;
      clearInterval(r.battle.tick);
      const sorted=r.members.map(serializeMember).sort((a,b)=>(b.damage||0)-(a.damage||0));
      io.to(roomCode).emit('battleEnded',{roomCode,win:true,reason:'kill',members:sorted,battle:r.battle});
      setTimeout(()=>{delete raidRooms[roomCode];},5000);
    }
  });

  socket.on('leaveBattle', ({ roomCode, playerName }) => {
    const r = raidRooms[roomCode];
    if(!r) return;
    r.members = r.members.filter(m=>m.id!==socket.id);
    socket.leave(roomCode);
    if(!r.members.length) { if(r.battle&&r.battle.tick)clearInterval(r.battle.tick); delete raidRooms[roomCode]; }
    else io.to(roomCode).emit('memberLeftBattle',{playerName:playerName||'Player',members:r.members.map(serializeMember),battle:r.battle});
  });

  socket.on('leaveRoom', ({ roomCode, playerName }) => {
    const r = raidRooms[roomCode];
    if(!r) return;
    r.members = r.members.filter(m=>m.id!==socket.id);
    socket.leave(roomCode);
    if(!r.members.length){if(r.battle&&r.battle.tick)clearInterval(r.battle.tick);delete raidRooms[roomCode];}
    else io.to(roomCode).emit('memberLeft',{playerName:playerName||'Player',members:r.members.map(serializeMember)});
  });

  socket.on('disconnect', () => {
    // 파티 방
    Object.keys(partyRooms).forEach(code => {
      const r = partyRooms[code];
      if(!r) return;
      const member = r.members.find(m=>m.id===socket.id);
      if(!member) return;
      const wasHost = r.hostId === socket.id;
      r.members = r.members.filter(m=>m.id!==socket.id);
      if(!r.members.length){
        if(r.battle&&r.battle.tick)clearInterval(r.battle.tick);
        delete partyRooms[code];
      } else {
        if(wasHost) r.hostId = r.members[0].id;
        if(r.battle&&r.battle.active) endPartyBattle(code,false,'disconnect');
        else io.to(code).emit('partyMemberLeft',{playerName:member.name,members:r.members.map(serializeMember)});
      }
      io.emit('roomListUpdated',getRoomList());
    });
    // 레이드 방
    Object.keys(raidRooms).forEach(code => {
      const r = raidRooms[code];
      if(!r) return;
      const member = r.members.find(m=>m.id===socket.id);
      if(!member) return;
      r.members = r.members.filter(m=>m.id!==socket.id);
      if(!r.members.length){if(r.battle&&r.battle.tick)clearInterval(r.battle.tick);delete raidRooms[code];}
      else io.to(code).emit(r.battle&&r.battle.active?'memberLeftBattle':'memberLeft',{playerName:member.name,members:r.members.map(serializeMember),battle:r.battle});
    });
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MHDB Server running on port ${PORT}`));
