const DB_NAME = "yt-posts-db";
const STORE_NAME = "yt-posts-store";
const DB_VERSION = 1;

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

export async function saveToIndexedDB(key, post) {
	const db = await openDB();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readwrite");
		const store = tx.objectStore(STORE_NAME);

		const req = store.put(post, key);

		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

export async function deleteExpiredPosts() {
	const db = await openDB();
	const posts = await loadFromIndexedDB();
	if (!posts || posts.length <= 500) return;

	const sorted = posts.sort((a, b) => parseTime(a.time) - parseTime(b.time));
	const toDelete = sorted.slice(500);

	const tx = db.transaction(STORE_NAME, "readwrite");
	const store = tx.objectStore(STORE_NAME);

	for (const post of toDelete) {
		store.delete(post.postId);
	}

	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function loadFromIndexedDB() {
	const db = await openDB();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readonly");
		const store = tx.objectStore(STORE_NAME);

		const req = store.getAll();

		req.onsuccess = () => {
			const posts = req.result;

			if (!posts) {
				resolve(null);
				return;
			}

			resolve(posts);
		};

		req.onerror = () => reject(req.error);
	});
}

export function parseTime(str) {
	if (!str) return 0;

	const ms = {
		second: 1000,
		minute: 60 * 1000,
		hour: 60 * 60 * 1000,
		day: 24 * 60 * 60 * 1000,
		week: 7 * 24 * 60 * 60 * 1000,
		month: 30 * 24 * 60 * 60 * 1000,
		year: 365 * 24 * 60 * 60 * 1000
	};

	const re = /(\d+)\s*(second|minute|hour|day|week|month|year)s?/i;
	const match = str.match(re);
	if (!match) return 0;

	const value = Number(match[1]);
	const unit = match[2].toLowerCase();

	const base = value * (ms[unit] || 0);

	if (/ago/i.test(str)) return base;
	if (/expires?\s+in/i.test(str)) return -base;

	return 0;
}