const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios');
const path = require('path');
const crypto = require('crypto'); // FIXED: Added missing require

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
    console.error("❌ Missing OPENROUTER_API_KEY or MODEL env vars!");
    process.exit(1);
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GAME_ROOMS = {};
const USERS = {};
const MAX_STATE_LENGTH = 5000;

// Session config
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    store: new FileStore({ path: './sessions' }),
    cookie: { secure: isProd, httpOnly: true }
}));

// FIXED: Static files MUST be served before any routes
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Simple async lock
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
            this.locked = true;
            next();
        }
    }
}

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
            lock: new SimpleLock(),
            lastUpdated: new Date()
        };
    }
    
    const room = GAME_ROOMS[roomId];
    await room.lock.acquire();
    
    try {
        const state = room.storyState.slice(-1000);
        const fullPrompt = `Current story: ${state}\nContext: ${context}\nPlayer action: ${prompt}\n` +
            "As DM, respond in D&D 5e style: Describe scenes, resolve actions with dice rolls, update HP/inventory, advance plot. Keep under 300 words. End with hooks.";

        const response = await axios.post(OPENROUTER_URL, {
            model: MODEL,
            messages: [
                { role: "system", content: "You are a D&D 5e Dungeon Master. Be narrative, fair, engaging. Resolve combats with d20 rolls. Track HP, inventory, levels." },
                { role: "user", content: fullPrompt }
            ],
            max_tokens: 500,
            temperature: 0.8
        }, {
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": process.env.SITE_URL || 'http://localhost:3000',
                "X-Title": "D&D AI Adventure"
            },
            timeout: 15000
        });

        if (response.status === 200) {
            let aiResponse = response.data.choices[0].message.content.trim();
            
            if (/roll|attack|check|save/i.test(aiResponse)) {
                const roll = generateDiceRoll('d20', 1, 0);
                aiResponse += ` (DM rolls: ${roll} on d20)`;
            }
            
            room.storyState = (room.storyState + `\n[${new Date().toLocaleTimeString()}] ${aiResponse}`).slice(-MAX_STATE_LENGTH);
            room.lastUpdated = new Date();
            return aiResponse;
        }
        throw new Error(`API error: ${response.status}`);
    } catch (error) {
        console.error('AI Error:', error.message);
        return `DM Error: ${error.message}`;
    } finally {
        room.lock.release();
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/rooms', (req, res) => {
    const rooms = Object.fromEntries(
        Object.entries(GAME_ROOMS).map(([k, v]) => [k, { 
            players: v.players.size, 
            lastUpdated: v.lastUpdated 
        }])
    );
    res.json(rooms);
});

