import type { MeetingList } from "@/lib/api";

// Backendの1ページ上限。検索・絞り込みは画面側で行うため全件を取得する。
export const MEETING_PAGE_SIZE = 100;

export async function loadAllMeetings(
  fetchPage: (offset: number) => Promise<MeetingList>,
): Promise<MeetingList["items"]> {
  const meetings: MeetingList["items"] = [];
  for (;;) {
    const page = await fetchPage(meetings.length);
    meetings.push(...page.items);
    if (page.items.length === 0 || meetings.length >= page.total) return meetings;
  }
}
