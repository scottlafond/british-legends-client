import os
import sys
import time
import json
import re
import http.server
import socketserver
import urllib.parse
import threading
import datetime
from telnet_client import MUDTelnetClient

from world_map import MUDWorldMap


def resource_path(*parts):
    base_path = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_path, *parts)


# Global state shared between HTTP server threads, Telnet reader, and AI loop
state_lock = threading.Lock()
reconnect_lock = threading.Lock()
mud_buffer = ""
mud_events = []
mud_event_seq = 0
legacy_update_cursors = {}
MAX_MUD_EVENTS = 500
tell_messages = []

players_online = set()
players_offline = set()
player_levels = {}
recently_logged_out = set()  # Persists across text chunks to prevent re-adding logged-out players
snoop_target = None
pending_snoop_target = None
pending_snoop_since = 0.0
origin_time = None
reset_age = "Unknown"
stats = {
    "score": 0,
    "stamina": "0/0",
    "stamina_val": 0,
    "stamina_max": 0,
    "strength": 0,
    "dexterity": 0
}

last_sent_command = None
current_room = None
previous_room = None
last_direction_command = None
current_weapon = None
graveyard_step = None
waiting_for_name = False
my_name = None

room_state = {"name": "", "description": "", "npcs": [], "items": [], "exits": []}
inventory_state = []
expecting_inventory = False

# Advanced tracking states
is_sleeping = False
in_combat = False
combat_logs = []

SNOOP_REFUSAL_GRACE_SECONDS = 6.0
PLAYER_NAME_BLACKLIST = {
    "Inside", "Outside", "Above", "Below", "Near", "Under", "Standing",
    "Walking", "Sitting", "In", "At", "On", "By", "A", "An", "The",
    "You", "Your", "It", "This", "That", "Also", "Misty", "Rocky",
    "Dark", "Old", "New", "Big", "Small", "Oh", "Ah", "Hide"
}

# Initialize persistent map & strategy guide
world_map = MUDWorldMap(resource_path("world_map_static.json"))
strategy_guide = {}
try:
    with open(resource_path("strategy.json"), "r") as f:
        strategy_guide = json.load(f)
    print("Loaded strategy guide.")
except Exception as e:
    print(f"[Warning: Could not load strategy.json: {e}]")



# Initialize MUD Telnet connection
CONNECT_ON_START = os.environ.get("BL_CONNECT_ON_START", "1").lower() in ("1", "true", "yes", "on")
client = MUDTelnetClient()
if CONNECT_ON_START:
    try:
        client.connect()
    except Exception as e:
        print(f"[Warning: Initial MUD connection failed: {e}]")


def is_mud_connected(client_instance=None):
    active_client = client_instance or client
    return bool(active_client and active_client.running and active_client.sock)


def append_mud_output(text):
    global mud_buffer, mud_event_seq
    if not text:
        return
    mud_buffer += text
    mud_event_seq += 1
    mud_events.append({"seq": mud_event_seq, "text": text})
    if len(mud_events) > MAX_MUD_EVENTS:
        del mud_events[:len(mud_events) - MAX_MUD_EVENTS]


def reset_mud_output(text=""):
    global mud_buffer, mud_events
    mud_buffer = ""
    mud_events.clear()
    append_mud_output(text)

# Regular Expressions for Parsing
re_stats_qs = re.compile(r"Score:\s*(\d+),\s*sta:\s*(\d+)/(\d+),\s*str:\s*(\d+),\s*dex:\s*(\d+)", re.IGNORECASE)
re_stats_score = re.compile(r"You have\s+(\d+)\s+points?.*stamina\s+(\d+)/(\d+)", re.IGNORECASE)

def get_level_from_score(score):
    if score >= 102400: return "Wizard"
    if score >= 51200: return "Legend"
    if score >= 25600: return "Necromancer"
    if score >= 12800: return "Sorcerer"
    if score >= 6400: return "Enchanter"
    if score >= 3200: return "Superhero"
    if score >= 1600: return "Hero"
    if score >= 800: return "Champion"
    if score >= 400: return "Warrior"
    return "Novice"

# MUD1 ranks/titles for player output matching
MUD1_TITLES = ["novice", "warrior", "champion", "hero", "heroine", "superhero", "superheroine",
               "enchanter", "enchantress", "sorcerer", "sorceress", "necromancer",
               "legend", "wizard", "witch", "mage", "sage", "sir", "lady",
               "keeper", "necromancess", "protector", "yeoman", "soothsayer"]
