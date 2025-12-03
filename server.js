const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const ADMIN_PASSWORD = "1qaz2wsx$";

// --- HELPER: Generate Sorted Bingo Card ---
function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getUniqueRandoms(min, max, count) {
    let nums = new Set();
    while(nums.size < count) nums.add(getRandomInt(min, max));
    return Array.from(nums).sort((a, b) => a - b);
}

function generatePlayerCard() {
    const b = getUniqueRandoms(1, 30, 5);
    const i = getUniqueRandoms(31, 60, 5);
    let nRaw = getUniqueRandoms(61, 90, 4); 
    const col3 = [nRaw[0], nRaw[1], 151, nRaw[2], nRaw[3]]; 
    const g = getUniqueRandoms(91, 120, 5);
    const o = getUniqueRandoms(121, 150, 5);

    const col1 = b;
    const col2 = i;
    const col4 = g;
    const col5 = o;

    let grid = [];
    for(let r=0; r<5; r++) {
        grid.push([col1[r], col2[r], col3[r], col4[r], col5[r]]);
    }
    return grid;
}

// --- HELPER: Calculate Distance ---
function calculateDistanceToBingo(card, markedNumbers) {
    let minMissing = 5;

    const checkLine = (line) => {
        let missing = 0;
        line.forEach(num => {
            if (!markedNumbers.includes(num)) missing++;
        });
        if (missing < minMissing) minMissing = missing;
    };

    for (let r = 0; r < 5; r++) checkLine(card[r]);
    for (let c = 0; c < 5; c++) {
        let col = [card[0][c], card[1][c], card[2][c], card[3][c], card[4][c]];
        checkLine(col);
    }
    checkLine([card[0][0], card[1][1], card[2][2], card[3][3], card[4][4]]);
    checkLine([card[0][4], card[1][3], card[2][2], card[3][1], card[4][0]]);

    return minMissing;
}

io.on('connection', (socket) => {
    
    // --- HOST EVENTS ---
    socket.on('create_game', (password) => {
        if (password !== ADMIN_PASSWORD) {
            socket.emit('error_msg', 'Incorrect Admin Password');
            return;
        }

        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            hostId: socket.id,
            started: false,
            calledNumbers: [],
            availableNumbers: Array.from({length: 150}, (_, i) => i + 1),
            players: [], 
            winner: null
        };
        
        socket.join(roomCode);
        socket.emit('game_created', roomCode);
    });

    socket.on('start_game', (roomCode) => {
        if (rooms[roomCode] && rooms[roomCode].hostId === socket.id) {
            rooms[roomCode].started = true;
            io.to(roomCode).emit('game_started');
            updateHostLeaderboard(roomCode);
        }
    });

    socket.on('draw_number', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id && room.availableNumbers.length > 0 && !room.winner) {
            const randomIndex = Math.floor(Math.random() * room.availableNumbers.length);
            const number = room.availableNumbers[randomIndex];
            
            room.availableNumbers.splice(randomIndex, 1);
            room.calledNumbers.push(number);

            io.to(roomCode).emit('number_drawn', { 
                number: number, 
                history: room.calledNumbers 
            });

            updateHostLeaderboard(roomCode);
        }
    });

    // --- PLAYER EVENTS ---
    socket.on('join_game', ({roomCode, name}) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error_msg', 'Room does not exist.');
        if (room.started) return socket.emit('error_msg', 'Game already started.');

        const myCard = generatePlayerCard();

        const playerObj = {
            id: socket.id,
            name: name || `Player ${room.players.length + 1}`,
            card: myCard,
            markedNumbers: [151], 
            toGo: 5
        };

        room.players.push(playerObj);
        socket.join(roomCode);

        socket.emit('joined_success', { roomCode, card: myCard });
        
        // Broadcast new count to everyone in the room
        io.to(roomCode).emit('player_count_update', room.players.length);
    });

    socket.on('mark_number', ({roomCode, number, isMarking}) => {
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (isMarking) {
            if (room.calledNumbers.includes(number) || number === 151) {
                if (!player.markedNumbers.includes(number)) {
                    player.markedNumbers.push(number);
                }
            }
        } else {
            player.markedNumbers = player.markedNumbers.filter(n => n !== number);
            if (!player.markedNumbers.includes(151)) player.markedNumbers.push(151);
        }

        updateHostLeaderboard(roomCode);
    });

    socket.on('claim_bingo', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.winner) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const dist = calculateDistanceToBingo(player.card, player.markedNumbers);
        
        if (dist === 0) {
            room.winner = player.name;
            io.to(roomCode).emit('game_over', player.name);
        } else {
            socket.emit('error_msg', 'False Bingo! You do not have 5 in a row yet.');
        }
    });

    function updateHostLeaderboard(roomCode) {
        const room = rooms[roomCode];
        if(!room) return;

        room.players.forEach(p => {
            p.toGo = calculateDistanceToBingo(p.card, p.markedNumbers);
        });

        room.players.sort((a, b) => a.toGo - b.toGo);

        const top10 = room.players.slice(0, 10);
        const hostSocket = io.sockets.sockets.get(room.hostId);
        
        if(hostSocket) {
            hostSocket.emit('host_update', {
                topPlayers: top10,
                calledNumbers: room.calledNumbers
            });
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});