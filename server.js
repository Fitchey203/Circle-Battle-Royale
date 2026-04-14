const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const PORT = 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname + '/public'));

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

const WORLD = { width: 3200, height: 2200 };
const TICK_RATE = 1000 / 60;
const PLAYER_RADIUS = 16;
const PLAYER_SIZE = PLAYER_RADIUS * 2;
const WALL_THICKNESS = 18;
const ROUND_LENGTH_MS = 300000; // 5 minutes
const MAX_PLAYERS_FOR_START = 4;
const CHEST_COUNT = 6;

const WEAPONS = {
    Pistol: {
        fireRate: 320,
        bulletSpeed: 15,
        damage: 24,
        spread: 0.012,
        pellets: 1,
        color: '#e5e7eb',
    },
    AR: {
        fireRate: 105,
        bulletSpeed: 16,
        damage: 11,
        spread: 0.03,
        pellets: 1,
        color: '#60a5fa',
    },
    Shotgun: {
        fireRate: 700,
        bulletSpeed: 13,
        damage: 11,
        spread: 0.24,
        pellets: 6,
        color: '#f59e0b',
    },
    SMG: {
        fireRate: 80,
        bulletSpeed: 15,
        damage: 8,
        spread: 0.055,
        pellets: 1,
        color: '#34d399',
    },
    Sniper: {
        fireRate: 950,
        bulletSpeed: 22,
        damage: 48,
        spread: 0.004,
        pellets: 1,
        color: '#f87171',
    },
};

const LOOT_GUNS = ['AR', 'Shotgun', 'SMG', 'Sniper'];

// Each room has its own full game state
const rooms = {};

function createRoom(name, isPrivate = false, password = '') {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    rooms[id] = {
        id,
        name,
        isPrivate,
        password,
        players: {},
        bullets: [],
        chests: [],
        roads: [],
        furniture: [],
        windows: [],
        glass: [],
        water: [],
        buildings: [],
        roundActive: false,
        roundEndsAt: 0,
    };
    return rooms[id];
}

// Default public room so there's always one to join
createRoom('Public Lobby', false);

function getPublicRooms() {
    return Object.values(rooms).map(r => ({
        id: r.id,
        name: r.name,
        isPrivate: r.isPrivate,
        playerCount: Object.keys(r.players).length,
        roundActive: r.roundActive,
    }));
}

function generateWater(room) {
    room.water = [];
    const { roads, buildings } = room;
    const water = room.water;

    // Helper: does this ellipse-pond overlap a road or building?
    function pondClear(cx, cy, rx, ry) {
        const rect = { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 };
        for (const r of roads) {
            if (rectsOverlap(rect, r)) return false;
        }
        for (const b of buildings) {
            if (rectsOverlap(rect, b)) return false;
        }
        return true;
    }

    // Helper: does this river rect overlap a road or building?
    function riverClear(x, y, w, h) {
        const rect = { x, y, w, h };
        for (const r of roads) {
            if (rectsOverlap(rect, r)) return false;
        }
        for (const b of buildings) {
            if (rectsOverlap(rect, b)) return false;
        }
        return true;
    }

    // Ponds
    let attempts = 0;
    while (water.filter(w => w.type === 'pond').length < 4 && attempts < 100) {
        attempts++;
        const cx = rand(300, WORLD.width - 300);
        const cy = rand(300, WORLD.height - 300);
        const rx = rand(80, 160);
        const ry = rand(60, 120);
        if (pondClear(cx, cy, rx, ry)) {
            water.push({ type: 'pond', cx, cy, rx, ry });
        }
    }

    // Rivers — tries a few positions to avoid roads/buildings
    attempts = 0;
    while (water.filter(w => w.type === 'river').length < 1 && attempts < 50) {
        attempts++;
        const x = rand(200, WORLD.width - 300);
        const w = rand(50, 90);
        if (riverClear(x, 0, w, WORLD.height)) {
            water.push({ type: 'river', x, y: 0, w, h: WORLD.height });
        }
    }
}

function generateRoads(room) {
    room.roads = [];
    const roads = room.roads;

    const ROAD_WIDTH = 140;

    // main horizontal road
    const mainY = WORLD.height / 2;

    roads.push({
        x: 0,
        y: mainY - ROAD_WIDTH / 2,
        w: WORLD.width,
        h: ROAD_WIDTH
    });

    // vertical road (perfect cross)
    const centerX = WORLD.width / 2;

    roads.push({
        x: centerX - ROAD_WIDTH / 2,
        y: 0,
        w: ROAD_WIDTH,
        h: WORLD.height
    });
}

