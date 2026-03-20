(() => {
  const GLOBAL_INNERTUBE_MAX_CONCURRENCY = 3;
  const GLOBAL_INNERTUBE_LOCK_NAME = "yt-posts-innertube";
  const GLOBAL_INNERTUBE_RATE_LOCK_NAME = "yt-posts-innertube-rate";
  const GLOBAL_INNERTUBE_LOCK_RETRY_MS = 200;
  const GLOBAL_INNERTUBE_MIN_INTERVAL_MS = 1000;
  const GLOBAL_INNERTUBE_NEXT_ALLOWED_AT_KEY = "yt-posts-innertube-next-allowed-at";
  const GLOBAL_INNERTUBE_MAX_PAGINATION_PAGES = 100;
  const canceledDialogSessions = new Set();
  const CANCELLATION_CHECK_INTERVAL_MS = 200;

  class DialogSessionCanceledError extends Error {
    constructor() {
      super("Dialog session canceled");
      this.name = "DialogSessionCanceledError";
    }
  }

  function sha1(str) {
    return window.crypto.subtle.digest("SHA-1", new TextEncoder().encode(str)).then((buf) => {
      return Array.prototype.map.call(new Uint8Array(buf), (x) => ("00" + x.toString(16)).slice(-2)).join("");
    });
  };

  async function getSApiSidHash(SAPISID, origin) {
    const TIMESTAMP_SEC = Math.floor(Date.now() / 1000);
    const digest = await sha1(`${TIMESTAMP_SEC} ${SAPISID} ${origin}`);
    return `${TIMESTAMP_SEC}_${digest}`;
  };

  function isDialogSessionCanceled(dialogSessionId) {
    return Boolean(dialogSessionId) && canceledDialogSessions.has(dialogSessionId);
  }

  function throwIfDialogSessionCanceled(dialogSessionId) {
    if (isDialogSessionCanceled(dialogSessionId)) {
      throw new DialogSessionCanceledError();
    }
  }

  async function sleepWithCancellation(ms, dialogSessionId) {
    let remainingMs = ms;

    while (remainingMs > 0) {
      throwIfDialogSessionCanceled(dialogSessionId);
      const waitMs = Math.min(remainingMs, CANCELLATION_CHECK_INTERVAL_MS);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      remainingMs -= waitMs;
    }
  }

  async function withInnertubeSlot(task, dialogSessionId) {
    if (!navigator.locks?.request) {
      throwIfDialogSessionCanceled(dialogSessionId);
      return task();
    }

    while (true) {
      throwIfDialogSessionCanceled(dialogSessionId);

      for (let index = 0; index < GLOBAL_INNERTUBE_MAX_CONCURRENCY; index++) {
        const lockName = `${GLOBAL_INNERTUBE_LOCK_NAME}:${index}`;
        let hasRun = false;
        let result;

        await navigator.locks.request(lockName, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) return;

          throwIfDialogSessionCanceled(dialogSessionId);
          hasRun = true;
          result = await task();
        });

        if (hasRun) {
          return result;
        }
      }

      await sleepWithCancellation(GLOBAL_INNERTUBE_LOCK_RETRY_MS, dialogSessionId);
    }
  }

  async function waitForInnertubeRateLimit(dialogSessionId) {
    if (!navigator.locks?.request) {
      await sleepWithCancellation(GLOBAL_INNERTUBE_MIN_INTERVAL_MS, dialogSessionId);
      return;
    }

    await navigator.locks.request(GLOBAL_INNERTUBE_RATE_LOCK_NAME, { mode: "exclusive" }, async () => {
      throwIfDialogSessionCanceled(dialogSessionId);
      const now = Date.now();
      const nextAllowedAt = Number(localStorage.getItem(GLOBAL_INNERTUBE_NEXT_ALLOWED_AT_KEY) ?? 0);
      const waitMs = Math.max(0, nextAllowedAt - now);

      if (waitMs > 0) {
        await sleepWithCancellation(waitMs, dialogSessionId);
      }

      localStorage.setItem(
        GLOBAL_INNERTUBE_NEXT_ALLOWED_AT_KEY,
        String(Date.now() + GLOBAL_INNERTUBE_MIN_INTERVAL_MS)
      );
    });
  }

  async function callInnertubeOnce(endpoint, body, dialogSessionId) {
    return withInnertubeSlot(async () => {
      await waitForInnertubeRateLimit(dialogSessionId);
      throwIfDialogSessionCanceled(dialogSessionId);

      const url = `/youtubei/v1/${endpoint}?key=${ytcfg.data_.INNERTUBE_API_KEY}&prettyPrint=false&hl=en`;

      const headers = {
        "Accept-Language": "en",
        "accept": "*/*",
        "content-type": "application/json",
        "referer": window.location.href,
        "x-origin": window.origin,
        "x-goog-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
        "x-youtube-client-name": ytcfg.data_.INNERTUBE_CLIENT_NAME,
        "x-youtube-client-version": ytcfg.data_.INNERTUBE_CLIENT_VERSION,
      };

      if (ytcfg.data_.LOGGED_IN) {
        headers["x-youtube-bootstrap-logged-in"] = "true";
        const sapisidCookie = document.cookie.match(/(?:^|; )SAPISID=([^;]+)/);
        if (sapisidCookie) {
          headers["authorization"] = `SAPISIDHASH ${await getSApiSidHash(sapisidCookie[1], window.origin)}`;
        }
      }

      if (ytcfg.data_.SESSION_INDEX !== undefined) headers["x-goog-authuser"] = ytcfg.data_.SESSION_INDEX;
      if (ytcfg.data_.VISITOR_DATA) headers["x-goog-visitor-id"] = ytcfg.data_.VISITOR_DATA;
      if (ytcfg.data_.DELEGATED_SESSION_ID) headers["x-goog-pageid"] = ytcfg.data_.DELEGATED_SESSION_ID;

      const context = { ...ytcfg.data_.INNERTUBE_CONTEXT };
      if (context.client) {
        context.client = { ...context.client };
        delete context.client.hl;

        context.request = {
          ...context.request,
          internalExperimentFlags: [],
          consistencyTokenJars: [],
        };
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          context,
          ...body
        }),
      });

      return res.json();
    }, dialogSessionId);
  }

  function getContinuationToken(data) {
    const continuationCommand = findFirstValueByKey(data, "continuationCommand");
    if (continuationCommand?.token) return continuationCommand.token;

    const continuationEndpoint = findFirstValueByKey(data, "continuationEndpoint");
    if (continuationEndpoint?.continuationCommand?.token) return continuationEndpoint.continuationCommand.token;

    const nextContinuationData = findFirstValueByKey(data, "nextContinuationData");
    if (nextContinuationData?.continuation) return nextContinuationData.continuation;

    const reloadContinuationData = findFirstValueByKey(data, "reloadContinuationData");
    if (reloadContinuationData?.continuation) return reloadContinuationData.continuation;

    return null;
  }

  async function callInnertube(endpoint, body, dialogSessionId, options = {}) {
    if (!options.paginate) {
      return callInnertubeOnce(endpoint, body, dialogSessionId);
    }

    const pages = [];
    const seenTokens = new Set();
    let requestBody = body;

    for (let pageIndex = 0; pageIndex < GLOBAL_INNERTUBE_MAX_PAGINATION_PAGES; pageIndex++) {
      const data = await callInnertubeOnce(endpoint, requestBody, dialogSessionId);
      pages.push(data);

      const continuation = getContinuationToken(data);
      if (!continuation || seenTokens.has(continuation)) {
        break;
      }

      seenTokens.add(continuation);
      requestBody = { continuation };
    }

    return pages;
  }

  async function fetchChannels(dialogSessionId) {
    try {
      const pages = await callInnertube("browse", {
        browseId: "FEchannels"
      }, dialogSessionId, { paginate: true });

      const channels = [];
      const seenChannelIds = new Set();

      pages.forEach(data => {
        findValuesByKey(data, "channelRenderer")?.forEach(channelRenderer => {
          if (!channelRenderer.channelId || seenChannelIds.has(channelRenderer.channelId)) return;

          seenChannelIds.add(channelRenderer.channelId);
          channels.push({
            channelId: channelRenderer.channelId,
            canonicalBaseUrl: channelRenderer.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl,
            name: channelRenderer.title?.simpleText,
            icon: channelRenderer.thumbnail?.thumbnails?.slice(-1)?.[0]?.url,
          });
        });
      });

      window.postMessage({
        type: "YT_FETCH_CHANNELS_RESULT",
        dialogSessionId,
        channels,
      }, "*");
    } catch (error) {
      if (!(error instanceof DialogSessionCanceledError)) throw error;

      window.postMessage({
        type: "YT_FETCH_CHANNELS_RESULT",
        dialogSessionId,
        channels: [],
        canceled: true,
      }, "*");
    }
  }

  function normalizeChannelInput(input) {
    const value = String(input ?? "").trim();
    if (!value) return null;

    if (/^UC[\w-]{20,}$/i.test(value)) {
      return {
        type: "browseId",
        browseId: value,
      };
    }

    if (value.startsWith("@")) {
      return {
        type: "url",
        url: `https://www.youtube.com/${value}`,
      };
    }

    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        if (!/youtube\.com$/i.test(parsed.hostname) && !/youtu\.be$/i.test(parsed.hostname)) {
          return null;
        }

        return {
          type: "url",
          url: value,
        };
      } catch {
        return null;
      }
    }

    if (value.startsWith("/")) {
      return {
        type: "url",
        url: `https://www.youtube.com${value}`,
      };
    }

    return null;
  }

  function extractChannelFromBrowseData(data, fallbackBrowseId = null) {
    const channelMetadataRenderer = findFirstValueByKey(data, "channelMetadataRenderer");
    const c4TabbedHeaderRenderer = findFirstValueByKey(data, "c4TabbedHeaderRenderer");
    const channelId = channelMetadataRenderer?.externalId ?? c4TabbedHeaderRenderer?.channelId ?? fallbackBrowseId;

    if (!channelId) return null;

    return {
      channelId,
      canonicalBaseUrl: channelMetadataRenderer?.vanityChannelUrl
        ? new URL(channelMetadataRenderer.vanityChannelUrl).pathname
        : channelMetadataRenderer?.channelUrl
          ? new URL(channelMetadataRenderer.channelUrl).pathname
          : c4TabbedHeaderRenderer?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl,
      name: channelMetadataRenderer?.title ?? c4TabbedHeaderRenderer?.title,
      icon: channelMetadataRenderer?.avatar?.thumbnails?.slice(-1)?.[0]?.url
        ?? c4TabbedHeaderRenderer?.avatar?.thumbnails?.slice(-1)?.[0]?.url,
    };
  }

  async function resolveChannel(requestId, dialogSessionId, input) {
    try {
      const normalizedInput = normalizeChannelInput(input);
      let channel = null;

      if (normalizedInput?.type === "browseId") {
        const data = await callInnertube("browse", {
          browseId: normalizedInput.browseId,
        }, dialogSessionId);
        channel = extractChannelFromBrowseData(data, normalizedInput.browseId);
      }

      if (normalizedInput?.type === "url") {
        const resolved = await callInnertube("navigation/resolve_url", {
          url: normalizedInput.url,
        }, dialogSessionId);
        const browseId = resolved?.endpoint?.browseEndpoint?.browseId;

        if (browseId) {
          const data = await callInnertube("browse", { browseId }, dialogSessionId);
          channel = extractChannelFromBrowseData(data, browseId);
        }
      }

      window.postMessage({
        type: "YT_RESOLVE_CHANNEL_RESULT",
        requestId,
        dialogSessionId,
        channel,
      }, "*");
    } catch (error) {
      if (!(error instanceof DialogSessionCanceledError)) throw error;

      window.postMessage({
        type: "YT_RESOLVE_CHANNEL_RESULT",
        requestId,
        dialogSessionId,
        channel: null,
        canceled: true,
      }, "*");
    }
  }

  async function fetchPostsByChannel(requestId, dialogSessionId, channel) {
    try {
      const data = await callInnertube("browse", { browseId: channel.channelId, params: "EgVwb3N0c_IGBAoCSgA%3D" }, dialogSessionId);

      const posts = [];
      findValuesByKey(data, "backstagePostRenderer")?.forEach(backstagePostRenderer => {
        posts.push({
          channel,
          postId: backstagePostRenderer.postId,
          text: backstagePostRenderer.contentText?.runs?.map(r => r.text).join("") ?? "...",
          time: backstagePostRenderer.publishedTimeText?.runs?.[0]?.text,
          fetchedAt: Date.now(),
        });
      });

      sendResponce("YT_FETCH_POSTS_BY_CHANNEL_RESULT", requestId, dialogSessionId, posts);
    } catch (error) {
      if (!(error instanceof DialogSessionCanceledError)) throw error;
      sendResponce("YT_FETCH_POSTS_BY_CHANNEL_RESULT", requestId, dialogSessionId, [], true);
    }
  }

  async function fetchPostById(requestId, dialogSessionId, post) {
    try {
      const data = await callInnertube("browse", { browseId: "FEpost_detail", params: encodeCommunityPostParamsBase64(post.postId, post.channel.channelId) }, dialogSessionId);

      const backstagePostRenderer = findFirstValueByKey(data, "backstagePostRenderer");
      if (!backstagePostRenderer) return;

      sendResponce("YT_FETCH_POST_BY_ID_RESULT", requestId, dialogSessionId, [{
        channel: post.channel,
        postId: post.postId,
        text: backstagePostRenderer?.contentText?.runs?.map(r => r.text).join("") ?? "...",
        time: backstagePostRenderer?.publishedTimeText?.runs?.[0]?.text,
        fetchedAt: Date.now(),
      }]);
    } catch (error) {
      if (!(error instanceof DialogSessionCanceledError)) throw error;
      sendResponce("YT_FETCH_POST_BY_ID_RESULT", requestId, dialogSessionId, [], true);
    }

  }

  async function fetchCacheNamespace(requestId) {
    const cacheNamespace = await getCacheNamespace();

    window.postMessage({
      type: "YT_GET_CACHE_NAMESPACE_RESULT",
      requestId,
      cacheNamespace,
    }, "*");
  }

  async function getCacheNamespace() {
    const loggedIn = Boolean(ytcfg.data_.LOGGED_IN);
    const delegatedSessionId = ytcfg.data_.DELEGATED_SESSION_ID ?? null;
    const datasyncId = ytcfg.data_.DATASYNC_ID ?? null;
    const accountKey = delegatedSessionId || datasyncId || null;

    const rawNamespace = JSON.stringify({
      loggedIn,
      accountKey,
    });

    return sha1(rawNamespace);
  }

  function sendResponce(type, requestId, dialogSessionId, posts, canceled = false) {
    window.postMessage({
      type,
      requestId,
      dialogSessionId,
      posts,
      canceled,
    }, "*");
  }

  function encodeVarint(value) {
    const bytes = [];
    while (value > 127) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value);
    return bytes;
  }

  function encodeTag(fieldNumber, wireType) {
    return encodeVarint((fieldNumber << 3) | wireType);
  }

  function encodeString(fieldNumber, str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);

    const out = [];
    out.push(...encodeTag(fieldNumber, 2));
    out.push(...encodeVarint(data.length));
    out.push(...data);
    return out;
  }

  function encodeField1({ ucid1, post_id, ucid2 }) {
    const out = [];

    if (ucid1 !== undefined) out.push(...encodeString(2, ucid1));
    if (post_id !== undefined) out.push(...encodeString(3, post_id));
    if (ucid2 !== undefined) out.push(...encodeString(11, ucid2));

    return new Uint8Array(out);
  }

  function uint8ToBase64(bytes) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes).toString("base64");
    }

    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function encodeCommunityPostParamsBase64(post_id, channel_id) {
    const field1 = encodeField1({ ucid1: channel_id, post_id, ucid2: channel_id });

    const out = [];
    out.push(...encodeTag(56, 2));
    out.push(...encodeVarint(field1.length));
    out.push(...field1);

    return uint8ToBase64(new Uint8Array(out));
  }

  function findValuesByKey(root, targetKey) {
    const results = [];
    const stack = [root];
    const visited = new WeakSet();

    while (stack.length) {
      const current = stack.pop();

      if (current === null || typeof current !== "object") continue;
      if (visited.has(current)) continue;
      visited.add(current);

      if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i++) {
          stack.push(current[i]);
        }
      } else {
        const keys = Object.keys(current);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const value = current[k];

          if (k === targetKey) {
            results.push(value);
          }

          if (value && typeof value === "object") {
            stack.push(value);
          }
        }
      }
    }

    return results;
  }

  function findFirstValueByKey(root, targetKey) {
    const stack = [root];
    const visited = new WeakSet();

    while (stack.length) {
      const current = stack.pop();

      if (current === null || typeof current !== "object") continue;
      if (visited.has(current)) continue;
      visited.add(current);

      if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i++) {
          stack.push(current[i]);
        }
      } else {
        const keys = Object.keys(current);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const value = current[k];

          if (k === targetKey) {
            return value;
          }

          if (value && typeof value === "object") {
            stack.push(value);
          }
        }
      }
    }

    return undefined;
  }

  window.addEventListener("message", e => {
    const msg = e.data;
    if (!msg || !msg.type) return;

    if (msg.type === "YT_FETCH_CHANNELS") {
      fetchChannels(msg.dialogSessionId);
    }

    if (msg.type === "YT_FETCH_POSTS_BY_CHANNEL") {
      fetchPostsByChannel(msg.requestId, msg.dialogSessionId, msg.channel);
    }

    if (msg.type === "YT_FETCH_POST_BY_ID") {
      fetchPostById(msg.requestId, msg.dialogSessionId, msg.post);
    }

    if (msg.type === "YT_RESOLVE_CHANNEL") {
      resolveChannel(msg.requestId, msg.dialogSessionId, msg.input);
    }

    if (msg.type === "YT_GET_CACHE_NAMESPACE") {
      fetchCacheNamespace(msg.requestId);
    }

    if (msg.type === "YT_CANCEL_DIALOG_SESSION") {
      canceledDialogSessions.add(msg.dialogSessionId);
    }
  });
})();
