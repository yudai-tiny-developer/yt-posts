const DB_NAME = "yt-posts-db";
const STORE_NAME = "yt-posts-store";
const DB_VERSION = 1;

export const MAX_POSTS = 100;

function getCacheKey(cacheNamespace = "anonymous", key) {
	return `${cacheNamespace}:${key}`;
}

function openDB() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);

		req.onupgradeneeded = e => {
			const db = e.target.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
			}
		};

		req.onsuccess = e => resolve(e.target.result);
		req.onerror = () => reject(req.error);
	});
}

export async function saveToIndexedDB(cacheNamespace, key, post) {
	const db = await openDB();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readwrite");
		const store = tx.objectStore(STORE_NAME);

		const req = store.put(post, getCacheKey(cacheNamespace, key));

		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

export async function deleteExpiredPosts(cacheNamespace) {
	const db = await openDB();
	const posts = await loadFromIndexedDB(cacheNamespace);
	if (!posts || posts.length <= MAX_POSTS) return;

	const sorted = posts.sort((a, b) => parseTime(a.time) - parseTime(b.time));
	const toDelete = sorted.slice(MAX_POSTS);

	const tx = db.transaction(STORE_NAME, "readwrite");
	const store = tx.objectStore(STORE_NAME);

	for (const post of toDelete) {
		store.delete(getCacheKey(cacheNamespace, post.postId));
	}

	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function loadFromIndexedDB(cacheNamespace) {
	const db = await openDB();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readonly");
		const store = tx.objectStore(STORE_NAME);

		const req = store.getAll();

		req.onsuccess = () => {
			const posts = req.result?.filter(post => post?.cacheNamespace === cacheNamespace);

			if (!posts) {
				resolve(null);
				return;
			}

			resolve(posts);
		};

		req.onerror = () => reject(req.error);
	});
}

const units = [
	{ name: "year", seconds: 60 * 60 * 24 * 365 },
	{ name: "month", seconds: 60 * 60 * 24 * 30 }, // tolerance
	{ name: "week", seconds: 60 * 60 * 24 * 7 },
	{ name: "day", seconds: 60 * 60 * 24 },
	{ name: "hour", seconds: 60 * 60 },
	{ name: "minute", seconds: 60 },
	{ name: "second", seconds: 1 },
];

export function parseTime(str) {
	if (!str) return Infinity;

	const re = /(\d+)\s*(second|minute|hour|day|week|month|year)s?/i;
	const match = str.match(re);
	if (!match) return Infinity;

	const value = Number(match[1]) * 1000;
	const unit = match[2].toLowerCase();

	const base = value * (units.find(u => u.name === unit)?.seconds ?? Infinity);

	if (/ago/i.test(str)) return base;
	if (/expires?\s+in/i.test(str)) return -base;

	return Infinity;
}

export function formatRelativeTime(ms) {
	const seconds = Math.floor(ms / 1000);
	const abs = Math.abs(seconds);

	for (let i = 0; i < units.length; i++) {
		const unit = units[i];
		const largerUnit = units[i - 1];

		const valueFloor = Math.floor(abs / unit.seconds);
		const value = Math.round(abs / unit.seconds);

		if (valueFloor >= 1 || unit.name === "second") {
			if (largerUnit && value * unit.seconds >= largerUnit.seconds) {
				const nextValue = Math.ceil(abs / largerUnit.seconds);
				const label = nextValue === 1 ? largerUnit.name : largerUnit.name + "s";

				return seconds >= 0
					? `${nextValue} ${label} ago`
					: `Expires in ${nextValue} ${label}`;
			}

			const label = value === 1 ? unit.name : unit.name + "s";

			return seconds >= 0
				? `${value} ${label} ago`
				: `Expires in ${value} ${label}`;
		}
	}

	return seconds;
}