function nearRoad(roads, x, y, buffer = 180) {
    for (const r of roads) {
        if (
            x > r.x - buffer &&
            x < r.x + r.w + buffer &&
            y > r.y - buffer &&
            y < r.y + r.h + buffer
        ) {
            return true;
        }
    }
    return false;
}

function generateBuildings(room) {
    room.buildings = [];
    const { roads } = room;
    const buildings = room.buildings;

let attempts = 0;

while (buildings.length < 35 && attempts < 500) {
    attempts++;

    const w = rand(260, 380);
    const h = rand(200, 300);

    const x = rand(100, WORLD.width - w - 100);
    const y = rand(100, WORLD.height - h - 100);

    if (!nearRoad(roads, x + w / 2, y + h / 2, 300)) continue;

    let overlap = false;

    // check buildings
    for (const b of buildings) {
    if (rectsOverlap({ x: x - 80, y: y - 80, w: w + 160, h: h + 160 }, b)) {
        overlap = true;
        break;
       }
    }

    // check roads
    for (const r of roads) {
        if (rectsOverlap({ x, y, w, h }, r)) {
            overlap = true;
            break;
        }
    }

    if (overlap) continue;

 const doorSide = ['top','bottom','left','right'][Math.floor(Math.random()*4)];
const doorSize = rand(60, 90);
const isVerticalWall = doorSide === 'left' || doorSide === 'right';
const maxOffset = isVerticalWall ? h - doorSize - 40 : w - doorSize - 40;

buildings.push({
    id: buildings.length + 1,
    x,
    y,
    w,
    h,
    theme: ['brick','warehouse','apartment'][Math.floor(Math.random()*3)],
    door: {
        side: doorSide,
        size: doorSize,
        offset: clamp(rand(40, maxOffset), 40, maxOffset),
        open: false,
        progress: 0
    }
});
     }
} 

function rand(min, max) {
    return Math.random() * (max - min) + min;
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
}

function rectsOverlap(a, b) {
    return (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
    );
}

function getPlayerRect(x, y) {
    return {
        x: x - PLAYER_RADIUS,
        y: y - PLAYER_RADIUS,
        w: PLAYER_SIZE,
        h: PLAYER_SIZE,
    };
}

function getDoorGap(building) {
    const d = building.door;
    if (d.side === 'top' || d.side === 'bottom') {
        return {
            axis: 'horizontal',
            start: building.x + d.offset,
            end: building.x + d.offset + d.size,
        };
    }
    return {
        axis: 'vertical',
        start: building.y + d.offset,
        end: building.y + d.offset + d.size,
    };
}

function getDoorCenter(building) {
    const d = building.door;
    if (d.side === 'top') return { x: building.x + d.offset + d.size / 2, y: building.y };
    if (d.side === 'bottom') return { x: building.x + d.offset + d.size / 2, y: building.y + building.h };
    if (d.side === 'left') return { x: building.x, y: building.y + d.offset + d.size / 2 };
    return { x: building.x + building.w, y: building.y + d.offset + d.size / 2 };
}

