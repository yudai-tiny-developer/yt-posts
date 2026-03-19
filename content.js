import(chrome.runtime.getURL("cache.js")).then(({ saveToIndexedDB, loadFromIndexedDB, deleteExpiredPosts, parseTime, formatRelativeTime, MAX_POSTS }) => {
  const MAX_PARALLEL = 1;

  function injectScript() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.type = "module";

    document.documentElement.appendChild(s);
  }

  injectScript();

  function createButton() {
    if (document.getElementById("yt-posts-list-btn")) return false;

    const section = document.querySelector('ytd-guide-section-renderer:has(a[href="/feed/subscriptions"])');
    if (!section) return false;

    const btn = document.createElement("button");
    btn.id = "yt-posts-list-btn";
    btn.textContent = "Subscribed Posts";
    btn.className = "yt-posts-btn yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono yt-spec-button-shape-next--size-m yt-spec-button-shape-next--enable-backdrop-filter-experiment";
    btn.onclick = openDialog;

    section.prepend(btn);

    return true;
  }

  const detect_interval = setInterval(() => {
    if (createButton()) clearInterval(detect_interval);
  }, 500);

  let dialog;
  let active = false;
  let doneCount = 0;
  let cacheNamespacePromise;
  let currentDialogSessionId = null;

  function getCacheNamespace() {
    if (!cacheNamespacePromise) {
      cacheNamespacePromise = new Promise(resolve => {
        const requestId = crypto.randomUUID();
        const timeoutId = setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve("anonymous");
        }, 1000);

        function handler(event) {
          if (
            event.data?.type === "YT_GET_CACHE_NAMESPACE_RESULT" &&
            event.data?.requestId === requestId
          ) {
            clearTimeout(timeoutId);
            window.removeEventListener("message", handler);
            resolve(event.data.cacheNamespace || "anonymous");
          }
        }

        window.addEventListener("message", handler);
        window.postMessage({
          type: "YT_GET_CACHE_NAMESPACE",
          requestId,
        }, "*");
      });
    }

    return cacheNamespacePromise;
  }

  async function openDialog() {
    currentDialogSessionId = crypto.randomUUID();
    const dialogSessionId = currentDialogSessionId;
    dialog = document.createElement("div");
    dialog.className = "yt-posts-dialog";
    dialog.innerHTML = `
      <div id="yt-posts-dialog-content">
        <div class="yt-posts-header">
          <div class="yt-posts-header-left">
            <span id="yt-posts-loader"></span>
            <span>Subscribed Posts</span>
            <span>&nbsp;(</span>
            <span id="yt-posts-count-done">???</span>
            <span>&nbsp;/&nbsp;</span>
            <span id="yt-posts-count-max">???</span>
            <span>)</span>
          </div>
          <div class="yt-posts-header-right">
            <span id="yt-posts-close">✕</span>
          </div>
        </div>
        <div id="yt-posts-body"></div>
      </div>
      <div id="yt-posts-dialog-overlay"></div>
    `;

    document.body.appendChild(dialog);

    document.getElementById("yt-posts-dialog-overlay").onclick = document.getElementById("yt-posts-close").onclick = () => {
      closeDialog(dialogSessionId);
    };

    const cacheNamespace = await getCacheNamespace();
    const posts = await loadFromIndexedDB(cacheNamespace);
    if (posts) {
      renderPosts(posts, true, cacheNamespace);
      active = true;
      refetchPosts(posts, dialogSessionId);
    } else {
      active = true;
    }

    requestChannels(dialogSessionId);
  }

  function closeDialog(dialogSessionId) {
    if (dialogSessionId !== currentDialogSessionId) return;

    active = false;
    currentDialogSessionId = null;

    window.postMessage({
      type: "YT_CANCEL_DIALOG_SESSION",
      dialogSessionId,
    }, "*");

    if (dialog) {
      dialog.remove();
      dialog = null;
    }
  }

  function requestChannels(dialogSessionId) {
    const loader = document.getElementById("yt-posts-loader");
    if (!loader) return;
    loader.style.visibility = "";

    window.postMessage({
      type: "YT_FETCH_CHANNELS",
      dialogSessionId,
    }, "*");
  }

  window.addEventListener("message", async e => {
    const msg = e.data;
    if (!msg || !msg.type) return;

    if (msg.type === "YT_FETCH_CHANNELS_RESULT") {
      if (msg.dialogSessionId !== currentDialogSessionId || !active) return;

      const loader = document.getElementById("yt-posts-loader");
      if (!loader) return;
      loader.style.visibility = "hidden";

      const max = document.getElementById("yt-posts-count-max");
      if (!max) return;
      max.textContent = msg.channels.length;
      doneCount = 0;

      fetchPostsByChannels(msg.channels, msg.dialogSessionId);
      return;
    }

    if (msg.type === "YT_FETCH_POSTS_BY_CHANNEL_RESULT") {
      if (msg.dialogSessionId !== currentDialogSessionId || !active || msg.canceled) return;

      const loader = document.getElementById("yt-posts-loader");
      if (!loader) return;
      loader.style.visibility = "hidden";

      const cacheNamespace = await getCacheNamespace();
      renderPosts(msg.posts, false, cacheNamespace);
      deleteExpiredPosts(cacheNamespace);
      return;
    }

    if (msg.type === "YT_FETCH_POST_BY_ID_RESULT") {
      if (msg.dialogSessionId !== currentDialogSessionId || !active || msg.canceled) return;

      const cacheNamespace = await getCacheNamespace();
      renderPosts(msg.posts, false, cacheNamespace);
      return;
    }
  });

  async function fetchPostsByChannels(channels, dialogSessionId) {
    const queue = [...channels];

    function fetchPostsByChannel(channel) {
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();

        function handler(event) {
          if (
            event.data?.type === "YT_FETCH_POSTS_BY_CHANNEL_RESULT" &&
            event.data?.requestId === requestId
          ) {
            window.removeEventListener("message", handler);
            resolve(event.data);
          }
        }

        window.addEventListener("message", handler);

        const loader = document.getElementById("yt-posts-loader");
        if (!loader) return;
        loader.style.visibility = "";

        window.postMessage({
          type: "YT_FETCH_POSTS_BY_CHANNEL",
          requestId,
          dialogSessionId,
          channel,
        }, "*");
      });
    }

    async function worker() {
      while (queue.length && active && dialogSessionId === currentDialogSessionId) {
        const channel = queue.shift();
        const response = await fetchPostsByChannel(channel);
        if (response?.canceled || dialogSessionId !== currentDialogSessionId || !active) return;

        doneCount++;
        const done = document.getElementById("yt-posts-count-done");
        if (!done) return;
        done.textContent = doneCount;
      }
    }

    await Promise.all(
      Array.from({ length: MAX_PARALLEL }, worker)
    );
  }

  async function refetchPosts(posts, dialogSessionId) {
    const queue = [...posts];

    function fetchPostById(post) {
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();

        function handler(event) {
          if (
            event.data?.type === "YT_FETCH_POST_BY_ID_RESULT" &&
            event.data?.requestId === requestId
          ) {
            window.removeEventListener("message", handler);
            resolve(event.data);
          }
        }

        window.addEventListener("message", handler);

        window.postMessage({
          type: "YT_FETCH_POST_BY_ID",
          requestId,
          dialogSessionId,
          post,
        }, "*");
      });
    }

    async function worker() {
      while (queue.length && active && dialogSessionId === currentDialogSessionId) {
        const post = queue.shift();
        const response = await fetchPostById(post);
        if (response?.canceled || dialogSessionId !== currentDialogSessionId || !active) return;
      }
    }

    await Promise.all(
      Array.from({ length: MAX_PARALLEL }, worker)
    );
  }

  function renderPosts(posts, isCache = false, cacheNamespace = "anonymous") {
    if (!posts) return;

    const container = document.getElementById(`yt-posts-body`);
    if (!container) return;

    posts.forEach(post => {
      if (!post) return;

      saveToIndexedDB(cacheNamespace, post.postId, {
        ...post,
        cacheNamespace,
      });

      let item = document.getElementById(post.postId);
      if (!item) {
        item = document.createElement("a");
        item.id = post.postId;
        item.className = "yt-posts-item";
        item.setAttribute("href", `https://www.youtube.com/post/${post.postId}`);
        item.setAttribute("target", "_blank");
      }

      if (isCache) {
        item.classList.add("yt-posts-item-cache");
      } else {
        item.classList.remove("yt-posts-item-cache");
      }

      if (post.time) {
        item.dataset.time = parseTime(post.time);
        item.dataset.fetchedAt = post.fetchedAt;

        item.innerHTML = `
          <div class="yt-posts-item-body">
            <a class="yt-posts-channel-header" href="${post.channel.canonicalBaseUrl ? post.channel.canonicalBaseUrl : ('/channel/' + post.channel.channelId)}" target="_blank">
              <img src="${post.channel.icon}">
              <span>${post.channel.name}</span>
            </a>
            <div class="yt-posts-date">${formatRelativeTime(Number(item.dataset.time) + Date.now() - post.fetchedAt)}</div>
            <div class="yt-posts-text">${post.text}</div>
          </div>
        `;

        container.appendChild(item);
      } else {
        item.remove();
      }
    });

    sortPostsByDate(container);
  }

  function sortPostsByDate(container) {
    const items = Array.from(container.querySelectorAll('.yt-posts-item'));

    const posts = items.sort((a, b) => {
      const dateA = Number(a.dataset.time) - Number(a.dataset.fetchedAt);
      const dateB = Number(b.dataset.time) - Number(b.dataset.fetchedAt);
      return dateA - dateB;
    }).slice(0, MAX_POSTS);

    const fragment = document.createDocumentFragment();
    posts.forEach(el => fragment.appendChild(el));
    container.replaceChildren(fragment);
  }
});