MUD1_TITLE_PATTERN = "|".join(MUD1_TITLES)
# Broader login/logout broadcast patterns for MUD1
# IMPORTANT: Don't use standalone short alternatives like 'entered' or 'arrived' — they cause
# false positives when 'has' gets captured as a player name from text like 'has entered MUD'.
re_player_login = re.compile(r"^\s*(?:\*\s*)?([A-Z][a-z][A-Za-z0-9_]*)(?:\s+the\s+(" + MUD1_TITLE_PATTERN + r"))?(?:\s+\[[^\]]+\])?\s+(?:has (?:entered|logged on|connected|just (?:logged on|entered|arrived)))", re.IGNORECASE | re.MULTILINE)
re_player_logout = re.compile(r"^\s*(?:\*\s*)?([A-Z][a-z][A-Za-z0-9_]*)(?:\s+the\s+(" + MUD1_TITLE_PATTERN + r"))?(?:\s+\[[^\]]+\])?\s+(?:has (?:logged off|disconnected|died|passed on|been destroyed|left the game|just (?:passed on|died)))", re.IGNORECASE | re.MULTILINE)
# QU/WHO command output: lines like "  PlayerName the Novice" or "  PlayerName the Legend"
re_qu_player = re.compile(
    r"^\s*(?:"
    r"\(([A-Z][A-Za-z0-9_]*)\s+the\s+(" + MUD1_TITLE_PATTERN + r")\)(?:\s+\[[^\]\n]+\])?"
    r"|"
    r"([A-Z][A-Za-z0-9_]*)\s+the\s+(" + MUD1_TITLE_PATTERN + r")(?:\s+\[[^\]\n]+\])?"
    r"|"
    r"([A-Z][A-Za-z0-9_]*)\s+\[[^\]\n]+\]"
    r")\s*$",
    re.IGNORECASE | re.MULTILINE
)
re_player_title_mention = re.compile(
    r"\b([A-Z][A-Za-z0-9_]*)\s+the\s+(" + MUD1_TITLE_PATTERN + r")\b",
    re.IGNORECASE | re.MULTILINE
)
re_snoop_started = re.compile(
    r"\bYou have started to\s+(?:snoop|watch|observe)\s+on\s+([A-Z][A-Za-z0-9_]*)(?:\s+the\s+("
    + MUD1_TITLE_PATTERN + r"))?\.",
    re.IGNORECASE
)
re_snoop_stopped = re.compile(
    r"\bYou have stopped snooping on\s+([A-Z][A-Za-z0-9_]*)(?:\s+the\s+("
    + MUD1_TITLE_PATTERN + r"))?\.",
    re.IGNORECASE
)
re_snoop_ended = re.compile(
    r"\bYou can snoop on\s+(?:the\s+)?([A-Z][A-Za-z0-9_]*)(?:\s+the\s+("
    + MUD1_TITLE_PATTERN + r"))?\s+no longer\.?",
    re.IGNORECASE
)
re_reset = re.compile(r"(?:reset|uptime).*?(\d+)\s+hours?\s+(\d+)\s+minutes?", re.IGNORECASE)
re_reset_single = re.compile(r"(?:reset|uptime).*?(\d+)\s+minutes?", re.IGNORECASE)
# Track whether the last command was a QU/WHO so we know to parse the response
last_was_qu_command = False

def normalize_player_name(name):
    if not name:
        return None
    return name.strip().capitalize()

def normalize_player_title(title):
    if not title:
        return None
    return title.strip().capitalize()

def is_plausible_player_name(name):
    return bool(name) and name not in PLAYER_NAME_BLACKLIST

def mark_player_online(name, title=None):
    pname = normalize_player_name(name)
    if not is_plausible_player_name(pname):
        return None
    ptitle = normalize_player_title(title)
    if ptitle:
        player_levels[pname] = ptitle
    recently_logged_out.discard(pname)
    players_online.add(pname)
    players_offline.discard(pname)
    return pname

def mark_player_offline(name, title=None):
    pname = normalize_player_name(name)
    if not is_plausible_player_name(pname):
        return None
    ptitle = normalize_player_title(title)
    if ptitle:
        player_levels[pname] = ptitle
    recently_logged_out.add(pname)
    players_online.discard(pname)
    players_offline.add(pname)
    return pname