function getWallSegments(building) {
    const gap = getDoorGap(building);
    const openEnough = building.door.progress > 0.72;
    const segments = [];

    if (building.door.side === 'top') {
        if (openEnough) {
            segments.push({ x: building.x, y: building.y, w: gap.start - building.x, h: WALL_THICKNESS });
            segments.push({ x: gap.end, y: building.y, w: building.x + building.w - gap.end, h: WALL_THICKNESS });
        } else {
            segments.push({ x: building.x, y: building.y, w: building.w, h: WALL_THICKNESS });
        }
        segments.push({ x: building.x, y: building.y + building.h - WALL_THICKNESS, w: building.w, h: WALL_THICKNESS });
        segments.push({ x: building.x, y: building.y, w: WALL_THICKNESS, h: building.h });
        segments.push({ x: building.x + building.w - WALL_THICKNESS, y: building.y, w: WALL_THICKNESS, h: building.h });
    } else if (building.door.side === 'bottom') {
        segments.push({ x: building.x, y: building.y, w: building.w, h: WALL_THICKNESS });
        if (openEnough) {
            segments.push({ x: building.x, y: building.y + building.h - WALL_THICKNESS, w: gap.start - building.x, h: WALL_THICKNESS });
            segments.push({ x: gap.end, y: building.y + building.h - WALL_THICKNESS, w: building.x + building.w - gap.end, h: WALL_THICKNESS });
        } else {
            segments.push({ x: building.x, y: building.y + building.h - WALL_THICKNESS, w: building.w, h: WALL_THICKNESS });
        }
        segments.push({ x: building.x, y: building.y, w: WALL_THICKNESS, h: building.h });
        segments.push({ x: building.x + building.w - WALL_THICKNESS, y: building.y, w: WALL_THICKNESS, h: building.h });
    } else if (building.door.side === 'left') {
        segments.push({ x: building.x, y: building.y, w: building.w, h: WALL_THICKNESS });
        segments.push({ x: building.x, y: building.y + building.h - WALL_THICKNESS, w: building.w, h: WALL_THICKNESS });
        if (openEnough) {
            segments.push({ x: building.x, y: building.y, w: WALL_THICKNESS, h: gap.start - building.y });
            segments.push({ x: building.x, y: gap.end, w: WALL_THICKNESS, h: building.y + building.h - gap.end });
        } else {
            segments.push({ x: building.x, y: building.y, w: WALL_THICKNESS, h: building.h });
        }
        segments.push({ x: building.x + building.w - WALL_THICKNESS, y: building.y, w: WALL_THICKNESS, h: building.h });
    } else {
        segments.push({ x: building.x, y: building.y, w: building.w, h: WALL_THICKNESS });
        segments.push({ x: building.x, y: building.y + building.h - WALL_THICKNESS, w: building.w, h: WALL_THICKNESS });
        segments.push({ x: building.x, y: building.y, w: WALL_THICKNESS, h: building.h });
        if (openEnough) {
            segments.push({ x: building.x + building.w - WALL_THICKNESS, y: building.y, w: WALL_THICKNESS, h: gap.start - building.y });
            segments.push({ x: building.x + building.w - WALL_THICKNESS, y: gap.end, w: WALL_THICKNESS, h: building.y + building.h - gap.end });
        } else {
            segments.push({ x: building.x + building.w - WALL_THICKNESS, y: building.y, w: WALL_THICKNESS, h: building.h });
        }
    }

    return segments.filter((s) => s.w > 0 && s.h > 0);
}

function collidesWithBuildings(room, rect) {
    for (const building of room.buildings) {
        const segments = getWallSegments(building);
        for (const seg of segments) {
            if (rectsOverlap(rect, seg)) return true;
        }
    }
    return false;
}

function collidesWorld(room, rect) {
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > WORLD.width || rect.y + rect.h > WORLD.height) {
        return true;
    }
    return collidesWithBuildings(room, rect);
}

function getRandomSpawn(room) {
    for (let i = 0; i < 200; i++) {
        const x = rand(80, WORLD.width - 80);
        const y = rand(80, WORLD.height - 80);
        const rect = getPlayerRect(x, y);
        if (!collidesWorld(room, rect)) return { x, y };
    }
    return { x: 120, y: 120 };
}

function resetPlayerForNewRound(room, p) {
    const spawn = getRandomSpawn(room);
    p.x = spawn.x;
    p.y = spawn.y;
    p.health = 100;
    p.alive = true;
    p.weaponAngle = 0;
    p.stamina = 100;
    p.inventory = ['Pistol', null, null, null, null];
    p.selectedSlot = 0;
    p.medkits = 0;
    p.lastShotAt = 0;
}

function createPlayer(room, socketId) {
    const spawn = getRandomSpawn(room);
    room.players[socketId] = {
        id: socketId,
        x: spawn.x,
        y: spawn.y,
        health: 100,
        alive: true,
        color: '#38bdf8',
        name: 'Player',
        stamina: 100,
        lastSprintTime: 0, // ✅ added
        weaponAngle: 0,
        inventory: ['Pistol', null, null, null, null],
        selectedSlot: 0,
        medkits: 0,
        kills: 0,
        deaths: 0,
        lastShotAt: 0,
    };
}

function getCurrentWeapon(player) {
    return player.inventory[player.selectedSlot];
}

