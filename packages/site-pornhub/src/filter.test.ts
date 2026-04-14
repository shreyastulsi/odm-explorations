import { describe, expect, it } from "vitest";
import { filterPornhubResults } from "./filter.js";

describe("filterPornhubResults", () => {
  it("keeps unique video URLs and limits the result count", () => {
    const filtered = filterPornhubResults(
      [
        {
          title: "One",
          url: "https://www.pornhub.com/view_video.php?viewkey=1",
          viewsText: "1M",
          durationText: "10:00",
          uploader: "user1"
        },
        {
          title: "Duplicate",
          url: "https://www.pornhub.com/view_video.php?viewkey=1",
          viewsText: "1M",
          durationText: "10:00",
          uploader: "user1"
        },
        {
          title: "Bad",
          url: "https://www.pornhub.com/model/foo",
          viewsText: null,
          durationText: null,
          uploader: null
        },
        {
          title: "Two",
          url: "https://www.pornhub.com/view_video.php?viewkey=2",
          viewsText: "2M",
          durationText: "11:00",
          uploader: "user2"
        }
      ],
      2
    );

    expect(filtered).toHaveLength(2);
    expect(filtered[0]?.url).toContain("view_video.php?viewkey=");
    expect(filtered[1]?.url).toContain("view_video.php?viewkey=2");
  });
});
