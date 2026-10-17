export function parseBilibiliVideoLink(input: string): { bvid: string; normalizedUrl: string } {
  const raw = input.trim();
  const direct = raw.match(/^(BV[0-9A-Za-z]{10})$/);
  if (direct !== null) {
    return {
      bvid: direct[1],
      normalizedUrl: `https://www.bilibili.com/video/${direct[1]}`,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("videoUrl must be a BV id or a valid bilibili video URL.");
  }

  const bvid = extractBvidFromUrl(url);
  if (bvid === undefined) {
    throw new Error("videoUrl must include a BV id, for example https://www.bilibili.com/video/BVxxxxxxxxxx.");
  }

  return {
    bvid,
    normalizedUrl: `https://www.bilibili.com/video/${bvid}`,
  };
}

function extractBvidFromUrl(url: URL): string | undefined {
  const fromPath = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/);
  if (fromPath !== null) {
    return fromPath[1];
  }
  const fromQuery = url.search.match(/[?&]bvid=(BV[0-9A-Za-z]{10})(?:&|$)/);
  if (fromQuery !== null) {
    return fromQuery[1];
  }
  const anywhere = `${url.pathname}${url.search}${url.hash}`.match(/(BV[0-9A-Za-z]{10})/);
  return anywhere?.[1];
}
