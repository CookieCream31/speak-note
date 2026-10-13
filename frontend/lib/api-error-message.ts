export function apiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object" || !("detail" in body)) return fallback;
  const detail = body.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (!Array.isArray(detail)) return fallback;
  const messages = detail.flatMap((item: unknown) => (
    item && typeof item === "object" && "msg" in item && typeof item.msg === "string"
      ? [item.msg]
      : []
  ));
  return messages.length ? `${fallback}: ${messages.join(" / ")}` : fallback;
}
