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