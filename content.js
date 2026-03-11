import(chrome.runtime.getURL("cache.js")).then(({ saveToIndexedDB, loadFromIndexedDB, deleteExpiredPosts, parseTime, formatRelativeTime, MAX_POSTS }) => {
  const MAX_PARALLEL = 2;
  const PARALLEL_DELAY = 1000;

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

  async function openDialog() {
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
      active = false;
      dialog.remove();
    };

    const posts = await loadFromIndexedDB();
    if (posts) {
      renderPosts(posts, true);
      active = true;
      refetchPosts(posts);
    } else {
      active = true;
    }

    requestChannels();
  }

  function requestChannels() {
    const loader = document.getElementById("yt-posts-loader");
    if (!loader) return;
    loader.style.visibility = "";

    window.postMessage({
      type: "YT_FETCH_CHANNELS",
    }, "*");
  }

  window.addEventListener("message", async e => {
    const msg = e.data;
    if (!msg || !msg.type) return;

    if (msg.type === "YT_FETCH_CHANNELS_RESULT") {
      const loader = document.getElementById("yt-posts-loader");
      if (!loader) return;
      loader.style.visibility = "hidden";

      const max = document.getElementById("yt-posts-count-max");
      if (!max) return;
      max.textContent = msg.channels.length;
      doneCount = 0;

      fetchPostsByChannels(msg.channels);
      return;
    }

    if (msg.type === "YT_FETCH_POSTS_BY_CHANNEL_RESULT") {
      const loader = document.getElementById("yt-posts-loader");
      if (!loader) return;
      loader.style.visibility = "hidden";

      renderPosts(msg.posts);
      deleteExpiredPosts();
      return;
    }

    if (msg.type === "YT_FETCH_POST_BY_ID_RESULT") {
      renderPosts(msg.posts);
      return;
    }
  });

  async function fetchPostsByChannels(channels) {
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
            setTimeout(() => resolve(event.data.payload), PARALLEL_DELAY);
          }
        }

        window.addEventListener("message", handler);

        const loader = document.getElementById("yt-posts-loader");
        if (!loader) return;
        loader.style.visibility = "";

        window.postMessage({
          type: "YT_FETCH_POSTS_BY_CHANNEL",
          requestId,
          channel,
        }, "*");
      });
    }

    async function worker() {
      while (queue.length && active) {
        const channel = queue.shift();
        await fetchPostsByChannel(channel);

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

  async function refetchPosts(posts) {
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
            setTimeout(() => resolve(event.data.payload), PARALLEL_DELAY);
          }
        }

        window.addEventListener("message", handler);

        window.postMessage({
          type: "YT_FETCH_POST_BY_ID",
          requestId,
          post,
        }, "*");
      });
    }

    async function worker() {
      while (queue.length && active) {
        const post = queue.shift();
        await fetchPostById(post);
      }
    }

    await Promise.all(
      Array.from({ length: MAX_PARALLEL }, worker)
    );
  }

  function renderPosts(posts, isCache = false) {
    if (!posts) return;

    const container = document.getElementById(`yt-posts-body`);
    if (!container) return;

    posts.forEach(post => {
      if (!post) return;

      saveToIndexedDB(post.postId, post);

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