function createChestLoot() {
    const loot = [];
    if (Math.random() < 0.9) {
        loot.push(LOOT_GUNS[Math.floor(Math.random() * LOOT_GUNS.length)]);
    }
    if (Math.random() < 0.6) {
        loot.push('Medkit');
    }
    if (loot.length === 0) loot.push('Medkit');
    return loot;
}

function findChestInBuilding(building) {
    const minX = building.x + WALL_THICKNESS + 30;
    const maxX = building.x + building.w - WALL_THICKNESS - 30;
    const minY = building.y + WALL_THICKNESS + 30;
    const maxY = building.y + building.h - WALL_THICKNESS - 30;

    return {
        x: rand(minX, maxX),
        y: rand(minY, maxY),
    };
}

function spawnChests(room) {
    room.chests = [];

    room.buildings.forEach((building, i) => {
        if (Math.random() < 0.7) { // ✅ more chests
            const pos = findChestInBuilding(building);
            room.chests.push({
                id: `chest_${i}_${Date.now()}`,
                x: pos.x,
                y: pos.y,
                opened: false,
                buildingId: building.id,
                loot: createChestLoot(),
            });
        }
    });
}

function spawnFurniture(room) {
    room.furniture = [];

    room.buildings.forEach(b => {
        if (Math.random() < 0.9) { // most buildings have stuff

            // table
            room.furniture.push({
                id: `table_${Math.random()}`,
                x: b.x + rand(40, b.w - 80),
                y: b.y + rand(40, b.h - 80),
                w: 50,
                h: 30,
                type: "table",
                vx: 0,
                vy: 0
            });

            // chairs
            for (let i = 0; i < 2; i++) {
                room.furniture.push({
                    id: `chair_${Math.random()}`,
                    x: b.x + rand(40, b.w - 60),
                    y: b.y + rand(40, b.h - 60),
                    w: 25,
                    h: 25,
                    type: "chair",
                    vx: 0,
                    vy: 0
                });
            }
        }
    });
}

function spawnWindows(room) {
    room.windows = [];

    room.buildings.forEach(b => {
	if (Math.random() < 0.7) {
            const wallSize = WALL_THICKNESS;
            const d = b.door;

            // Build a "danger zone" around the door that the window must not touch
            let doorRect;
            if (d.side === 'top')    doorRect = { x: b.x + d.offset - 20, y: b.y,                          w: d.size + 40, h: wallSize };
            if (d.side === 'bottom') doorRect = { x: b.x + d.offset - 20, y: b.y + b.h - wallSize,         w: d.size + 40, h: wallSize };
            if (d.side === 'left')   doorRect = { x: b.x,                  y: b.y + d.offset - 20,          w: wallSize, h: d.size + 40 };
            if (d.side === 'right')  doorRect = { x: b.x + b.w - wallSize, y: b.y + d.offset - 20,          w: wallSize, h: d.size + 40 };

            // Try up to 10 positions for the window
            for (let attempt = 0; attempt < 10; attempt++) {
                let win;

                if (d.side === 'top' || d.side === 'bottom') {
                    const maxX = b.w - 80 - 20;
                    const wx = b.x + 20 + Math.random() * maxX;
                    const wy = d.side === 'top' ? b.y : b.y + b.h - wallSize;
                    win = { id: `window_${b.id}`, x: wx, y: wy, w: 80, h: wallSize, broken: false };
                } else {
                    const maxY = b.h - 80 - 20;
                    const wy = b.y + 20 + Math.random() * maxY;
                    const wx = d.side === 'left' ? b.x : b.x + b.w - wallSize;
                    win = { id: `window_${b.id}`, x: wx, y: wy, w: wallSize, h: 80, broken: false };
                }

                // Only place the window if it doesn't overlap the door zone
                if (!rectsOverlap(win, doorRect)) {
                    room.windows.push(win);
                    break;
                }
            }
        }
    });
}

function collidesFurniture(room, rect) {
    for (const f of room.furniture) {
        if (rectsOverlap(rect, f)) return f;
    }
    return null;
}

function getLeaderboard(room) {
    return Object.values(room.players)
        .sort((a, b) => {
            if (b.kills !== a.kills) return b.kills - a.kills;
            return a.deaths - b.deaths;
        })
        .slice(0, 8)
        .map((p) => ({
            name: p.name,
            kills: p.kills,
            deaths: p.deaths,
        }));
}

