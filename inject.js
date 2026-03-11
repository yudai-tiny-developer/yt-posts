(() => {
  function sha1(str) {
    return window.crypto.subtle.digest("SHA-1", new TextEncoder().encode(str)).then((buf) => {
      return Array.prototype.map.call(new Uint8Array(buf), (x) => ("00" + x.toString(16)).slice(-2)).join("");
    });
  };

  async function getSApiSidHash(SAPISID, origin) {
    const TIMESTAMP_MS = Date.now();
    const digest = await sha1(`${TIMESTAMP_MS} ${SAPISID} ${origin}`);
    return `${TIMESTAMP_MS}_${digest}`;
  };

  async function callInnertube(endpoint, body) {
    const res = await fetch(`/youtubei/v1/${endpoint}?key=${ytcfg.data_.INNERTUBE_API_KEY}&prettyPrint=false`, {
      method: "POST",
      headers: {
        "accept": "*/*",
        "authorization": "SAPISIDHASH " + await getSApiSidHash(document.cookie.split("SAPISID=")[1]?.split("; ")[0], window.origin),
        "content-type": "application/json",
        "x-goog-authuser": ytcfg.data_.SESSION_INDEX,
        "x-goog-pageid": ytcfg.data_.DELEGATED_SESSION_ID,
      },
      body: JSON.stringify({
        "context": {
          "client": {
            "clientName": "WEB",
            "clientVersion": ytcfg.data_.INNERTUBE_CLIENT_VERSION,
          },
        },
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

    const items = data
      ?.contents
      ?.twoColumnBrowseResultsRenderer
      ?.tabs?.[0]
      ?.tabRenderer
      ?.content
      ?.sectionListRenderer
      ?.contents?.[0]
      ?.itemSectionRenderer
      ?.contents?.[0]
      ?.shelfRenderer
      ?.content
      ?.expandedShelfContentsRenderer
      ?.items ?? [];

    items.forEach(i => {
      const r = i.channelRenderer;
      if (!r) return;

      channels.push({
        channelId: r.channelId,
        canonicalBaseUrl: r.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl,
        name: r.title?.simpleText,
        icon: r.thumbnail?.thumbnails?.slice(-1)?.[0]?.url,
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

    const items = data
      ?.contents
      ?.twoColumnBrowseResultsRenderer
      ?.tabs
      ?.find(t => t.tabRenderer?.title === "Posts")
      ?.tabRenderer
      ?.content
      ?.sectionListRenderer
      ?.contents ?? [];

    items.forEach(s => {
      const contents = s.itemSectionRenderer?.contents ?? [];

      contents.forEach(content => {
        const backstagePostRenderer = content.backstagePostThreadRenderer?.post?.backstagePostRenderer;
        if (!backstagePostRenderer) return;

        posts.push({
          channel,
          postId: backstagePostRenderer.postId,
          text: backstagePostRenderer.contentText?.runs?.map(r => r.text).join("") ?? "...",
          time: backstagePostRenderer.publishedTimeText?.runs?.[0]?.text,
          fetchedAt: Date.now(),
        });
      });
    });

    sendResponce("YT_FETCH_POSTS_BY_CHANNEL_RESULT", requestId, posts);
  }

  async function fetchPostById(requestId, post) {
    const data = await callInnertube("browse", { browseId: "FEpost_detail", params: encodeCommunityPostParamsBase64(post.postId, post.channel.channelId) });

    const backstagePostRenderer = data
      ?.contents
      ?.twoColumnBrowseResultsRenderer
      ?.tabs?.[0]
      ?.tabRenderer
      ?.content
      ?.sectionListRenderer
      ?.contents?.[0]
      ?.itemSectionRenderer
      ?.contents?.[0]
      ?.backstagePostThreadRenderer
      ?.post
      ?.backstagePostRenderer;

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