def apply_presence_events(game_text):
    events = []

    for m in re_player_login.finditer(game_text):
        events.append((m.start(), 1, "online", m.group(1), m.group(2)))

    for m in re_player_logout.finditer(game_text):
        events.append((m.start(), 3, "offline", m.group(1), m.group(2)))

    # QU/WHO lines are authoritative at the point where they appear.
    for m in re_qu_player.finditer(game_text):
        name = m.group(1) or m.group(3) or m.group(5)
        title = m.group(2) or m.group(4)
        events.append((m.start(), 1, "online", name, title))

    # Room descriptions and score/listing text mention "Name the Title".
    # Mentions can discover players, but should not revive someone already
    # marked offline unless a real login or later QU/WHO line says so.
    for m in re_player_title_mention.finditer(game_text):
        # Prevent false positives from graveyard tombstones and statues
        start_idx = max(0, m.start() - 100)
        context = re.sub(r'\s+', ' ', game_text[start_idx:m.start()].lower())
        ignore_phrases = [
            "tombstone of ", "mausoleum of ", "grave of ", "statue of ", "tomb of ", 
            'name "', "name '", 'name, "', "name, '", "memory of ", "monument to ", "shrine to ", 
            "remains of ", "resting place of ", "dedicated to ", "here lies ", "rests ",
            "inscribed ", "inscription ", "body of ", 'insculpt "', "insculpt '",
            "headstone ", "bears the ", "legend, ", "mausoleum to ", "gravestone of ",
            'reads: "', 'reads "', "tombstone here ", "gravestone here ", "remembrance of ",
            "marker of ", "bones of ", "which is ", "vault of ", "soul of "
        ]
        if any(ignore_word in context for ignore_word in ignore_phrases):
            continue
            
        end_idx = min(len(game_text), m.end() + 30)
        post_context = re.sub(r'\s+', ' ', game_text[m.end():end_idx].lower())
        post_ignore_phrases = [" deceased"]
        if any(ignore_word in post_context for ignore_word in post_ignore_phrases):
            continue
            
        events.append((m.start(), 2, "mention", m.group(1), m.group(2)))

    for _pos, _priority, event_type, name, title in sorted(events, key=lambda event: (event[0], event[1])):
        pname = normalize_player_name(name)
        if not is_plausible_player_name(pname):
            continue

        if event_type == "offline":
            mark_player_offline(pname, title)
        elif event_type == "online":
            mark_player_online(pname, title)
        elif pname not in recently_logged_out:
            mark_player_online(pname, title)

def clean_json_response(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r'^```(?:json)?\n', '', text)
        text = re.sub(r'\n```$', '', text)
    return text.strip()