function startRound(room) {
    room.roundActive = true;
    room.roundEndsAt = Date.now() + ROUND_LENGTH_MS;

    room.bullets = [];
    room.glass = [];

    generateRoads(room);
    generateBuildings(room);
    generateWater(room);

    spawnFurniture(room);
    spawnChests(room);
    spawnWindows(room);

    for (const player of Object.values(room.players)) {
        resetPlayerForNewRound(room, player);
    }
}

function endRound(room) {
    room.roundActive = false;
    room.roundEndsAt = 0;
    room.bullets = [];
    room.chests = [];

    for (const player of Object.values(room.players)) {
        player.health = 100;
        player.alive = true;
        player.stamina = 100;
    }
}

function tryGiveLoot(player, item) {
    if (item === 'Medkit') {
        player.medkits = Math.min(player.medkits + 1, 5);
        return true;
    }

    if (!WEAPONS[item]) return false;
    if (player.inventory.includes(item)) return true;

    const emptyIndex = player.inventory.findIndex((slot) => slot === null);
    if (emptyIndex !== -1) {
        player.inventory[emptyIndex] = item;
        return true;
    }

    return false;
}

function updateDoors(room) {
    for (const building of room.buildings) {
        const center = getDoorCenter(building);
        let shouldOpen = false;

        for (const p of Object.values(room.players)) {
            if (!p.alive) continue;
            if (dist(center.x, center.y, p.x, p.y) < 85) {
                shouldOpen = true;
                break;
            }
        }

        building.door.open = shouldOpen;
        const target = shouldOpen ? 1 : 0;
        building.door.progress += (target - building.door.progress) * 0.18;
        if (Math.abs(target - building.door.progress) < 0.01) {
            building.door.progress = target;
        }
    }
}

