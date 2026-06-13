// tile_system.js — Dynamic map tile loader for Three.js globe
// Loads CartoDB Dark Matter tiles at progressive zoom levels as camera zooms in.
// Tiles are children of the planet mesh, so they rotate with it automatically.
import * as THREE from 'https://threejsfundamentals.org/threejs/resources/threejs/r122/build/three.module.js';

// ── Web Mercator math ───────────────────────────────────────────────────────

function latToMercY(lat) {
    const r = lat * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + r / 2));
}

// NW corner lat/lng for tile (x, y) at zoom z
function tileNW(x, y, z) {
    const n    = Math.pow(2, z);
    const lng  = x / n * 360 - 180;
    const mercN = Math.PI - 2 * Math.PI * y / n;
    const lat  = 180 / Math.PI * Math.atan(0.5 * (Math.exp(mercN) - Math.exp(-mercN)));
    return { lat, lng };
}

// Tile (x, y) that contains (lat, lng) at zoom z
function latLngToTile(lat, lng, z) {
    const n  = Math.pow(2, z);
    const x  = Math.floor((lng + 180) / 360 * n);
    const lr = lat * Math.PI / 180;
    const y  = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
    return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

// ── Sphere-patch geometry with Mercator UV ─────────────────────────────────
// Vertices are linearly spaced in lat/lng; UV follows Mercator so the
// tile image (which is in Mercator projection) maps without distortion.
function buildTileGeometry(latN, lngW, latS, lngE, r) {
    const SEG = 22;
    const mN  = latToMercY(Math.min(85, latN));
    const mS  = latToMercY(Math.max(-85, latS));
    const pos = new Float32Array((SEG + 1) * (SEG + 1) * 3);
    const uvs = new Float32Array((SEG + 1) * (SEG + 1) * 2);
    const idx = [];

    for (let j = 0; j <= SEG; j++) {
        for (let i = 0; i <= SEG; i++) {
            const k  = j * (SEG + 1) + i;
            const u  = i / SEG;
            const vt = j / SEG;  // 0=north edge, 1=south edge

            const lat   = latN - (latN - latS) * vt;
            const lng   = lngW + (lngE - lngW) * u;
            const phi   = (90 - lat) * Math.PI / 180;
            const theta = (lng + 180) * Math.PI / 180;

            pos[k * 3]     = -r * Math.sin(phi) * Math.cos(theta);
            pos[k * 3 + 1] =  r * Math.cos(phi);
            pos[k * 3 + 2] =  r * Math.sin(phi) * Math.sin(theta);

            // UV v follows Mercator: 0=south(bottom in Three.js), 1=north(top)
            const mLat = latToMercY(Math.max(-85, Math.min(85, lat)));
            uvs[k * 2]     = u;
            uvs[k * 2 + 1] = (mLat - mS) / (mN - mS);
        }
    }

    for (let j = 0; j < SEG; j++) {
        for (let i = 0; i < SEG; i++) {
            const a = j * (SEG + 1) + i;
            idx.push(a, a + SEG + 1, a + 1,
                     a + 1, a + SEG + 1, a + SEG + 2);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    return geo;
}

// ── TileSystem ─────────────────────────────────────────────────────────────
export class TileSystem {
    constructor({ planet, RADIO }) {
        this.planet  = planet;
        this.RADIO   = RADIO;
        this.cache   = new Map();   // "z/x/y" → { mesh, mat }
        this.loader  = new THREE.TextureLoader();
        this.prevKey = '';
        this.prevZ   = -1;
    }

    _url(z, x, y) {
        // Esri World Imagery — satellite tiles, free, no API key
        // Note: Esri uses {z}/{y}/{x} order (y before x)
        return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    }

    // Camera distance → tile zoom level (0 = tiles hidden)
    _distToZoom(dist) {
        if (dist > 8.0)  return 0;
        if (dist > 6.5)  return 3;
        if (dist > 5.2)  return 4;
        if (dist > 4.4)  return 5;
        if (dist > 4.0)  return 6;
        if (dist > 3.75) return 7;
        if (dist > 3.5)  return 8;
        if (dist > 3.3)  return 9;
        return 10;
    }

    // Center lat/lng the camera is facing, in planet local space
    // Handles both planet.rotation.z (axial tilt) and .y (spin)
    _center(camera) {
        this.planet.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().getInverse(this.planet.matrixWorld);
        const lc  = camera.position.clone().applyMatrix4(inv).normalize();
        const lat = Math.asin(Math.max(-1, Math.min(1, lc.y))) * 180 / Math.PI;
        const lng = (Math.atan2(lc.z, -lc.x) * 180 / Math.PI - 180 + 360) % 360 - 180;
        return { lat, lng };
    }

    _load(z, x, y) {
        const key = `${z}/${x}/${y}`;
        if (this.cache.has(key)) return;

        const nw = tileNW(x,     y,     z);
        const se = tileNW(x + 1, y + 1, z);
        if (se.lat < -85 || nw.lat > 85) return;

        const geo = buildTileGeometry(nw.lat, nw.lng, se.lat, se.lng, this.RADIO + 0.003);
        const mat = new THREE.MeshBasicMaterial({
            transparent:         true,
            opacity:             0,
            depthWrite:          false,
            polygonOffset:       true,
            polygonOffsetFactor: -2,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 1;
        this.planet.add(mesh);
        this.cache.set(key, { mesh, mat });

        this.loader.load(
            this._url(z, x, y),
            (tex) => {
                tex.anisotropy = 8;
                mat.map = tex;
                mat.needsUpdate = true;
                this._fadeIn(mat);
            },
            undefined,
            () => this._drop(key)   // silent fail — base texture still shows
        );
    }

    _fadeIn(mat, ms = 380) {
        const t0 = performance.now();
        const fn = () => {
            if (!mat.map) return;
            const t = Math.min(1, (performance.now() - t0) / ms);
            mat.opacity = t * 0.97;
            if (t < 1) requestAnimationFrame(fn);
        };
        fn();
    }

    _drop(key) {
        const e = this.cache.get(key);
        if (!e) return;
        this.planet.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.mat.map?.dispose();
        e.mat.dispose();
        this.cache.delete(key);
    }

    clearAll() {
        for (const k of [...this.cache.keys()]) this._drop(k);
        this.prevKey = '';
        this.prevZ   = -1;
    }

    // Call this once per animation frame
    update(camera) {
        const dist = camera.position.length();
        const zoom = this._distToZoom(dist);

        if (zoom === 0) {
            if (this.prevZ !== 0) this.clearAll();
            this.prevZ = 0;
            return;
        }

        const { lat, lng } = this._center(camera);
        const ct  = latLngToTile(lat, lng, zoom);
        const ck  = `${zoom}/${ct.x}/${ct.y}`;

        // Only refresh when center tile or zoom level changes
        if (ck === this.prevKey && zoom === this.prevZ) return;
        const zoomChanged = zoom !== this.prevZ;
        this.prevKey = ck;
        this.prevZ   = zoom;

        const n = Math.pow(2, zoom);
        // Radius: more tiles at lower zoom (fewer total tiles on sphere)
        const R = zoom <= 3 ? 3 : zoom >= 7 ? 1 : 2;

        const needed = new Set();
        for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
                const tx = ((ct.x + dx) % n + n) % n;  // wrap longitude
                const ty = ct.y + dy;
                if (ty < 0 || ty >= n) continue;
                needed.add(`${zoom}/${tx}/${ty}`);
            }
        }

        // Drop unneeded tiles; when zoom level changes keep old tiles briefly
        // as visual fallback while new ones load (avoids flash of base texture)
        for (const k of [...this.cache.keys()]) {
            if (!needed.has(k)) {
                if (zoomChanged) setTimeout(() => this._drop(k), 600);
                else this._drop(k);
            }
        }

        // Load new tiles
        for (const k of needed) {
            const [z, x, y] = k.split('/').map(Number);
            this._load(z, x, y);
        }
    }
}