# Telnet output parser and background logger
def mud_reader_loop(client_instance):
    global mud_buffer, tell_messages, players_online, players_offline, stats, current_room, previous_room, my_name, waiting_for_name, last_sent_command, history_turns, last_direction_command, origin_time, room_state, inventory_state, expecting_inventory
    global snoop_target, pending_snoop_target, pending_snoop_since
    global is_sleeping, in_combat, combat_logs
    graveyard_step = None
    parse_buffer = ""
    
    while True:
        try:
            # Exit if this thread's client is no longer the active global client
            if client is not client_instance:
                break
                
            if not client_instance.running:
                with state_lock:
                    # Only add the message once, then exit thread
                    if not getattr(client_instance, 'disconnected_reported', False):
                        append_mud_output("\n[System Error: Connection to MUD server lost or closed.]\n")
                        client_instance.disconnected_reported = True
                break
            output = client_instance.read_buffer()
            if output:
                # Extract incoming tells before appending to mud_buffer
                lines = output.split('\n')
                filtered_lines = []
                for line in lines:
                    clean_line = re.sub(r'\x1b\[[0-9;]*[mK]', '', line).strip()
                    m_tell = re.match(r"^([A-Za-z0-9_]+)(?:\s+the\s+[A-Za-z]+)? tells you \"(.*)\"$", clean_line, re.IGNORECASE)
                    m_tell_echo = re.match(r"^tell\s+[A-Za-z0-9_]+", clean_line, re.IGNORECASE)
                    
                    if m_tell:
                        name = m_tell.group(1).capitalize()
                        message = m_tell.group(2)
                        with state_lock:
                            tell_messages.append({"type": "received", "from": name, "message": message})
                            if len(tell_messages) > 100:
                                tell_messages.pop(0)
                        # Do not append to filtered_lines
                    elif m_tell_echo:
                        # Do not append server tell echoes to terminal
                        pass
                    else:
                        filtered_lines.append(line)
                
                filtered_output = '\n'.join(filtered_lines)

                # Add to text buffer for UI
                with state_lock:
                    append_mud_output(filtered_output)

                parse_buffer += filtered_output
                if '\n' in parse_buffer:
                    last_newline_idx = parse_buffer.rfind('\n')
                    complete_lines = parse_buffer[:last_newline_idx+1]
                    parse_buffer = parse_buffer[last_newline_idx+1:]
                else:
                    complete_lines = ""

                if not complete_lines:
                    continue

                game_text = complete_lines.strip()
                
                # Strip echoed command from parsing view
                if last_sent_command:
                    lines = game_text.split("\n")
                    if lines and lines[0].strip().lower() == last_sent_command.strip().lower():
                        game_text = "\n".join(lines[1:]).strip()

                # Clean game text for accurate string matching
                clean_game_text = re.sub(r'\x1b\[[0-9;]*[mK]', '', game_text)
                
                # Create a version of the text with snoop lines removed so we don't parse another player's state
                no_snoop_text = "\n".join([line for line in game_text.split("\n") if not line.startswith("|")])

                # Track snoop lifecycle so "You can snoop on X no longer" can
                # retire a player only when it ends an actual snoop stream.
                m_snoop_started = re_snoop_started.search(clean_game_text)
                if m_snoop_started:
                    name = normalize_player_name(m_snoop_started.group(1))
                    title = m_snoop_started.group(2)
                    if is_plausible_player_name(name):
                        with state_lock:
                            mark_player_online(name, title)
                            pending_snoop_target = name
                            pending_snoop_since = time.time()
                            snoop_target = None

                has_snoop_output = bool(re.search(r"(?m)^\|", clean_game_text))
                if has_snoop_output:
                    with state_lock:
                        if pending_snoop_target:
                            snoop_target = pending_snoop_target
                            pending_snoop_target = None
                            pending_snoop_since = 0.0

                # Check for sleep/wake
                if "You go to sleep." in clean_game_text:
                    with state_lock:
                        is_sleeping = True
                if "You wake up." in clean_game_text or "You are woken up" in clean_game_text or "You can't sleep" in clean_game_text:
                    with state_lock:
                        is_sleeping = False
                        
                # Check for combat strings
                # Typical MUD1 combat messages include "hit", "miss", "smite", "slay", "crush", "dead"
                combat_indicators = [" hit ", " hits ", " missed.", " misses.", " smite ", " crush ", " slay ", " killed ", " dead."]
                lines = clean_game_text.split("\n")
                with state_lock:
                    found_combat_this_tick = False
                    for line in lines:
                        clean_line = line.strip()
                        # Ignore snoop lines or prompts
                        if clean_line.startswith("|") or clean_line.startswith("*"):
                            continue
                        # If a line contains combat indicators, tag it
                        if any(ind in clean_line.lower() for ind in combat_indicators) and ("You " in clean_line or " you" in clean_line or "Your " in clean_line):
                            in_combat = True
                            found_combat_this_tick = True
                            combat_logs.append(clean_line)
                            if len(combat_logs) > 10:
                                combat_logs.pop(0)
                    
                    # If we didn't find any combat text for a while, we might be out of combat.
                    # MUD1 doesn't have an explicit "combat ends" except the enemy dying or fleeing.
                    if any(" is dead." in clean_line or " you fled" in clean_line.lower() or " flees" in clean_line.lower() for clean_line in lines):
                        in_combat = False

                for m in re_snoop_stopped.finditer(clean_game_text):
                    name = normalize_player_name(m.group(1))
                    with state_lock:
                        if name and name == snoop_target:
                            snoop_target = None
                        if name and name == pending_snoop_target:
                            pending_snoop_target = None
                            pending_snoop_since = 0.0

                for m in re_snoop_ended.finditer(no_snoop_text):
                    name = normalize_player_name(m.group(1))
                    title = m.group(2)
                    with state_lock:
                        pending_is_old = (
                            name
                            and name == pending_snoop_target
                            and pending_snoop_since
                            and time.time() - pending_snoop_since >= SNOOP_REFUSAL_GRACE_SECONDS
                        )
                        ended_active_snoop = name and (name == snoop_target or pending_is_old)
                        if ended_active_snoop:
                            mark_player_offline(name, title)
                        if name and name == snoop_target:
                            snoop_target = None
                        if name and name == pending_snoop_target:
                            pending_snoop_target = None
                            pending_snoop_since = 0.0

                # Reset stats if we are at a login/character creation screen
                login_indicators = ["enter your name", "what name do you wish", "password", "what sex", "what gender", "invalid password", "select gender"]
                if any(ind in no_snoop_text.lower() for ind in login_indicators) or re.search(r"By what name shall I call you\?", no_snoop_text):
                    with state_lock:
                        stats["score"] = 0
                        stats["stamina"] = "0/0"
                        stats["stamina_val"] = 0
                        stats["stamina_max"] = 0
                        stats["strength"] = 0
                        stats["dexterity"] = 0
                        players_online.clear()
                        players_offline.clear()
                        recently_logged_out.clear()
                        snoop_target = None
                        pending_snoop_target = None
                        pending_snoop_since = 0.0
                        my_name = None
                        waiting_for_name = True

                # Parse welcome/identity banners to discover player's own name
                m_welcome = re.search(r"^(?:welcome,|welcome back,|hello again,|hello,)\s+([A-Za-z0-9_]+)", no_snoop_text, re.IGNORECASE | re.MULTILINE)
                if m_welcome and waiting_for_name:
                    name = m_welcome.group(1).capitalize()
                    with state_lock:
                        my_name = name
                        waiting_for_name = False
                        mark_player_online(name)

                m_pass = re.search(r"Password for\s+([A-Za-z0-9_]+)", no_snoop_text, re.IGNORECASE)
                if m_pass and waiting_for_name:
                    name = m_pass.group(1).capitalize()
                    with state_lock:
                        my_name = name
                        waiting_for_name = False
                        mark_player_online(name)
                
                m_you_are = re.search(r"You are\s+([A-Z][A-Za-z0-9_]*)\s+the\s+([A-Za-z0-9_]+)", no_snoop_text)
                if m_you_are:
                    name = m_you_are.group(1).capitalize()
                    if is_plausible_player_name(name):
                        with state_lock:
                            my_name = name
                            waiting_for_name = False
                            mark_player_online(name)

                # 1. Parse player presence in terminal order so later events win.
                with state_lock:
                    apply_presence_events(no_snoop_text)

                # 2. Parse reset age
                m_reset = re_reset.search(no_snoop_text)
                if m_reset:
                    h, m = m_reset.group(1), m_reset.group(2)
                    with state_lock:
                        reset_age = f"{h}h {m}m ago"
                else:
                    m_reset_s = re_reset_single.search(no_snoop_text)
                    if m_reset_s:
                        m = m_reset_s.group(1)
                        with state_lock:
                            reset_age = f"{m}m ago"

                # Parse exact server origin time for live counter
                m_origin = re.search(r"Origin of version:\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})", no_snoop_text)
                if m_origin:
                    try:
                        dt = datetime.datetime.strptime(m_origin.group(1), "%a %b %d %H:%M:%S %Y")
                        dt = dt.replace(tzinfo=datetime.timezone.utc)
                        with state_lock:
                            origin_time = dt
                    except:
                        pass

                # 3. Parse stats
                m_qs = re_stats_qs.search(no_snoop_text)
                if m_qs:
                    with state_lock:
                        stats["score"] = int(m_qs.group(1))
                        stats["stamina"] = f"{m_qs.group(2)}/{m_qs.group(3)}"
                        stats["stamina_val"] = int(m_qs.group(2))
                        stats["stamina_max"] = int(m_qs.group(3))
                        stats["strength"] = int(m_qs.group(4))
                        stats["dexterity"] = int(m_qs.group(5))
                else:
                    m_score = re_stats_score.search(no_snoop_text)
                    if m_score:
                        with state_lock:
                            stats["score"] = int(m_score.group(1))
                            stats["stamina"] = f"{m_score.group(2)}/{m_score.group(3)}"
                            stats["stamina_val"] = int(m_score.group(2))
                            stats["stamina_max"] = int(m_score.group(3))

                # 4. Update world map logic
                room_info = world_map.parse_room(no_snoop_text)
                if room_info[0] is not None:
                    r_name, r_desc, r_items, r_npcs = room_info
                    world_map.add_room(r_name, r_desc, r_items)
                    
                    if previous_room and last_direction_command and previous_room != r_name:
                        world_map.add_connection(previous_room, r_name, last_direction_command)
                        previous_room = None
                        last_direction_command = None
                    
                    current_room = r_name
                    
                    # Update room state for UI
                    with state_lock:
                        room_state["name"] = world_map.static_map.get(r_name, {}).get("name", r_name)
                        room_state["description"] = r_desc
                        room_state["npcs"] = r_npcs
                        room_state["items"] = r_items
                        
                        # Exits from static map
                        exits_data = world_map.static_map.get(r_name, {}).get("exits", [])
                        parsed_exits = []
                        for ex in exits_data:
                            if ex["directions"]:
                                parsed_exits.append(ex["directions"][0].upper())
                        room_state["exits"] = parsed_exits

                else:
                    block_words = ["locked shut", "shut", "locked", "can't go", "needs keys", "closed", "berk"]
                    is_blocked = any(w in no_snoop_text.lower() for w in block_words)
                    if is_blocked and current_room and last_direction_command:
                        world_map.mark_locked(current_room, last_direction_command)
                        last_direction_command = None
                        previous_room = None

                # 5. Inventory parsing
                if expecting_inventory:
                    if "You are carrying:" in no_snoop_text or "You are holding:" in no_snoop_text:
                        lines = no_snoop_text.split("\n")
                        inv_list = []
                        capture = False
                        for line in lines:
                            line = line.strip()
                            if "You are" in line and ("carrying" in line or "holding" in line):
                                capture = True
                                continue
                            if capture and line:
                                if line.startswith("You") or line.startswith("Score") or line.startswith("Sta"):
                                    break
                                # Clean up formatting (e.g. "A sword" -> "sword")
                                inv_list.append(line.strip("., \t"))
                        
                        with state_lock:
                            inventory_state = inv_list
                            expecting_inventory = False
                    elif "You are empty handed" in no_snoop_text or "You are empty-handed" in no_snoop_text or "You are not carrying anything" in no_snoop_text:
                        with state_lock:
                            inventory_state = []
                            expecting_inventory = False

        except Exception as e:
            print(f"[Reader thread error: {e}]")
        time.sleep(0.1)