io.on('connection', (socket) => {
    let myRoom = null;

    socket.on('getRooms', () => {
        socket.emit('roomList', getPublicRooms());
    });

    socket.on('createRoom', ({ name, password }) => {
        const isPrivate = !!password;
        const room = createRoom(name || 'New Room', isPrivate, password || '');
        joinRoom(socket, room);
    });

    socket.on('joinRoom', ({ roomId, password }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('joinError', 'Room not found.');
        if (room.isPrivate && room.password !== password) return socket.emit('joinError', 'Wrong password.');
        joinRoom(socket, room);
    });

    socket.on('joinAny', () => {
        // Find a public room with space, or create one
        const available = Object.values(rooms).find(r => !r.isPrivate && Object.keys(r.players).length < 20);
        const room = available || createRoom('Public Lobby', false);
        joinRoom(socket, room);
    });

    function joinRoom(sock, room) {
        myRoom = room;
        sock.join(room.id);
        createPlayer(room, sock.id);

        sock.emit('init', {
            world: WORLD,
            weapons: Object.keys(WEAPONS),
            buildings: room.buildings,
            roads: room.roads,
            water: room.water,
            roomId: room.id,
            roomName: room.name,
        });
    }

    socket.on('updateProfile', (data) => {
        if (!myRoom) return;
        const p = myRoom.players[socket.id];
        if (!p) return;
        if (typeof data.name === 'string') p.name = data.name.trim().slice(0, 16) || 'Player';
        if (typeof data.color === 'string') p.color = data.color;
    });

    socket.on('startRound', () => {
        if (!myRoom) return;
        if (!myRoom.roundActive && Object.keys(myRoom.players).length >= 1) {
            startRound(myRoom);
        }
    });

    socket.on('move', (data) => {
        if (!myRoom) return;
        const p = myRoom.players[socket.id];
        if (!p || !p.alive) return;

        let dx = Number(data.dx) || 0;
        let dy = Number(data.dy) || 0;
        const sprint = !!data.sprint;

        if (dx === 0 && dy === 0) return;

        const length = Math.hypot(dx, dy) || 1;
        dx /= length;
        dy /= length;

        let inWater = false;
        for (const w of myRoom.water) {
            if (w.type === 'pond') {
                const ddx = (p.x - w.cx) / w.rx;
                const ddy = (p.y - w.cy) / w.ry;
                if (ddx * ddx + ddy * ddy < 1) { inWater = true; break; }
            } else {
                if (p.x > w.x && p.x < w.x + w.w && p.y > w.y && p.y < w.y + w.h) { inWater = true; break; }
            }
        }

        p.inWater = inWater;

        let speed = inWater ? 2.5 : 4.25;
        if (myRoom.roundActive && sprint && p.stamina > 0) {
            speed = inWater ? 3.2 : 6.4;
            p.stamina = Math.max(0, p.stamina - 1.1);
            p.lastSprintTime = Date.now();
        } else {
            if (Date.now() - p.lastSprintTime > 3000) {
                p.stamina = Math.min(100, p.stamina + 0.35);
            }
        }

        const nextX = p.x + dx * speed;
        const nextY = p.y + dy * speed;

        const rectX = getPlayerRect(nextX, p.y);
        let hit = collidesFurniture(myRoom, rectX);
        if (!collidesWorld(myRoom, rectX)) {
            if (hit) hit.vx += dx * 2;
            else p.x = nextX;
        }

        const rectY = getPlayerRect(p.x, nextY);
        let hitY = collidesFurniture(myRoom, rectY);
        if (!collidesWorld(myRoom, rectY)) {
            if (hitY) hitY.vy += dy * 2;
            else p.y = nextY;
        }

        p.x = clamp(p.x, PLAYER_RADIUS, WORLD.width - PLAYER_RADIUS);
        p.y = clamp(p.y, PLAYER_RADIUS, WORLD.height - PLAYER_RADIUS);
    });

    socket.on('aim', (angle) => {
        if (!myRoom) return;
        const p = myRoom.players[socket.id];
        if (!p) return;
        if (typeof angle === 'number') p.weaponAngle = angle;
    });

    socket.on('shoot', () => {
        if (!myRoom) return;
        const p = myRoom.players[socket.id];
        if (!p || !p.alive || !myRoom.roundActive) return;

        const weaponName = getCurrentWeapon(p);
        if (!weaponName || !WEAPONS[weaponName]) return;

        const weapon = WEAPONS[weaponName];
        const now = Date.now();

        if (now - p.lastShotAt < weapon.fireRate) return;
        p.lastShotAt = now;

        const originX = p.x + Math.cos(p.weaponAngle) * 22;
        const originY = p.y + Math.sin(p.weaponAngle) * 22;

        for (let i = 0; i < weapon.pellets; i++) {
            const spread = (Math.random() * 2 - 1) * weapon.spread;
            myRoom.bullets.push({
                id: `${socket.id}_${now}_${i}`,
                x: originX,
                y: originY,
                angle: p.weaponAngle + spread,
                speed: weapon.bulletSpeed,
                damage: weapon.damage,
                owner: socket.id,
                color: weapon.color,
                life: weaponName === 'Sniper' ? 110 : 85,
            });
        }
    });

    socket.on('interact', () => {
        if (!myRoom) return;
        const p = myRoom.players[socket.id];
        if (!p || !p.alive || !myRoom.roundActive) return;

        for (let i = 0; i < myRoom.chests.length; i++) {
            const chest = myRoom.chests[i];
            if (dist(p.x, p.y, chest.x, chest.y) < 52) {
                let tookAnything = false;
                for (const item of chest.loot) {
                    if (tryGiveLoot(p, item)) tookAnything = true;
                }
                if (tookAnything) myRoom.chests.splice(i, 1);
                break;
            }
        }
    });

    socket.on('useMedkit', () => {
        if (!myRoom) return;
        const p = myRoom.players[socket.id];
        if (!p || !p.alive || !myRoom.roundActive) return;
        if (p.medkits <= 0 || p.health >= 100) return;
        p.medkits -= 1;
        p.health = Math.min(100, p.health + 40);
    });

    socket.on('selectSlot', (index) => {
        if (!myRoom) return;
        const p = myRoom.players[socket.id];
        if (!p) return;
        if (typeof index !== 'number') return;
        if (index < 0 || index >= p.inventory.length) return;
        p.selectedSlot = index;
    });

    socket.on('moveInventory', ({ from, to }) => {
        if (!myRoom) return;
        const p = myRoom.players[socket.id];
        if (!p) return;
        if (typeof from !== 'number' || typeof to !== 'number') return;
        if (from < 0 || from > 4 || to < 0 || to > 4) return;
        const temp = p.inventory[from];
        p.inventory[from] = p.inventory[to];
        p.inventory[to] = temp;
        if (p.selectedSlot === from) p.selectedSlot = to;
        else if (p.selectedSlot === to) p.selectedSlot = from;
    });

    socket.on('disconnect', () => {
        if (!myRoom) return;
        delete myRoom.players[socket.id];
        // Clean up empty non-default rooms
        if (Object.keys(myRoom.players).length === 0 && Object.keys(rooms).length > 1) {
            delete rooms[myRoom.id];
        }
    });
});

