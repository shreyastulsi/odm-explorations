import { describe, expect, it } from "vitest";
import { filterOrganicYouTubeResults } from "./filter.js";

describe("filterOrganicYouTubeResults", () => {
  it("keeps organic watch URLs, removes duplicates, and limits results", () => {
    const filtered = filterOrganicYouTubeResults(
      [
        {
          title: "LeBron clip 1",
          url: "https://www.youtube.com/watch?v=1",
          channel: "NBA",
          publishedText: "1 day ago",
          durationText: "10:00",
          descriptionText: "desc",
          viewsText: "1M views"
        },
        {
          title: "LeBron clip 1 duplicate",
          url: "https://www.youtube.com/watch?v=1",
          channel: "NBA",
          publishedText: "1 day ago",
          durationText: "10:00",
          descriptionText: "desc",
          viewsText: "1M views"
        },
        {
          title: "Short",
          url: "https://www.youtube.com/shorts/123",
          channel: "NBA",
          publishedText: null,
          durationText: null,
          descriptionText: null,
          viewsText: null
        },
        {
          title: "LeBron clip 2",
          url: "https://www.youtube.com/watch?v=2",
          channel: "NBA",
          publishedText: "2 days ago",
          durationText: "12:00",
          descriptionText: "desc",
          viewsText: "2M views"
        }
      ],
      2
    );

    expect(filtered).toHaveLength(2);
    expect(filtered[0]?.url).toContain("/watch");
    expect(filtered[1]?.url).toBe("https://www.youtube.com/watch?v=2");
  });
});
