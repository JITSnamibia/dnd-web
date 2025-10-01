const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios');
const path = require('path');
const { Mutex } = require('async-mutex'); // New dep for better locking
const rateLimit = require('express-rate-limit'); // New dep for rate limiting
const sanitizeHtml = require('sanitize-html'); // New dep for input sanitization

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Environment checks
const isProd = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL;
if (!OPENROUTER_API_KEY || !MODEL) {
    console.error("Missing OPENROUTER_API_KEY or MODEL env vars!");
    process.exit(1);
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Globals with improvements
const GAME_ROOMS = {}; // {roomId: {storyState: string (limited size), players: Set<username>, mutex: Mutex, lastUpdated: Date}}
const USERS = {}; // {socketId: {username, character: {class, hp, maxHp, level, stats, inventory}, room}}
const MAX_STATE_LENGTH = 5000; // Prevent memory bloat

// Rate limiting for AI calls
const aiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // Limit to 10 AI calls per minute per IP
    message: 'Too many AI requests - try again later.'
});
app.use('/api/ai', aiLimiter);

// Session config
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    store: new FileStore({ path: './sessions' }),
    cookie: { secure: isProd, httpOnly: true, sameSite: 'strict' }
}));

app.use(express.static(path.join(__dirname, 'public')));

// Utility functions
function generateDiceRoll(dieType = 'd20', num = 1, modifier = 0) {
    const sides = parseInt(dieType.slice(1)) || 20;
    return Array.from({ length: num }, () => Math.floor(Math.random() * sides) + 1)
        .reduce((a, b) => a + b, 0) + modifier;
}

async function callAiAsDm(prompt, roomId, context = '') {
    if (!GAME_ROOMS[roomId]) {
        GAME_ROOMS[roomId] = {
            storyState: "A new adventure begins in a vast world of magic and mystery.",
            players: new Set(),
            mutex: new Mutex(),
            lastUpdated: new Date()
        };
    }
    const room = GAME_ROOMS[roomId];
    const release = await room.mutex.acquire();
    try {
        const state = room.storyState.slice(-1000); // Use recent state for context
        const fullPrompt = `Current story state: ${state}\nContext: ${context}\nPlayer action: ${prompt}\n` +
            "As DM, respond immersively in D&D 5e style: Describe scenes, resolve actions with dice rolls if needed (e.g., attacks, checks), update player stats, track HP/inventory, and advance the plot. Keep responses concise (under 300 words). End with player hooks or decisions.";

        const response = await axios.post(OPENROUTER_URL, {
            model: MODEL,
            messages: [
                { role: "system", content: "You are an expert D&D 5e Dungeon Master for a multiplayer text adventure. Be narrative, fair, engaging. Resolve combats with d20 rolls + modifiers from player stats. Track HP, inventory, levels. Suggest group votes for major decisions." },
                { role: "user", content: fullPrompt }
            ],
            max_tokens: 500,
            temperature: 0.8
        }, {
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": process.env.SITE_URL || 'http://localhost', // Use env for prod
                "X-Title": "D&D AI Adventure Game"
            },
            timeout: 15000 // Increased timeout
        });

        if (response.status === 200) {
            let aiResponse = response.data.choices[0].message.content.trim();
            // Auto-roll dice if keywords detected
            if (/roll|attack|check|save/i.test(aiResponse)) {
                const roll = generateDiceRoll('d20', 1, 0); // Can enhance with player stats
                aiResponse += ` (DM rolls: ${roll} on d20)`;
            }
            // Update state, trim if too long
            room.storyState = (room.storyState + `\n${new Date().toLocaleTimeString()}: ${aiResponse}`).slice(-MAX_STATE_LENGTH);
            room.lastUpdated = new Date();
            return aiResponse;
        }
        throw new Error(`API error: ${response.status}`);
    } catch (error) {
        console.error('AI call error:', error);
        return `DM Error: ${error.message}. Check logs.`;
    } finally {
        release();
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/rooms', (req, res) => {
    const rooms = Object.fromEntries(
        Object.entries(GAME_ROOMS).map(([k, v]) => [k, { players: v.players.size, lastUpdated: v.lastUpdated }])
    );
    res.json(rooms);
});

