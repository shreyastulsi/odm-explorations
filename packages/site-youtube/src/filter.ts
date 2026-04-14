export interface YoutubeSearchResult {
  title: string;
  url: string;
  channel: string | null;
  publishedText: string | null;
  durationText: string | null;
  descriptionText: string | null;
  viewsText: string | null;
}

export function filterOrganicYouTubeResults(
  results: YoutubeSearchResult[],
  limit: number
): YoutubeSearchResult[] {
  const seen = new Set<string>();

  return results
    .filter((result) => {
      const normalizedUrl = result.url.trim();
      if (!result.title.trim()) {
        return false;
      }
      if (!normalizedUrl.includes("/watch")) {
        return false;
      }
      if (normalizedUrl.includes("/shorts/")) {
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

