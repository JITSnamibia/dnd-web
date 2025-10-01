import eventlet
eventlet.monkey_patch()
from flask import Flask, render_template, session, request, redirect, url_for, jsonify
from flask_socketio import SocketIO, join_room, leave_room, emit, rooms
from flask_session import Session
import requests
import os
import random
import uuid
from threading import Lock
from datetime import datetime

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SESSION_SECRET_KEY', 'super-secret-key-change-me!')
app.config['SESSION_TYPE'] = 'filesystem'  # For self-hosting; use 'redis' for scale
Session(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet', manage_session=False)

# Globals
OPENROUTER_API_KEY = os.environ.get('OPENROUTER_API_KEY')
MODEL = os.environ.get('MODEL')
if not OPENROUTER_API_KEY:
    OPENROUTER_API_KEY = input("Enter OpenRouter API key (or set env): ").strip()
if not MODEL:
    MODEL = input("Enter model (e.g., 'anthropic/claude-3.5-sonnet'): ").strip()

if not OPENROUTER_API_KEY or not MODEL:
    raise ValueError("API key and model required.")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
GAME_ROOMS = {}  # {room_id: {'story_state': str, 'players': set, 'lock': Lock}}
DEFAULT_ROOM = 'main_adventure'
LOCK = Lock()

# In-memory user/character storage (use DB for prod)
USERS = {}  # {session_id: {'username': str, 'character': dict, 'room': str}}

def generate_dice_roll(die_type='d20', num=1, modifier=0):
    """Simple dice roller for D&D mechanics."""
    return sum(random.randint(1, int(die_type[1:])) for _ in range(num)) + modifier

def call_ai_as_dm(prompt, room_id, context=None):
    """Enhanced AI DM call with room state and context."""
    with LOCK:
        if room_id not in GAME_ROOMS:
            GAME_ROOMS[room_id] = {'story_state': "A new adventure begins in a vast world of magic and mystery.", 'players': set(), 'lock': Lock()}
        room_data = GAME_ROOMS[room_id]
        with room_data['lock']:
            state = room_data['story_state']
    
    full_prompt = f"Current story state: {state}\nContext: {context or ''}\nPlayer action: {prompt}\n"
    full_prompt += "As DM, respond immersively: Describe scenes, outcomes (use dice if implied, e.g., attack rolls), NPCs, and advance the plot. Keep concise, D&D-style. End with hooks for players."

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": request.url_root,  # Optional for OpenRouter tracking
        "X-Title": "D&D AI Adventure Game"  # Optional
    }
    data = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You are an expert Dungeon Master for a multiplayer D&D 5e text adventure. Be narrative, fair, and engaging. Incorporate player actions, resolve combats with implied d20 rolls, track simple stats (HP, inventory). Suggest group decisions."},
            {"role": "user", "content": full_prompt}
        ],
        "max_tokens": 500,
        "temperature": 0.8
    }
    
    try:
        response = requests.post(OPENROUTER_URL, headers=headers, json=data, timeout=10)
        if response.status_code == 200:
            result = response.json()
            ai_response = result['choices'][0]['message']['content'].strip()
            # Parse for dice rolls or updates if AI mentions them (simple regex/keyword for now)
            if any(d in ai_response.lower() for d in ['roll', 'attack', 'check']):
                roll = generate_dice_roll()
                ai_response += f" (DM rolls: {roll} on d20)"
            
            # Update state
            with room_data['lock']:
                room_data['story_state'] += f"\n{datetime.now().strftime('%H:%M')}: {ai_response}"
            return ai_response
        else:
            return f"DM Error: {response.status_code} - Check API key/quotas."
    except Exception as e:
        return f"DM Exception: {str(e)}"

@app.route('/')
def index():
    return render_template('index.html', default_room=DEFAULT_ROOM)

@app.route('/api/rooms')
def get_rooms():
    return jsonify({k: {'players': len(v['players'])} for k, v in GAME_ROOMS.items()})