// Socket.io events
io.on('connection', (socket) => {
    socket.on('create_character', (data) => {
        const sanitizedData = {
            username: sanitizeHtml(data.username || 'Anonymous', { allowedTags: [] }),
            charClass: sanitizeHtml(data.charClass || 'Adventurer', { allowedTags: [] }),
            maxHP: parseInt(data.maxHP) || 20,
            level: 1,
            stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } // New: basic stats
        };
        if (!sanitizedData.username) return socket.emit('error', 'Invalid username');

        USERS[socket.id] = {
            username: sanitizedData.username,
            character: { 
                class: sanitizedData.charClass, 
                hp: sanitizedData.maxHP, 
                maxHp: sanitizedData.maxHP, 
                level: sanitizedData.level, 
                stats: sanitizedData.stats, 
                inventory: [] 
            },
            room: 'main_adventure'
        };
        socket.emit('character_update', USERS[socket.id].character);
    });

    socket.on('join', (data) => {
        if (!USERS[socket.id]) return socket.emit('error', 'Create character first');
        const user = USERS[socket.id];
        const roomId = sanitizeHtml(data.room || 'main_adventure', { allowedTags: [] });

        if (user.room) socket.leave(user.room);
        user.room = roomId;
        socket.join(roomId);

        if (!GAME_ROOMS[roomId]) {
            GAME_ROOMS[roomId] = { storyState: "A new party forms. What adventures await?", players: new Set(), mutex: new Mutex(), lastUpdated: new Date() };
        }
        GAME_ROOMS[roomId].players.add(user.username);

        const joinMsg = `${user.username} joins ${roomId}!`;
        io.to(roomId).emit('message', { username: 'System', message: joinMsg });
        io.emit('room_update', { rooms: Object.keys(GAME_ROOMS).reduce((acc, k) => ({ ...acc, [k]: { players: GAME_ROOMS[k].players.size } }), {}) });

        // Send state snippet
        const stateSnippet = GAME_ROOMS[roomId].storyState.slice(-500);
        socket.emit('message', { username: 'DM', message: `Current tale: ${stateSnippet}...` });

        // Send player list
        socket.emit('player_list', Array.from(GAME_ROOMS[roomId].players));
    });

    socket.on('leave', () => {
        if (!USERS[socket.id]) return;
        const user = USERS[socket.id];
        const roomId = user.room;

        socket.leave(roomId);
        if (GAME_ROOMS[roomId]) {
            GAME_ROOMS[roomId].players.delete(user.username);
            if (GAME_ROOMS[roomId].players.size === 0) delete GAME_ROOMS[roomId];
        }

        io.to(roomId).emit('message', { username: 'System', message: `${user.username} departs.` });
        io.emit('room_update', { rooms: Object.keys(GAME_ROOMS).reduce((acc, k) => ({ ...acc, [k]: { players: GAME_ROOMS[k]?.players.size || 0 } }), {}) });

        user.room = 'main_adventure';
        socket.emit('join', { room: 'main_adventure' });
    });

    socket.on('message', async (data) => {
        if (!USERS[socket.id]) return;
        const user = USERS[socket.id];
        const message = sanitizeHtml(data.message.trim(), { allowedTags: [] });
        if (!message) return;

        const roomId = user.room;
        io.to(roomId).emit('message', { username: user.username, message });

        // Trigger AI if action-oriented
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.startsWith('i ') || lowerMsg.startsWith('we ') || lowerMsg.startsWith('group: ') || lowerMsg.startsWith('the party ') ||
            /attack|cast|investigate|roll|\?/i.test(lowerMsg)) {
            const context = `Player: ${user.username}, Character: ${JSON.stringify(user.character)}`;
            const aiResponse = await callAiAsDm(message, roomId, context);

            // Parse for inventory/HP updates (simple regex-based)
            if (/loot|find|treasure/i.test(aiResponse)) {
                const newItem = ['Potion', 'Sword', 'Gold', 'Scroll'][Math.floor(Math.random() * 4)];
                user.character.inventory.push(newItem);
                socket.emit('character_update', user.character);
            }
            if (/damage|hurt/i.test(aiResponse)) {
                user.character.hp = Math.max(0, user.character.hp - generateDiceRoll('d6')); // Example damage
                socket.emit('character_update', user.character);
            }

            io.to(roomId).emit('message', { username: 'DM', message: aiResponse });
        }
    });

    socket.on('roll_dice', (data) => {
        const { dieType, num, modifier } = data;
        const roll = generateDiceRoll(dieType, num, modifier);
        const msg = `${USERS[socket.id].username} rolls ${num}${dieType} + ${modifier}: ${roll}`;
        io.to(USERS[socket.id].room).emit('message', { username: 'System', message: msg });
    });

    socket.on('disconnect', () => {
        if (USERS[socket.id]) {
            const user = USERS[socket.id];
            const roomId = user.room;
            if (GAME_ROOMS[roomId]) {
                GAME_ROOMS[roomId].players.delete(user.username);
                if (GAME_ROOMS[roomId].players.size === 0) delete GAME_ROOMS[roomId];
                io.to(roomId).emit('message', { username: 'System', message: `${user.username} departs.` });
                io.emit('room_update', { rooms: Object.keys(GAME_ROOMS).reduce((acc, k) => ({ ...acc, [k]: { players: GAME_ROOMS[k]?.players.size || 0 } }), {}) });
            }
            delete USERS[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT} with model: ${MODEL}`);
});
