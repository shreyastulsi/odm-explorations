export interface PornhubSearchResult {
  title: string;
  url: string;
  viewsText: string | null;
  durationText: string | null;
  uploader: string | null;
}

export function filterPornhubResults(
  results: PornhubSearchResult[],
  limit: number
): PornhubSearchResult[] {
  const seen = new Set<string>();

  return results
    .filter((result) => {
      const normalizedUrl = result.url.trim();
      if (!result.title.trim()) {
        return false;
      }
      if (!normalizedUrl.includes("/view_video.php?viewkey=")) {
        return false;
      }
      if (seen.has(normalizedUrl)) {
        return false;
      }
      seen.add(normalizedUrl);
      return true;
    })
    .slice(0, limit);
}