@socketio.on('create_character')
def on_create_character(data):
    session_id = request.sid
    USERS[session_id] = {
        'username': data['username'],
        'character': {'class': data['charClass'], 'hp': data['maxHP'], 'inventory': []},
        'room': DEFAULT_ROOM
    }
    emit('character_update', {'inventory': []})

@socketio.on('join')
def on_join(data):
    session_id = request.sid
    if session_id not in USERS:
        emit('message', {'username': 'System', 'message': 'Create a character first!'})
        return
    
    username = USERS[session_id]['username']
    room_id = data['room'] if data.get('room') else DEFAULT_ROOM
    USERS[session_id]['room'] = room_id
    
    join_room(room_id)
    if room_id not in GAME_ROOMS:
        GAME_ROOMS[room_id] = {'story_state': "A new party forms. What adventures await?", 'players': set(), 'lock': Lock()}
    
    with LOCK:
        GAME_ROOMS[room_id]['players'].add(username)
    
    emit('message', {'username': 'System', 'message': f'{username} joins {room_id}! The tale unfolds...'}, room=room_id)
    emit('room_update', {'rooms': {k: {'players': len(v['players'])} for k, v in GAME_ROOMS.items()}}, broadcast=True)
    
    # Send current story state to new player
    with GAME_ROOMS[room_id]['lock']:
        current_state = GAME_ROOMS[room_id]['story_state'][-500:]  # Last 500 chars for brevity
        emit('message', {'username': 'DM (AI)', 'message': f"Current tale: {current_state}..."}, room=request.sid)

@socketio.on('leave')
def on_leave(data):
    session_id = request.sid
    if session_id not in USERS:
        return
    username = USERS[session_id]['username']
    room_id = USERS[session_id]['room']
    
    leave_room(room_id)
    with LOCK:
        if room_id in GAME_ROOMS:
            GAME_ROOMS[room_id]['players'].discard(username)
            if not GAME_ROOMS[room_id]['players']:
                del GAME_ROOMS[room_id]  # Cleanup empty rooms
    
    emit('message', {'username': 'System', 'message': f'{username} departs the realm.'}, room=room_id)
    emit('room_update', {'rooms': {k: {'players': len(v['players'])} for k, v in GAME_ROOMS.items() if v.get('players')}}, broadcast=True)

@socketio.on('message')
def handle_message(data):
    session_id = request.sid
    if session_id not in USERS:
        return
    username = USERS[session_id]['username']
    message = data['message']
    room_id = USERS[session_id]['room']
    
    # Broadcast to room (exclude self for echo)
    emit('message', {'username': username, 'message': message}, room=room_id, include_self=False)
    
    # Trigger AI DM for actions (enhanced detection)
    if any(prefix in message.lower() for prefix in ['i ', 'we ', 'group: ', 'the party ']) or any(word in message.lower() for word in ['attack', 'cast', 'investigate', 'roll', '?']):
        context = f"Player: {username}, Character: {USERS[session_id]['character']}"
        ai_response = call_ai_as_dm(message, room_id, context)
        # Simulate simple inventory update if AI mentions items (placeholder)
        if any(word in ai_response.lower() for word in ['find', 'loot', 'treasure']):
            new_item = random.choice(['Potion of Healing', 'Rusty Sword', 'Gold Coin', 'Magic Scroll'])
            USERS[session_id]['character']['inventory'].append(new_item)
            emit('character_update', {'inventory': USERS[session_id]['character']['inventory']}, room=session_id)
        emit('message', {'username': 'DM (AI)', 'message': ai_response}, room=room_id)

if __name__ == '__main__':
    print(f"🚀 Starting Enhanced D&D AI Game Server with model: {MODEL}")
    print("💡 Self-host tips:")
    print("   - Set env vars: OPENROUTER_API_KEY, MODEL, SESSION_SECRET_KEY")
    print("   - For prod: gunicorn -w 4 -k eventlet -b 0.0.0.0:5000 app:app")
    print("   - Access via browser: http://your-ip:5000")
    print("   - Features: Character sheets, multi-rooms, dice, responsive UI.")
    socketio.run(app, debug=False, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)
