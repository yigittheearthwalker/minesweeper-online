const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

const rooms = new Map();
const shortIdToUuid = new Map();

function generateShortId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/game/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/create-game', (req, res) => {
  const uuid = uuidv4();
  let shortId;
  do {
    shortId = generateShortId();
  } while (shortIdToUuid.has(shortId));

  shortIdToUuid.set(shortId, uuid);
  const width = 10;
  const height = 10;
  const mineCount = 10;
  const mode = req.query.mode === 'single' ? 'single' : 'multi';
  rooms.set(uuid, {
    shortId,
    players: [],
    board: createBoard(width, height),
    minePositions: placeMines(width, height, mineCount),
    currentTurn: 0,
    width,
    height,
    mineCount,
    mode
  });
  res.json({ roomId: shortId });
});

io.on('connection', (socket) => {
  console.log('New user connected');

  socket.on('joinRoom', (shortId) => {
    const uuid = shortIdToUuid.get(shortId);
    const room = rooms.get(uuid);
    if (room) {
      if (room.mode === 'single' || (room.mode === 'multi' && room.players.length < 2)) {
        const playerIndex = room.players.length;
        room.players.push({ id: socket.id, index: playerIndex });
        socket.join(uuid);
        
        socket.emit('gameState', {
          board: room.board,
          currentTurn: room.currentTurn,
          playerIndex: playerIndex,
          shortId: room.shortId,
          width: room.width,
          height: room.height,
          mineCount: room.mineCount,
          mode: room.mode
        });

        if (room.mode === 'multi' && room.players.length === 2) {
          io.to(uuid).emit('gameStart', {
            board: room.board,
            currentTurn: room.currentTurn,
            width: room.width,
            height: room.height,
            mineCount: room.mineCount
          });
        }
      } else {
        socket.emit('roomFull');
      }
    } else {
      socket.emit('roomNotFound');
    }
  });

  socket.on('resetGame', (shortId) => {
    const uuid = shortIdToUuid.get(shortId);
    const room = rooms.get(uuid);
    if (room && room.players[0].id === socket.id) {
      room.board = createBoard(room.width, room.height);
      room.minePositions = placeMines(room.width, room.height, room.mineCount);
      room.currentTurn = 0;
      io.to(uuid).emit('gameReset', {
        board: room.board,
        currentTurn: room.currentTurn,
        width: room.width,
        height: room.height,
        mineCount: room.mineCount
      });
    }
  });

  socket.on('move', ({ shortId, x, y }) => {
    const uuid = shortIdToUuid.get(shortId);
    const room = rooms.get(uuid);
    if (room && (room.mode === 'single' || (room.mode === 'multi' && room.players[room.currentTurn].id === socket.id))) {
      console.log(`Move made: Room ${shortId}, Player ${room.currentTurn}, x: ${x}, y: ${y}`);
      const result = revealCell(room, x, y);
      if (result === 'mine') {
        io.to(uuid).emit('gameOver', {
          result: 'mine',
          loser: room.currentTurn,
          winner: room.mode === 'multi' ? (room.currentTurn + 1) % 2 : null
        });
      } else if (result === 'game end') {
        io.to(uuid).emit('gameOver', { result: 'draw' });
      } else {
        if (room.mode === 'multi') {
          room.currentTurn = (room.currentTurn + 1) % 2;
        }
        io.to(uuid).emit('updateBoard', {
          board: room.board,
          currentTurn: room.currentTurn
        });
      }
    } else {
      console.log(`Invalid move: Room ${shortId}, Player ${socket.id}, Current turn: ${room ? room.currentTurn : 'Room not found'}`);
    }
  });

  socket.on('disconnect', () => {
    // Handle player leaving the room logic
  });

  socket.on('setDifficulty', ({ shortId, width, height, mineCount }) => {
    const uuid = shortIdToUuid.get(shortId);
    const room = rooms.get(uuid);
    if (room && room.players[0].id === socket.id) {
      room.width = width;
      room.height = height;
      room.mineCount = mineCount;
      room.board = createBoard(width, height);
      room.minePositions = placeMines(width, height, mineCount);
      room.currentTurn = 0;
      io.to(uuid).emit('difficultySet', {
        board: room.board,
        currentTurn: room.currentTurn,
        width,
        height,
        mineCount
      });
    }
  });

  socket.on('sendMessage', ({ shortId, message }) => {
    const uuid = shortIdToUuid.get(shortId);
    const room = rooms.get(uuid);
    if (room) {
      const playerIndex = room.players.findIndex(player => player.id === socket.id);
      if (playerIndex !== -1) {
        io.to(uuid).emit('newMessage', {
          playerIndex,
          message
        });
      }
    }
  });
});

function createBoard(width, height) {
  return Array(height).fill().map(() => Array(width).fill('hidden'));
}

function placeMines(width, height, mineCount) {
  const mines = new Set();
  while (mines.size < mineCount) {
    const x = Math.floor(Math.random() * width);
    const y = Math.floor(Math.random() * height);
    mines.add(`${x},${y}`);
  }
  return mines;
}

function revealCell(room, x, y) {
  if (!room.board || !room.board[y] || room.board[y][x] !== 'hidden') {
    return 'already revealed';
  }
  
  if (room.minePositions.has(`${x},${y}`)) {
    room.board[y][x] = 'mine';
    return 'mine';
  }

  const count = countAdjacentMines(room, x, y);
  room.board[y][x] = count.toString();

  if (count === 0) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const newX = x + dx;
        const newY = y + dy;
        if (newX >= 0 && newX < room.width && newY >= 0 && newY < room.height && room.board[newY][newX] === 'hidden') {
          revealCell(room, newX, newY);
        }
      }
    }
  }

  if (checkGameEnd(room)) {
    return 'game end';
  }

  return 'safe';
}

function checkGameEnd(room) {
  let hiddenCount = 0;
  for (let y = 0; y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      if (room.board[y][x] === 'hidden') {
        hiddenCount++;
      }
    }
  }
  return hiddenCount === room.minePositions.size;
}

function countAdjacentMines(room, x, y) {
  let count = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const newX = x + dx;
      const newY = y + dy;
      if (newX >= 0 && newX < room.width && newY >= 0 && newY < room.height && room.minePositions.has(`${newX},${newY}`)) {
        count++;
      }
    }
  }
  return count;
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});