# Start reader background thread
reader_thread = None
if client.running:
    reader_thread = threading.Thread(target=mud_reader_loop, args=(client,), daemon=True)
    reader_thread.start()

# AI Play Background Loop


def reconnect_mud():
    global client, waiting_for_name, my_name, snoop_target, pending_snoop_target, pending_snoop_since
    global mud_buffer, players_online, players_offline, stats, current_room, previous_room, is_sleeping, in_combat, combat_logs
    if not reconnect_lock.acquire(blocking=False):
        with state_lock:
            append_mud_output("\n[System: Reconnect is already in progress.]\n")
        return False, "Reconnect is already in progress."

    print("[Reconnecting MUD...]")
    try:
        with state_lock:
            waiting_for_name = False
            my_name = None
        try:
            setattr(client, "disconnected_reported", True)
            client.close()
        except Exception as e:
            print(f"[Error closing client socket during reconnect: {e}]")
        
        # Cooldown for MUD server to drop the old connection completely
        time.sleep(2.0)
        
        with state_lock:
            reset_mud_output("\n[System: Connecting to British Legends...]\n")
            players_online.clear()
            players_offline.clear()
            recently_logged_out.clear()
            snoop_target = None
            pending_snoop_target = None
            pending_snoop_since = 0.0
            stats["score"] = 0
            stats["stamina"] = "0/0"
            stats["stamina_val"] = 0
            stats["stamina_max"] = 0
            stats["strength"] = 0
            stats["dexterity"] = 0
            current_room = None
            previous_room = None
            is_sleeping = False
            in_combat = False
            combat_logs.clear()
        
        client = MUDTelnetClient()
        try:
            client.connect()
            # Start a new reader loop thread, passing the specific client instance
            new_reader = threading.Thread(target=mud_reader_loop, args=(client,), daemon=True)
            new_reader.start()
            print("[MUD Reconnected successfully]")
            return True, "MUD reconnected successfully."
        except Exception as e:
            print(f"[Failed to connect to MUD: {e}]")
            with state_lock:
                append_mud_output(f"[System Error: Connection failed: {e}]\n")
            return False, f"Connection failed: {e}"
    finally:
        reconnect_lock.release()

