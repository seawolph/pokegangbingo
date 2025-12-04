const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000, 
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const ADMIN_PASSWORD = "1qaz2wsx$";

const BAD_WORDS = [
    "nigger", "nigga", "faggot", "dyke", "retard", "chink", "kike", "spic", "tranny", 
    "cunt", "whore", "slut", "dick", "pussy", "cock", "hitler", "nazi", "rapist", "suicide", "nig", "gay"
]; 

function filterMessage(text) {
    let filtered = text;
    BAD_WORDS.forEach(word => {
        const regex = new RegExp(word, "gi"); 
        filtered = filtered.replace(regex, "*".repeat(word.length));
    });
    return filtered;
}

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
    
    socket.on('create_game', ({ password, clientID }) => {
        if (password !== ADMIN_PASSWORD) {
            socket.emit('error_msg', 'Incorrect Admin Password');
            return;
        }

        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            hostId: socket.id,
            hostClientID: clientID,
            hostLastChat: 0,
            started: false,
            calledNumbers: [],
            availableNumbers: Array.from({length: 150}, (_, i) => i + 1),
            players: [], 
            bannedClients: [], 
            winner: null,
            chatHistory: [],
            voteData: {
                active: false,
                endTime: 0,
                counts: { B: 0, I: 0, N: 0, G: 0, O: 0 },
                voters: []
            }
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
        drawNumberLogic(roomCode);
    });

    socket.on('send_chat', ({ roomCode, message, clientID }) => {
        const room = rooms[roomCode];
        if (!room) return;

        let senderName = "Unknown";
        let lastChatTime = 0;
        let isHost = false;

        if (room.hostClientID === clientID) {
            senderName = "HOST";
            lastChatTime = room.hostLastChat;
            isHost = true;
        } else {
            const player = room.players.find(p => p.clientID === clientID);
            if (player) {
                senderName = player.name;
                lastChatTime = player.lastChatTime || 0;
            } else {
                return;
            }
        }

        const now = Date.now();
        if (now - lastChatTime < 10000) {
            socket.emit('error_msg', 'Slow mode: Please wait 10 seconds.');
            return;
        }

        if (isHost) room.hostLastChat = now;
        else {
            const player = room.players.find(p => p.clientID === clientID);
            if (player) player.lastChatTime = now;
        }

        const cleanMessage = filterMessage(message.substring(0, 100));

        const msgObj = {
            name: senderName,
            text: cleanMessage,
            isHost: isHost,
            clientID: clientID
        };

        room.chatHistory.push(msgObj);
        if (room.chatHistory.length > 50) room.chatHistory.shift();

        io.to(roomCode).emit('chat_message', msgObj);
    });

    // --- BAN PLAYER LOGIC ---
    socket.on('ban_player', ({ roomCode, targetClientID }) => {
        const room = rooms[roomCode];
        if (!room) return;

        // Security Check: Only Host can ban
        if (room.hostId !== socket.id) return;
        if (targetClientID === room.hostClientID) return;

        room.bannedClients.push(targetClientID);

        let bannedName = "A player";

        // Remove from players list
        const playerIndex = room.players.findIndex(p => p.clientID === targetClientID);
        if (playerIndex !== -1) {
            const player = room.players[playerIndex];
            bannedName = player.name;
            io.to(player.id).emit('banned'); 
            room.players.splice(playerIndex, 1);
        }

        // Clean Chat History
        room.chatHistory = room.chatHistory.filter(msg => msg.clientID !== targetClientID);

        // Add System Message about the ban
        const sysMsg = {
            name: "SYSTEM",
            text: `${bannedName} was banned by the Host.`,
            isHost: true,
            isSystem: true // New flag for styling
        };
        room.chatHistory.push(sysMsg);

        // Broadcast Updates
        io.to(roomCode).emit('chat_history_update', room.chatHistory); 
        io.to(roomCode).emit('player_count_update', room.players.length);
        updateHostLeaderboard(roomCode);
    });

    // --- VOTING LOGIC ---
    socket.on('start_vote', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id || room.voteData.active) return;

        const duration = 15000; 
        const endTime = Date.now() + duration;

        room.voteData = {
            active: true,
            endTime: endTime,
            counts: { B: 0, I: 0, N: 0, G: 0, O: 0 },
            voters: []
        };

        io.to(roomCode).emit('vote_started', { endTime: endTime });

        setTimeout(() => {
            endVoteAndDraw(roomCode);
        }, duration);
    });

    socket.on('submit_vote', ({ roomCode, letter, clientID }) => {
        const room = rooms[roomCode];
        if (!room || !room.voteData.active) return;
        if (room.voteData.voters.includes(clientID)) return;

        if (['B','I','N','G','O'].includes(letter)) {
            room.voteData.counts[letter]++;
            room.voteData.voters.push(clientID);
            io.to(roomCode).emit('vote_update', room.voteData.counts);
        }
    });

    function endVoteAndDraw(roomCode) {
        const room = rooms[roomCode];
        if (!room || !room.voteData.active) return;

        room.voteData.active = false;
        
        const counts = room.voteData.counts;
        let winningLetter = null;
        let maxVotes = -1;

        for (const [letter, count] of Object.entries(counts)) {
            if (count > maxVotes) {
                maxVotes = count;
                winningLetter = letter;
            }
        }
        if (maxVotes === 0) winningLetter = null;

        io.to(roomCode).emit('vote_ended', winningLetter);
        drawNumberLogic(roomCode, winningLetter);
    }

    function drawNumberLogic(roomCode, preferredLetter = null) {
        const room = rooms[roomCode];
        if (room && room.availableNumbers.length > 0 && !room.winner) {
            
            let filteredPool = room.availableNumbers;

            if (preferredLetter) {
                let min=1, max=150;
                if (preferredLetter === 'B') { min=1; max=30; }
                if (preferredLetter === 'I') { min=31; max=60; }
                if (preferredLetter === 'N') { min=61; max=90; }
                if (preferredLetter === 'G') { min=91; max=120; }
                if (preferredLetter === 'O') { min=121; max=150; }

                const letterSpecific = room.availableNumbers.filter(n => n >= min && n <= max);
                if (letterSpecific.length > 0) {
                    filteredPool = letterSpecific;
                }
            }

            const randomIndex = Math.floor(Math.random() * filteredPool.length);
            const number = filteredPool[randomIndex];
            
            const mainIndex = room.availableNumbers.indexOf(number);
            if (mainIndex > -1) room.availableNumbers.splice(mainIndex, 1);
            
            room.calledNumbers.push(number);

            io.to(roomCode).emit('number_drawn', { 
                number: number, 
                history: room.calledNumbers 
            });

            updateHostLeaderboard(roomCode);
        }
    }

    socket.on('join_game', ({roomCode, name, clientID}) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error_msg', 'Room does not exist.');

        if (room.bannedClients.includes(clientID)) {
            socket.emit('banned');
            return;
        }

        const existingPlayer = room.players.find(p => p.clientID === clientID);
        if (existingPlayer) {
            existingPlayer.id = socket.id;
            socket.join(roomCode);
            socket.emit('joined_success', { 
                roomCode, 
                card: existingPlayer.card,
                markedNumbers: existingPlayer.markedNumbers,
                chatHistory: room.chatHistory
            });
            if(room.started) socket.emit('game_started');
            if (room.calledNumbers.length > 0) {
                socket.emit('number_drawn', { 
                    number: room.calledNumbers[room.calledNumbers.length - 1], 
                    history: room.calledNumbers 
                });
            }
            if (room.voteData.active) {
                const hasVoted = room.voteData.voters.includes(clientID);
                socket.emit('vote_started', { 
                    endTime: room.voteData.endTime,
                    hasVoted: hasVoted,
                    counts: room.voteData.counts
                }); 
            }
            return;
        }

        if (room.started) return socket.emit('error_msg', 'Game already started.');

        const myCard = generatePlayerCard();
        const playerObj = {
            id: socket.id,
            clientID: clientID,
            name: name || `Player ${room.players.length + 1}`,
            card: myCard,
            markedNumbers: [151], 
            toGo: 5,
            lastChatTime: 0
        };

        room.players.push(playerObj);
        socket.join(roomCode);

        socket.emit('joined_success', { 
            roomCode, 
            card: myCard,
            markedNumbers: [151],
            chatHistory: room.chatHistory
        });
        io.to(roomCode).emit('player_count_update', room.players.length);
    });

    socket.on('reconnect_session', ({ roomCode, clientID }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (room.bannedClients.includes(clientID)) {
            socket.emit('banned');
            return;
        }

        if (room.hostClientID === clientID) {
            room.hostId = socket.id;
            socket.join(roomCode);
            socket.emit('game_created', {
                roomCode: roomCode,
                chatHistory: room.chatHistory
            }); 
            if(room.started) socket.emit('game_started');
            updateHostLeaderboard(roomCode);
            if (room.calledNumbers.length > 0) {
                socket.emit('number_drawn', { 
                    number: room.calledNumbers[room.calledNumbers.length - 1], 
                    history: room.calledNumbers 
                });
            }
            if (room.voteData.active) {
                socket.emit('vote_started', { 
                    endTime: room.voteData.endTime,
                    counts: room.voteData.counts
                }); 
            }
            return;
        }

        const player = room.players.find(p => p.clientID === clientID);
        if (player) {
            player.id = socket.id;
            socket.join(roomCode);
            socket.emit('joined_success', { 
                roomCode, 
                card: player.card,
                markedNumbers: player.markedNumbers,
                chatHistory: room.chatHistory
            });
            if (room.started) socket.emit('game_started');
            if (room.calledNumbers.length > 0) {
                socket.emit('number_drawn', { 
                    number: room.calledNumbers[room.calledNumbers.length - 1], 
                    history: room.calledNumbers 
                });
            }
            if (room.voteData.active) {
                const hasVoted = room.voteData.voters.includes(clientID);
                socket.emit('vote_started', { 
                    endTime: room.voteData.endTime,
                    hasVoted: hasVoted,
                    counts: room.voteData.counts
                }); 
            }
        }
    });

    socket.on('mark_number', ({roomCode, number, isMarking}) => {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (isMarking) {
            if (room.calledNumbers.includes(number) || number === 151) {
                if (!player.markedNumbers.includes(number)) player.markedNumbers.push(number);
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




