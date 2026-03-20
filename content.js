import(chrome.runtime.getURL("cache.js")).then(({ saveToIndexedDB, loadFromIndexedDB, deleteExpiredPosts, parseTime, formatRelativeTime, MAX_POSTS }) => {
  const MAX_PARALLEL_FETCH_POSTS_BY_CHANNELS = 1;
  const MAX_PARALLEL_FETCH_POST_BY_ID = 1;
  const STORAGE_KEYS = {
    useManagedChannels: "yt-posts-use-managed-channels",
    managedChannels: "yt-posts-managed-channels",
    resumeProgress: "yt-posts-resume-progress",
  };

  function t(key) {
    return chrome.i18n.getMessage(key) || key;
  }

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
    btn.textContent = t("subscribedPosts");
    btn.className = "yt-posts-btn yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono yt-spec-button-shape-next--size-m yt-spec-button-shape-next--enable-backdrop-filter-experiment";
    btn.onclick = openDialog;

    section.prepend(btn);

    return true;
  }

  const detect_interval = setInterval(() => {
    if (createButton()) clearInterval(detect_interval);
  }, 500);

  let dialog;
  let channelManagerDialog;
  let cacheNamespacePromise;
  let currentDialogSessionId = null;
  let activeCacheNamespace = "anonymous";
  const resumeState = {
    channels: null,
    channelsHash: null,
    nextChannelIndex: 0,
    totalChannels: 0,
    doneCount: 0,
    postsToRefetch: null,
    nextRefetchIndex: 0,
    fetchedPostIds: new Set(),
  };

  function storageGet(keys) {
    return new Promise(resolve => {
      chrome.storage.local.get(keys, resolve);
    });
  }

  function storageSet(items) {
    return new Promise(resolve => {
      chrome.storage.local.set(items, resolve);
    });
  }

  async function getManagedChannels() {
    const result = await storageGet([STORAGE_KEYS.managedChannels]);
    return Array.isArray(result[STORAGE_KEYS.managedChannels]) ? result[STORAGE_KEYS.managedChannels] : [];
  }

  async function saveManagedChannels(channels) {
    await storageSet({
      [STORAGE_KEYS.managedChannels]: channels,
    });
  }

  async function getUseManagedChannels() {
    const result = await storageGet([STORAGE_KEYS.useManagedChannels]);
    return Boolean(result[STORAGE_KEYS.useManagedChannels]);
  }

  async function saveUseManagedChannels(enabled) {
    await storageSet({
      [STORAGE_KEYS.useManagedChannels]: enabled,
    });
  }

  async function getResumeProgressMap() {
    const result = await storageGet([STORAGE_KEYS.resumeProgress]);
    const progressMap = result[STORAGE_KEYS.resumeProgress];
    return progressMap && typeof progressMap === "object" ? progressMap : {};
  }

  async function getResumeProgress(cacheNamespace) {
    if (!cacheNamespace) return null;

    const progressMap = await getResumeProgressMap();
    const progress = progressMap[cacheNamespace];
    return progress && typeof progress === "object" ? progress : null;
  }

  async function setResumeProgress(cacheNamespace, progress) {
    if (!cacheNamespace) return;

    const progressMap = await getResumeProgressMap();
    if (progress) {
      progressMap[cacheNamespace] = progress;
    } else {
      delete progressMap[cacheNamespace];
    }

    await storageSet({
      [STORAGE_KEYS.resumeProgress]: progressMap,
    });
  }

  function resetResumeState() {
    resumeState.channels = null;
    resumeState.channelsHash = null;
    resumeState.nextChannelIndex = 0;
    resumeState.totalChannels = 0;
    resumeState.doneCount = 0;
    resumeState.postsToRefetch = null;
    resumeState.nextRefetchIndex = 0;
    resumeState.fetchedPostIds = new Set();
  }

  function hashString(value) {
    let hash = 5381;
    for (let index = 0; index < value.length; index++) {
      hash = ((hash << 5) + hash) + value.charCodeAt(index);
      hash |= 0;
    }

    return Math.abs(hash).toString(36);
  }

  function getChannelsHash(channels) {
    return hashString(channels.map(channel => channel.channelId).join(","));
  }

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

  async function getActiveCacheNamespace() {
    const baseCacheNamespace = await getCacheNamespace();
    const useManagedChannels = document.getElementById("yt-posts-use-managed-channels")?.checked;

    if (!useManagedChannels) {
      return `${baseCacheNamespace}:subscriptions`;
    }

    const channels = await getManagedChannels();
    const channelIds = channels.map(channel => channel.channelId).join(",");
    return `${baseCacheNamespace}:managed:${hashString(channelIds)}`;
  }

  function isDialogSessionActive(dialogSessionId) {
    return Boolean(dialogSessionId) && dialogSessionId === currentDialogSessionId;
  }

  function findScrollableAncestor(root, target) {
    let node = target instanceof Element ? target : null;
    while (node && node !== root) {
      const style = getComputedStyle(node);
      const overflowY = style.overflowY;
      const canScrollY = (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight;
      if (canScrollY) {
        return node;
      }
      node = node.parentElement;
    }

    const rootStyle = getComputedStyle(root);
    const rootCanScrollY =
      (rootStyle.overflowY === "auto" || rootStyle.overflowY === "scroll") &&
      root.scrollHeight > root.clientHeight;
    return rootCanScrollY ? root : null;
  }

  function trapWheelScroll(root) {
    root.addEventListener("wheel", event => {
      event.stopPropagation();

      const scrollable = findScrollableAncestor(root, event.target);
      if (!scrollable) {
        event.preventDefault();
        return;
      }

      const deltaY = event.deltaY;
      if (deltaY === 0) return;

      const isScrollingDown = deltaY > 0;
      const reachedTop = scrollable.scrollTop <= 0;
      const reachedBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight;

      if ((isScrollingDown && reachedBottom) || (!isScrollingDown && reachedTop)) {
        event.preventDefault();
      }
    }, { passive: false });
  }

  async function openDialog() {
    if (currentDialogSessionId) {
      closeDialog(currentDialogSessionId);
    }

    currentDialogSessionId = crypto.randomUUID();
    const dialogSessionId = currentDialogSessionId;
    dialog = document.createElement("div");
    dialog.className = "yt-posts-dialog";
    dialog.innerHTML = `
      <div id="yt-posts-dialog-content">
        <div class="yt-posts-header">
          <div class="yt-posts-header-left">
            <span id="yt-posts-loader"></span>
            <span>${t("subscribedPosts")}</span>
            <span>&nbsp;(</span>
            <span id="yt-posts-count-done">???</span>
            <span>&nbsp;/&nbsp;</span>
            <span id="yt-posts-count-max">???</span>
            <span>)</span>
          </div>
          <div class="yt-posts-header-controls">
            <label class="yt-posts-managed-toggle">
              <input id="yt-posts-use-managed-channels" type="checkbox">
              <span>${t("useManagedChannels")}</span>
            </label>
            <button id="yt-posts-manage-channels" class="yt-posts-secondary-btn" type="button" hidden>${t("channel")}</button>
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

    trapWheelScroll(document.getElementById("yt-posts-dialog-content"));

    document.getElementById("yt-posts-dialog-overlay").onclick = document.getElementById("yt-posts-close").onclick = () => {
      closeDialog(dialogSessionId);
    };

    const useManagedChannelsInput = document.getElementById("yt-posts-use-managed-channels");
    const manageChannelsButton = document.getElementById("yt-posts-manage-channels");
    const useManagedChannels = await getUseManagedChannels();

    useManagedChannelsInput.checked = useManagedChannels;
    manageChannelsButton.hidden = !useManagedChannels;

    useManagedChannelsInput.onchange = async () => {
      const enabled = useManagedChannelsInput.checked;
      manageChannelsButton.hidden = !enabled;
      await saveUseManagedChannels(enabled);
      if (isDialogSessionActive(dialogSessionId)) {
        openDialog();
      }
    };

    manageChannelsButton.onclick = () => {
      openChannelManagerDialog(dialogSessionId);
    };

    activeCacheNamespace = await getActiveCacheNamespace();
    const posts = await loadFromIndexedDB(activeCacheNamespace);
    if (posts) {
      renderPosts(posts, true, activeCacheNamespace);

      if (!hasPendingRefetchWork()) {
        resumeState.postsToRefetch = [...posts].sort((a, b) => parseTime(a.time) - parseTime(b.time));
        resumeState.nextRefetchIndex = 0;
      }
    }

    syncDialogProgress();

    if (hasPendingRefetchWork()) {
      refetchPosts(dialogSessionId);
    } else {
      resumeState.postsToRefetch = null;
      resumeState.nextRefetchIndex = 0;
    }

    if (hasPendingChannelWork()) {
      fetchPostsByChannels(dialogSessionId);
    } else {
      requestChannelsByCurrentMode(dialogSessionId);
    }
  }

  function closeDialog(dialogSessionId) {
    if (!isDialogSessionActive(dialogSessionId)) return;
    currentDialogSessionId = null;
    closeChannelManagerDialog(false);
    resetResumeState();

    window.postMessage({
      type: "YT_CANCEL_DIALOG_SESSION",
      dialogSessionId,
    }, "*");

    if (dialog) {
      dialog.remove();
      dialog = null;
    }
  }

  async function requestChannelsByCurrentMode(dialogSessionId) {
    const useManagedChannels = document.getElementById("yt-posts-use-managed-channels")?.checked;

    if (useManagedChannels) {
      const channels = await getManagedChannels();
      if (!isDialogSessionActive(dialogSessionId)) return;

      await applyChannelResumeProgress(channels);

      fetchPostsByChannels(dialogSessionId);
      return;
    }

    requestChannels(dialogSessionId);
  }

  function requestChannels(dialogSessionId) {
    const loader = document.getElementById("yt-posts-loader");
    if (!loader) return;
    loader.style.visibility = "visible";

    window.postMessage({
      type: "YT_FETCH_CHANNELS",
      dialogSessionId,
    }, "*");
  }

  window.addEventListener("message", async e => {
    const msg = e.data;
    if (!msg || !msg.type) return;

    if (msg.type === "YT_FETCH_CHANNELS_RESULT") {
      if (!isDialogSessionActive(msg.dialogSessionId)) return;

      const loader = document.getElementById("yt-posts-loader");
      if (!loader) return;
      loader.style.visibility = "hidden";

      await applyChannelResumeProgress(msg.channels);

      fetchPostsByChannels(msg.dialogSessionId);
      return;
    }

    if (msg.type === "YT_FETCH_POSTS_BY_CHANNEL_RESULT") {
      if (!isDialogSessionActive(msg.dialogSessionId) || msg.canceled) return;

      const loader = document.getElementById("yt-posts-loader");
      if (!loader) return;
      loader.style.visibility = "hidden";

      renderPosts(msg.posts, false, activeCacheNamespace);
      deleteExpiredPosts(activeCacheNamespace);
      return;
    }

    if (msg.type === "YT_FETCH_POST_BY_ID_RESULT") {
      if (!isDialogSessionActive(msg.dialogSessionId) || msg.canceled) return;

      renderPosts(msg.posts, false, activeCacheNamespace);
      return;
    }
  });

  async function fetchPostsByChannels(dialogSessionId) {
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
        loader.style.visibility = "visible";

        window.postMessage({
          type: "YT_FETCH_POSTS_BY_CHANNEL",
          requestId,
          dialogSessionId,
          channel,
        }, "*");
      });
    }

    async function worker() {
      while (hasPendingChannelWork() && isDialogSessionActive(dialogSessionId)) {
        const index = resumeState.nextChannelIndex;
        const channel = resumeState.channels?.[index];
        if (!channel) return;

        resumeState.nextChannelIndex += 1;
        const response = await fetchPostsByChannel(channel);
        if (response?.canceled || !isDialogSessionActive(dialogSessionId)) {
          resumeState.nextChannelIndex = index;
          return;
        }

        await markChannelFetchCompleted(channel);
      }
    }

    await Promise.all(
      Array.from({ length: MAX_PARALLEL_FETCH_POSTS_BY_CHANNELS }, worker)
    );

    await finalizeChannelResumeProgress();
  }

  async function refetchPosts(dialogSessionId) {
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
      while (hasPendingRefetchWork() && isDialogSessionActive(dialogSessionId)) {
        const index = resumeState.nextRefetchIndex;
        const post = resumeState.postsToRefetch?.[index];
        if (!post) return;

        resumeState.nextRefetchIndex += 1;
        if (!isPostVisible(post.postId)) {
          continue;
        }

        const response = await fetchPostById(post);
        if (response?.canceled || !isDialogSessionActive(dialogSessionId)) {
          resumeState.nextRefetchIndex = index;
          return;
        }
      }
    }

    await Promise.all(
      Array.from({ length: MAX_PARALLEL_FETCH_POST_BY_ID }, worker)
    );
  }

  function hasPendingChannelWork() {
    return Array.isArray(resumeState.channels) && resumeState.nextChannelIndex < resumeState.channels.length;
  }

  function hasPendingRefetchWork() {
    return Array.isArray(resumeState.postsToRefetch) && resumeState.nextRefetchIndex < resumeState.postsToRefetch.length;
  }

  function isPostVisible(postId) {
    if (!postId) return false;

    const container = document.getElementById("yt-posts-body");
    if (!container) return false;

    try {
      return CSS.escape
        ? container.querySelector(`#${CSS.escape(postId)}`) !== null
        : container.querySelector(`[id="${postId}"]`) !== null;
    } catch {
      return container.querySelector(`[id="${postId}"]`) !== null;
    }
  }

  function syncDialogProgress() {
    const done = document.getElementById("yt-posts-count-done");
    if (done) {
      done.textContent = resumeState.doneCount;
    }

    const max = document.getElementById("yt-posts-count-max");
    if (max) {
      max.textContent = resumeState.totalChannels ?? "???";
    }
  }

  async function applyChannelResumeProgress(channels) {
    const channelList = Array.isArray(channels) ? channels : [];
    const channelsHash = getChannelsHash(channelList);
    const progress = await getResumeProgress(activeCacheNamespace);
    const completedChannelIds = progress?.channelsHash === channelsHash
      ? new Set(progress.completedChannelIds ?? [])
      : new Set();

    resumeState.channels = channelList.filter(channel => !completedChannelIds.has(channel.channelId));
    resumeState.channelsHash = channelsHash;
    resumeState.nextChannelIndex = 0;
    resumeState.totalChannels = channelList.length;
    resumeState.doneCount = Math.min(completedChannelIds.size, channelList.length);
    syncDialogProgress();

    if (channelList.length === 0 || completedChannelIds.size >= channelList.length) {
      await setResumeProgress(activeCacheNamespace, null);
      return;
    }

    await setResumeProgress(activeCacheNamespace, {
      channelsHash,
      completedChannelIds: [...completedChannelIds],
    });
  }

  async function markChannelFetchCompleted(channel) {
    resumeState.doneCount += 1;
    syncDialogProgress();

    if (!channel?.channelId || !activeCacheNamespace) return;

    const progress = await getResumeProgress(activeCacheNamespace);
    const completedChannelIds = new Set(progress?.completedChannelIds ?? []);
    completedChannelIds.add(channel.channelId);

    await setResumeProgress(activeCacheNamespace, {
      channelsHash: progress?.channelsHash ?? resumeState.channelsHash,
      completedChannelIds: [...completedChannelIds],
    });
  }

  async function finalizeChannelResumeProgress() {
    if (!activeCacheNamespace) return;

    if (resumeState.totalChannels > 0 && resumeState.doneCount >= resumeState.totalChannels) {
      await setResumeProgress(activeCacheNamespace, null);
    }
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

      if (!isCache) {
        resumeState.fetchedPostIds.add(post.postId);
      }

      if (isCache && !resumeState.fetchedPostIds.has(post.postId)) {
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

  function openChannelManagerDialog(dialogSessionId) {
    if (channelManagerDialog) return;

    channelManagerDialog = document.createElement("div");
    channelManagerDialog.className = "yt-posts-subdialog";
    channelManagerDialog.innerHTML = `
      <div class="yt-posts-subdialog-content">
        <div class="yt-posts-subdialog-header">
          <span>${t("channelManager")}</span>
          <button id="yt-posts-channel-manager-close" class="yt-posts-icon-btn" type="button">✕</button>
        </div>
        <div class="yt-posts-subdialog-body">
          <div class="yt-posts-channel-form">
            <input id="yt-posts-channel-name" class="yt-posts-text-input" type="text" placeholder="${t("channelInputPlaceholder")}">
            <button id="yt-posts-channel-add" class="yt-posts-secondary-btn" type="button">${t("add")}</button>
          </div>
          <div id="yt-posts-channel-manager-status" class="yt-posts-channel-manager-status"></div>
          <div id="yt-posts-channel-list" class="yt-posts-channel-list"></div>
        </div>
      </div>
      <div id="yt-posts-channel-manager-overlay" class="yt-posts-subdialog-overlay"></div>
    `;

    dialog?.appendChild(channelManagerDialog);

    trapWheelScroll(channelManagerDialog.querySelector(".yt-posts-subdialog-content"));

    const close = () => closeChannelManagerDialog(true);
    document.getElementById("yt-posts-channel-manager-close").onclick = close;
    document.getElementById("yt-posts-channel-manager-overlay").onclick = close;
    document.getElementById("yt-posts-channel-add").onclick = async () => {
      await addManagedChannelFromInput(dialogSessionId);
    };
    document.getElementById("yt-posts-channel-name").onkeydown = async event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      await addManagedChannelFromInput(dialogSessionId);
    };

    renderManagedChannelList();
  }

  function closeChannelManagerDialog(shouldRefreshPosts = true) {
    if (!channelManagerDialog) return;
    channelManagerDialog.remove();
    channelManagerDialog = null;

    if (shouldRefreshPosts && currentDialogSessionId) {
      openDialog();
    }
  }

  async function renderManagedChannelList() {
    const container = document.getElementById("yt-posts-channel-list");
    if (!container) return;

    const channels = await getManagedChannels();
    container.replaceChildren();

    channels.forEach((channel, index) => {
      const item = document.createElement("div");
      item.className = "yt-posts-channel-list-item";
      item.draggable = true;
      item.dataset.index = String(index);
      item.innerHTML = `
        <div class="yt-posts-channel-list-main">
          <img class="yt-posts-channel-list-icon" src="${channel.icon ?? ""}" alt="">
          <span class="yt-posts-channel-list-name">${channel.name ?? channel.channelId}</span>
        </div>
        <button class="yt-posts-channel-delete yt-posts-danger-btn" type="button">${t("remove")}</button>
      `;

      item.addEventListener("dragstart", event => {
        event.dataTransfer?.setData("text/plain", String(index));
        event.dataTransfer.effectAllowed = "move";
        item.classList.add("yt-posts-dragging");
      });

      item.addEventListener("dragend", () => {
        item.classList.remove("yt-posts-dragging");
      });

      item.addEventListener("dragover", event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });

      item.addEventListener("drop", async event => {
        event.preventDefault();
        const fromIndex = Number(event.dataTransfer?.getData("text/plain"));
        const toIndex = index;
        if (Number.isNaN(fromIndex) || fromIndex === toIndex) return;

        const nextChannels = await getManagedChannels();
        const [moved] = nextChannels.splice(fromIndex, 1);
        nextChannels.splice(toIndex, 0, moved);
        await saveManagedChannels(nextChannels);
        await renderManagedChannelList();
      });

      item.querySelector(".yt-posts-channel-delete").onclick = async () => {
        const nextChannels = channels.filter((_, channelIndex) => channelIndex !== index);
        await saveManagedChannels(nextChannels);
        await renderManagedChannelList();
      };

      container.appendChild(item);
    });
  }

  async function addManagedChannelFromInput(dialogSessionId) {
    const input = document.getElementById("yt-posts-channel-name");
    if (!input) return;

    const channelInput = input.value.trim();
    if (!channelInput) return;

    setChannelManagerStatus(t("resolvingChannel"));

    const selectedChannel = await resolveChannel(channelInput, dialogSessionId);
    if (!isDialogSessionActive(dialogSessionId)) return;

    if (!selectedChannel) {
      setChannelManagerStatus(t("channelNotFound"));
      return;
    }

    const managedChannels = await getManagedChannels();
    if (managedChannels.some(channel => channel.channelId === selectedChannel.channelId)) {
      setChannelManagerStatus(t("channelAlreadyAdded"));
      return;
    }

    await saveManagedChannels([...managedChannels, selectedChannel]);
    input.value = "";
    setChannelManagerStatus(t("channelAdded"));
    await renderManagedChannelList();
  }

  function setChannelManagerStatus(message) {
    const status = document.getElementById("yt-posts-channel-manager-status");
    if (status) {
      status.textContent = message;
    }
  }

  function resolveChannel(input, dialogSessionId) {
    return new Promise(resolve => {
      const requestId = crypto.randomUUID();

      function handler(event) {
        if (
          event.data?.type === "YT_RESOLVE_CHANNEL_RESULT" &&
          event.data?.requestId === requestId
        ) {
          window.removeEventListener("message", handler);
          resolve(event.data.channel ?? null);
        }
      }

      window.addEventListener("message", handler);
      window.postMessage({
        type: "YT_RESOLVE_CHANNEL",
        requestId,
        dialogSessionId,
        input,
      }, "*");
    });
  }
});
