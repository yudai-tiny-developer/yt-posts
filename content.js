import("./cache.js").then(({ saveToIndexedDB, loadFromIndexedDB }) => {
  const MAX_PARALLEL = 2;
  const PARALLEL_DELAY = 500;

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
            <span>)&nbsp;</span>
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
    }

    const posts = await loadFromIndexedDB();
    if (posts) {
      renderPosts(posts, true);
    }

    active = true;

    requestSubscriptions();
  }

  function requestSubscriptions() {
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

      fetchPosts(msg.channels);
    }

    if (msg.type === "YT_FETCH_POSTS_RESULT") {
      const loader = document.getElementById("yt-posts-loader");
      if (!loader) return;
      loader.style.visibility = "hidden";

      renderPosts(msg.posts);
    }
  });

  async function fetchPosts(channels) {
    const queue = [...channels];

    function fetchChannelPosts(channel) {
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();

        function handler(event) {
          if (
            event.data?.type === "YT_FETCH_POSTS_RESULT" &&
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
          type: "YT_FETCH_POSTS",
          requestId,
          channel,
        }, "*");
      });
    }

    async function worker() {
      while (queue.length && active) {
        const channel = queue.shift();
        await fetchChannelPosts(channel);

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

  function renderPosts(posts, isCache = false) {
    if (!posts) return;

    const container = document.getElementById(`yt-posts-body`);
    if (!container) return;

    posts
      .forEach(post => {
        saveToIndexedDB(post.postId, post);

        let item = document.getElementById(post.postId)
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

        item.innerHTML = `
          <div class="yt-posts-item-body">
            <a class="yt-posts-channel-header" href="${post.channel.canonicalBaseUrl ? post.channel.canonicalBaseUrl : ('/channel/' + post.channel.channelId)}" target="_blank">
              <img src="${post.channel.icon}">
              <span>${post.channel.name}</span>
            </a>
            <div class="yt-posts-date">${post.time}</div>
            <div class="yt-posts-text">${post.text || "..."}</div>
          </div>
        `;

        container.appendChild(item);
      });

    sortPostsByDate(container);
  }

  function sortPostsByDate(container) {
    const items = Array.from(container.querySelectorAll('.yt-posts-item'));

    const posts = items.sort((a, b) => {
      const dateA = a.querySelector('.yt-posts-date')?.textContent.trim();
      const dateB = b.querySelector('.yt-posts-date')?.textContent.trim();
      return parseTime(dateA) - parseTime(dateB);
    }).slice(0, 500);

    const fragment = document.createDocumentFragment();
    posts.forEach(el => fragment.appendChild(el));
    container.replaceChildren(fragment);
  }

  function parseTime(str) {
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

});