# HTTP Request Handler for UI static files & polling API
class DashboardHTTPHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
    }

    def log_message(self, format, *args):
        # Silence server request logs in command line
        pass

    def send_json(self, payload, status=200):
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def do_GET(self):
        global players_online, players_offline, reset_age, stats, my_name, origin_time, room_state, inventory_state
        global snoop_target, pending_snoop_target, pending_snoop_since
        parsed_url = urllib.parse.urlparse(self.path)
        request_path = parsed_url.path
        
        # API Route: Fetch live state updates
        if request_path == "/updates":
            query_params = urllib.parse.parse_qs(parsed_url.query)
            has_since_param = "since" in query_params
            legacy_cursor_key = (self.client_address[0], self.headers.get("User-Agent", "")) if not has_since_param else None
            if has_since_param:
                try:
                    since_seq = int(query_params.get("since", ["0"])[0])
                except ValueError:
                    since_seq = 0
            else:
                since_seq = 0

            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            
            # If not connected, make sure stats and state are cleared.
            # A fresh browser starts with since=0; in that case, do not replay
            # stale terminal text from a dead MUD session.
            is_connected = is_mud_connected()
            if not is_connected:
                with state_lock:
                    if since_seq <= 0:
                        reset_mud_output("")
                    stats["score"] = 0
                    stats["stamina"] = "0/0"
                    stats["stamina_val"] = 0
                    stats["stamina_max"] = 0
                    stats["strength"] = 0
                    stats["dexterity"] = 0
                    players_online.clear()
                    players_offline.clear()
                    recently_logged_out.clear()
                    snoop_target = None
                    pending_snoop_target = None
                    pending_snoop_since = 0.0
                    origin_time = None
                    reset_age = "Unknown"
                    my_name = None
                    tell_messages.clear()

            with state_lock:
                if my_name:
                    mark_player_online(my_name)

                # Return all unseen terminal chunks for this browser.
                if legacy_cursor_key is not None:
                    since_seq = legacy_update_cursors.get(legacy_cursor_key, 0)
                event_slice = [event for event in mud_events if event["seq"] > since_seq]
                out_text = "".join(event["text"] for event in event_slice)
                latest_seq = mud_event_seq
                if legacy_cursor_key is not None:
                    legacy_update_cursors[legacy_cursor_key] = latest_seq
                
                # Send elapsed seconds since reset (computed server-side to avoid clock skew)
                reset_elapsed = None
                if origin_time is not None:
                    now_utc = datetime.datetime.now(datetime.timezone.utc)
                    reset_elapsed = int((now_utc - origin_time).total_seconds())
                
                
                response = {
                    "mud_output": out_text,
                    "mud_event_seq": latest_seq,

                    "players_online": sorted(list(players_online)),
                    "players_offline": sorted(list(players_offline)),
                    "player_levels": player_levels,
                    "reset_age": reset_age,
                    "reset_elapsed": reset_elapsed,
                    "stats": stats,
                    "level": get_level_from_score(stats.get("score", 0)),
                    "room": room_state,
                    "inventory": inventory_state,

                    "my_name": my_name or "",
                    "is_sleeping": is_sleeping,
                    "in_combat": in_combat,
                    "combat_logs": list(combat_logs),
                    "is_connected": is_connected,
                    "snoop_target": snoop_target,
                    "tells": list(tell_messages)
                }
            self.wfile.write(json.dumps(response).encode("utf-8"))
            return

        # Serve static assets
        if request_path == "/":
            self.path = "/index.html"
            
        return super().do_GET()

    def do_POST(self):
        global last_sent_command, previous_room, last_direction_command, current_room, waiting_for_name, my_name
        global mud_buffer, expecting_inventory
        
        # API Route: Send user typed command
        if self.path == "/command":
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode("utf-8")) if post_data else {}
            except (ValueError, json.JSONDecodeError):
                self.send_json({"status": "error", "error": "Invalid command request."}, status=400)
                return

            command = data.get("command", "").strip()
            if not command:
                self.send_json({"status": "ok"})
                return

            active_client = client
            if not is_mud_connected(active_client):
                message = "MUD connection is closed. Tap Reconnect MUD, then wait for the name prompt."
                self.send_json({"status": "error", "error": message}, status=409)
                return

            try:
                active_client.send_command(command)
            except ConnectionError:
                message = "MUD connection closed while sending command. Tap Reconnect MUD, then wait for the name prompt."
                self.send_json({"status": "error", "error": message}, status=409)
                return
            except Exception as e:
                print(f"[Command send error: {e}]")
                message = "Unexpected backend error while sending command."
                self.send_json({"status": "error", "error": message}, status=500)
                return

            last_sent_command = command

            # Intercept outgoing tells only after a successful send.
            m_sent_tell = re.match(r"^tell\s+([A-Za-z0-9_]+)\s*,\s*(.*)$", command, re.IGNORECASE)
            if not m_sent_tell:
                m_sent_tell = re.match(r"^tell\s+([A-Za-z0-9_]+)\s+(.*)$", command, re.IGNORECASE)
            
            if m_sent_tell:
                target = m_sent_tell.group(1).capitalize()
                message = m_sent_tell.group(2)
                with state_lock:
                    tell_messages.append({"type": "sent", "to": target, "message": message})
                    if len(tell_messages) > 100:
                        tell_messages.pop(0)
            
            # Track direction movement
            cmd_cleaned = command.strip().lower()
            
            if cmd_cleaned in ["qu", "who", "query"]:
                with state_lock:
                    # Move all to offline so the incoming response correctly rebuilds the online list
                    for p in list(players_online):
                        players_offline.add(p)
                    players_online.clear()
            
            if cmd_cleaned in ["i", "inv", "inventory", "eq", "equipment"]:
                with state_lock:
                    expecting_inventory = True
                    
            is_movement = cmd_cleaned in ["n", "s", "e", "w", "u", "d", "ne", "nw", "se", "sw", "in", "out", "swamp", "back"]
            if is_movement:
                last_direction_command = cmd_cleaned
                previous_room = current_room
            elif cmd_cleaned in ["get all", "g all"]:
                world_map.clear_all_items(current_room)
            elif cmd_cleaned.startswith("get ") or cmd_cleaned.startswith("g "):
                item_to_remove = re.sub(r'^(?:get|g)\s+', '', cmd_cleaned)
                world_map.remove_item(current_room, item_to_remove)

            self.send_json({"status": "ok"})
            return

        # API Route: Reconnect to MUD
        if self.path == "/reconnect":
            ok, message = reconnect_mud()
            if ok:
                self.send_json({"status": "ok", "message": message})
            else:
                status = 409 if "already in progress" in message else 503
                self.send_json({"status": "error", "error": message}, status=status)
            return

        # API Route: Clear Tells
        if self.path == "/clear_tells":
            with state_lock:
                tell_messages.clear()
            self.send_json({"status": "ok"})
            return

        self.send_json({"status": "error", "error": "Unknown endpoint."}, status=404)

# Main server runner
def run_web_dashboard():
    import webview
    
    # If compiled with PyInstaller, the files are extracted to a temp dir (_MEIPASS)
    if getattr(sys, 'frozen', False):
        os.chdir(sys._MEIPASS)
        
    # Configure and start HTTP Threading server on a random free port
    server_address = ("127.0.0.1", 0)
    httpd = http.server.ThreadingHTTPServer(server_address, DashboardHTTPHandler)
    actual_port = httpd.server_address[1]
    
    # Start the web server in a background thread
    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()
    
    print(f"\n========================================================")
    print(f"  British Legends Web UI Dashboard Started successfully!")
    print(f"  Local URL: http://127.0.0.1:{actual_port}")
    print(f"========================================================\n", flush=True)
    
    try:
        # Create and start the native window
        webview.create_window('British Legends MUD', f'http://127.0.0.1:{actual_port}?v=1.0.1', width=1200, height=800, background_color='#1a1a1a', text_select=True)
        webview.start()
    except Exception as e:
        print(f"Failed to start webview: {e}")
    finally:
        print("\nShutting down web dashboard...", flush=True)
        httpd.shutdown()
        client.close()

if __name__ == "__main__":
    run_web_dashboard()