// One game loop per room
setInterval(() => {
    for (const room of Object.values(rooms)) {
        updateDoors(room);

        if (room.roundActive && Date.now() >= room.roundEndsAt) {
            endRound(room);
        }

        room.glass = room.glass.filter(g => {
            g.x += g.vx;
            g.y += g.vy;
            g.vx *= 0.9;
            g.vy *= 0.9;
            g.life--;
            return g.life > 0;
        });

        room.bullets = room.bullets.filter((b) => {
            b.x += Math.cos(b.angle) * b.speed;
            b.y += Math.sin(b.angle) * b.speed;
            b.life -= 1;

            if (b.life <= 0) return false;
            if (b.x < 0 || b.y < 0 || b.x > WORLD.width || b.y > WORLD.height) return false;

            const bulletRect = { x: b.x - 2, y: b.y - 2, w: 4, h: 4 };

            for (const w of room.windows) {
                if (!w.broken && rectsOverlap(bulletRect, w)) {
                    w.broken = true;
                    for (let i = 0; i < 8; i++) {
                        room.glass.push({
                            x: w.x + w.w / 2,
                            y: w.y + w.h / 2,
                            vx: (Math.random() - 0.5) * 4,
                            vy: (Math.random() - 0.5) * 4,
                            life: 60 + Math.random() * 40
                        });
                    }
                    return false;
                }
            }

            let blocked = false;
            for (const building of room.buildings) {
                const segments = getWallSegments(building);
                for (const seg of segments) {
                    let insideBrokenWindow = false;
                    for (const w of room.windows) {
                        if (w.broken && rectsOverlap(bulletRect, { x: w.x, y: w.y, w: w.w, h: w.h })) {
                            insideBrokenWindow = true;
                            break;
                        }
                    }
                    if (!insideBrokenWindow && rectsOverlap(bulletRect, seg)) {
                        blocked = true;
                        break;
                    }
                }
                if (blocked) break;
            }
            if (blocked) return false;

            for (const id in room.players) {
                if (id === b.owner) continue;
                const p = room.players[id];
                if (!p.alive) continue;

                const d = dist(b.x, b.y, p.x, p.y);
                if (d <= PLAYER_RADIUS) {
                    const falloff = Math.max(0.4, 1 - d / 600);
                    p.health -= b.damage * falloff;

                    if (p.health <= 0) {
                        p.health = 0;
                        p.alive = false;
                        p.deaths += 1;
                        if (room.players[b.owner]) room.players[b.owner].kills += 1;

                        setTimeout(() => {
                            if (room.players[id] && room.roundActive) {
                                resetPlayerForNewRound(room, room.players[id]);
                            } else if (room.players[id]) {
                                room.players[id].alive = true;
                                room.players[id].health = 100;
                            }
                        }, 2200);
                    }
                    return false;
                }
            }
            return true;
        });

        room.furniture.forEach(f => {
            let nextX = f.x + f.vx;
            if (!collidesWorld(room, { x: nextX, y: f.y, w: f.w, h: f.h })) f.x = nextX;
            else f.vx *= -0.3;

            let nextY = f.y + f.vy;
            if (!collidesWorld(room, { x: f.x, y: nextY, w: f.w, h: f.h })) f.y = nextY;
            else f.vy *= -0.3;

            f.vx *= 0.85;
            f.vy *= 0.85;
        });

        io.to(room.id).emit('state', {
            players: room.players,
            bullets: room.bullets,
            chests: room.chests,
            furniture: room.furniture,
            windows: room.windows,
            glass: room.glass,
            buildings: room.buildings,
            roads: room.roads,
            water: room.water,
            leaderboard: getLeaderboard(room),
            roundActive: room.roundActive,
            roundTimeLeft: room.roundActive ? Math.max(0, Math.ceil((room.roundEndsAt - Date.now()) / 1000)) : 0,
            world: WORLD,
        });
    }
}, TICK_RATE);

http.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
});
