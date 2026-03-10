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

  const items = data.contents
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
    ?.items || [];

  items.forEach(i => {
    const r = i.channelRenderer;
    if (!r) return;

    channels.push({
      channelId: r.channelId,
      canonicalBaseUrl: r.navigationEndpoint.browseEndpoint.canonicalBaseUrl,
      name: r.title.simpleText,
      icon: r.thumbnail.thumbnails.slice(-1)[0].url,
    });
  });

  window.postMessage({
    type: "YT_FETCH_CHANNELS_RESULT",
    channels,
  }, "*");
}

async function fetchPosts(requestId, channel) {
  const data = await callInnertube("browse", { browseId: channel.channelId, params: "EgVwb3N0c_IGBAoCSgA%3D" });

  const tabs = data.contents
    ?.twoColumnBrowseResultsRenderer
    ?.tabs || [];

  const postsTab = tabs.find(t => t.tabRenderer?.title === "Posts");

  if (!postsTab) {
    send(requestId, []);
    return;
  }

  const posts = [];

  const items = postsTab.tabRenderer
    .content
    .sectionListRenderer
    .contents;

  items.forEach(s => {
    const arr = s.itemSectionRenderer?.contents || [];

    arr.forEach(p => {
      const post = p.backstagePostThreadRenderer?.post?.backstagePostRenderer;
      if (!post) return;

      posts.push({
        channel,
        postId: post.postId,
        text: post.contentText?.runs?.map(r => r.text).join("") || "",
        time: post.publishedTimeText.runs[0].text,
      });
    });
  });

  send(requestId, posts);
}

function send(requestId, posts) {
  window.postMessage({
    type: "YT_FETCH_POSTS_RESULT",
    requestId,
    posts
  }, "*");
}

window.addEventListener("message", e => {
  const msg = e.data;
  if (!msg || !msg.type) return;

  if (msg.type === "YT_FETCH_CHANNELS") {
    fetchChannels();
  }

  if (msg.type === "YT_FETCH_POSTS") {
    fetchPosts(msg.requestId, msg.channel);
  }
});