import { describe, expect, it } from "vitest";

import type { Meeting, MeetingList } from "@/lib/api";
import { loadAllMeetings } from "@/lib/meeting-list";

function page(offset: number, size: number, total: number): MeetingList {
  const count = Math.max(0, Math.min(size, total - offset));
  return {
    items: Array.from({ length: count }, (_, index) => ({ id: `m${offset + index}` }) as Meeting),
    total,
    limit: size,
    offset,
  };
}

describe("loadAllMeetings", () => {
  it("reads every page beyond the backend page limit", async () => {
    const offsets: number[] = [];
    const meetings = await loadAllMeetings(async (offset) => {
      offsets.push(offset);
      return page(offset, 100, 250);
    });
    expect(offsets).toEqual([0, 100, 200]);
    expect(meetings).toHaveLength(250);
    expect(meetings.at(-1)?.id).toBe("m249");
  });

  it("stops when meetings were deleted while paging", async () => {
    const meetings = await loadAllMeetings(async (offset) => (
      offset === 0 ? page(0, 100, 150) : page(offset, 100, 100)
    ));
    expect(meetings).toHaveLength(100);
  });
});