// Socket.io events
io.on('connection', (socket) => {
    console.log('✅ Client connected:', socket.id);

    socket.on('create_character', (data) => {
        const username = (data.username || 'Anonymous').trim().slice(0, 20);
        const charClass = (data.charClass || 'Adventurer').trim().slice(0, 20);
        const maxHP = parseInt(data.maxHP) || 20;

        if (!username) return socket.emit('error', 'Username required');

        USERS[socket.id] = {
            username: username,
            character: { 
                class: charClass, 
                hp: maxHP, 
                maxHp: maxHP, 
                level: 1, 
                inventory: [] 
            },
            room: 'main_adventure'
        };
        
        socket.emit('character_created', USERS[socket.id]);
        console.log('✅ Character created:', username);
    });

    socket.on('join', (data) => {
        if (!USERS[socket.id]) {
            return socket.emit('error', 'Create character first');
        }
        
        const user = USERS[socket.id];
        const roomId = (data.room || 'main_adventure').trim().toLowerCase().replace(/\s+/g, '_');

        if (user.room) {
            socket.leave(user.room);
            if (GAME_ROOMS[user.room]) {
                GAME_ROOMS[user.room].players.delete(user.username);
            }
        }

        user.room = roomId;
        socket.join(roomId);

        if (!GAME_ROOMS[roomId]) {
            GAME_ROOMS[roomId] = { 
                storyState: "A new party forms. What adventures await?", 
                players: new Set(), 
                lock: new SimpleLock(), 
                lastUpdated: new Date() 
            };
        }
        
        GAME_ROOMS[roomId].players.add(user.username);

        io.to(roomId).emit('message', { 
            username: 'System', 
            message: `${user.username} joins ${roomId}!` 
        });

        io.emit('room_update', { 
            rooms: Object.fromEntries(
                Object.entries(GAME_ROOMS).map(([k, v]) => [k, { players: v.players.size }])
            ) 
        });

        const stateSnippet = GAME_ROOMS[roomId].storyState.slice(-500);
        socket.emit('message', { 
            username: 'DM', 
            message: `Current tale: ${stateSnippet}...` 
        });

        socket.emit('player_list', Array.from(GAME_ROOMS[roomId].players));
        console.log('✅', user.username, 'joined', roomId);
    });

    socket.on('leave', () => {
        if (!USERS[socket.id]) return;
        
        const user = USERS[socket.id];
        const roomId = user.room;

        socket.leave(roomId);
        
        if (GAME_ROOMS[roomId]) {
            GAME_ROOMS[roomId].players.delete(user.username);
            if (GAME_ROOMS[roomId].players.size === 0) {
                delete GAME_ROOMS[roomId];
            }
        }

        io.to(roomId).emit('message', { 
            username: 'System', 
            message: `${user.username} departs.` 
        });

        io.emit('room_update', { 
            rooms: Object.fromEntries(
                Object.entries(GAME_ROOMS).map(([k, v]) => [k, { players: v.players.size }])
            ) 
        });
    });

    socket.on('message', async (data) => {
        if (!USERS[socket.id]) return;
        
        const user = USERS[socket.id];
        const message = (data.message || '').trim().slice(0, 500);
        
        if (!message) return;

        const roomId = user.room;
        
        io.to(roomId).emit('message', { 
            username: user.username, 
            message 
        });

        const lowerMsg = message.toLowerCase();
        if (lowerMsg.startsWith('i ') || lowerMsg.startsWith('we ') || 
            lowerMsg.startsWith('group:') || lowerMsg.startsWith('the party') ||
            /attack|cast|investigate|roll|\?|look|search|open/i.test(lowerMsg)) {
            
            const context = `Player: ${user.username}, Class: ${user.character.class}, HP: ${user.character.hp}/${user.character.maxHp}`;
            const aiResponse = await callAiAsDm(message, roomId, context);

            if (/loot|find|treasure|discover/i.test(aiResponse)) {
                const items = ['Potion', 'Sword', 'Gold', 'Scroll', 'Shield'];
                const newItem = items[Math.floor(Math.random() * items.length)];
                user.character.inventory.push(newItem);
                socket.emit('character_update', user.character);
            }

            if (/damage|hurt|hit/i.test(aiResponse)) {
                const damage = generateDiceRoll('d6');
                user.character.hp = Math.max(0, user.character.hp - damage);
                socket.emit('character_update', user.character);
            }

            io.to(roomId).emit('message', { 
                username: 'DM', 
                message: aiResponse 
            });
        }
    });

    socket.on('roll_dice', (data) => {
        if (!USERS[socket.id]) return;
        
        const dieType = data.dieType || 'd20';
        const num = parseInt(data.num) || 1;
        const modifier = parseInt(data.modifier) || 0;
        
        const roll = generateDiceRoll(dieType, num, modifier);
        const msg = `${USERS[socket.id].username} rolls ${num}${dieType}${modifier ? ' +' + modifier : ''}: ${roll}`;
        
        io.to(USERS[socket.id].room).emit('message', { 
            username: 'System', 
            message: msg 
        });
    });

    socket.on('disconnect', () => {
        if (USERS[socket.id]) {
            const user = USERS[socket.id];
            const roomId = user.room;
            
            if (GAME_ROOMS[roomId]) {
                GAME_ROOMS[roomId].players.delete(user.username);
                if (GAME_ROOMS[roomId].players.size === 0) {
                    delete GAME_ROOMS[roomId];
                }
                io.to(roomId).emit('message', { 
                    username: 'System', 
                    message: `${user.username} departs.` 
                });
            }
            
            delete USERS[socket.id];
            console.log('❌ Client disconnected:', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Model: ${MODEL}`);
    console.log(`🌐 Access: http://localhost:${PORT}`);
});
