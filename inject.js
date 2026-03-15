(() => {
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

  async function callInnertube(endpoint, body) {
    const url = `/youtubei/v1/${endpoint}?key=${ytcfg.data_.INNERTUBE_API_KEY}&prettyPrint=false&hl=en`;

    const headers = {
      "Accept-Language": "en",
      "accept": "*/*",
      "content-type": "application/json",
      "x-origin": window.origin,
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

    // JSON.parse(JSON.stringify())を使わず、スプレッド構文でコピーして hl を削除
    const context = { ...ytcfg.data_.INNERTUBE_CONTEXT };
    if (context.client) {
      context.client = { ...context.client };
      delete context.client.hl;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        context,
        ...body
      })
    });

    return res.json();
  }

  async function fetchChannels() {
    const data = await callInnertube("browse", {
      browseId: "FEchannels"
    });

    const channels = [];
    findValuesByKey(data, "channelRenderer")?.forEach(channelRenderer => {
      channels.push({
        channelId: channelRenderer.channelId,
        canonicalBaseUrl: channelRenderer.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl,
        name: channelRenderer.title?.simpleText,
        icon: channelRenderer.thumbnail?.thumbnails?.slice(-1)?.[0]?.url,
      });
    });

    window.postMessage({
      type: "YT_FETCH_CHANNELS_RESULT",
      channels,
    }, "*");
  }

  async function fetchPostsByChannel(requestId, channel) {
    const data = await callInnertube("browse", { browseId: channel.channelId, params: "EgVwb3N0c_IGBAoCSgA%3D" });

    const posts = [];
    findValuesByKey(data, "backstagePostRenderer")?.forEach(backstagePostRenderer => {
      console.log(backstagePostRenderer);
      posts.push({
        channel,
        postId: backstagePostRenderer.postId,
        text: backstagePostRenderer.contentText?.runs?.map(r => r.text).join("") ?? "...",
        time: backstagePostRenderer.publishedTimeText?.runs?.[0]?.text,
        fetchedAt: Date.now(),
      });
    });

    sendResponce("YT_FETCH_POSTS_BY_CHANNEL_RESULT", requestId, posts);
  }

  async function fetchPostById(requestId, post) {
    const data = await callInnertube("browse", { browseId: "FEpost_detail", params: encodeCommunityPostParamsBase64(post.postId, post.channel.channelId) });

    const backstagePostRenderer = findFirstValueByKey(data, "backstagePostRenderer");
    if (!backstagePostRenderer) return;

    sendResponce("YT_FETCH_POST_BY_ID_RESULT", requestId, [{
      channel: post.channel,
      postId: post.postId,
      text: backstagePostRenderer?.contentText?.runs?.map(r => r.text).join("") ?? "...",
      time: backstagePostRenderer?.publishedTimeText?.runs?.[0]?.text,
      fetchedAt: Date.now(),
    }]);

  }

  function sendResponce(type, requestId, posts) {
    window.postMessage({
      type,
      requestId,
      posts
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
      fetchChannels();
    }

    if (msg.type === "YT_FETCH_POSTS_BY_CHANNEL") {
      fetchPostsByChannel(msg.requestId, msg.channel);
    }

    if (msg.type === "YT_FETCH_POST_BY_ID") {
      fetchPostById(msg.requestId, msg.post);
    }
  });
})();