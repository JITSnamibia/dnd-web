const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios'); // For API calls (replaces requests)
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Sessions config (file-based for self-hosting)
app.use(session({
    secret: process.env.SESSION_SECRET || 'super-secret-key-change-me!',
    resave: false,
    saveUninitialized: true,
    store: new FileStore(),
    cookie: { secure: false } // Set true for HTTPS in prod
}));

app.use(express.static(path.join(__dirname, 'public')));

// Globals
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL;
if (!OPENROUTER_API_KEY || !MODEL) {
    console.error("Set OPENROUTER_API_KEY and MODEL env vars!");
    process.exit(1);
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GAME_ROOMS = {}; // {room_id: {story_state: str, players: Set, lock: async lock simulation}}
const DEFAULT_ROOM = 'main_adventure';
const USERS = {}; // {socket_id: {username, character, room}}

// Simple async lock simulation (Node doesn't have built-in; use per-room)
class SimpleLock {
    constructor() {
        this.locked = false;
        this.queue = [];
    }
    async acquire() {
        return new Promise(resolve => {
            if (!this.locked) {
                this.locked = true;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }
    release() {
        this.locked = false;
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            next();
        }
    }
}

function generateDiceRoll(dieType = 'd20', num = 1, modifier = 0) {
    return Array.from({length: num}, () => Math.floor(Math.random() * parseInt(dieType.slice(1))) + 1)
        .reduce((a, b) => a + b, 0) + modifier;
}

async function callAiAsDm(prompt, roomId, context = null) {
    // Simulate lock for room
    if (!GAME_ROOMS[roomId]) {
        GAME_ROOMS[roomId] = { story_state: "A new adventure begins in a vast world of magic and mystery.", players: new Set(), lock: new SimpleLock() };
    }
    const roomData = GAME_ROOMS[roomId];
    const release = await roomData.lock.acquire();
    try {
        const state = roomData.story_state;
        const fullPrompt = `Current story state: ${state}\nContext: ${context || ''}\nPlayer action: ${prompt}\n` +
            "As DM, respond immersively: Describe scenes, outcomes (use dice if implied, e.g., attack rolls), NPCs, and advance the plot. Keep concise, D&D-style. End with hooks for players.";

        const response = await axios.post(OPENROUTER_URL, {
            model: MODEL,
            messages: [
                { role: "system", content: "You are an expert Dungeon Master for a multiplayer D&D 5e text adventure. Be narrative, fair, and engaging. Incorporate player actions, resolve combats with implied d20 rolls, track simple stats (HP, inventory). Suggest group decisions." },
                { role: "user", content: fullPrompt }
            ],
            max_tokens: 500,
            temperature: 0.8
        }, {
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": req ? req.headers.origin : '', // Fallback
                "X-Title": "D&D AI Adventure Game"
            },
            timeout: 10000
        });

        if (response.status === 200) {
            let aiResponse = response.data.choices[0].message.content.trim();
            // Simulate dice if mentioned
            if (['roll', 'attack', 'check'].some(word => aiResponse.toLowerCase().includes(word))) {
                const roll = generateDiceRoll();
                aiResponse += ` (DM rolls: ${roll} on d20)`;
            }
            // Update state
            roomData.story_state += `\n${new Date().toLocaleTimeString()}: ${aiResponse}`;
            return aiResponse;
        } else {
            return `DM Error: ${response.status} - Check API key/quotas.`;
        }
    } catch (error) {
        return `DM Exception: ${error.message}`;
    } finally {
        roomData.lock.release();
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/rooms', (req, res) => {
    res.json(Object.fromEntries(Object.entries(GAME_ROOMS).map(([k, v]) => [k, { players: v.players.size }])));
});

// Socket.io events
io.on('connection', (socket) => {
    socket.on('create_character', (data) => {
        USERS[socket.id] = {
            username: data.username,
            character: { class: data.charClass, hp: data.maxHP, inventory: [] },
            room: DEFAULT_ROOM
        };
        socket.emit('character_update', { inventory: [] });
    });

    socket.on('join', (data) => {
        if (!USERS[socket.id]) {
            socket.emit('message', { username: 'System', message: 'Create a character first!' });
            return;
        }
        const username = USERS[socket.id].username;
        let roomId = data.room || DEFAULT_ROOM;
        USERS[socket.id].room = roomId;

        socket.join(roomId);
        if (!GAME_ROOMS[roomId]) {
            GAME_ROOMS[roomId] = { story_state: "A new party forms. What adventures await?", players: new Set(), lock: new SimpleLock() };
        }

        GAME_ROOMS[roomId].players.add(username);

        socket.to(roomId).emit('message', { username: 'System', message: `${username} joins ${roomId}! The tale unfolds...` });
        socket.emit('message', { username: 'System', message: `${username} joins ${roomId}! The tale unfolds...` });

        io.emit('room_update', { rooms: Object.fromEntries(Object.entries(GAME_ROOMS).map(([k, v]) => [k, { players: v.players.size }])) });

        // Send current state to new player
        const currentState = GAME_ROOMS[roomId].story_state.slice(-500); // Last 500 chars
        socket.emit('message', { username: 'DM (AI)', message: `Current tale: ${currentState}...` });
    });

    socket.on('leave', (data) => {
        if (!USERS[socket.id]) return;
        const username = USERS[socket.id].username;
        const roomId = USERS[socket.id].room;

        socket.leave(roomId);
        if (GAME_ROOMS[roomId]) {
            GAME_ROOMS[roomId].players.delete(username);
            if (GAME_ROOMS[roomId].players.size === 0) {
                delete GAME_ROOMS[roomId];
            }
        }

        socket.to(roomId).emit('message', { username: 'System', message: `${username} departs the realm.` });

        io.emit('room_update', { rooms: Object.fromEntries(Object.entries(GAME_ROOMS).filter(([_, v]) => v.players.size > 0).map(([k, v]) => [k, { players: v.players.size }])) });

        // Default back to main room (optional)
        USERS[socket.id].room = DEFAULT_ROOM;
        socket.emit('join', { room: DEFAULT_ROOM });
    });

    socket.on('message', async (data) => {
        if (!USERS[socket.id]) return;
        const username = USERS[socket.id].username;
        const message = data.message;
        const roomId = USERS[socket.id].room;

        // Broadcast to room
        socket.to(roomId).emit('message', { username, message });

        // Trigger AI for actions
        const lowerMsg = message.toLowerCase();
        if (['i ', 'we ', 'group: ', 'the party '].some(prefix => lowerMsg.startsWith(prefix)) ||
            ['attack', 'cast', 'investigate', 'roll', '?'].some(word => lowerMsg.includes(word))) {
            const context = `Player: ${username}, Character: ${JSON.stringify(USERS[socket.id].character)}`;
            const aiResponse = await callAiAsDm(message, roomId, context);
            // Simple loot simulation
            if (['find', 'loot', 'treasure'].some(word => aiResponse.toLowerCase().includes(word))) {
                const items = ['Potion of Healing', 'Rusty Sword', 'Gold Coin', 'Magic Scroll'];
                const newItem = items[Math.floor(Math.random() * items.length)];
                USERS[socket.id].character.inventory.push(newItem);
                socket.emit('character_update', { inventory: USERS[socket.id].character.inventory });
            }
            socket.to(roomId).emit('message', { username: 'DM (AI)', message: aiResponse });
            socket.emit('message', { username: 'DM (AI)', message: aiResponse });
        }
    });

    socket.on('disconnect', () => {
        if (USERS[socket.id]) {
            const username = USERS[socket.id].username;
            const roomId = USERS[socket.id].room;
            if (GAME_ROOMS[roomId]) {
                GAME_ROOMS[roomId].players.delete(username);
                if (GAME_ROOMS[roomId].players.size === 0) {
                    delete GAME_ROOMS[roomId];
                }
                io.to(roomId).emit('message', { username: 'System', message: `${username} departs the realm.` });
                io.emit('room_update', { rooms: Object.fromEntries(Object.entries(GAME_ROOMS).filter(([_, v]) => v.players.size > 0).map(([k, v]) => [k, { players: v.players.size }])) });
            }
            delete USERS[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Starting D&D AI Game Server on port ${PORT} with model: ${MODEL}`);
    console.log('💡 Set env: OPENROUTER_API_KEY, MODEL, SESSION_SECRET');
    console.log('💡 Prod: pm2 start server.js or Heroku deploy');
    console.log('💡 Access: http://your-ip:3000');
});
